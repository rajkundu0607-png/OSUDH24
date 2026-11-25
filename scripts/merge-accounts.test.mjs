import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from '../server/database.mjs';

const script = fileURLToPath(new URL('./merge-accounts.mjs', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'osudh24-merge-cli-'));
  const databasePath = join(directory, 'account.sqlite');
  const db = openDatabase(databasePath);
  db.prepare('INSERT INTO sessions(id,token_hash,expires_at,profile) VALUES (?,?,?,?)').run(1, 'fake-google-owner', 123, '{"name":"Google original"}');
  db.prepare('INSERT INTO sessions(id,token_hash,expires_at,profile) VALUES (?,?,?,?)').run(2, 'fake-mobile-owner', 123, '{"name":"Mobile original","city":"Kolkata"}');
  const user = db.prepare('INSERT INTO users(id,owner_id,name,email,phone,created_at) VALUES (?,?,?,?,?,?)');
  user.run('google-user', 1, 'Google Owner', 'owner@example.test', null, 1);
  user.run('mobile-user', 2, '', null, '+919876543210', 2);
  const identity = db.prepare('INSERT INTO auth_identities(provider,subject,user_id) VALUES (?,?,?)');
  identity.run('google', 'verified-google-subject', 'google-user');
  identity.run('mobile', '919876543210', 'mobile-user');
  db.close();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const args = ['--database', databasePath, '--google-email', 'owner@example.test', '--mobile', '+919876543210'];
  const read = () => new DatabaseSync(databasePath, { readOnly: true });
  return { directory, databasePath, args, read };
}

test('administrative merge CLI previews without writes, backs up both originals, and is idempotent', async t => {
  const f = await fixture(t);
  const preview = JSON.parse(execFileSync(process.execPath, [script, ...f.args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.profileConflicts, ['name']);
  assert.ok(!(await readdir(f.directory)).includes('backups'));
  let db = f.read();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  db.close();

  const applied = JSON.parse(execFileSync(process.execPath, [script, ...f.args, '--apply'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(applied.merged, true);
  assert.equal((await stat(applied.backupPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.directory, 'backups'))).mode & 0o777, 0o700);
  const backup = new DatabaseSync(applied.backupPath, { readOnly: true });
  assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  assert.equal(JSON.parse(backup.prepare('SELECT profile FROM sessions WHERE id=2').get().profile).name, 'Mobile original');
  backup.close();
  db = f.read();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM auth_identities').get().n, 1);
  assert.deepEqual(JSON.parse(db.prepare('SELECT profile FROM sessions WHERE id=1').get().profile), { name: 'Google original', city: 'Kolkata' });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
  const repeated = JSON.parse(execFileSync(process.execPath, [script, ...f.args, '--apply'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(repeated.alreadyMerged, true);
  assert.equal((await readdir(join(f.directory, 'backups'))).length, 1);
});

test('backup failure prevents administrative merging', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'backups'), 'A file prevents creating the backup directory.', { mode: 0o600 });
  const result = spawnSync(process.execPath, [script, ...f.args, '--apply'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  const db = f.read();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM auth_identities').get().n, 2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});
