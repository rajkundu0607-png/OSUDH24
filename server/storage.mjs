import { AsyncLocalStorage } from 'node:async_hooks';
import { openDatabase } from './database.mjs';
import { products, doctors, emptyProfile, appointmentDates, appointmentTimes } from './catalog.mjs';
import { postgresSchema } from './postgres-schema.mjs';

// Split SQL into executable segments and quoted/comment segments. Rewriting
// only executable segments keeps question marks in names, strings, JSON and
// comments intact, including PostgreSQL dollar-quoted strings.
function sqlSegments(sql) {
  const segments = [];
  let start = 0;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    let end;
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      const closing = character === '[' ? ']' : character;
      end = index + 1;
      while (end < sql.length) {
        if (sql[end] === closing) {
          if (sql[end + 1] === closing) { end += 2; continue; }
          end += 1;
          break;
        }
        // PostgreSQL E'...' strings permit backslash-escaped quotes.
        if (character === "'" && /[eE]/.test(sql[index - 1] || '') && sql[end] === '\\') end += 2;
        else end += 1;
      }
    } else if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2);
      end = newline === -1 ? sql.length : newline + 1;
    } else if (sql.startsWith('/*', index)) {
      end = index + 2;
      let depth = 1;
      while (end < sql.length && depth) {
        if (sql.startsWith('/*', end)) { depth += 1; end += 2; }
        else if (sql.startsWith('*/', end)) { depth -= 1; end += 2; }
        else end += 1;
      }
    } else if (character === '$') {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if (delimiter) {
        const closing = sql.indexOf(delimiter, index + delimiter.length);
        end = closing === -1 ? sql.length : closing + delimiter.length;
      }
    }
    if (end !== undefined) {
      if (index > start) segments.push({ code: true, text: sql.slice(start, index) });
      segments.push({ code: false, text: sql.slice(index, end) });
      index = end;
      start = end;
    } else index += 1;
  }
  if (start < sql.length) segments.push({ code: true, text: sql.slice(start) });
  return segments;
}

