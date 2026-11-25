import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from './database.mjs';
import { createApp } from './app.mjs';
import { planGoogleMobileMerge, mergeGoogleAndMobileAccounts } from './account-merge.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const tableNames = ['sessions', 'users', 'auth_identities', 'browser_sessions', 'cart', 'orders', 'appointments', 'prescriptions', 'otp_challenges', 'widget_token_uses'];
const plain = value => JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? Buffer.from(item).toString('base64') : item));
const rows = (db, table) => plain(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const fingerprint = db => JSON.stringify(Object.fromEntries(tableNames.map(table => [table, rows(db, table)])));

function seedAccounts(db, now = Date.now()) {
  const targetProfile = { name: 'Google Contact Name', email: 'google-contact@example.test', phone: '', address: '', city: 'Kolkata', pin: '' };
  const sourceProfile = { name: 'Mobile Contact Name', email: 'mobile-contact@example.test', phone: '9876543210', address: '42 Source Street', city: 'Delhi', pin: '110001' };
  const owner = (label, profile, pin = '', newsletter = '') => Number(db.prepare('INSERT INTO sessions(token_hash,expires_at,profile,location_pin,newsletter_email) VALUES (?,?,?,?,?)')
    .run(sha256(`${label}-old-cookie`), Math.floor(now / 1000) + 86400, JSON.stringify(profile), pin, newsletter).lastInsertRowid);
  const googleOwner = owner('google', targetProfile, '', 'google-news@example.test');
  const mobileOwner = owner('mobile', sourceProfile, '110001', 'mobile-news@example.test');
  const otherOwner = owner('unrelated', { name: 'Unrelated Customer' });
  db.prepare('INSERT INTO users(id,owner_id,name,email,phone,created_at) VALUES (?,?,?,?,?,?)')
    .run('google-user', googleOwner, 'Google Verified Name', 'verified-google@example.test', null, now - 10000);
  db.prepare('INSERT INTO users(id,owner_id,name,email,phone,created_at) VALUES (?,?,?,?,?,?)')
    .run('mobile-user', mobileOwner, 'Mobile Verified Name', null, '+919876543210', now - 5000);
  db.prepare('INSERT INTO users(id,owner_id,name,email,phone,created_at) VALUES (?,?,?,?,?,?)')
    .run('unrelated-user', otherOwner, 'Other Verified Name', 'other@example.test', null, now);
  for (const [provider, subject, user] of [
    ['google', 'google-firebase-uid', 'google-user'], ['mobile', '919876543210', 'mobile-user'], ['google', 'unrelated-firebase-uid', 'unrelated-user'],
  ]) db.prepare('INSERT INTO auth_identities(provider,subject,user_id) VALUES (?,?,?)').run(provider, subject, user);

  const browser = (id, ownerId, userId, secret) => db.prepare('INSERT INTO browser_sessions(id,owner_id,user_id,token_hash,expires_at) VALUES (?,?,?,?,?)')
    .run(id, ownerId, userId, sha256(secret), now + 86400_000);
  browser('google-browser', googleOwner, 'google-user', 'google-browser-secret');
  browser('mobile-browser', mobileOwner, 'mobile-user', 'mobile-browser-secret');
  browser('mobile-second-browser', mobileOwner, 'mobile-user', 'mobile-second-browser-secret');
  browser('google-guest-browser', googleOwner, null, 'google-guest-secret');
  browser('mobile-guest-browser', mobileOwner, null, 'mobile-guest-secret');
  browser('unrelated-browser', otherOwner, 'unrelated-user', 'unrelated-browser-secret');
  for (const [ownerId, id, quantity] of [[googleOwner, 1, 2], [googleOwner, 2, 1], [mobileOwner, 1, 3], [mobileOwner, 3, 4], [otherOwner, 4, 2]]) {
    db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES (?,?,?)').run(ownerId, id, quantity);
  }
  const addOrder = (id, ownerId, key) => {
    const order = {
      id, date: new Date(now).toISOString(), items: [{ name: 'Daily multivitamin', quantity: 1, price: 299 }],
      subtotal: 299, discount: 0, shipping: 49, total: 348, status: 'Demo placed', address: `${id} preserved address`,
    };
    db.prepare('INSERT INTO orders(id,session_id,idempotency_key,request_hash,data,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, ownerId, key, sha256(`request-${id}`), JSON.stringify(order), order.date);
  };
  addOrder('DEMO-GOOGLE', googleOwner, 'same-idempotency-key');
  addOrder('DEMO-MOBILE', mobileOwner, 'same-idempotency-key');
  addOrder('DEMO-MOBILE-UNIQUE', mobileOwner, 'mobile-unique-key');
  addOrder('DEMO-UNRELATED', otherOwner, 'unrelated-key');
  for (const [id, ownerId, doctor, time, status] of [
    ['APT-GOOGLE', googleOwner, 'ananya', '10:00', 'Booked'],
    ['APT-MOBILE', mobileOwner, 'rohan', '11:30', 'Booked'],
    ['APT-MOBILE-CANCELLED', mobileOwner, 'ishita', '14:00', 'Cancelled'],
    ['APT-UNRELATED', otherOwner, 'arjun', '16:30', 'Booked'],
  ]) db.prepare('INSERT INTO appointments(id,session_id,doctor_id,patient,date,time,fee,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, ownerId, doctor, `${id} Patient`, '2030-01-02', time, 499, status, new Date(now).toISOString());
  for (const [id, ownerId] of [['FILE-GOOGLE', googleOwner], ['FILE-MOBILE', mobileOwner], ['FILE-UNRELATED', otherOwner]]) {
    const bytes = Buffer.from(`%PDF-1.4\n% ${id} private bytes\n%%EOF`);
    db.prepare('INSERT INTO prescriptions(id,session_id,name,mime,size,created_at,content) VALUES (?,?,?,?,?,?,?)')
      .run(id, ownerId, `${id}.pdf`, 'application/pdf', bytes.length, new Date(now).toISOString(), bytes);
  }
  for (const [id, browserId, status] of [
    ['otp-google', 'google-browser', 'pending'], ['otp-mobile', 'mobile-browser', 'verifying'],
    ['otp-google-guest', 'google-guest-browser', 'sending'], ['otp-mobile-guest', 'mobile-guest-browser', 'pending'],
    ['otp-unrelated', 'unrelated-browser', 'pending'],
  ]) db.prepare('INSERT INTO otp_challenges(id,browser_id,mobile,mode,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, browserId, '919876543210', 'link', now + 300000, status, now);
  for (const [token, browserId, status] of [
    ['widget-google', 'google-browser', 'verifying'], ['widget-mobile', 'mobile-browser', 'verifying'],
    ['widget-google-guest', 'google-guest-browser', 'verifying'], ['widget-mobile-guest', 'mobile-guest-browser', 'verifying'],
    ['widget-consumed', 'google-browser', 'consumed'], ['widget-unrelated', 'unrelated-browser', 'verifying'],
  ]) db.prepare('INSERT INTO widget_token_uses(token_hash,browser_id,created_at,expires_at,status) VALUES (?,?,?,?,?)')
    .run(sha256(token), browserId, now, now + 86400_000, status);
  return { googleOwner, mobileOwner, otherOwner, targetProfile, sourceProfile, now };
}

function database(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return { db, ...seedAccounts(db) };
}

const mergeOptions = { googleUserId: 'google-user', mobileUserId: 'mobile-user' };

test('merge plan is read-only and requires a Google-only target plus a mobile-only source', t => {
  const { db } = database(t);
  const before = fingerprint(db);
  assert.ok(planGoogleMobileMerge(db, mergeOptions));
  assert.equal(fingerprint(db), before);
  for (const options of [
    { googleUserId: '', mobileUserId: 'mobile-user' },
    { googleUserId: 'missing-user', mobileUserId: 'mobile-user' },
    { googleUserId: 'google-user', mobileUserId: 'missing-user' },
    { googleUserId: 'mobile-user', mobileUserId: 'google-user' },
    { googleUserId: 'google-user', mobileUserId: 'google-user' },
  ]) {
    assert.throws(() => mergeGoogleAndMobileAccounts(db, options), JSON.stringify(options));
    assert.equal(fingerprint(db), before);
  }
});

test('an account with an already-linked provider cannot be merged into a different account', async t => {
  for (const addProviderTo of ['google-user', 'mobile-user']) {
    await t.test(addProviderTo, subtest => {
      const { db } = database(subtest);
      const provider = addProviderTo === 'google-user' ? 'mobile' : 'google';
      const subject = provider === 'mobile' ? '919999999999' : 'another-google-firebase-uid';
      db.prepare('INSERT INTO auth_identities(provider,subject,user_id) VALUES (?,?,?)').run(provider, subject, addProviderTo);
      const before = fingerprint(db);
      assert.throws(() => planGoogleMobileMerge(db, mergeOptions));
      assert.throws(() => mergeGoogleAndMobileAccounts(db, mergeOptions));
      assert.equal(fingerprint(db), before);
    });
  }
});

test('merge preserves records, identities, verified metadata, carts and profile precedence', t => {
  const { db, googleOwner, mobileOwner, otherOwner, targetProfile, sourceProfile, now } = database(t);
  const beforeOrders = rows(db, 'orders');
  const beforeAppointments = rows(db, 'appointments');
  const beforeFiles = rows(db, 'prescriptions');
  mergeGoogleAndMobileAccounts(db, { ...mergeOptions, now });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get('google-user');
  assert.equal(user.owner_id, googleOwner);
  assert.equal(user.name, 'Google Verified Name');
  assert.equal(user.email, 'verified-google@example.test');
  assert.equal(user.phone, '+919876543210');
  assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get('mobile-user'), undefined);
  assert.equal(db.prepare('SELECT id FROM sessions WHERE id = ?').get(mobileOwner), undefined);
  assert.deepEqual(plain(db.prepare('SELECT provider,subject FROM auth_identities WHERE user_id = ? ORDER BY provider').all('google-user')), [
    { provider: 'google', subject: 'google-firebase-uid' }, { provider: 'mobile', subject: '919876543210' },
  ]);
  const owner = db.prepare('SELECT * FROM sessions WHERE id = ?').get(googleOwner);
  assert.deepEqual(JSON.parse(owner.profile), {
    ...sourceProfile, ...targetProfile, phone: sourceProfile.phone, address: sourceProfile.address, pin: sourceProfile.pin,
  });
  assert.equal(owner.location_pin, '110001');
  assert.equal(owner.newsletter_email, 'google-news@example.test');
  assert.deepEqual(plain(db.prepare('SELECT product_id,quantity FROM cart WHERE session_id = ? ORDER BY product_id').all(googleOwner)), [
    { product_id: 1, quantity: 5 }, { product_id: 2, quantity: 1 }, { product_id: 3, quantity: 4 },
  ]);
  for (const row of rows(db, 'orders')) {
    const previous = beforeOrders.find(item => item.id === row.id);
    assert.ok(previous);
    assert.equal(row.data, previous.data);
    assert.equal(row.request_hash, previous.request_hash);
    assert.equal(row.created_at, previous.created_at);
    assert.equal(row.session_id, previous.session_id === mobileOwner ? googleOwner : previous.session_id);
    if (row.id !== 'DEMO-MOBILE') assert.equal(row.idempotency_key, previous.idempotency_key);
  }
  assert.equal(rows(db, 'orders').length, beforeOrders.length);
  assert.notEqual(db.prepare('SELECT idempotency_key FROM orders WHERE id = ?').get('DEMO-MOBILE').idempotency_key, 'same-idempotency-key');
  assert.deepEqual(rows(db, 'appointments'), beforeAppointments.map(row => ({ ...row, session_id: row.session_id === mobileOwner ? googleOwner : row.session_id })));
  assert.deepEqual(rows(db, 'prescriptions'), beforeFiles.map(row => ({ ...row, session_id: row.session_id === mobileOwner ? googleOwner : row.session_id })));
  assert.equal(db.prepare('SELECT owner_id FROM users WHERE id = ?').get('unrelated-user').owner_id, otherOwner);
  assert.deepEqual(plain(db.prepare('PRAGMA foreign_key_check').all()), []);
});

test('merge keeps browser hashes stable, moves source sign-ins, and invalidates pending authorizations', t => {
  const { db, googleOwner, now } = database(t);
  const before = rows(db, 'browser_sessions');
  const unrelatedOtp = plain(db.prepare('SELECT * FROM otp_challenges WHERE id = ?').get('otp-unrelated'));
  mergeGoogleAndMobileAccounts(db, { ...mergeOptions, now });
  for (const id of ['google-browser', 'mobile-browser', 'mobile-second-browser']) {
    const row = db.prepare('SELECT * FROM browser_sessions WHERE id = ?').get(id);
    const previous = before.find(item => item.id === id);
    assert.equal(row.owner_id, googleOwner);
    assert.equal(row.user_id, 'google-user');
    assert.equal(row.token_hash, previous.token_hash);
    assert.equal(row.expires_at, previous.expires_at);
  }
  assert.equal(db.prepare('SELECT id FROM browser_sessions WHERE id = ?').get('google-guest-browser'), undefined);
  assert.equal(db.prepare('SELECT id FROM browser_sessions WHERE id = ?').get('mobile-guest-browser'), undefined);
  assert.deepEqual(plain(db.prepare('SELECT * FROM browser_sessions WHERE id = ?').get('unrelated-browser')), before.find(row => row.id === 'unrelated-browser'));
  assert.deepEqual(plain(db.prepare("SELECT id FROM otp_challenges WHERE browser_id IN ('google-browser','mobile-browser','mobile-second-browser','google-guest-browser','mobile-guest-browser') AND status IN ('sending','pending','verifying')").all()), []);
  assert.deepEqual(plain(db.prepare('SELECT * FROM otp_challenges WHERE id = ?').get('otp-unrelated')), unrelatedOtp);
  for (const token of ['widget-google', 'widget-mobile', 'widget-google-guest', 'widget-mobile-guest']) {
    assert.equal(db.prepare('SELECT status FROM widget_token_uses WHERE token_hash = ?').get(sha256(token)).status, 'failed');
  }
  assert.equal(db.prepare('SELECT status FROM widget_token_uses WHERE token_hash = ?').get(sha256('widget-consumed')).status, 'consumed');
  assert.equal(db.prepare('SELECT status FROM widget_token_uses WHERE token_hash = ?').get(sha256('widget-unrelated')).status, 'verifying');
  assert.deepEqual(plain(db.prepare('PRAGMA foreign_key_check').all()), []);
});

test('blank verified target names are filled from the mobile account without replacing Google email', t => {
  const { db } = database(t);
  db.prepare("UPDATE users SET name = '' WHERE id = 'google-user'").run();
  mergeGoogleAndMobileAccounts(db, mergeOptions);
  const user = db.prepare("SELECT name,email,phone FROM users WHERE id = 'google-user'").get();
  assert.equal(user.name, 'Mobile Verified Name');
  assert.equal(user.email, 'verified-google@example.test');
  assert.equal(user.phone, '+919876543210');
});

test('cart overflow rejects the merge and leaves every record unchanged', t => {
  const { db, googleOwner } = database(t);
  db.prepare('UPDATE cart SET quantity = 98 WHERE session_id = ? AND product_id = 1').run(googleOwner);
  const before = fingerprint(db);
  assert.throws(() => planGoogleMobileMerge(db, mergeOptions));
  assert.equal(fingerprint(db), before);
  assert.throws(() => mergeGoogleAndMobileAccounts(db, mergeOptions));
  assert.equal(fingerprint(db), before);
  assert.deepEqual(plain(db.prepare('PRAGMA foreign_key_check').all()), []);
});

test('a failure after record movement rolls back all account, session, and history changes', t => {
  const { db, mobileOwner } = database(t);
  db.exec(`CREATE TRIGGER reject_test_prescription_move BEFORE UPDATE OF session_id ON prescriptions
    WHEN OLD.session_id = ${mobileOwner} BEGIN SELECT RAISE(ABORT, 'injected merge failure'); END;`);
  const before = fingerprint(db);
  assert.throws(() => mergeGoogleAndMobileAccounts(db, mergeOptions), /injected merge failure/);
  assert.equal(fingerprint(db), before);
  assert.deepEqual(plain(db.prepare('PRAGMA foreign_key_check').all()), []);
});

test('calling merge for the same already-linked canonical account is an idempotent no-op', t => {
  const { db } = database(t);
  mergeGoogleAndMobileAccounts(db, mergeOptions);
  const before = fingerprint(db);
  const sameAccount = { googleUserId: 'google-user', mobileUserId: 'google-user' };
  assert.ok(planGoogleMobileMerge(db, sameAccount));
  mergeGoogleAndMobileAccounts(db, sameAccount);
  assert.equal(fingerprint(db), before);
});

test('Google and widget sign-ins restore the merged account and existing source cookies remain scoped safely', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'osudh24-merge-http-test-'));
  const databasePath = join(directory, 'test.sqlite');
  const now = Date.now();
  let app;
  let base;
  let googleId;
  let mobileId;
  const providers = {
    google: { verifyIdToken: async () => ({ uid: 'merge-firebase-uid', email: 'merge-google@example.test', email_verified: true, name: 'Merge Google', auth_time: Math.floor(now / 1000), firebase: { sign_in_provider: 'google.com' } }) },
    widget: { verifyAccessToken: async () => '919876543210' },
  };
  async function start() {
    app = createApp({ databasePath, distPath: join(directory, 'no-frontend'), authProviders: providers, now: () => now });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function stop() { if (app) { const previous = app; app = undefined; await previous.close(); } }
  function client() {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(path, { method = 'GET', body, headers = {} } = {}) {
        const response = await fetch(`${base}${path}`, {
          method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        for (const value of response.headers.getSetCookie()) if (value.startsWith('osudh24_session=')) cookie = value.split(';')[0];
        const bytes = Buffer.from(await response.arrayBuffer());
        const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString()) : null;
        return { status: response.status, data, bytes };
      },
      async state() { return ok(await this.request('/api/bootstrap')); },
    };
  }
  const ok = result => {
    assert.ok(result.status >= 200 && result.status < 300, `HTTP ${result.status}: ${JSON.stringify(result.data)}`);
    return result.data;
  };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  await start();
  const google = client();
  const mobile = client();
  const contact = { name: 'Merge Customer', email: 'merge-google@example.test', phone: '9876543210', address: '42 Merge Street', city: 'Kolkata', pin: '700001' };
  googleId = ok(await google.request('/api/auth/google', { method: 'POST', body: { idToken: 'fake-google-id-token' } })).state.auth.user.id;
  ok(await google.request('/api/profile', { method: 'PUT', body: contact }));
  // Matching an editable profile phone must not link an identity before the
  // explicit account merge has been requested and applied.
  mobileId = ok(await mobile.request('/api/auth/msg91', { method: 'POST', body: { accessToken: 'fake-widget-merge-token-first' } })).state.auth.user.id;
  assert.notEqual(googleId, mobileId);
  assert.equal((await mobile.state()).profile.email, '');
  ok(await mobile.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 1 } }));
  const order = ok(await mobile.request('/api/orders', { method: 'POST', body: { profile: contact, coupon: '' }, headers: { 'Idempotency-Key': 'merge-http-checkout' } })).order;
  const oldMobileCookie = mobile.cookie;
  await stop();
  const db = openDatabase(databasePath);
  try { mergeGoogleAndMobileAccounts(db, { googleUserId: googleId, mobileUserId: mobileId, now }); }
  finally { db.close(); }
  await start();

  const existingMobile = await mobile.state();
  assert.equal(mobile.cookie, oldMobileCookie);
  assert.equal(existingMobile.auth.user.id, googleId);
  assert.deepEqual(existingMobile.auth.user.providers.sort(), ['google', 'mobile']);
  assert.equal(existingMobile.orders[0].id, order.id);
  assert.equal((await mobile.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 2 }, headers: { 'X-Account-Id': mobileId } })).status, 401);
  assert.deepEqual((await mobile.state()).cart, {});
  ok(await mobile.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 2 }, headers: { 'X-Account-Id': googleId } }));
  const googleAgain = client();
  const googleState = ok(await googleAgain.request('/api/auth/google', { method: 'POST', body: { idToken: 'fake-google-id-token' } })).state;
  const mobileAgain = client();
  const mobileState = ok(await mobileAgain.request('/api/auth/msg91', { method: 'POST', body: { accessToken: 'fake-widget-merge-token-second' } })).state;
  assert.equal(googleState.auth.user.id, googleId);
  assert.equal(mobileState.auth.user.id, googleId);
  assert.deepEqual(googleState.orders, mobileState.orders);
  assert.equal(googleState.orders[0].id, order.id);
  assert.equal(googleState.cart[1], 2);
  assert.equal(mobileState.cart[1], 2);
  assert.deepEqual((await google.state()).orders, mobileState.orders);
});
