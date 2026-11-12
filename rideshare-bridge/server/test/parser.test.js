import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLyftRequest, scoreRide } from '../src/parser.js';

test('parses a full request card', () => {
  const r = parseLyftRequest(`New ride request
Lyft XL · 4.92 ★
6 min (1.8 mi) away
1234 Mission St, San Francisco
$18.40
24 min (9.6 mi) trip`);
  assert.equal(r.isRideRequest, true);
  assert.equal(r.service, 'Lyft XL');
  assert.equal(r.riderRating, 4.92);
  assert.equal(r.fare, 18.4);
  assert.deepEqual(r.pickup, { address: '1234 Mission St, San Francisco', etaMin: 6, distanceMi: 1.8 });
  assert.deepEqual(r.trip, { durationMin: 24, distanceMi: 9.6 });
});

test('parses notification title/text objects and labelled addresses', () => {
  const r = parseLyftRequest({
    title: 'Ride request',
    text: 'Pickup: 500 W 2nd Ave · 3 min away',
    bigText: 'Pickup: 500 W 2nd Ave · 3 min away\nDropoff: 77 Harbor Blvd\n1 hr 5 min · 41.3 mi trip\nEst. $52.10',
  });
  assert.equal(r.isRideRequest, true);
  assert.equal(r.pickup.address, '500 W 2nd Ave');
  assert.equal(r.dropoff.address, '77 Harbor Blvd');
  assert.equal(r.trip.durationMin, 65);
  assert.equal(r.trip.distanceMi, 41.3);
  assert.equal(r.fare, 52.1);
});

test('handles km distances and intersection pickups', () => {
  const r = parseLyftRequest('Lyft request\n4 min (2 km) away · Queen St W & Spadina\n$9.00');
  assert.equal(r.pickup.distanceMi, 1.24);
  assert.equal(r.pickup.address, 'Queen St W & Spadina');
});

test('ignores unrelated notifications', () => {
  const r = parseLyftRequest('Weekly summary: you earned $412 this week');
  assert.equal(r.isRideRequest, false);
});

test('scores rides', () => {
  const good = parseLyftRequest('Ride request\n3 min (0.9 mi) away\n$25.00\n20 min (11 mi) trip');
  assert.equal(scoreRide(good).verdict, 'go');
  const bad = parseLyftRequest('Ride request\n18 min (7 mi) away\n$6.00\n8 min (2 mi) trip\n4.5 ★');
  const s = scoreRide(bad);
  assert.equal(s.verdict, 'skip');
  assert.ok(s.reasons.length >= 2);
});
