import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStorage, snapshotAsync, transactionAsync, translateSql } from './storage.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

async function sqlite(t) {
  const directory = await mkdtemp(join(tmpdir(), 'osudh24-storage-test-'));
  const databasePath = join(directory, 'test.sqlite');
  const db = await openStorage({ databasePath });
  t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  return { db, databasePath };
}

async function owner(db, label = randomUUID()) {
  const result = await db.prepare('INSERT INTO sessions(token_hash,expires_at) VALUES (?,?)').run(label, Math.floor(Date.now() / 1000) + 86400);
  assert.equal(typeof result.lastInsertRowid, 'number');
  assert.ok(Number.isSafeInteger(result.lastInsertRowid) && result.lastInsertRowid > 0);
  return result.lastInsertRowid;
}

async function storageContract(t, fixture) {
  const { db } = await fixture(t);
  const ownerId = await owner(db);
  const insert = await db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?)').run(ownerId, 1, 2);
  assert.equal(Number(insert.changes), 1);
  assert.deepEqual(plain(await db.prepare('SELECT product_id,quantity FROM cart WHERE session_id = ?').all(ownerId)), [{ product_id: 1, quantity: 2 }]);
  assert.equal(await db.prepare('SELECT id FROM sessions WHERE id = ?').get(-1), undefined);
  const snapshot = await snapshotAsync(db, ownerId);
  assert.equal(snapshot.products.length, 4);
  assert.equal(snapshot.doctors.length, 4);
  assert.equal(snapshot.cart[1], 2);
  assert.equal(snapshot.profile.name, '');
  assert.deepEqual(snapshot.orders, []);
  assert.deepEqual(snapshot.prescriptions, []);
  assert.equal(snapshot.availability.dates.length, 7);
}

test('SQLite adapter exposes asynchronous statement results, inserted owner IDs, and seeded snapshots', t => storageContract(t, sqlite));

test('SQLite transactions serialize concurrent read-modify-write operations', async t => {
  const { db } = await sqlite(t);
  const id = await owner(db);
  await db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?)').run(id, 1, 1);
  await Promise.all(Array.from({ length: 20 }, () => transactionAsync(db, async () => {
    const before = await db.prepare('SELECT quantity FROM cart WHERE session_id = ? AND product_id = ?').get(id, 1);
    await flush();
    await db.prepare('UPDATE cart SET quantity = ? WHERE session_id = ? AND product_id = ?').run(before.quantity + 1, id, 1);
  })));
  assert.equal((await db.prepare('SELECT quantity FROM cart WHERE session_id = ? AND product_id = ?').get(id, 1)).quantity, 21);
});

test('nontransaction queries cannot see another asynchronous transaction’s uncommitted writes', async t => {
  const { db } = await sqlite(t);
  const id = await owner(db);
  await db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?)').run(id, 1, 1);
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const pending = assert.rejects(transactionAsync(db, async () => {
    await db.prepare('UPDATE cart SET quantity = 7 WHERE session_id = ?').run(id);
    started();
    await gate;
    throw new Error('rollback visible write');
  }), /rollback visible write/);
  await entered;
  let outsideSettled = false;
  const outside = db.prepare('SELECT quantity FROM cart WHERE session_id = ?').get(id).then(result => { outsideSettled = true; return result; });
  try {
    await flush();
    assert.equal(outsideSettled, false);
  } finally { release(); }
  await pending;
  assert.equal((await outside).quantity, 1);
});

test('constraint errors roll back earlier writes and release the storage mutex for later work', async t => {
  const { db } = await sqlite(t);
  const id = await owner(db);
  await assert.rejects(transactionAsync(db, async () => {
    await db.prepare("UPDATE sessions SET profile = ? WHERE id = ?").run(JSON.stringify({ name: 'Must roll back' }), id);
    await db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?)').run(id, 1, 100);
  }));
  assert.equal(JSON.parse((await db.prepare('SELECT profile FROM sessions WHERE id = ?').get(id)).profile).name, undefined);
  assert.deepEqual(await db.prepare('SELECT product_id FROM cart WHERE session_id = ?').all(id), []);
  await transactionAsync(db, async () => {
    await db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?)').run(id, 2, 3);
  });
  assert.equal((await snapshotAsync(db, id)).cart[2], 3);
});

test('snapshot data and prescription bytes survive closing and reopening SQLite storage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'osudh24-storage-reopen-'));
  const databasePath = join(directory, 'test.sqlite');
  let db = await openStorage({ databasePath });
  t.after(async () => { if (db) await db.close(); await rm(directory, { recursive: true, force: true }); });
  const id = await owner(db);
  const bytes = Buffer.from('%PDF-1.4\n% storage contract\n%%EOF');
  await db.prepare('INSERT INTO prescriptions(id,session_id,name,mime,size,created_at,content) VALUES (?,?,?,?,?,?,?)')
    .run('persistent-file', id, 'persistent.pdf', 'application/pdf', bytes.length, new Date().toISOString(), bytes);
  await db.close();
  db = await openStorage({ databasePath });
  assert.equal((await snapshotAsync(db, id)).prescriptions[0].id, 'persistent-file');
  assert.deepEqual(Buffer.from((await db.prepare('SELECT content FROM prescriptions WHERE id = ?').get('persistent-file')).content), bytes);
});

