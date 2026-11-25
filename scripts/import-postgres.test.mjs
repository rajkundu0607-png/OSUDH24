import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../server/database.mjs';
import { openStorage } from '../server/storage.mjs';
import { importSqliteToPostgres } from './import-postgres.mjs';

const durableTables = ['sessions', 'users', 'auth_identities', 'cart', 'orders', 'appointments', 'prescriptions'];

async function sourceFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'osudh24-import-'));
  const sourcePath = join(directory, 'source.sqlite');
  const source = openDatabase(sourcePath);
  const bytes = Buffer.from([0, 255, 1, 128, 10, 42]);
  source.prepare('INSERT INTO sessions(id,token_hash,expires_at,profile,location_pin,newsletter_email) VALUES (?,?,?,?,?,?)')
    .run(7, 'fake-original-owner-hash', 123, '{"name":"Original profile","city":"Kolkata"}', '700001', 'news@example.test');
  source.prepare('INSERT INTO users(id,owner_id,name,email,phone,created_at) VALUES (?,?,?,?,?,?)')
    .run('preserved-user', 7, 'Original account', 'owner@example.test', '+919876543210', 101);
  for (const [provider, subject] of [['google', 'original-google-subject'], ['mobile', '919876543210']]) {
    source.prepare('INSERT INTO auth_identities(provider,subject,user_id) VALUES (?,?,?)').run(provider, subject, 'preserved-user');
  }
  source.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?)').run(7, 3, 2);
  source.prepare('INSERT INTO orders(rowid,id,session_id,idempotency_key,request_hash,data,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(13, 'preserved-order', 7, 'original-order-key', 'original-request-hash', '{"id":"preserved-order","total":299,"status":"Cancelled"}', '2026-01-01T12:00:00.000Z');
  source.prepare('INSERT INTO appointments(rowid,id,session_id,doctor_id,patient,date,time,fee,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(17, 'preserved-appointment', 7, 'ananya', 'Sample patient', '2030-01-01', '10:00', 499, 'Booked', '2026-01-01T12:00:00.000Z');
  source.prepare('INSERT INTO prescriptions(rowid,id,session_id,name,mime,size,created_at,content) VALUES (?,?,?,?,?,?,?,?)')
    .run(29, 'preserved-file', 7, 'original.pdf', 'application/pdf', bytes.length, '2026-01-01T12:00:00.000Z', bytes);
  source.prepare('INSERT INTO browser_sessions(id,owner_id,user_id,token_hash,expires_at) VALUES (?,?,?,?,?)')
    .run('old-browser', 7, 'preserved-user', 'old-browser-hash', 999999);
  source.prepare("INSERT INTO otp_challenges(id,browser_id,mobile,mode,expires_at,status,created_at) VALUES (?,?,?,?,?,'pending',?)")
    .run('old-challenge', 'old-browser', '919876543210', 'login', 999999, 1);
  source.prepare("INSERT INTO widget_token_uses(token_hash,browser_id,created_at,expires_at,status) VALUES (?,?,?,?,'consumed')")
    .run('old-widget-hash', 'old-browser', 1, 999999);
  source.prepare('INSERT INTO auth_rate_limits(scope,key,window_start,count,last_sent) VALUES (?,?,?,?,?)')
    .run('phone', 'old-rate-hash', 1, 1, 1);
  source.close();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, sourcePath, bytes };
}

// Real SQLite constraints/transactions exercise migration failure and rollback
// offline. Only PostgreSQL table-lock/sequence statements are stand-ins here;
// the separately opt-in hosted test below exercises those statements unchanged.
async function targetFixture(t, source, options = {}) {
  const actual = await openStorage({ databasePath: join(source.directory, 'target.sqlite') });
  t.after(() => actual.close());
  const operations = { writes: 0, sequenceResets: [] };
  const storage = {
    dialect: 'postgres',
    transaction: operation => actual.transaction(() => operation(storage)),
    exec: async sql => {
      assert.match(sql, /^LOCK TABLE /);
    },
    prepare(sql) {
      if (sql.startsWith('SELECT setval(')) return { get: async () => {operations.sequenceResets.push(sql); return { setval: 1 };} };
      const statement = actual.prepare(sql);
      return {
        get: (...values) => statement.get(...values),
        all: async (...values) => {
          const rows = await statement.all(...values);
          if (options.corruptVerification && sql.includes('content FROM prescriptions')) return rows.map(row => ({...row, content: Buffer.from('different bytes')}));
          return rows;
        },
        run: async (...values) => {
          operations.writes += 1;
          if (options.failOnFile && sql.startsWith('INSERT INTO prescriptions')) throw new Error('Simulated private provider details must never be exposed');
          return statement.run(...values);
        },
      };
    },
  };
  return { actual, storage, operations };
}

test('Postgres migration dry-run preserves source bytes and writes no account records', async t => {
  const source = await sourceFixture(t);
  const target = await targetFixture(t, source);
  const before = createHash('sha256').update(await readFile(source.sourcePath)).digest('hex');
  const result = await importSqliteToPostgres({ sourcePath: source.sourcePath, storage: target.storage });
  assert.equal(result.dryRun, true);
  assert.equal(result.targetEmpty, true);
  assert.equal(result.sourceCounts.auth_identities, 2);
  assert.deepEqual(result.excludedAuthenticationRecords, { browser_sessions: 1, otp_challenges: 1, widget_token_uses: 1, auth_rate_limits: 1 });
  assert.equal(target.operations.writes, 0);
  assert.deepEqual(target.operations.sequenceResets, []);
  const after = createHash('sha256').update(await readFile(source.sourcePath)).digest('hex');
  assert.equal(after, before);
  const output = JSON.stringify(result);
  assert.ok(!output.includes('owner@example.test') && !output.includes('preserved-user') && !output.includes('919876543210'));
});

