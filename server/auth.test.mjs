import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from './app.mjs';
import { createAuthProviders } from './auth-providers.mjs';

const profile = {
  name: 'Auth Test Customer', email: 'customer@example.test', phone: '9876543210',
  address: '123 Sample Street', city: 'Kolkata', pin: '700001',
};

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'osudh24-auth-test-'));
  const databasePath = join(directory, 'test.sqlite');
  const clock = { value: Date.now() };
  const calls = { google: [], send: [], verify: [] };
  const providers = options.disabled ? {} : {
    google: {
      async verifyIdToken(token) {
        calls.google.push(token);
        if (options.verifyGoogle) return options.verifyGoogle(token, clock.value);
        if (token === 'invalid-token') throw new Error('A fake provider failure containing secret credentials');
        return {
          uid: token, name: `Verified ${token}`, email: `${token}@example.test`,
          email_verified: true, auth_time: Math.floor(clock.value / 1000),
          firebase: { sign_in_provider: 'google.com' },
        };
      },
    },
    mobile: {
      async sendOtp(mobile) {
        calls.send.push(mobile);
        if (options.sendOtp) return options.sendOtp(mobile);
      },
      async verifyOtp(mobile, otp) {
        calls.verify.push({ mobile, otp });
        return options.verifyOtp ? options.verifyOtp(mobile, otp) : otp === '123456';
      },
    },
  };
  let app;
  let base;
  if (options.beforeStart) await options.beforeStart(databasePath, clock.value);
  async function start() {
    app = createApp({ databasePath, distPath: join(directory, 'no-frontend'), authProviders: providers, now: () => clock.value });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function stop() {
    if (!app) return;
    const closing = app;
    app = undefined;
    await closing.close();
  }
  function client(initialCookie = '') {
    let cookie = initialCookie;
    return {
      get cookie() { return cookie; },
      async request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
        const requestHeaders = { ...(cookie ? { Cookie: cookie } : {}), ...headers };
        if (body !== undefined && !raw) requestHeaders['Content-Type'] = 'application/json';
        const response = await fetch(`${base}${path}`, {
          method, headers: requestHeaders,
          body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        });
        for (const setCookie of response.headers.getSetCookie()) {
          if (setCookie.startsWith('osudh24_session=')) cookie = setCookie.split(';')[0];
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        let data;
        if (response.headers.get('content-type')?.includes('application/json')) data = JSON.parse(bytes.toString());
        return { status: response.status, headers: response.headers, data, bytes };
      },
      async state() { return ok(await this.request('/api/bootstrap')); },
      async google(idToken, mode = 'login') {
        return this.request('/api/auth/google', { method: 'POST', body: { idToken, mode } });
      },
      async send(mobile = '9876543210', mode = 'login') {
        return this.request('/api/auth/otp/send', { method: 'POST', body: { mobile, mode } });
      },
      async verify(challengeId, otp = '123456') {
        return this.request('/api/auth/otp/verify', { method: 'POST', body: { challengeId, otp } });
      },
    };
  }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  await start();
  return { client, start, stop, clock, calls, databasePath };
}

