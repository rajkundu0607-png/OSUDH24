import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openStorage, transactionAsync } from '../server/storage.mjs';

const durable = [
  { table: 'sessions', columns: ['id', 'token_hash', 'expires_at', 'profile', 'location_pin', 'newsletter_email'], key: ['id'] },
  { table: 'users', columns: ['id', 'owner_id', 'name', 'email', 'phone', 'created_at'], key: ['id'] },
  { table: 'auth_identities', columns: ['provider', 'subject', 'user_id'], key: ['provider', 'subject'] },
  { table: 'cart', columns: ['session_id', 'product_id', 'quantity'], key: ['session_id', 'product_id'] },
  { table: 'orders', columns: ['rowid', 'id', 'session_id', 'idempotency_key', 'request_hash', 'data', 'created_at'], key: ['id'] },
  { table: 'appointments', columns: ['rowid', 'id', 'session_id', 'doctor_id', 'patient', 'date', 'time', 'fee', 'status', 'created_at'], key: ['id'] },
  { table: 'prescriptions', columns: ['rowid', 'id', 'session_id', 'name', 'mime', 'size', 'created_at', 'content'], key: ['id'] },
];
const catalogs = [
  { table: 'products', columns: ['id', 'data'], key: ['id'] },
  { table: 'doctors', columns: ['rowid', 'id', 'data'], key: ['id'] },
];
const transient = ['browser_sessions', 'otp_challenges', 'widget_token_uses', 'auth_rate_limits'];
const targetTables = [...durable.map(item => item.table), ...transient];

export class ImportError extends Error {}

function normalized(value) {
  if (value instanceof Uint8Array) return { binary: Buffer.from(value).toString('base64') };
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new ImportError('A database integer is outside the supported safe range. Nothing was imported.');
    return number;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new ImportError('A database integer is outside the supported safe range. Nothing was imported.');
  return value;
}

