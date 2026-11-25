import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { products, doctors, emptyProfile, appointmentDates, appointmentTimes } from './catalog.mjs';

export function openDatabase(databasePath) {
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS doctors (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
      profile TEXT NOT NULL DEFAULT '{}', location_pin TEXT NOT NULL DEFAULT '',
      newsletter_email TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS cart (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),
      PRIMARY KEY(session_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      data TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(session_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      doctor_id TEXT NOT NULL REFERENCES doctors(id), patient TEXT NOT NULL,
      date TEXT NOT NULL, time TEXT NOT NULL, fee INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('Booked','Cancelled')), created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_appointment
      ON appointments(doctor_id,date,time) WHERE status = 'Booked';
    CREATE TABLE IF NOT EXISTS prescriptions (
      id TEXT PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
      created_at TEXT NOT NULL, content BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id),
      name TEXT NOT NULL DEFAULT '', email TEXT, phone TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_identities (
      provider TEXT NOT NULL CHECK(provider IN ('google','mobile')),
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(provider, subject), UNIQUE(user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS browser_sessions (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES sessions(id),
      user_id TEXT REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS otp_challenges (
      id TEXT PRIMARY KEY,
      browser_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
      mobile TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('login','link')),
      expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('sending','pending','verifying','consumed','failed')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      scope TEXT NOT NULL, key TEXT NOT NULL,
      window_start INTEGER NOT NULL, count INTEGER NOT NULL, last_sent INTEGER NOT NULL,
      PRIMARY KEY(scope,key)
    );
    CREATE TABLE IF NOT EXISTS widget_token_uses (
      token_hash TEXT PRIMARY KEY, browser_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('verifying','consumed','failed'))
    );
    CREATE INDEX IF NOT EXISTS widget_token_expiry ON widget_token_uses(expires_at);
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
  `);
  const seedProduct = db.prepare('INSERT OR IGNORE INTO products(id,data) VALUES (?,?)');
  const seedDoctor = db.prepare('INSERT OR IGNORE INTO doctors(id,data) VALUES (?,?)');
  transaction(db, () => {
    for (const product of products) seedProduct.run(product.id, JSON.stringify(product));
    for (const doctor of doctors) seedDoctor.run(doctor.id, JSON.stringify(doctor));
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 2').get()) {
      // Legacy sessions remain durable data owners. Separate browser sessions
      // can now expire or rotate without deleting an account's saved records.
      const migrate = db.prepare('INSERT OR IGNORE INTO browser_sessions(id,owner_id,token_hash,expires_at) VALUES (?,?,?,?)');
      for (const session of db.prepare('SELECT id,token_hash,expires_at FROM sessions').all()) {
        migrate.run(randomUUID(), session.id, session.token_hash, session.expires_at * 1000);
      }
      db.prepare('INSERT INTO schema_migrations(version) VALUES (2)').run();
    }
  });
  return db;
}

export function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function snapshot(db, sessionId, auth = { user: null, providers: { google: false, mobile: false }, mobileMethod: null, sessionExpiresAt: null }) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  return {
    products: db.prepare('SELECT data FROM products ORDER BY id').all().map(row => JSON.parse(row.data)),
    doctors: db.prepare('SELECT data FROM doctors ORDER BY rowid').all().map(row => JSON.parse(row.data)),
    cart: Object.fromEntries(db.prepare('SELECT product_id, quantity FROM cart WHERE session_id = ?').all(sessionId).map(row => [row.product_id, row.quantity])),
    profile: { ...emptyProfile, ...JSON.parse(session.profile) },
    orders: db.prepare('SELECT data FROM orders WHERE session_id = ? ORDER BY created_at DESC, rowid DESC').all(sessionId).map(row => JSON.parse(row.data)),
    appointments: db.prepare('SELECT id, doctor_id AS doctorId, patient, date, time, fee, status FROM appointments WHERE session_id = ? ORDER BY created_at DESC, rowid DESC').all(sessionId),
    prescriptions: db.prepare('SELECT id, name, mime, size, created_at AS createdAt FROM prescriptions WHERE session_id = ? ORDER BY created_at DESC, rowid DESC').all(sessionId),
    availability: {
      dates: appointmentDates(),
      times: appointmentTimes,
      booked: db.prepare("SELECT doctor_id AS doctorId, date, time FROM appointments WHERE status = 'Booked' AND date BETWEEN ? AND ?").all(appointmentDates()[0], appointmentDates().at(-1)),
    },
    locationPin: session.location_pin,
    newsletterEmail: session.newsletter_email,
    auth,
  };
}
