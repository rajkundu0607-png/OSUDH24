import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './app.mjs';

const ORIGIN = 'https://osudh24-deployment.example.test';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'osudh24-deployment-test-'));
  const databasePath = join(directory, 'test.sqlite');
  const now = Date.now();
  const calls = [];
  const app = createApp({
    databasePath, distPath: directory, serveFrontend: false,
    allowedOrigins: [ORIGIN], secureCookies: true,
    authProviders: {
      google: { verifyIdToken: async token => ({ uid: token, name: 'Deployment Customer', email: `${token}@example.test`, email_verified: true, auth_time: Math.floor(now / 1000), firebase: { sign_in_provider: 'google.com' } }) },
      widget: { verifyAccessToken: async token => { calls.push(token); throw new Error('fake provider rejection'); } },
    },
    now: () => now,
    ...options,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  function client() {
    let cookie = '';
    return {
      async request(path, { method = 'GET', body, raw = false, headers = {} } = {}) {
        // Native HTTP preserves the test Host header. Node fetch can replace it
        // with the localhost connection host, defeating the origin simulation.
        const payload = body === undefined ? undefined : raw ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
        return new Promise((resolve, reject) => {
          const request = httpRequest(`${base}${path}`, {
            method,
            headers: { Host: new URL(ORIGIN).host, Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined || raw ? {} : { 'Content-Type': 'application/json' }), ...(payload ? { 'Content-Length': payload.length } : {}), ...headers },
          }, response => {
            (async () => {
              for (const value of response.headers['set-cookie'] || []) if (value.startsWith('osudh24_session=')) cookie = value.split(';')[0];
              const responseHeaders = new Headers();
              for (const [key, values] of Object.entries(response.headers)) {
                for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) responseHeaders.append(key, String(value));
              }
              const chunks = [];
              for await (const chunk of response) chunks.push(chunk);
              const bytes = Buffer.concat(chunks);
              const data = responseHeaders.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString()) : null;
              return { status: response.statusCode, headers: responseHeaders, bytes, data };
            })().then(resolve, reject);
          });
          request.on('error', reject);
          request.setTimeout(30000, () => request.destroy(new Error('Deployment test request timed out.')));
          request.end(payload);
        });
      },
      async login(uid = 'deployment-google') {
        return this.request('/api/auth/google', { method: 'POST', body: { idToken: uid } });
      },
    };
  }
  return { app, client, directory, databasePath, calls };
}