export function translateSql(sql) {
  let parameter = 0;
  let ignoredInsert = false;
  const segments = sqlSegments(sql);
  const translated = segments.map(segment => {
    if (!segment.code) return segment.text;
    return segment.text
      .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, () => { ignoredInsert = true; return 'INSERT INTO'; })
      .replace(/\bMIN\s*\(\s*99\s*,/gi, 'LEAST(99,')
      .replace(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi, (match, alias) => /[a-z]/.test(alias) && /[A-Z]/.test(alias) ? `AS "${alias}"` : match)
      .replace(/\?/g, () => `$${++parameter}`);
  }).join('');
  let result = translated.trim().replace(/;\s*$/, '');
  if (ignoredInsert && !/\bON\s+CONFLICT\b/i.test(segments.filter(segment => segment.code).map(segment => segment.text).join(' '))) result += ' ON CONFLICT DO NOTHING';
  if (/^INSERT\s+INTO\s+sessions\s*\(/i.test(result) && !/\bRETURNING\b/i.test(result)) result += ' RETURNING id';
  return result;
}

function sqliteStorage(raw) {
  const context = new AsyncLocalStorage();
  let tail = Promise.resolve();
  let closing;
  let closed = false;
  let savepoint = 0;
  const adapter = { dialect: 'sqlite' };
  const active = () => {
    const state = context.getStore();
    return state?.adapter === adapter && state.active ? state : null;
  };
  function exclusive(work) {
    if (active()) return Promise.resolve().then(work);
    const result = tail.then(() => {
      const state = { adapter, active: true, transaction: false };
      return context.run(state, async () => {
        try { return await work(); }
        finally { state.active = false; }
      });
    });
    tail = result.catch(() => undefined);
    return result;
  }
  function query(work) {
    if (closed || (closing && !active())) return Promise.reject(new Error('The database is closed.'));
    return exclusive(work);
  }
  adapter.prepare = sql => ({
    get: (...values) => query(() => raw.prepare(sql).get(...values)),
    all: (...values) => query(() => raw.prepare(sql).all(...values)),
    run: (...values) => query(() => raw.prepare(sql).run(...values)),
  });
  adapter.exec = sql => query(() => raw.exec(sql));
  adapter.transaction = operation => query(async () => {
    const parent = active();
    const nested = parent.transaction;
    const name = `osudh24_${++savepoint}`;
    raw.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
    const state = { adapter, active: true, transaction: true };
    try {
      const result = await context.run(state, () => operation(adapter));
      raw.exec(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
      return result;
    } catch (error) {
      raw.exec(nested ? `ROLLBACK TO SAVEPOINT ${name}` : 'ROLLBACK');
      if (nested) raw.exec(`RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally { state.active = false; }
  });
  adapter.close = () => {
    if (!closing) closing = exclusive(() => { raw.close(); closed = true; });
    return closing;
  };
  return adapter;
}

const numericBigInt = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('PostgreSQL integer exceeds the safe JavaScript range.');
  return number;
};

async function postgresStorage({ databaseUrl, pool: suppliedPool, schema }) {
  if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid PostgreSQL schema name.');
  const pg = await import('pg');
  const { Pool, types } = pg.default;
  let connectionString = databaseUrl;
  if (databaseUrl && schema) {
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `${url.searchParams.get('options') || ''} -c search_path=${schema}`.trim());
    connectionString = url.toString();
  }
  const pool = suppliedPool || new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
    types: { getTypeParser: (oid, format) => oid === 20 && format !== 'binary' ? numericBigInt : types.getTypeParser(oid, format) },
  });
  // An idle connection can fail outside a request. Handle that event without
  // printing connection strings, credentials, SQL, or bound user values.
  pool.on?.('error', () => console.error('An idle database connection was closed.'));
  if (process.env.VERCEL && !suppliedPool) {
    const { attachDatabasePool } = await import('@vercel/functions');
    attachDatabasePool(pool);
  }
  const context = new AsyncLocalStorage();
  let closing;
  let savepoint = 0;
  const adapter = { dialect: 'postgres', pool };
  const active = () => {
    const state = context.getStore();
    return state?.adapter === adapter && state.active ? state : null;
  };
  const query = async (sql, values = []) => {
    const state = active();
    if (closing && !state) throw new Error('The database is closed.');
    return (state?.client || pool).query(translateSql(sql), values.map(value => value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value));
  };
  adapter.prepare = sql => ({
    get: async (...values) => (await query(sql, values)).rows[0],
    all: async (...values) => (await query(sql, values)).rows,
    run: async (...values) => {
      const result = !active() && /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
        ? await adapter.transaction(() => query(sql, values))
        : await query(sql, values);
      return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
    },
  });
  adapter.exec = sql => query(sql).then(() => undefined);
  adapter.transaction = async operation => {
    const parent = active();
    if (closing && !parent) throw new Error('The database is closed.');
    const client = parent?.client || await pool.connect();
    const nested = !!parent;
    const name = `osudh24_${++savepoint}`;
    const state = { adapter, client, active: true };
    try {
      await client.query(nested ? `SAVEPOINT ${name}` : 'BEGIN');
      if (!nested && schema) {
        const selected = await client.query('SELECT current_schema() AS schema');
        if (selected.rows[0]?.schema !== schema) throw new Error('PostgreSQL schema isolation could not be verified.');
      }
      if (!nested) await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 7802401)');
      const result = await context.run(state, () => operation(adapter));
      await client.query(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
      return result;
    } catch (error) {
      await client.query(nested ? `ROLLBACK TO SAVEPOINT ${name}` : 'ROLLBACK').catch(() => undefined);
      if (nested) await client.query(`RELEASE SAVEPOINT ${name}`).catch(() => undefined);
      throw error;
    } finally {
      state.active = false;
      if (!nested) client.release();
    }
  };
  adapter.close = () => { if (!closing) closing = pool.end(); return closing; };
  try {
    await adapter.transaction(async () => {
      // One DDL initializer per schema, including separate preview/test schemas.
      await query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 7802400)');
      await query(postgresSchema);
      for (const product of products) await adapter.prepare('INSERT OR IGNORE INTO products(id,data) VALUES (?,?)').run(product.id, JSON.stringify(product));
      for (const doctor of doctors) await adapter.prepare('INSERT OR IGNORE INTO doctors(id,data) VALUES (?,?)').run(doctor.id, JSON.stringify(doctor));
      await adapter.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)').run(2);
    });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  return adapter;
}

export async function openStorage({ databasePath = 'data/osudh24.sqlite', databaseUrl, pool, schema } = {}) {
  return databaseUrl || pool ? postgresStorage({ databaseUrl, pool, schema }) : sqliteStorage(openDatabase(databasePath));
}

export const transactionAsync = (db, operation) => db.transaction(operation);

export async function snapshotAsync(db, sessionId, auth = { user: null, providers: { google: false, mobile: false }, mobileMethod: null, sessionExpiresAt: null }) {
  const dates = appointmentDates();
  const [session, productRows, doctorRows, cartRows, orderRows, appointments, prescriptions, booked] = await Promise.all([
    db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId),
    db.prepare('SELECT data FROM products ORDER BY id').all(),
    db.prepare('SELECT data FROM doctors ORDER BY rowid').all(),
    db.prepare('SELECT product_id,quantity FROM cart WHERE session_id = ?').all(sessionId),
    db.prepare('SELECT data FROM orders WHERE session_id = ? ORDER BY created_at DESC,rowid DESC').all(sessionId),
    db.prepare('SELECT id,doctor_id AS doctorId,patient,date,time,fee,status FROM appointments WHERE session_id = ? ORDER BY created_at DESC,rowid DESC').all(sessionId),
    db.prepare('SELECT id,name,mime,size,created_at AS createdAt FROM prescriptions WHERE session_id = ? ORDER BY created_at DESC,rowid DESC').all(sessionId),
    db.prepare("SELECT doctor_id AS doctorId,date,time FROM appointments WHERE status = 'Booked' AND date BETWEEN ? AND ?").all(dates[0], dates.at(-1)),
  ]);
  if (!session) throw new Error('The requested profile no longer exists.');
  return {
    products: productRows.map(row => JSON.parse(row.data)),
    doctors: doctorRows.map(row => JSON.parse(row.data)),
    cart: Object.fromEntries(cartRows.map(row => [row.product_id, row.quantity])),
    profile: { ...emptyProfile, ...JSON.parse(session.profile) },
    orders: orderRows.map(row => JSON.parse(row.data)),
    appointments, prescriptions,
    availability: { dates, times: appointmentTimes, booked },
    locationPin: session.location_pin, newsletterEmail: session.newsletter_email, auth,
  };
}
