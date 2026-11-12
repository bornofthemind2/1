import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { TeslaClient } from '../src/tesla.js';

const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ response: { result: true } }), { status: 200 });
};
const tesla = new TeslaClient({ accessToken: 't', vin: 'VIN123', fetchImpl: fakeFetch });
const { server } = createApp({ token: 'secret', tesla, log: {} });
let base;

before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => server.close());

const api = (path, { method = 'GET', body, key = 'secret' } = {}) =>
  fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });

test('rejects requests without the token', async () => {
  assert.equal((await api('/api/rides', { key: 'wrong' })).status, 401);
});

test('ingests a request, then auto-navigates on accept and trip start', async () => {
  let res = await api('/api/rides', {
    method: 'POST',
    body: { source: 'test', title: 'Ride request', text: 'Lyft · 4.9 ★\n5 min (1.2 mi) away\n10 Main St\n$12.00\n15 min (6 mi) trip' },
  });
  assert.equal(res.status, 201);
  const { ride } = await res.json();
  assert.equal(ride.pickup.address, '10 Main St');

  res = await api('/api/rides', { method: 'POST', body: { status: 'accepted', text: 'Picking up Sam' } });
  assert.equal(res.status, 201);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(calls.at(-1).url, /VIN123\/command\/navigation_request$/);
  assert.equal(calls.at(-1).body.value['android.intent.extra.TEXT'], '10 Main St');

  res = await api('/api/rides', {
    method: 'POST',
    body: { status: 'in_trip', text: 'Dropping off Sam', dropoff: { lat: 37.77, lon: -122.41 } },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(calls.at(-1).url, /navigation_gps_request$/);
  assert.deepEqual(calls.at(-1).body, { lat: 37.77, lon: -122.41, order: 1 });

  const latest = await (await api('/api/rides/latest')).json();
  assert.equal(latest.ride.status, 'in_trip');
  assert.equal(latest.ride.lastSentToCar.target, 'dropoff');
});

test('manual navigate endpoint', async () => {
  const { ride } = await (await api('/api/rides/latest')).json();
  const res = await api(`/api/rides/${ride.id}/navigate`, { method: 'POST', body: { target: 'pickup' } });
  assert.equal(res.status, 200);
});

test('ignores non-request notifications', async () => {
  const res = await api('/api/rides', { method: 'POST', body: { text: 'You are now online' } });
  assert.equal(res.status, 202);
});

test('serves the dashboard', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /RideBridge/);
});