function sortedRows(rows, key) {
  return [...rows].sort((left, right) => {
    for (const column of key) {
      const a = normalized(left[column]);
      const b = normalized(right[column]);
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  });
}

function recordHash(rows, spec) {
  const digest = createHash('sha256');
  for (const row of sortedRows(rows, spec.key)) {
    digest.update(JSON.stringify(spec.columns.map(column => normalized(row[column]))));
    digest.update('\n');
  }
  return digest.digest('hex');
}

function readSource(sourcePath) {
  if (!existsSync(sourcePath)) throw new ImportError('The selected SQLite source does not exist.');
  let source;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    source.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN;');
    if (source.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new ImportError('SQLite integrity validation failed. Nothing was imported.');
    if (source.prepare('PRAGMA foreign_key_check').all().length) throw new ImportError('SQLite relationships are inconsistent. Nothing was imported.');
    const rows = Object.fromEntries([...catalogs, ...durable].map(spec => [
      spec.table, source.prepare(`SELECT ${spec.columns.join(',')} FROM ${spec.table} ORDER BY rowid`).all(),
    ]));
    for (const file of rows.prescriptions) {
      if (!(file.content instanceof Uint8Array) || file.content.byteLength !== file.size) throw new ImportError('A source prescription has inconsistent file bytes. Nothing was imported.');
    }
    const excluded = Object.fromEntries(transient.map(table => [table, Number(source.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
    source.exec('COMMIT;');
    return { rows, excluded };
  } catch (cause) {
    if (cause instanceof ImportError) throw cause;
    throw new ImportError('The SQLite source could not be read or validated. Nothing was imported.', { cause });
  } finally { source?.close(); }
}

async function readTargetCounts(storage) {
  const counts = {};
  for (const table of targetTables) counts[table] = Number((await storage.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count);
  return counts;
}

async function verifyCatalog(storage, source) {
  for (const spec of catalogs) {
    const target = await storage.prepare(`SELECT ${spec.columns.join(',')} FROM ${spec.table}`).all();
    if (target.length !== source.rows[spec.table].length || recordHash(target, spec) !== recordHash(source.rows[spec.table], spec)) {
      throw new ImportError('The source catalog differs from the target catalog. Nothing was imported.');
    }
  }
}

function countsFor(source) {
  return Object.fromEntries(durable.map(spec => [spec.table, source.rows[spec.table].length]));
}

function linkedAccountCount(rows) {
  const methods = new Map();
  for (const identity of rows.auth_identities) {
    const providers = methods.get(identity.user_id) || new Set();
    providers.add(identity.provider);
    methods.set(identity.user_id, providers);
  }
  return [...methods.values()].filter(providers => providers.has('google') && providers.has('mobile')).length;
}

async function verifyImported(storage, source) {
  for (const spec of durable) {
    const target = await storage.prepare(`SELECT ${spec.columns.join(',')} FROM ${spec.table}`).all();
    if (target.length !== source.rows[spec.table].length || recordHash(target, spec) !== recordHash(source.rows[spec.table], spec)) {
      throw new ImportError('Imported records failed verification. The import was rolled back.');
    }
  }
  // Each identity's original subject and user_id participate in the exact
  // record hash above, so both sign-in methods retain their original account.
  for (const table of transient) {
    if (Number((await storage.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count) !== 0) throw new ImportError('Transient authentication records were found. The import was rolled back.');
  }
  return {
    recordHashesMatch: true,
    prescriptionBytesVerified: source.rows.prescriptions.reduce((sum, row) => sum + row.content.byteLength, 0),
    identityLinksVerified: source.rows.auth_identities.length,
    linkedAccountsVerified: linkedAccountCount(source.rows),
  };
}

async function resetSequences(storage) {
  for (const [table, column] of [['sessions', 'id'], ['orders', 'rowid'], ['appointments', 'rowid'], ['prescriptions', 'rowid']]) {
    await storage.prepare(`SELECT setval(pg_get_serial_sequence('${table}','${column}'), GREATEST(COALESCE(MAX(${column}),0),1), COALESCE(MAX(${column}),0) >= 1) FROM ${table}`).get();
  }
}

/**
 * Copies only durable account data. Use an immutable SQLite backup as source.
 * The caller owns the initialized PostgreSQL connection and its lifecycle.
 * Dry-run reads user data only; openStorage can initialize schema/catalog first.
 */
export async function importSqliteToPostgres({ sourcePath = 'data/osudh24.sqlite', storage, apply = false }) {
  if (!storage || storage.dialect !== 'postgres') throw new ImportError('Choose a PostgreSQL target for this migration.');
  const source = readSource(resolve(sourcePath));
  await verifyCatalog(storage, source);
  const sourceCounts = countsFor(source);
  const targetCounts = await readTargetCounts(storage);
  const targetEmpty = Object.values(targetCounts).every(count => count === 0);
  const summary = { sourceCounts, targetCountsBeforeImport: targetCounts, targetEmptyBeforeImport: targetEmpty, excludedAuthenticationRecords: source.excluded };
  if (!apply) return { dryRun: true, ...summary, targetEmpty };
  if (!targetEmpty) throw new ImportError('The target contains account or authentication data. Nothing was imported; overwriting and repeat imports are not allowed.');
  try {
    return await transactionAsync(storage, async () => {
      // Prevent application traffic from creating a guest/account between the
      // final emptiness check and commit. Import before enabling the deployment.
      await storage.exec(`LOCK TABLE ${targetTables.join(',')} IN ACCESS EXCLUSIVE MODE`);
      const currentCounts = await readTargetCounts(storage);
      if (Object.values(currentCounts).some(count => count !== 0)) throw new ImportError('The target changed during migration. Nothing was imported.');
      await verifyCatalog(storage, source);
      for (const spec of durable) {
        const statement = storage.prepare(`INSERT INTO ${spec.table}(${spec.columns.join(',')}) VALUES (${spec.columns.map(() => '?').join(',')})`);
        for (const row of source.rows[spec.table]) {
          await statement.run(...spec.columns.map(column => row[column] instanceof Uint8Array ? Buffer.from(row[column]) : row[column]));
        }
      }
      const verification = await verifyImported(storage, source);
      await resetSequences(storage);
      return { imported: true, ...summary, importedCounts: sourceCounts, verification };
    });
  } catch (cause) {
    if (cause instanceof ImportError) throw cause;
    throw new ImportError('The PostgreSQL import could not be completed. The data transaction was rolled back.', { cause });
  }
}

async function main() {
  let storage;
  try {
    const { values } = parseArgs({ options: {
      source: { type: 'string', default: 'data/osudh24.sqlite' },
      apply: { type: 'boolean', default: false },
    } });
    if (existsSync('.env')) process.loadEnvFile('.env');
    const databaseUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
    if (!databaseUrl) throw new ImportError('Set DIRECT_DATABASE_URL or DATABASE_URL before importing.');
    if (!existsSync(resolve(values.source))) throw new ImportError('The selected SQLite source does not exist.');
    storage = await openStorage({ databaseUrl });
    const result = await importSqliteToPostgres({ sourcePath: values.source, storage, apply: values.apply });
    console.log(JSON.stringify(result));
  } catch (cause) {
    // Provider/database errors may contain connection strings, queries or private
    // values. Print only our deliberately aggregate migration diagnostics.
    console.error(cause instanceof ImportError ? cause.message : 'Migration could not be started. Check the source, database settings and target schema.');
    process.exitCode = 1;
  } finally {
    try { await storage?.close(); }
    catch { console.error('The migration connection could not be closed cleanly.'); process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