function ok(result) {
  assert.ok(result.status >= 200 && result.status < 300, `HTTP ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

test('cloud mode requires exact allowed HTTPS origins and emits secure HttpOnly cookies', async t => {
  const f = await fixture(t);
  const client = f.client();
  const first = await client.request('/api/bootstrap');
  ok(first);
  const cookie = first.headers.get('set-cookie');
  assert.match(cookie, /; Secure(?:;|$)/i);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.equal((await client.request('/api/bootstrap', { headers: { Origin: 'https://untrusted.example.test' } })).status, 403);
  assert.equal((await client.request('/api/bootstrap', { headers: { Origin: 'http://osudh24-deployment.example.test' } })).status, 403);
  assert.equal((await client.request('/api/bootstrap', { headers: { Host: 'untrusted.example.test' } })).status, 403);
  assert.equal((await client.request('/api/bootstrap', { headers: { Host: '127.0.0.1:5173', Origin: 'http://127.0.0.1:5173' } })).status, 403);
  assert.equal(ok(await client.login()).state.auth.user.email, 'deployment-google@example.test');
});

test('serverless enforcement fails closed when hosted database configuration is missing', async t => {
  const f = await fixture(t, { databaseUrl: '', enforcePostgres: true });
  const response = await f.client().request('/api/bootstrap');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), null);
  await assert.rejects(access(f.databasePath));
});

test('API-only handlers return JSON 404 responses instead of serving the SPA fallback', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'index.html'), '<html>Static deployment index</html>');
  const client = f.client();
  const root = await client.request('/');
  assert.equal(root.status, 404);
  assert.ok(!root.bytes.toString().includes('Static deployment index'));
  const missing = await client.request('/api/no-such-route');
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
});

test('10 MiB prescription responses stream without a buffered Content-Length and stay owner-scoped', async t => {
  const f = await fixture(t);
  const owner = f.client();
  const other = f.client();
  ok(await owner.login('deployment-file-owner'));
  ok(await other.login('deployment-other-owner'));
  const bytes = Buffer.alloc(10 * 1024 * 1024, 65);
  bytes.write('%PDF-1.4\n', 0);
  const uploaded = ok(await owner.request('/api/prescriptions', {
    method: 'POST', raw: true, body: bytes,
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'ten-mebibytes.pdf' },
  }));
  const path = `/api/prescriptions/${uploaded.prescription.id}/file`;
  const download = await owner.request(path);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-length'), null);
  assert.equal(download.headers.get('transfer-encoding'), 'chunked');
  assert.equal(download.bytes.length, bytes.length);
  assert.equal(digest(download.bytes), digest(bytes));
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await other.request(path)).status, 404);
});

test('configured platform client-IP headers separate rate limits without trusting generic forwarding headers', async t => {
  const f = await fixture(t, { trustedClientIpHeader: 'x-vercel-forwarded-for' });
  for (let index = 0; index < 50; index++) {
    const result = await f.client().request('/api/auth/msg91', {
      method: 'POST', body: { accessToken: `deployment-ip-rate-token-${index}` },
      headers: { 'X-Vercel-Forwarded-For': '192.0.2.10', 'X-Forwarded-For': `198.51.100.${index}` },
    });
    assert.notEqual(result.status, 429, `attempt ${index + 1}`);
  }
  assert.equal(f.calls.length, 50);
  assert.equal((await f.client().request('/api/auth/msg91', {
    method: 'POST', body: { accessToken: 'deployment-ip-rate-token-blocked' },
    headers: { 'X-Vercel-Forwarded-For': '192.0.2.10', 'X-Forwarded-For': '198.51.100.200' },
  })).status, 429);
  assert.equal(f.calls.length, 50);
  assert.notEqual((await f.client().request('/api/auth/msg91', {
    method: 'POST', body: { accessToken: 'deployment-ip-rate-token-other-address' },
    headers: { 'X-Vercel-Forwarded-For': '192.0.2.11' },
  })).status, 429);
  assert.equal(f.calls.length, 51);
});

test('hosted Postgres serves isolated account, checkout, appointment, and file flows', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL to run isolated hosted Postgres tests',
}, async t => {
  const { Pool } = await import('pg');
  const schema = `osudh24_deploy_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });
  const scoped = new URL(process.env.TEST_DATABASE_URL);
  scoped.searchParams.set('options', `-csearch_path=${schema}`);
  const f = await fixture(t, { databaseUrl: scoped.toString(), databaseSchema: schema, enforcePostgres: true });
  const alice = f.client();
  const bob = f.client();
  const initial = ok(await alice.login('postgres-alice')).state;
  const aliceId = initial.auth.user.id;
  ok(await bob.login('postgres-bob'));
  const profile = { name: 'Postgres Test Customer', email: 'postgres-test@example.test', phone: '9876543210', address: '42 Isolated Schema Street', city: 'Kolkata', pin: '700001' };
  ok(await alice.request('/api/profile', { method: 'PUT', body: profile }));
  ok(await alice.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 1 } }));
  const checkout = { method: 'POST', body: { profile, coupon: 'WELCOME10' }, headers: { 'Idempotency-Key': 'pg-isolated-checkout' } };
  const placed = ok(await alice.request('/api/orders', checkout));
  assert.equal(placed.order.total, 318);
  assert.equal(ok(await alice.request('/api/orders', checkout)).order.id, placed.order.id);
  assert.equal(ok(await bob.request('/api/bootstrap')).orders.length, 0);
  assert.equal((await bob.request(`/api/orders/${placed.order.id}/cancel`, { method: 'POST' })).status, 404);
  const slot = { doctorId: 'ananya', patient: 'Isolated Test Patient', date: initial.availability.dates[0], time: '10:00' };
  const booked = ok(await alice.request('/api/appointments', { method: 'POST', body: slot }));
  assert.equal((await bob.request('/api/appointments', { method: 'POST', body: { ...slot, patient: 'Other Test Patient' } })).status, 409);
  ok(await alice.request(`/api/appointments/${booked.appointment.id}/cancel`, { method: 'POST' }));
  ok(await bob.request('/api/appointments', { method: 'POST', body: { ...slot, patient: 'Other Test Patient' } }));
  const bytes = Buffer.from('%PDF-1.4\n% isolated Postgres download\n%%EOF');
  const upload = ok(await alice.request('/api/prescriptions', { method: 'POST', raw: true, body: bytes, headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'postgres.pdf' } }));
  const file = `/api/prescriptions/${upload.prescription.id}/file`;
  assert.equal(digest((await alice.request(file)).bytes), digest(bytes));
  assert.equal((await bob.request(file)).status, 404);
  ok(await alice.request('/api/auth/logout', { method: 'POST' }));
  const restored = ok(await alice.login('postgres-alice')).state;
  assert.equal(restored.auth.user.id, aliceId);
  assert.deepEqual(restored.profile, profile);
  assert.equal(restored.orders[0].id, placed.order.id);
  assert.equal(restored.prescriptions[0].id, upload.prescription.id);
});
