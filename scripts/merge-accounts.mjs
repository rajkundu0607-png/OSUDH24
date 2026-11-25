import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { normalizeMobile } from '../server/phone.mjs';
import { planGoogleMobileMerge, mergeGoogleAndMobileAccounts } from '../server/account-merge.mjs';

let db;
try {
  const { values } = parseArgs({ options: {
    database: { type: 'string', default: 'data/osudh24.sqlite' },
    'google-email': { type: 'string' }, mobile: { type: 'string' }, apply: { type: 'boolean', default: false },
  } });
  const email = values['google-email']?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !values.mobile) {
    throw new Error('Usage: node scripts/merge-accounts.mjs --google-email <verified email> --mobile <verified mobile> [--database <path>] [--apply]');
  }
  const phone = normalizeMobile(values.mobile);
  const databasePath = resolve(values.database);
  if (!existsSync(databasePath)) throw new Error('The selected database does not exist.');
  db = new DatabaseSync(databasePath, { readOnly: !values.apply });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const google = db.prepare(`SELECT u.id FROM users u JOIN auth_identities a ON a.user_id = u.id
    WHERE a.provider = 'google' AND LOWER(u.email) = ?`).all(email);
  const mobile = db.prepare("SELECT user_id AS id FROM auth_identities WHERE provider = 'mobile' AND subject = ?").get(phone);
  if (google.length !== 1 || !mobile) throw new Error('The verified account selection is missing or ambiguous. Nothing was merged.');
  const options = { googleUserId: google[0].id, mobileUserId: mobile.id };
  const plan = planGoogleMobileMerge(db, options);
  if (plan.alreadyMerged) {
    console.log(JSON.stringify({ alreadyMerged: true, signInMethods: ['google', 'mobile'] }));
  } else {
    const summary = {
      sourceRecords: plan.records, authenticatedSessionsToMove: plan.authenticatedSessionsToMove,
      profileConflicts: plan.profileConflicts, settingsConflicts: plan.settingsConflicts,
      conflictPolicy: 'Keep non-empty Google-account profile/settings; fill blanks from mobile. Backup retains both originals.',
    };
    if (!values.apply) console.log(JSON.stringify({ dryRun: true, ...summary }));
    else {
      // Stop the API before applying: the backup and merge must not race with
      // uploads or authentication requests already in progress in that process.
      const backupDirectory = join(dirname(databasePath), 'backups');
      mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      chmodSync(backupDirectory, 0o700);
      const backupPath = join(backupDirectory, `before-account-merge-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`);
      let backup;
      try {
        db.prepare('VACUUM INTO ?').run(backupPath);
        chmodSync(backupPath, 0o600);
        backup = new DatabaseSync(backupPath, { readOnly: true });
        if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed. Nothing was merged.');
      } catch (error) {
        backup?.close(); backup = undefined;
        if (existsSync(backupPath)) unlinkSync(backupPath);
        throw error;
      } finally { backup?.close(); }
      const result = mergeGoogleAndMobileAccounts(db, options);
      console.log(JSON.stringify({ ...result, backupPath, signInMethods: ['google', 'mobile'] }));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Account merge could not be completed.');
  process.exitCode = 1;
} finally { db?.close(); }
