import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './app.mjs';

const profile = {
  name: 'Test Customer',
  email: 'customer@example.test',
  phone: '9876543210',
  address: '123 Sample Street',
  city: 'Kolkata',
  pin: '700001',
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'osudh24-api-test-'));
  const databasePath = join(directory, 'test.sqlite');
  let app;
  let base;
  let clientNumber = 0;

  async function start() {
    app = createApp({
      databasePath, distPath: join(directory, 'no-frontend'),
      authProviders: {
        google: { verifyIdToken: async uid => ({ uid, name: 'Test User', email: `${uid}@example.test`, email_verified: true, auth_time: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: 'google.com' } }) },
        mobile: null,
      },
    });
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

  function client() {
    let cookie = '';
    let authenticated = false;
    const identity = `test-user-${++clientNumber}`;
    return {
      get cookie() { return cookie; },
      async request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
        const requestHeaders = { ...(cookie ? { Cookie: cookie } : {}), ...headers };
        if (body !== undefined && !raw) requestHeaders['Content-Type'] = 'application/json';
        const response = await fetch(`${base}${path}`, {
          method,
          headers: requestHeaders,
          body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const bytes = Buffer.from(await response.arrayBuffer());
        let data;
        if (response.headers.get('content-type')?.includes('application/json')) {
          data = JSON.parse(bytes.toString());
        }
        return { status: response.status, headers: response.headers, data, bytes };
      },
      async state() {
        let result = await this.request('/api/bootstrap');
        assert.equal(result.status, 200, JSON.stringify(result.data));
        if (!authenticated) {
          const login = await this.request('/api/auth/google', { method: 'POST', body: { idToken: identity } });
          assert.equal(login.status, 200, JSON.stringify(login.data));
          authenticated = true;
          result = { ...login, data: login.data.state };
        }
        return result.data;
      },
    };
  }

  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  await start();
  return { client, start, stop, get origin() { return base; } };
}

function ok(response) {
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response.data));
  return response.data;
}

test('closing the server is safe for concurrent and repeated shutdown calls', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'osudh24-close-test-'));
  const app = createApp({ databasePath: join(directory, 'test.sqlite'), authProviders: {} });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  await Promise.all([app.close(), app.close()]);
  await app.close();
  assert.equal(app.server.listening, false);
});

test('bootstrap creates an HttpOnly guest session and serves the seeded catalog', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  const health = await client.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.status, 'ok');
  assert.equal(health.data.database, 'sqlite');

  const first = await client.request('/api/bootstrap');
  assert.equal(first.status, 200);
  assert.match(client.cookie, /^osudh24_session=/);
  assert.match(first.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(first.headers.get('set-cookie'), /SameSite=Strict/i);
  assert.equal(first.data.products.length, 4);
  assert.equal(first.data.doctors.length, 4);
  assert.deepEqual(first.data.cart, {});
  assert.deepEqual(first.data.orders, []);
  assert.deepEqual(first.data.appointments, []);
  assert.deepEqual(first.data.prescriptions, []);
  assert.equal(first.data.profile.name, '');
  assert.equal(first.data.availability.dates.length, 7);
  assert.deepEqual(first.data.availability.times, ['10:00', '11:30', '14:00', '16:30']);
});

test('guest data and session cookies survive a database restart', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  const initial = await client.state();
  ok(await client.request('/api/profile', { method: 'PUT', body: profile }));
  ok(await client.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 1 } }));
  const checkout = {
    method: 'POST', body: { profile, coupon: '' }, headers: { 'Idempotency-Key': 'persistent-checkout' },
  };
  const { order } = ok(await client.request('/api/orders', checkout));
  ok(await client.request('/api/cart/items/3', { method: 'PUT', body: { quantity: 2 } }));
  const { appointment } = ok(await client.request('/api/appointments', {
    method: 'POST', body: { doctorId: 'ananya', patient: 'Persistence Test', date: initial.availability.dates[0], time: '14:00' },
  }));
  const bytes = Buffer.from('%PDF-1.4\n% persistent test document\n%%EOF\n');
  const { prescription } = ok(await client.request('/api/prescriptions', {
    method: 'POST', raw: true, body: bytes,
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'persistent.pdf' },
  }));
  ok(await client.request('/api/location', { method: 'PUT', body: { pin: '700001' } }));
  ok(await client.request('/api/newsletter', { method: 'POST', body: { email: 'news@example.test' } }));
  const cookie = client.cookie;
  await f.stop();
  await f.start();
  const state = await client.state();
  assert.equal(client.cookie, cookie);
  assert.deepEqual(state.profile, profile);
  assert.equal(state.cart[3], 2);
  assert.equal(state.orders[0].id, order.id);
  assert.equal(state.appointments[0].id, appointment.id);
  assert.equal(state.prescriptions[0].id, prescription.id);
  assert.deepEqual((await client.request(`/api/prescriptions/${prescription.id}/file`)).bytes, bytes);
  assert.equal(state.locationPin, '700001');
  assert.equal(state.newsletterEmail, 'news@example.test');
  const retried = ok(await client.request('/api/orders', checkout));
  assert.equal(retried.order.id, order.id);
  assert.equal(retried.state.orders.length, 1);
  assert.equal(retried.state.cart[3], 2);
});

