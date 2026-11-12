import { randomUUID } from 'node:crypto';

/** In-memory ring buffer of recent ride requests plus pub/sub for live clients. */
export class RideStore {
  constructor(limit = 50) {
    this.limit = limit;
    this.rides = [];
    this.listeners = new Set();
  }

  add(ride) {
    const entry = { id: randomUUID(), receivedAt: new Date().toISOString(), ...ride };
    this.rides.unshift(entry);
    this.rides.length = Math.min(this.rides.length, this.limit);
    this.emit('ride', entry);
    return entry;
  }

  get(id) {
    return this.rides.find((r) => r.id === id);
  }

  latest() {
    return this.rides[0] || null;
  }

  list() {
    return this.rides;
  }

  update(id, patch) {
    const ride = this.get(id);
    if (!ride) return null;
    Object.assign(ride, patch);
    this.emit('update', ride);
    return ride;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event, data) {
    for (const fn of this.listeners) fn(event, data);
  }
}
