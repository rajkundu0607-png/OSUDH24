import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './app.mjs';
import { createAuthProviders } from './auth-providers.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'osudh24-widget-test-'));
  const databasePath = join(directory, 'test.sqlite');
  const clock = { value: Date.now() };
  const calls = [];
  const providers = {
    ...(options.disabled ? {} : {
      widget: {
        async verifyAccessToken(token) {
          calls.push(token);
          return options.verifyWidget ? options.verifyWidget(token) : '919876543210';
        },
      },
    }),
    ...(options.mobile ? {
      mobile: { sendOtp: async () => {}, verifyOtp: async (_mobile, otp) => otp === '123456' },
    } : {}),
    google: {
      verifyIdToken: async token => ({
        uid: token, name: `Verified ${token}`, email: `${token}@example.test`, email_verified: true,
        auth_time: Math.floor(clock.value / 1000), firebase: { sign_in_provider: 'google.com' },
      }),
    },
  };
  let app;
  let base;
  async function start() {
    app = createApp({ databasePath, distPath: join(directory, 'no-frontend'), authProviders: providers, now: () => clock.value });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function stop() {
    if (!app) return;
    const previous = app;
    app = undefined;
    await previous.close();
  }
  function client(initialCookie = '') {
    let cookie = initialCookie;
    return {
      get cookie() { return cookie; },
      async request(path, { method = 'GET', body, headers = {} } = {}) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        for (const setCookie of response.headers.getSetCookie()) {
          if (setCookie.startsWith('osudh24_session=')) cookie = setCookie.split(';')[0];
        }
        const data = await response.json();
        return { status: response.status, data, headers: response.headers };
      },
      async state() { return ok(await this.request('/api/bootstrap')); },
      async widget(accessToken, mode = 'login', extras = {}, headers = {}) {
        return this.request('/api/auth/msg91', { method: 'POST', body: { accessToken, mode, ...extras }, headers });
      },
      async google(idToken, mode = 'login') {
        return this.request('/api/auth/google', { method: 'POST', body: { idToken, mode } });
      },
      async logout() { return this.request('/api/auth/logout', { method: 'POST' }); },
    };
  }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  await start();
  return { client, clock, calls, start, stop };
}