test('nested transaction rollback preserves the outer transaction and storage close is idempotent', async t => {
  const { db } = await sqlite(t);
  const id = await owner(db);
  await transactionAsync(db, async () => {
    await db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?)').run(id, 1, 2);
    await assert.rejects(transactionAsync(db, async () => {
      await db.prepare('UPDATE cart SET quantity = ? WHERE session_id = ?').run(9, id);
      throw new Error('nested rollback');
    }), /nested rollback/);
    assert.equal((await db.prepare('SELECT quantity FROM cart WHERE session_id = ?').get(id)).quantity, 2);
    await db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?)').run(id, 2, 1);
  });
  assert.deepEqual((await snapshotAsync(db, id)).cart, { 1: 2, 2: 1 });
  await db.close();
  await db.close();
  await assert.rejects(db.prepare('SELECT id FROM sessions').all(), /closed/i);
});

test('Postgres SQL translation preserves literals and comments while binding only executable placeholders', () => {
  const original = "SELECT '?' AS literal, $$dollar ? literal$$ AS body, doctor_id AS doctorId FROM appointments WHERE patient = ? /* ignored ? */ AND time = ? -- trailing ?\n";
  const translated = translateSql(original);
  assert.match(translated, /SELECT '\?' AS literal/);
  assert.ok(translated.includes('$$dollar ? literal$$'));
  assert.ok(translated.includes('/* ignored ? */'));
  assert.ok(translated.includes('-- trailing ?'));
  assert.ok(translated.includes('doctor_id AS "doctorId"'));
  assert.ok(translated.includes('patient = $1'));
  assert.ok(translated.includes('time = $2'));
  assert.ok(!translated.includes('$3'));
});

test('Postgres SQL translation retains insert-ignore, scalar cart caps, and inserted owner IDs', () => {
  assert.equal(translateSql('INSERT OR IGNORE INTO products(id,data) VALUES (?,?);'), 'INSERT INTO products(id,data) VALUES ($1,$2) ON CONFLICT DO NOTHING');
  assert.equal(translateSql('INSERT INTO sessions(token_hash,expires_at) VALUES (?,?)'), 'INSERT INTO sessions(token_hash,expires_at) VALUES ($1,$2) RETURNING id');
  const upsert = translateSql('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?) ON CONFLICT(session_id,product_id) DO UPDATE SET quantity = MIN(99, cart.quantity + excluded.quantity)');
  assert.ok(upsert.includes('VALUES ($1,$2,$3)'));
  assert.ok(upsert.includes('quantity = LEAST(99, cart.quantity + excluded.quantity)'));
});

// Postgres tests are opt-in and never use the application's DATABASE_URL.
// They create their own random schema, set search_path to it, and drop only
// that schema during cleanup. A hosted production schema is never addressed.
async function postgres(t) {
  const { Pool } = await import('pg');
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'TEST_DATABASE_URL must explicitly opt into hosted tests');
  const schema = `osudh24_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set('options', `-csearch_path=${schema}`);
  let db;
  t.after(async () => {
    if (db) await db.close();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });
  db = await openStorage({ databaseUrl: scoped.toString(), schema });
  return { db };
}

const postgresOptions = { skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL to run isolated hosted Postgres tests' };

test('Postgres adapter uses the same inserted-ID and snapshot contract in an isolated schema', postgresOptions, t => storageContract(t, postgres));

test('Postgres preserves binary uploads, order insertion order, upserts, and rollback semantics', postgresOptions, async t => {
  const { db } = await postgres(t);
  const id = await owner(db);
  const stamp = new Date().toISOString();
  const content = Buffer.from([0, 255, 1, 128, 65, 66, 67]);
  await db.prepare('INSERT INTO prescriptions(id,session_id,name,mime,size,created_at,content) VALUES (?,?,?,?,?,?,?)')
    .run('pg-file', id, 'binary.pdf', 'application/pdf', content.length, stamp, content);
  assert.deepEqual(Buffer.from((await db.prepare('SELECT content FROM prescriptions WHERE id = ?').get('pg-file')).content), content);
  for (const orderId of ['pg-order-first', 'pg-order-second']) {
    const order = { id: orderId, date: stamp, items: [], total: 0, status: 'Cancelled', address: 'Storage test' };
    await db.prepare('INSERT INTO orders(id,session_id,idempotency_key,request_hash,data,created_at) VALUES (?,?,?,?,?,?)')
      .run(orderId, id, `${orderId}-key`, `${orderId}-hash`, JSON.stringify(order), stamp);
  }
  assert.deepEqual((await snapshotAsync(db, id)).orders.map(order => order.id), ['pg-order-second', 'pg-order-first']);
  await db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?)').run(id, 1, 98);
  await db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?) ON CONFLICT(session_id,product_id) DO UPDATE SET quantity = MIN(99, cart.quantity + excluded.quantity)').run(id, 1, 4);
  assert.equal((await snapshotAsync(db, id)).cart[1], 99);
  await assert.rejects(transactionAsync(db, async () => {
    await db.prepare('UPDATE cart SET quantity = ? WHERE session_id = ?').run(3, id);
    await db.prepare('INSERT INTO orders(id,session_id,idempotency_key,request_hash,data,created_at) VALUES (?,?,?,?,?,?)')
      .run('pg-colliding-order', id, 'pg-order-first-key', 'duplicate-hash', '{}', stamp);
  }));
  assert.equal((await snapshotAsync(db, id)).cart[1], 99);
  assert.equal((await snapshotAsync(db, id)).orders.length, 2);
});