async function assertImported(storage, source, result) {
  assert.equal(result.imported, true);
  assert.equal(result.verification.recordHashesMatch, true);
  assert.equal(result.verification.identityLinksVerified, 2);
  assert.equal(result.verification.linkedAccountsVerified, 1);
  assert.equal(result.verification.prescriptionBytesVerified, source.bytes.length);
  assert.equal((await storage.prepare('SELECT id FROM users').get()).id, 'preserved-user');
  assert.deepEqual((await storage.prepare('SELECT user_id FROM auth_identities ORDER BY provider').all()).map(row => row.user_id), ['preserved-user', 'preserved-user']);
  const file = await storage.prepare('SELECT rowid,content FROM prescriptions').get();
  assert.equal(Number(file.rowid), 29);
  assert.deepEqual(Buffer.from(file.content), source.bytes);
  assert.equal(Number((await storage.prepare('SELECT rowid FROM orders').get()).rowid), 13);
  assert.equal(Number((await storage.prepare('SELECT rowid FROM appointments').get()).rowid), 17);
  for (const table of ['browser_sessions', 'otp_challenges', 'widget_token_uses', 'auth_rate_limits']) {
    assert.equal(Number((await storage.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count), 0);
  }
}

test('Postgres migration retains linked identities, row ordering and private file bytes, and rejects repeats', async t => {
  const source = await sourceFixture(t);
  const target = await targetFixture(t, source);
  const result = await importSqliteToPostgres({ sourcePath: source.sourcePath, storage: target.storage, apply: true });
  await assertImported(target.actual, source, result);
  assert.equal(target.operations.sequenceResets.length, 4);
  await assert.rejects(importSqliteToPostgres({ sourcePath: source.sourcePath, storage: target.storage, apply: true }), /target contains account or authentication data/i);
  assert.equal(Number((await target.actual.prepare('SELECT COUNT(*) AS count FROM users').get()).count), 1);
});

for (const failure of ['failOnFile', 'corruptVerification']) {
  test(`Postgres migration rolls back all durable records on ${failure}`, async t => {
    const source = await sourceFixture(t);
    const target = await targetFixture(t, source, { [failure]: true });
    await assert.rejects(importSqliteToPostgres({ sourcePath: source.sourcePath, storage: target.storage, apply: true }), error => {
      assert.ok(!error.message.includes('private provider details'));
      return /rolled back/.test(error.message);
    });
    for (const table of durableTables) assert.equal(Number((await target.actual.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count), 0);
    assert.deepEqual(target.operations.sequenceResets, []);
  });
}

test('Postgres migration rejects catalog drift without importing data', async t => {
  const source = await sourceFixture(t);
  const target = await targetFixture(t, source);
  await target.actual.prepare('UPDATE products SET data = ? WHERE id = ?').run('{"price":1}', 1);
  await assert.rejects(importSqliteToPostgres({ sourcePath: source.sourcePath, storage: target.storage, apply: true }), /catalog differs/);
  assert.equal(target.operations.writes, 0);
});

test('Postgres migration rejects leftover authentication data even without durable accounts', async t => {
  const source = await sourceFixture(t);
  const target = await targetFixture(t, source);
  await target.actual.prepare("INSERT INTO widget_token_uses(token_hash,browser_id,created_at,expires_at,status) VALUES (?,?,?,?,'failed')")
    .run('existing-target-token', 'existing-target-browser', 1, 999999);
  const plan = await importSqliteToPostgres({ sourcePath: source.sourcePath, storage: target.storage });
  assert.equal(plan.targetEmpty, false);
  assert.equal(plan.targetCountsBeforeImport.users, 0);
  assert.equal(plan.targetCountsBeforeImport.widget_token_uses, 1);
  await assert.rejects(importSqliteToPostgres({ sourcePath: source.sourcePath, storage: target.storage, apply: true }), /target contains account or authentication data/);
  assert.equal(target.operations.writes, 0);
});

test('Postgres migration requires the Postgres adapter and does not create missing source databases', async t => {
  const source = await sourceFixture(t);
  const target = await targetFixture(t, source);
  await assert.rejects(importSqliteToPostgres({ sourcePath: source.sourcePath, storage: target.actual }), /PostgreSQL target/);
  await assert.rejects(importSqliteToPostgres({ sourcePath: join(source.directory, 'missing.sqlite'), storage: target.storage }), /source does not exist/);
});

test('Postgres migration preserves data and resets generated IDs in an isolated hosted schema', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL to run the isolated hosted migration test',
}, async t => {
  const source = await sourceFixture(t);
  const { Pool } = await import('pg');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const schema = `osudh24_import_test_${randomUUID().replaceAll('-', '')}`;
  let storage;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    if (storage) await storage.close();
    try {await admin.query(`DROP SCHEMA "${schema}" CASCADE`);} finally {await admin.end();}
  });
  storage = await openStorage({ databaseUrl: process.env.TEST_DATABASE_URL, schema });
  const result = await importSqliteToPostgres({ sourcePath: source.sourcePath, storage, apply: true });
  await assertImported(storage, source, result);
  const owner = await storage.prepare('INSERT INTO sessions(token_hash,expires_at) VALUES (?,?)').run('new-after-import', 999999);
  assert.equal(owner.lastInsertRowid, 8);
  const file = await storage.prepare('INSERT INTO prescriptions(id,session_id,name,mime,size,created_at,content) VALUES (?,?,?,?,?,?,?) RETURNING rowid')
    .get('new-after-import-file', 8, 'new.pdf', 'application/pdf', 0, '2026-01-01T00:00:00.000Z', Buffer.alloc(0));
  assert.equal(Number(file.rowid), 30);
});