function ok(result) {
  assert.ok(result.status >= 200 && result.status < 300, `HTTP ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

function rejected(result) {
  assert.ok(result.status >= 400 && result.status < 500, `HTTP ${result.status}: ${JSON.stringify(result.data)}`);
}

const widgetEnv = { MSG91_AUTH_KEY: 'fake-widget-auth-key', VITE_MSG91_WIDGET_ID: 'fake-widget-id', VITE_MSG91_TOKEN_AUTH: 'fake-token-auth' };

test('widget provider uses server access-token verification and the verified response phone', async () => {
  const calls = [];
  const providers = createAuthProviders({ env: widgetEnv, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ type: 'success', message: '919876543210' }), { status: 200 });
  } });
  assert.equal(await providers.widget.verifyAccessToken('fake-widget-access-token'), '919876543210');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.msg91.com/api/v5/widget/verifyAccessToken');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authkey, 'fake-widget-auth-key');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), { 'access-token': 'fake-widget-access-token' });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.ok(!calls[0].url.includes('fake-widget-auth-key'));
});

test('widget provider rejects HTTP200 errors, unsupported identities, and network failures without leaking details', async () => {
  for (const responseBody of [
    { type: 'error', message: 'provider-secret-do-not-leak' },
    { type: 'success', message: 'alice@example.test' },
    { type: 'success', message: '1234' },
    { type: 'success', message: { mobile: '919876543210' } },
    { type: 'success' },
  ]) {
    const provider = createAuthProviders({ env: widgetEnv, fetchImpl: async () => new Response(JSON.stringify(responseBody), { status: 200 }) });
    await assert.rejects(() => provider.widget.verifyAccessToken('fake-token'), error => !String(error).includes('provider-secret'));
  }
  const unavailable = createAuthProviders({ env: widgetEnv, fetchImpl: async () => { throw new Error('fake-secret-authkey-and-network-url'); } });
  await assert.rejects(() => unavailable.widget.verifyAccessToken('fake-token'), error => !String(error).includes('fake-secret'));
  for (const key of Object.keys(widgetEnv)) {
    const partial = { ...widgetEnv };
    delete partial[key];
    assert.equal(createAuthProviders({ env: partial }).widget, null);
  }
});

test('mobile availability prefers widget while direct OTP remains an optional fallback', async t => {
  const widget = await fixture(t, { mobile: true });
  const state = await widget.client().state();
  assert.equal(state.auth.providers.mobile, true);
  assert.equal(state.auth.mobileMethod, 'widget');
  const direct = await fixture(t, { disabled: true, mobile: true });
  const directState = await direct.client().state();
  assert.equal(directState.auth.providers.mobile, true);
  assert.equal(directState.auth.mobileMethod, 'otp');
  const disabled = await fixture(t, { disabled: true });
  const disabledState = await disabled.client().state();
  assert.equal(disabledState.auth.providers.mobile, false);
  assert.equal(disabledState.auth.mobileMethod, null);
  assert.equal((await disabled.client().widget('widget-disabled-token-0001')).status, 503);
});

test('widget sign-in trusts only the provider phone and rotates the guest cookie', async t => {
  const f = await fixture(t);
  const client = f.client();
  await client.state();
  const guestCookie = client.cookie;
  ok(await client.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 2 } }));
  const signedIn = ok(await client.widget('widget-alice-access-token-0001', 'login', { mobile: '919999999999', phone: '919999999999', email: 'attacker@example.test' })).state;
  assert.equal(signedIn.auth.user.phone, '+919876543210');
  assert.equal(signedIn.auth.user.email, null);
  assert.deepEqual(signedIn.auth.user.providers, ['mobile']);
  assert.equal(signedIn.cart[1], 2);
  assert.notEqual(client.cookie, guestCookie);
  assert.equal((await f.client(guestCookie).state()).auth.user, null);
  assert.ok(!JSON.stringify(signedIn).includes('widget-alice-access-token-0001'));
  const second = f.client();
  assert.equal(ok(await second.widget('widget-alice-access-token-0002')).state.auth.user.id, signedIn.auth.user.id);
});

test('malformed widget tokens and invalid verified identities cannot authenticate a browser', async t => {
  const f = await fixture(t, { verifyWidget: async () => 'alice@example.test' });
  const client = f.client();
  for (const accessToken of ['', null, 42, {}, []]) {
    rejected(await client.widget(accessToken));
  }
  assert.equal(f.calls.length, 0);
  rejected(await client.widget('widget-provider-email-token-0001'));
  assert.equal((await client.state()).auth.user, null);
  assert.equal(f.calls.length, 1);
});

test('widget token reuse is rejected across fresh browsers and database restart', async t => {
  const f = await fixture(t);
  const first = f.client();
  const token = 'widget-replay-resistant-token-0001';
  const account = ok(await first.widget(token)).state.auth.user;
  ok(await first.logout());
  rejected(await f.client().widget(token));
  assert.equal(f.calls.length, 1);
  await f.stop();
  await f.start();
  rejected(await f.client().widget(token));
  assert.equal(f.calls.length, 1);
  assert.equal(ok(await first.widget('widget-replay-resistant-token-0002')).state.auth.user.id, account.id);
});

test('failed widget verification burns its token and sanitizes provider exceptions', async t => {
  const f = await fixture(t, { verifyWidget: async () => { throw new Error('private-provider-response-do-not-leak'); } });
  const token = 'widget-failed-token-reservation-0001';
  const first = await f.client().widget(token);
  assert.ok(first.status >= 400 && first.status < 600);
  assert.ok(!JSON.stringify(first.data).includes('private-provider'));
  assert.equal(f.calls.length, 1);
  rejected(await f.client().widget(token));
  assert.equal(f.calls.length, 1);
});

test('concurrent copies of a widget access token invoke the provider and sign in only once', async t => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { verifyWidget: async () => { entered(); await gate; return '919876543210'; } });
  const token = 'widget-concurrent-token-0001';
  const first = f.client().widget(token);
  await started;
  const second = await f.client().widget(token);
  rejected(second);
  assert.equal(f.calls.length, 1);
  release();
  ok(await first);
  assert.equal(f.calls.length, 1);
});

test('widget login reuses an existing direct-OTP mobile identity and linking cannot steal it', async t => {
  const f = await fixture(t, { mobile: true });
  const direct = f.client();
  const challenge = ok(await direct.request('/api/auth/otp/send', { method: 'POST', body: { mobile: '9876543210' } }));
  const original = ok(await direct.request('/api/auth/otp/verify', { method: 'POST', body: { challengeId: challenge.challengeId, otp: '123456' } })).state.auth.user;
  ok(await direct.logout());
  const restored = ok(await direct.widget('widget-existing-mobile-token-0001')).state.auth.user;
  assert.equal(restored.id, original.id);
  const other = f.client();
  const otherAccount = ok(await other.google('widget-other-google')).state.auth.user;
  assert.equal((await other.widget('widget-existing-mobile-token-0002', 'link')).status, 409);
  assert.equal((await other.state()).auth.user.id, otherAccount.id);
  assert.deepEqual((await other.state()).auth.user.providers, ['google']);
  const guest = f.client();
  assert.equal((await guest.widget('widget-guest-link-token-0001', 'link')).status, 401);
});

test('explicit widget linking keeps one account and rotates its browser session', async t => {
  const f = await fixture(t);
  const client = f.client();
  const account = ok(await client.google('widget-google-linked')).state.auth.user;
  const previousCookie = client.cookie;
  const linked = ok(await client.widget('widget-explicit-link-token-0001', 'link')).state;
  assert.equal(linked.auth.user.id, account.id);
  assert.deepEqual([...linked.auth.user.providers].sort(), ['google', 'mobile']);
  assert.notEqual(client.cookie, previousCookie);
  assert.equal((await f.client(previousCookie).state()).auth.user, null);
  ok(await client.logout());
  assert.equal(ok(await client.widget('widget-explicit-link-token-0002')).state.auth.user.id, account.id);
});

test('a late widget response cannot link or authenticate after its browser session was revoked', async t => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { verifyWidget: async () => { entered(); await gate; return '919876543210'; } });
  const client = f.client();
  const original = ok(await client.google('widget-late-google')).state.auth.user;
  const pending = client.widget('widget-late-provider-token-0001', 'link');
  await started;
  ok(await client.logout());
  release();
  assert.equal((await pending).status, 401);
  assert.equal((await client.state()).auth.user, null);
  const restored = ok(await client.google('widget-late-google')).state.auth.user;
  assert.equal(restored.id, original.id);
  assert.deepEqual(restored.providers, ['google']);
});

test('widget verification is rate limited per browser and IP even when provider verification fails', async t => {
  const f = await fixture(t, { verifyWidget: async () => { throw new Error('fake provider rejection'); } });
  const client = f.client();
  for (let index = 0; index < 10; index++) {
    const result = await client.widget(`widget-browser-rate-token-${index}`);
    assert.notEqual(result.status, 429, `attempt ${index + 1}`);
  }
  assert.equal(f.calls.length, 10);
  assert.equal((await client.widget('widget-browser-rate-token-blocked')).status, 429);
  assert.equal(f.calls.length, 10);
  for (let index = 10; index < 50; index++) {
    const result = await f.client().widget(`widget-ip-rate-token-${index}`);
    assert.notEqual(result.status, 429, `IP attempt ${index + 1}`);
  }
  assert.equal(f.calls.length, 50);
  assert.equal((await f.client().widget('widget-ip-rate-token-blocked')).status, 429);
  assert.equal(f.calls.length, 50);
  f.clock.value += 60 * 60_000 + 1;
  assert.notEqual((await f.client().widget('widget-ip-rate-token-after-reset')).status, 429);
  assert.equal(f.calls.length, 51);
});

test('widget verification rejects stale account and foreign-origin requests before contacting the provider', async t => {
  const f = await fixture(t);
  const alice = f.client();
  const bob = f.client();
  const aliceId = ok(await alice.google('widget-alice-stale')).state.auth.user.id;
  const bobId = ok(await bob.google('widget-bob-current')).state.auth.user.id;
  assert.equal((await bob.widget('widget-stale-account-token-0001', 'link', {}, { 'X-Account-Id': aliceId })).status, 401);
  assert.equal((await f.client().widget('widget-foreign-origin-token-0001', 'login', {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await bob.state()).auth.user.id, bobId);
  assert.deepEqual((await bob.state()).auth.user.providers, ['google']);
});