test('checkout uses catalog prices, applies coupon rules, and retries idempotently', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  await client.state();
  ok(await client.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 1 } }));
  const request = {
    method: 'POST',
    body: { profile, coupon: 'WELCOME10' },
    headers: { 'Idempotency-Key': 'checkout-test-0001' },
  };
  const { order, state } = ok(await client.request('/api/orders', request));
  assert.equal(order.subtotal, 299);
  assert.equal(order.discount, 30);
  assert.equal(order.shipping, 49);
  assert.equal(order.total, 318);
  assert.equal(order.items[0].name, 'Daily multivitamin');
  assert.equal(order.items[0].price, 299);
  assert.equal(order.items[0].quantity, 1);
  assert.equal(order.status, 'Demo placed');
  assert.deepEqual(state.cart, {});
  assert.deepEqual(state.profile, profile);
  assert.equal(state.orders.length, 1);

  // A lost checkout response must not place a second order or empty a newer cart.
  ok(await client.request('/api/cart/items/2', { method: 'PUT', body: { quantity: 1 } }));
  const retried = ok(await client.request('/api/orders', request));
  assert.equal(retried.order.id, order.id);
  assert.equal(retried.state.orders.length, 1);
  assert.equal(retried.state.cart[2], 1);

  const second = ok(await client.request('/api/orders', {
    ...request,
    body: { profile, coupon: '' },
    headers: { 'Idempotency-Key': 'checkout-test-0002' },
  }));
  assert.equal(second.order.subtotal, 1299);
  assert.equal(second.order.discount, 0);
  assert.equal(second.order.shipping, 0);
  assert.equal(second.order.total, 1299);
});

test('invalid input is rejected without changing stored state', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  await client.state();
  for (const quantity of [-1, 100, 1.5, '2', null]) {
    const result = await client.request('/api/cart/items/1', { method: 'PUT', body: { quantity } });
    assert.equal(result.status, 422, `quantity ${JSON.stringify(quantity)}`);
  }
  assert.equal((await client.request('/api/cart/items/999', { method: 'PUT', body: { quantity: 1 } })).status, 404);
  assert.equal((await client.request('/api/profile', { method: 'PUT', body: { ...profile, email: 'invalid' } })).status, 422);
  assert.equal((await client.request('/api/location', { method: 'PUT', body: { pin: '123' } })).status, 422);
  assert.equal((await client.request('/api/newsletter', { method: 'POST', body: { email: 'invalid' } })).status, 422);
  assert.equal((await client.request('/api/profile', {
    method: 'PUT', raw: true, body: '{invalid json', headers: { 'Content-Type': 'application/json' },
  })).status, 400);
  const missingKey = await client.request('/api/orders', { method: 'POST', body: { profile, coupon: '' } });
  assert.equal(missingKey.status, 422);
  const state = await client.state();
  assert.deepEqual(state.cart, {});
  assert.equal(state.profile.name, '');
  assert.deepEqual(state.orders, []);
});

test('guest sessions cannot read or cancel each other’s orders', async (t) => {
  const f = await fixture(t);
  const alice = f.client();
  const bob = f.client();
  await alice.state();
  await bob.state();
  assert.notEqual(alice.cookie, bob.cookie);
  ok(await alice.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 1 } }));
  const { order } = ok(await alice.request('/api/orders', {
    method: 'POST', body: { profile, coupon: '' }, headers: { 'Idempotency-Key': 'alice-order-test' },
  }));
  const bobState = await bob.state();
  assert.equal(bobState.profile.name, '');
  assert.deepEqual(bobState.cart, {});
  assert.deepEqual(bobState.orders, []);
  assert.equal((await bob.request(`/api/orders/${order.id}/cancel`, { method: 'POST' })).status, 404);
  const cancelled = ok(await alice.request(`/api/orders/${order.id}/cancel`, { method: 'POST' }));
  assert.equal(cancelled.state.orders[0].status, 'Cancelled');
});

