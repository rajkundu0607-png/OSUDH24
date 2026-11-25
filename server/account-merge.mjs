import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { normalizeMobile } from './phone.mjs';

// Local administration only: this module is deliberately not an HTTP route.
// The operator must establish ownership of both accounts before calling it.
export function planGoogleMobileMerge(db, { googleUserId, mobileUserId }) {
  if (typeof googleUserId !== 'string' || !googleUserId || typeof mobileUserId !== 'string' || !mobileUserId) {
    throw new Error('Select the verified Google and mobile accounts explicitly.');
  }
  const google = db.prepare('SELECT * FROM users WHERE id = ?').get(googleUserId);
  const mobile = db.prepare('SELECT * FROM users WHERE id = ?').get(mobileUserId);
  if (!google || !mobile) throw new Error('Both accounts must exist before merging.');
  const identities = id => db.prepare('SELECT provider,subject FROM auth_identities WHERE user_id = ? ORDER BY provider').all(id);
  const googleIdentities = identities(googleUserId);
  const mobileIdentities = identities(mobileUserId);
  if (googleUserId === mobileUserId) {
    if (googleIdentities.length !== 2 || !googleIdentities.some(item => item.provider === 'google') || !googleIdentities.some(item => item.provider === 'mobile')) {
      throw new Error('The selected account does not have both verified sign-in methods.');
    }
    return { alreadyMerged: true, googleUserId, mobileUserId };
  }
  if (googleIdentities.length !== 1 || googleIdentities[0].provider !== 'google'
    || mobileIdentities.length !== 1 || mobileIdentities[0].provider !== 'mobile') {
    throw new Error('Merge requires one Google-only account and one mobile-only account without conflicting sign-in identities.');
  }
  const verifiedPhone = `+${normalizeMobile(mobileIdentities[0].subject)}`;
  const owner = id => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  const googleOwner = owner(google.owner_id);
  const mobileOwner = owner(mobile.owner_id);
  if (!googleOwner || !mobileOwner || google.owner_id === mobile.owner_id) throw new Error('Account ownership is inconsistent.');
  if (db.prepare(`SELECT id FROM browser_sessions WHERE
    (user_id = ? AND owner_id != ?) OR (user_id = ? AND owner_id != ?)
    OR (owner_id IN (?,?) AND user_id IS NOT NULL AND user_id NOT IN (?,?))`).get(
    googleUserId, google.owner_id, mobileUserId, mobile.owner_id, google.owner_id, mobile.owner_id, googleUserId, mobileUserId,
  )) throw new Error('Browser ownership is inconsistent. Resolve it before merging.');

  const cart = db.prepare(`SELECT product_id,SUM(quantity) AS quantity FROM cart
    WHERE session_id IN (?,?) GROUP BY product_id ORDER BY product_id`).all(google.owner_id, mobile.owner_id);
  if (cart.some(item => item.quantity > 99)) throw new Error('The combined cart exceeds 99 of one product. Reduce its quantity before merging.');
  const targetProfile = JSON.parse(googleOwner.profile);
  const sourceProfile = JSON.parse(mobileOwner.profile);
  const filled = value => value !== undefined && value !== null && value !== '';
  const profile = { ...sourceProfile, ...Object.fromEntries(Object.entries(targetProfile).filter(([, value]) => filled(value))) };
  const profileConflicts = Object.keys(sourceProfile).filter(key => filled(sourceProfile[key]) && filled(targetProfile[key]) && sourceProfile[key] !== targetProfile[key]);
  const settingsConflicts = ['location_pin', 'newsletter_email'].filter(key => filled(googleOwner[key]) && filled(mobileOwner[key]) && googleOwner[key] !== mobileOwner[key]);
  const records = Object.fromEntries(['orders', 'appointments', 'prescriptions'].map(table => [table,
    Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(mobile.owner_id).count),
  ]));
  return {
    alreadyMerged: false, googleUserId, mobileUserId,
    googleOwnerId: google.owner_id, mobileOwnerId: mobile.owner_id,
    verifiedPhone, name: google.name || mobile.name || '', email: google.email,
    profile, profileConflicts, settingsConflicts, cart, records,
    locationPin: googleOwner.location_pin || mobileOwner.location_pin,
    newsletterEmail: googleOwner.newsletter_email || mobileOwner.newsletter_email,
    authenticatedSessionsToMove: Number(db.prepare('SELECT COUNT(*) AS count FROM browser_sessions WHERE user_id = ?').get(mobileUserId).count),
  };
}