function ok(result) {
  assert.ok(result.status >= 200 && result.status < 300, `HTTP ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

function rejected(result, message = 'request should be rejected') {
  assert.ok(result.status >= 400 && result.status < 500, `${message}: HTTP ${result.status} ${JSON.stringify(result.data)}`);
}

async function saveProfile(client, value = profile) {
  return ok(await client.request('/api/profile', { method: 'PUT', body: value }));
}

test('unconfigured login providers are disabled and do not enable fake authentication', async t => {
  const f = await fixture(t, { disabled: true });
  const client = f.client();
  const state = await client.state();
  assert.equal(state.auth.user, null);
  assert.equal(state.auth.sessionExpiresAt, null);
  assert.deepEqual(state.auth.providers, { google: false, mobile: false });
  assert.equal((await client.google('not-a-real-id-token')).status, 503);
  assert.equal((await client.send()).status, 503);
  assert.equal((await client.state()).auth.user, null);
});

test('guest access is restricted to public catalog, cart, location, and newsletter operations', async t => {
  const f = await fixture(t);
  const client = f.client();
  await client.state();
  ok(await client.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 1 } }));
  ok(await client.request('/api/location', { method: 'PUT', body: { pin: '700001' } }));
  ok(await client.request('/api/newsletter', { method: 'POST', body: { email: 'guest@example.test' } }));
  const protectedRequests = [
    ['/api/profile', { method: 'PUT', body: profile }],
    ['/api/profile', { method: 'DELETE' }],
    ['/api/orders', { method: 'POST', body: { profile, coupon: '' }, headers: { 'Idempotency-Key': 'guest-test-order' } }],
    ['/api/orders/unknown/cancel', { method: 'POST' }],
    ['/api/appointments', { method: 'POST', body: { doctorId: 'ananya', patient: 'Guest' } }],
    ['/api/appointments/unknown/cancel', { method: 'POST' }],
    ['/api/prescriptions', { method: 'POST', body: Buffer.from('%PDF-1.4\n'), raw: true, headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'test.pdf' } }],
    ['/api/prescriptions/unknown/file', {}],
    ['/api/prescriptions/unknown', { method: 'DELETE' }],
  ];
  for (const [path, options] of protectedRequests) {
    assert.equal((await client.request(path, options)).status, 401, path);
  }
});

test('Google sign-in requires verified recent Google claims and sanitizes provider errors', async t => {
  let claims = null;
  const f = await fixture(t, { verifyGoogle: async () => {
    if (!claims) throw new Error('private-key-must-not-leak');
    return claims;
  } });
  const client = f.client();
  await client.state();
  const failed = await client.google('rejected-token');
  assert.equal(failed.status, 401);
  assert.ok(!JSON.stringify(failed.data).includes('private-key'));
  const valid = {
    uid: 'verified-alice', email: 'alice@example.test', email_verified: true,
    name: 'Alice', auth_time: Math.floor(f.clock.value / 1000), firebase: { sign_in_provider: 'google.com' },
  };
  for (const change of [
    { uid: '' }, { email_verified: false }, { email: undefined },
    { firebase: { sign_in_provider: 'password' } },
    { auth_time: Math.floor(f.clock.value / 1000) - 301 },
    { auth_time: Math.floor(f.clock.value / 1000) + 300 },
  ]) {
    claims = { ...valid, ...change };
    assert.equal((await client.google('claims-test')).status, 401, JSON.stringify(change));
    assert.equal((await client.state()).auth.user, null);
  }
  claims = valid;
  const result = ok(await client.google('claims-test'));
  assert.equal(result.state.auth.user.email, 'alice@example.test');
  assert.ok(result.state.auth.user.providers.includes('google'));
});

test('Google login rotates cookies, restores an account on another browser, and logout revokes only its browser', async t => {
  const f = await fixture(t);
  const alice = f.client();
  await alice.state();
  const guestCookie = alice.cookie;
  ok(await alice.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 2 } }));
  const first = ok(await alice.google('alice'));
  const accountId = first.state.auth.user.id;
  assert.notEqual(alice.cookie, guestCookie);
  assert.equal(first.state.cart[1], 2);
  assert.ok(Number.isFinite(Date.parse(first.state.auth.sessionExpiresAt)));
  await saveProfile(alice);
  const authenticatedCookie = alice.cookie;

  // A fixed pre-login cookie must not become an authenticated session.
  const stolenGuest = f.client(guestCookie);
  assert.equal((await stolenGuest.state()).auth.user, null);
  assert.equal((await stolenGuest.request('/api/profile', { method: 'PUT', body: profile })).status, 401);

  const secondBrowser = f.client();
  await secondBrowser.state();
  const second = ok(await secondBrowser.google('alice'));
  assert.equal(second.state.auth.user.id, accountId);
  assert.deepEqual(second.state.profile, profile);
  assert.equal(second.state.cart[1], 2);
  const loggedOut = ok(await alice.request('/api/auth/logout', { method: 'POST' }));
  assert.equal(loggedOut.state.auth.user, null);
  assert.equal(loggedOut.state.profile.name, '');
  assert.deepEqual(loggedOut.state.cart, {});
  assert.deepEqual(loggedOut.state.orders, []);
  assert.deepEqual(loggedOut.state.prescriptions, []);
  assert.notEqual(alice.cookie, authenticatedCookie);
  assert.equal((await f.client(authenticatedCookie).state()).auth.user, null);
  assert.equal((await secondBrowser.state()).auth.user.id, accountId);
  assert.equal(ok(await alice.google('alice')).state.auth.user.id, accountId);
  assert.deepEqual((await alice.state()).profile, profile);
});

test('account data survives browser-session expiry and database restart', async t => {
  const f = await fixture(t);
  const client = f.client();
  const first = ok(await client.google('persistent-user'));
  const accountId = first.state.auth.user.id;
  await saveProfile(client);
  ok(await client.request('/api/cart/items/3', { method: 'PUT', body: { quantity: 1 } }));
  f.clock.value = Date.parse(first.state.auth.sessionExpiresAt) + 1;
  assert.equal((await client.state()).auth.user, null);
  await f.stop();
  await f.start();
  const returning = ok(await client.google('persistent-user')).state;
  assert.equal(returning.auth.user.id, accountId);
  assert.deepEqual(returning.profile, profile);
  assert.equal(returning.cart[3], 1);
});

test('editable contact fields never merge accounts and switching signed-in identities requires logout', async t => {
  const f = await fixture(t);
  const alice = f.client();
  const bob = f.client();
  const a = ok(await alice.google('alice')).state.auth.user;
  await saveProfile(alice, { ...profile, email: 'bob@example.test', phone: '9876543211' });
  const b = ok(await bob.google('bob')).state.auth.user;
  assert.notEqual(a.id, b.id);
  assert.equal((await bob.state()).profile.address, '');
  assert.equal((await alice.google('bob')).status, 409);
  assert.equal((await alice.state()).auth.user.id, a.id);
  assert.equal((await alice.state()).auth.user.email, 'alice@example.test');
  ok(await alice.request('/api/auth/logout', { method: 'POST' }));
  assert.equal(ok(await alice.google('bob')).state.auth.user.id, b.id);
  assert.equal((await alice.state()).profile.address, '');
});

test('stale account headers cannot mutate or link the account in a shared browser cookie', async t => {
  const f = await fixture(t);
  const alice = f.client();
  const bob = f.client();
  const aliceId = ok(await alice.google('alice-stale-tab')).state.auth.user.id;
  const bobId = ok(await bob.google('bob-current-tab')).state.auth.user.id;
  const staleHeaders = { 'X-Account-Id': aliceId };
  const googleCalls = f.calls.google.length;

  assert.equal((await bob.request('/api/cart/items/1', {
    method: 'PUT', body: { quantity: 3 }, headers: staleHeaders,
  })).status, 401);
  assert.equal((await bob.request('/api/profile', {
    method: 'PUT', body: profile, headers: staleHeaders,
  })).status, 401);
  assert.equal((await bob.request('/api/auth/google', {
    method: 'POST', body: { idToken: 'new-google-identity', mode: 'link' }, headers: staleHeaders,
  })).status, 401);
  assert.equal((await bob.request('/api/auth/otp/send', {
    method: 'POST', body: { mobile: '9876543210', mode: 'link' }, headers: staleHeaders,
  })).status, 401);
  assert.equal((await bob.request('/api/auth/logout', { method: 'POST', headers: staleHeaders })).status, 401);
  assert.equal(f.calls.google.length, googleCalls);
  assert.equal(f.calls.send.length, 0);
  const state = await bob.state();
  assert.equal(state.auth.user.id, bobId);
  assert.equal(state.profile.name, '');
  assert.deepEqual(state.cart, {});
  assert.deepEqual(state.auth.user.providers, ['google']);

  ok(await bob.request('/api/cart/items/1', {
    method: 'PUT', body: { quantity: 2 }, headers: { 'X-Account-Id': bobId },
  }));
  assert.equal((await bob.state()).cart[1], 2);
  assert.equal((await bob.request('/api/cart/items/1', {
    method: 'PUT', body: { quantity: 1 }, headers: { 'X-Account-Id': 'guest' },
  })).status, 401);
  const guest = f.client();
  ok(await guest.request('/api/cart/items/1', {
    method: 'PUT', body: { quantity: 1 }, headers: { 'X-Account-Id': 'guest' },
  }));
});

test('mobile sign-in consumes a browser-bound OTP challenge and restores the same verified identity', async t => {
  const f = await fixture(t);
  const alice = f.client();
  const other = f.client();
  await alice.state();
  await other.state();
  const before = alice.cookie;
  const challenge = ok(await alice.send());
  assert.equal(typeof challenge.challengeId, 'string');
  assert.ok(challenge.challengeId.length >= 16);
  assert.ok(Date.parse(challenge.expiresAt) > f.clock.value);
  assert.ok(Date.parse(challenge.expiresAt) <= f.clock.value + 5 * 60_000 + 1000);
  assert.equal(challenge.retryAfter, 60);
  assert.equal(challenge.otp, undefined);
  rejected(await other.verify(challenge.challengeId), 'challenge must be browser-bound');
  assert.equal(f.calls.verify.length, 0);
  const signedIn = ok(await alice.verify(challenge.challengeId)).state;
  assert.notEqual(alice.cookie, before);
  assert.ok(signedIn.auth.user.providers.includes('mobile'));
  assert.match(signedIn.auth.user.phone, /9876543210$/);
  assert.equal(f.calls.verify.length, 1);
  rejected(await alice.verify(challenge.challengeId), 'OTP cannot be replayed');
  assert.equal(f.calls.verify.length, 1);
  await saveProfile(alice);
  f.clock.value += 61_000;
  const anotherChallenge = ok(await other.send());
  const returning = ok(await other.verify(anotherChallenge.challengeId)).state;
  assert.equal(returning.auth.user.id, signedIn.auth.user.id);
  assert.deepEqual(returning.profile, profile);
});

test('OTP challenges expire, cap attempts, enforce six digits, and consume provider failures safely', async t => {
  const f = await fixture(t);
  const client = f.client();
  await client.state();
  const expired = ok(await client.send());
  f.clock.value += 5 * 60_000 + 1;
  rejected(await client.verify(expired.challengeId));
  assert.equal(f.calls.verify.length, 0);
  const challenge = ok(await client.send());
  rejected(await client.verify(challenge.challengeId, '12'));
  assert.equal(f.calls.verify.length, 0);
  for (let attempt = 0; attempt < 5; attempt++) rejected(await client.verify(challenge.challengeId, '000000'));
  assert.ok(f.calls.verify.length <= 5);
  const called = f.calls.verify.length;
  rejected(await client.verify(challenge.challengeId, '123456'));
  assert.equal(f.calls.verify.length, called);
  assert.equal((await client.state()).auth.user, null);
});

test('OTP resend cooldown and phone rate limits survive fresh cookies', async t => {
  const f = await fixture(t);
  const first = f.client();
  ok(await first.send());
  const fresh = f.client();
  assert.equal((await fresh.send()).status, 429);
  assert.equal(f.calls.send.length, 1);
  let blocked = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    f.clock.value += 61_000;
    const result = await f.client().send();
    if (result.status === 429) { blocked = true; break; }
    ok(result);
  }
  assert.equal(blocked, true, 'per-phone hourly rate must survive new browser sessions');
  const calls = f.calls.send.length;
  assert.equal((await f.client().send()).status, 429);
  assert.equal(f.calls.send.length, calls);
});

test('OTP send rates cap both session and IP across different phone numbers', async t => {
  const f = await fixture(t);
  const client = f.client();
  let sessionBlocked = false;
  for (let index = 0; index < 30; index++) {
    const result = await client.send(`987654${String(index).padStart(4, '0')}`);
    if (result.status === 429) { sessionBlocked = true; break; }
    ok(result);
    f.clock.value += 61_000;
  }
  assert.equal(sessionBlocked, true, 'one browser cannot send unlimited OTPs to different phones');
  let ipBlocked = false;
  for (let index = 30; index < 70; index++) {
    const result = await f.client().send(`987654${String(index).padStart(4, '0')}`);
    if (result.status === 429) { ipBlocked = true; break; }
    ok(result);
    f.clock.value += 61_000;
  }
  assert.equal(ipBlocked, true, 'fresh cookies cannot bypass the IP limit');
});

test('concurrent verification of one OTP challenge authenticates only one request', async t => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { verifyOtp: async () => { started(); await gate; return true; } });
  const client = f.client();
  const challenge = ok(await client.send());
  const concurrent = f.client(client.cookie);
  const first = client.verify(challenge.challengeId);
  await entered;
  const second = concurrent.verify(challenge.challengeId);
  // The provider has intentionally not answered the first verification yet.
  // Releasing it lets either rejection strategy finish without a timing sleep.
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(result => result.status >= 200 && result.status < 300).length, 1);
  assert.equal(f.calls.verify.length, 1);
});

test('explicit provider linking works and cannot take an identity from another account', async t => {
  const f = await fixture(t);
  const alice = f.client();
  const a = ok(await alice.google('alice')).state.auth.user;
  const oldCookie = alice.cookie;
  const link = ok(await alice.send('9876543210', 'link'));
  const linked = ok(await alice.verify(link.challengeId)).state;
  assert.notEqual(alice.cookie, oldCookie);
  assert.equal(linked.auth.user.id, a.id);
  assert.deepEqual([...linked.auth.user.providers].sort(), ['google', 'mobile']);
  const bob = f.client();
  const b = ok(await bob.google('bob')).state.auth.user;
  f.clock.value += 61_000;
  const contested = ok(await bob.send('9876543210', 'link'));
  assert.equal((await bob.verify(contested.challengeId)).status, 409);
  assert.equal((await bob.state()).auth.user.id, b.id);
  assert.deepEqual((await bob.state()).auth.user.providers, ['google']);
  const guest = f.client();
  assert.equal((await guest.google('alice', 'link')).status, 401);
  assert.equal((await guest.send('9876543211', 'link')).status, 401);
});

test('a mobile account can explicitly link Google and use either provider without merging another account', async t => {
  const f = await fixture(t);
  const client = f.client();
  const challenge = ok(await client.send());
  const first = ok(await client.verify(challenge.challengeId)).state;
  const id = first.auth.user.id;
  const linked = ok(await client.google('mobile-google-link', 'link')).state;
  assert.equal(linked.auth.user.id, id);
  assert.deepEqual([...linked.auth.user.providers].sort(), ['google', 'mobile']);
  ok(await client.request('/api/auth/logout', { method: 'POST' }));
  assert.equal(ok(await client.google('mobile-google-link')).state.auth.user.id, id);
  const separate = f.client();
  ok(await separate.google('separate-google'));
  assert.equal((await separate.google('mobile-google-link', 'link')).status, 409);
});

test('MSG91 adapters require type=success even for HTTP 200 and never expose provider text', async () => {
  const calls = [];
  const providers = createAuthProviders({
    env: { MSG91_AUTH_KEY: 'not-a-real-auth-key', MSG91_TEMPLATE_ID: 'test-template' },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ type: 'error', message: 'provider-secret-must-not-leak' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  await assert.rejects(() => providers.mobile.sendOtp('919876543210'), error => !String(error).includes('provider-secret'));
  let verified = false;
  try { verified = await providers.mobile.verifyOtp('919876543210', '123456'); }
  catch (error) { assert.ok(!String(error).includes('provider-secret')); }
  assert.equal(verified, false);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(new URL(calls[0].url).searchParams.get('mobile'), '919876543210');
  assert.equal(new URL(calls[0].url).searchParams.get('template_id'), 'test-template');
  assert.equal(calls[0].options.headers.authkey, 'not-a-real-auth-key');
  assert.ok(!calls[0].url.includes('not-a-real-auth-key'));
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(new URL(calls[1].url).pathname, '/api/v5/otp/verify');
  assert.equal(new URL(calls[1].url).searchParams.get('otp'), '123456');
  assert.equal(new URL(calls[1].url).searchParams.get('mobile'), '919876543210');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('MSG91 accepts successful provider responses and sanitizes network failures', async () => {
  const env = { MSG91_AUTH_KEY: 'fake-auth-key', MSG91_TEMPLATE_ID: 'fake-template' };
  const working = createAuthProviders({ env, fetchImpl: async () => new Response(JSON.stringify({ type: 'success' }), { status: 200 }) });
  await working.mobile.sendOtp('919876543210');
  assert.equal(await working.mobile.verifyOtp('919876543210', '123456'), true);
  const unavailable = createAuthProviders({ env, fetchImpl: async () => { throw new Error('secret-url-and-authkey'); } });
  await assert.rejects(() => unavailable.mobile.sendOtp('919876543210'), error => !String(error).includes('secret-url'));
  await assert.rejects(() => unavailable.mobile.verifyOtp('919876543210', '123456'), error => !String(error).includes('secret-url'));
});

test('legacy guest cookies and records migrate without loss and are adopted after verified login', async t => {
  const legacySecret = 'ab'.repeat(32);
  const oldOrder = {
    id: 'DEMO-LEGACY', date: new Date().toISOString(), items: [{ name: 'Daily multivitamin', quantity: 1, price: 299 }],
    subtotal: 299, discount: 0, shipping: 49, total: 348, status: 'Demo placed', address: 'Legacy address',
  };
  const f = await fixture(t, { beforeStart(databasePath, now) {
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE products (id INTEGER PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE doctors (id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE sessions (id INTEGER PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL,profile TEXT NOT NULL DEFAULT '{}',location_pin TEXT NOT NULL DEFAULT '',newsletter_email TEXT NOT NULL DEFAULT '');
      CREATE TABLE cart (session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,product_id INTEGER NOT NULL REFERENCES products(id),quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),PRIMARY KEY(session_id,product_id));
      CREATE TABLE orders (id TEXT PRIMARY KEY,session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(session_id,idempotency_key));
      CREATE TABLE appointments (id TEXT PRIMARY KEY,session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,doctor_id TEXT NOT NULL REFERENCES doctors(id),patient TEXT NOT NULL,date TEXT NOT NULL,time TEXT NOT NULL,fee INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE prescriptions (id TEXT PRIMARY KEY,session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL,content BLOB NOT NULL);
    `);
    db.prepare('INSERT INTO sessions(id,token_hash,expires_at,profile,location_pin,newsletter_email) VALUES(1,?,?,?,?,?)')
      .run(createHash('sha256').update(legacySecret).digest('hex'), Math.floor(now / 1000) + 86400, JSON.stringify(profile), '700001', 'legacy@example.test');
    db.prepare('INSERT INTO products(id,data) VALUES(?,?)').run(1, JSON.stringify({ id: 1, name: 'Daily multivitamin', price: 299 }));
    db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES(1,1,2)').run();
    db.prepare('INSERT INTO orders(id,session_id,idempotency_key,request_hash,data,created_at) VALUES(?,1,?,?,?,?)')
      .run(oldOrder.id, 'legacy-order-key', 'legacy-hash', JSON.stringify(oldOrder), oldOrder.date);
    const bytes = Buffer.from('%PDF-1.4\n% legacy prescription\n%%EOF');
    db.prepare('INSERT INTO prescriptions(id,session_id,name,mime,size,created_at,content) VALUES(?,1,?,?,?,?,?)')
      .run('legacy-file', 'legacy.pdf', 'application/pdf', bytes.length, oldOrder.date, bytes);
    db.close();
  } });
  const client = f.client(`osudh24_session=${legacySecret}`);
  const before = await client.state();
  assert.equal(before.auth.user, null);
  assert.equal(before.cart[1], 2);
  const signedIn = ok(await client.google('legacy-owner')).state;
  assert.deepEqual(signedIn.profile, profile);
  assert.equal(signedIn.orders[0].id, oldOrder.id);
  assert.equal(signedIn.prescriptions[0].id, 'legacy-file');
  assert.equal(signedIn.cart[1], 2);
  assert.equal(signedIn.locationPin, '700001');
  assert.equal(signedIn.newsletterEmail, 'legacy@example.test');
  assert.equal((await client.request('/api/prescriptions/legacy-file/file')).status, 200);
  const other = f.client();
  const restored = ok(await other.google('legacy-owner')).state;
  assert.equal(restored.auth.user.id, signedIn.auth.user.id);
  assert.equal(restored.orders[0].id, oldOrder.id);
  assert.equal(restored.cart[1], 2);
});