test('appointment conflicts are global, expose only availability, and release on cancellation', async (t) => {
  const f = await fixture(t);
  const alice = f.client();
  const bob = f.client();
  const initial = await alice.state();
  await bob.state();
  const slot = { doctorId: 'ananya', date: initial.availability.dates[0], time: '10:00' };
  const { appointment } = ok(await alice.request('/api/appointments', {
    method: 'POST', body: { ...slot, patient: 'Test Patient Alice' },
  }));
  assert.equal(appointment.fee, 499);
  const conflict = await bob.request('/api/appointments', {
    method: 'POST', body: { ...slot, patient: 'Test Patient Bob' },
  });
  assert.equal(conflict.status, 409);
  const otherState = await bob.state();
  assert.deepEqual(otherState.appointments, []);
  assert.ok(otherState.availability.booked.some((item) => item.doctorId === slot.doctorId && item.date === slot.date && item.time === slot.time));
  assert.ok(!JSON.stringify(otherState).includes('Test Patient Alice'));
  assert.equal((await bob.request(`/api/appointments/${appointment.id}/cancel`, { method: 'POST' })).status, 404);
  ok(await alice.request(`/api/appointments/${appointment.id}/cancel`, { method: 'POST' }));
  const booked = ok(await bob.request('/api/appointments', {
    method: 'POST', body: { ...slot, patient: 'Test Patient Bob' },
  }));
  assert.equal(booked.appointment.status, 'Booked');
  assert.equal((await alice.state()).appointments[0].status, 'Cancelled');
  assert.equal((await bob.request('/api/appointments', {
    method: 'POST', body: { ...slot, date: '2000-01-01', patient: 'Test Patient' },
  })).status, 422);
});

test('prescriptions validate file signatures and are downloadable only by their owner', async (t) => {
  const f = await fixture(t);
  const alice = f.client();
  const bob = f.client();
  await alice.state();
  await bob.state();
  const bytes = Buffer.from('%PDF-1.4\n% harmless integration test document\n%%EOF\n');
  const upload = {
    method: 'POST', raw: true, body: bytes,
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('sample prescription.pdf') },
  };
  const { prescription } = ok(await alice.request('/api/prescriptions', upload));
  assert.equal(prescription.name, 'sample prescription.pdf');
  assert.equal(prescription.mime, 'application/pdf');
  assert.equal(prescription.size, bytes.length);
  const download = await alice.request(`/api/prescriptions/${prescription.id}/file`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(download.bytes, bytes);
  assert.deepEqual((await bob.state()).prescriptions, []);
  assert.equal((await bob.request(`/api/prescriptions/${prescription.id}/file`)).status, 404);
  assert.equal((await bob.request(`/api/prescriptions/${prescription.id}`, { method: 'DELETE' })).status, 404);
  const invalid = await alice.request('/api/prescriptions', { ...upload, body: Buffer.from('<script>not a pdf</script>') });
  assert.ok(invalid.status >= 400 && invalid.status < 500);
  const tooLarge = await alice.request('/api/prescriptions', { ...upload, body: Buffer.alloc(10 * 1024 * 1024 + 1, 65) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await alice.state()).prescriptions.length, 1);
  ok(await alice.request(`/api/prescriptions/${prescription.id}`, { method: 'DELETE' }));
  assert.deepEqual((await alice.state()).prescriptions, []);
});

test('clearing profile and history affects only the current guest and keeps its cart', async (t) => {
  const f = await fixture(t);
  const alice = f.client();
  const bob = f.client();
  const initial = await alice.state();
  await bob.state();
  ok(await alice.request('/api/profile', { method: 'PUT', body: profile }));
  ok(await bob.request('/api/profile', { method: 'PUT', body: { ...profile, name: 'Other Customer' } }));
  ok(await alice.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 1 } }));
  ok(await alice.request('/api/orders', {
    method: 'POST', body: { profile, coupon: '' }, headers: { 'Idempotency-Key': 'clear-profile-order' },
  }));
  ok(await alice.request('/api/cart/items/1', { method: 'PUT', body: { quantity: 2 } }));
  ok(await alice.request('/api/prescriptions', {
    method: 'POST', raw: true, body: Buffer.from('%PDF-1.4\n% delete test\n%%EOF\n'),
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'delete-test.pdf' },
  }));
  ok(await alice.request('/api/appointments', {
    method: 'POST', body: { doctorId: 'ananya', patient: 'Test Patient', date: initial.availability.dates[0], time: '11:30' },
  }));
  ok(await alice.request('/api/newsletter', { method: 'POST', body: { email: 'clear@example.test' } }));
  ok(await alice.request('/api/location', { method: 'PUT', body: { pin: '700001' } }));
  const cleared = ok(await alice.request('/api/profile', { method: 'DELETE' })).state;
  assert.equal(cleared.profile.name, '');
  assert.deepEqual(cleared.orders, []);
  assert.deepEqual(cleared.appointments, []);
  assert.deepEqual(cleared.prescriptions, []);
  assert.equal(cleared.newsletterEmail, '');
  assert.equal(cleared.locationPin, '');
  assert.equal(cleared.cart[1], 2);
  assert.equal((await bob.state()).profile.name, 'Other Customer');
});

test('cross-origin writes are rejected while the local frontend origin is allowed', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  await client.state();
  const blocked = await client.request('/api/cart/items/1', {
    method: 'PUT', body: { quantity: 1 }, headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(blocked.status, 403);
  assert.deepEqual((await client.state()).cart, {});
  ok(await client.request('/api/cart/items/1', {
    method: 'PUT', body: { quantity: 1 }, headers: { Origin: 'http://127.0.0.1:5173' },
  }));
  assert.equal((await client.state()).cart[1], 1);
});