export function mergeGoogleAndMobileAccounts(db, options) {
  return transaction(db, () => {
    const plan = planGoogleMobileMerge(db, options);
    if (plan.alreadyMerged) return { merged: false, alreadyMerged: true };
    const { googleUserId, mobileUserId, googleOwnerId, mobileOwnerId } = plan;

    // A pending verification was initiated against the old identity layout.
    // Completed token digests remain in place to retain replay protection.
    db.prepare(`DELETE FROM otp_challenges WHERE browser_id IN
      (SELECT id FROM browser_sessions WHERE owner_id IN (?,?))`).run(googleOwnerId, mobileOwnerId);
    db.prepare(`UPDATE widget_token_uses SET status = 'failed' WHERE status = 'verifying' AND browser_id IN
      (SELECT id FROM browser_sessions WHERE owner_id IN (?,?))`).run(googleOwnerId, mobileOwnerId);
    db.prepare('DELETE FROM browser_sessions WHERE owner_id IN (?,?) AND user_id IS NULL').run(googleOwnerId, mobileOwnerId);

    db.prepare('DELETE FROM cart WHERE session_id IN (?,?)').run(googleOwnerId, mobileOwnerId);
    const addCart = db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?)');
    for (const item of plan.cart) addCart.run(googleOwnerId, item.product_id, item.quantity);
    for (const order of db.prepare('SELECT id,idempotency_key FROM orders WHERE session_id = ?').all(mobileOwnerId)) {
      const collision = db.prepare('SELECT id FROM orders WHERE session_id = ? AND idempotency_key = ?').get(googleOwnerId, order.idempotency_key);
      db.prepare('UPDATE orders SET session_id = ?,idempotency_key = ? WHERE id = ?')
        .run(googleOwnerId, collision ? `merged-${randomUUID()}` : order.idempotency_key, order.id);
    }
    for (const table of ['appointments', 'prescriptions']) {
      db.prepare(`UPDATE ${table} SET session_id = ? WHERE session_id = ?`).run(googleOwnerId, mobileOwnerId);
    }
    db.prepare('UPDATE sessions SET profile = ?,location_pin = ?,newsletter_email = ? WHERE id = ?')
      .run(JSON.stringify(plan.profile), plan.locationPin, plan.newsletterEmail, googleOwnerId);
    db.prepare('UPDATE users SET name = ?,email = ?,phone = ? WHERE id = ?')
      .run(plan.name, plan.email, plan.verifiedPhone, googleUserId);
    db.prepare('UPDATE auth_identities SET user_id = ? WHERE user_id = ?').run(googleUserId, mobileUserId);
    // Explicitly authorized consolidation keeps already-authenticated devices
    // signed in. Old account headers are rejected by the existing HTTP guard.
    db.prepare('UPDATE browser_sessions SET user_id = ?,owner_id = ? WHERE user_id = ?')
      .run(googleUserId, googleOwnerId, mobileUserId);
    db.prepare('DELETE FROM users WHERE id = ?').run(mobileUserId);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(mobileOwnerId);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Account merge failed its database integrity check.');
    return {
      merged: true, alreadyMerged: false, records: plan.records,
      authenticatedSessionsMoved: plan.authenticatedSessionsToMove,
      profileConflicts: plan.profileConflicts, settingsConflicts: plan.settingsConflicts,
    };
  });
}