test('returning-account login merges only its guest data and keeps colliding order histories intact', async t => {
  const legacySecret = 'cd'.repeat(32);
  const oldOrder = {
    id: 'DEMO-GUEST-LEGACY', date: new Date().toISOString(), items: [{ name: 'Daily multivitamin', quantity: 1, price: 299 }],
    subtotal: 299, discount: 0, shipping: 49, total: 348, status: 'Demo placed', address: 'Legacy guest address',
  };
  const f = await fixture(t, { beforeStart(databasePath, now) {
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE products (id INTEGER PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE sessions (id INTEGER PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL,profile TEXT NOT NULL DEFAULT '{}',location_pin TEXT NOT NULL DEFAULT '',newsletter_email TEXT NOT NULL DEFAULT '');
      CREATE TABLE cart (session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,product_id INTEGER NOT NULL REFERENCES products(id),quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),PRIMARY KEY(session_id,product_id));
      CREATE TABLE orders (id TEXT PRIMARY KEY,session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(session_id,idempotency_key));
    `);
    db.prepare('INSERT INTO sessions(id,token_hash,expires_at,profile) VALUES(1,?,?,?)')
      .run(createHash('sha256').update(legacySecret).digest('hex'), Math.floor(now / 1000) + 86400, JSON.stringify({ ...profile, name: 'Legacy Guest Details' }));
    db.prepare('INSERT INTO products(id,data) VALUES(?,?)').run(1, JSON.stringify({ id: 1, name: 'Daily multivitamin', price: 299 }));
    db.prepare('INSERT INTO cart(session_id,product_id,quantity) VALUES(1,1,2)').run();
    db.prepare('INSERT INTO orders(id,session_id,idempotency_key,request_hash,data,created_at) VALUES(?,1,?,?,?,?)')
      .run(oldOrder.id, 'shared-checkout-key', 'legacy-hash', JSON.stringify(oldOrder), oldOrder.date);
    db.close();
  } });
  const returning = f.client();
  const account = ok(await returning.google('existing-account')).state.auth.user;
  const currentProfile = { ...profile, name: 'Current Account Details' };
  await saveProfile(returning, currentProfile);
  ok(await returning.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 1 } }));
  const checkout = { method: 'POST', body: { profile: currentProfile, coupon: '' }, headers: { 'Idempotency-Key': 'shared-checkout-key' } };
  const currentOrder = ok(await returning.request('/api/orders', checkout)).order;
  ok(await returning.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 98 } }));
  const guest = f.client(`osudh24_session=${legacySecret}`);
  const merged = ok(await guest.google('existing-account')).state;
  assert.equal(merged.auth.user.id, account.id);
  assert.equal(merged.cart[1], 99);
  assert.equal(merged.profile.name, currentProfile.name);
  assert.deepEqual(merged.orders.map(order => order.id).sort(), [currentOrder.id, oldOrder.id].sort());
  assert.equal((await f.client(`osudh24_session=${legacySecret}`).state()).auth.user, null);
  assert.deepEqual((await f.client(`osudh24_session=${legacySecret}`).state()).orders, []);
  const retried = ok(await guest.request('/api/orders', checkout));
  assert.equal(retried.order.id, currentOrder.id);
  assert.equal(retried.state.cart[1], 99);
  assert.equal(retried.state.orders.length, 2);
});
