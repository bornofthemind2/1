import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLyftRequest, scoreRide } from './parser.js';
import { RideStore } from './store.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATUSES = ['request', 'accepted', 'in_trip', 'completed', 'cancelled'];
const MAX_BODY = 64 * 1024;

function send(res, status, body, headers = {}) {
  const isString = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isString ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isString ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function coords(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? { lat: p.lat, lon: p.lon } : {};
}

/** Copies fields that the new parse found onto the stored ride without erasing known ones. */
function mergeKnown(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v == null || k === 'raw' || k === 'isRideRequest') continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      target[k] = target[k] || {};
      mergeKnown(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.token        shared secret the phone / dashboard must present
 * @param {object} [opts.tesla]      TeslaClient (optional)
 * @param {object} [opts.prefs]      thresholds for scoreRide
 * @param {string} [opts.autoNavigate] 'off' | 'accepted' (pickup on accept, dropoff on trip start)
 */
export function createApp({ token, tesla = null, prefs = {}, autoNavigate = 'accepted', log = console } = {}) {
  if (!token) throw new Error('BRIDGE_TOKEN is required');
  const store = new RideStore();

  function authorized(req, url) {
    const header = req.headers.authorization || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('key');
    return presented != null && safeEqual(presented, token);
  }

  async function navigate(ride, target) {
    if (!tesla?.configured) throw Object.assign(new Error('Tesla is not configured'), { status: 501 });
    const dest = ride[target];
    if (!dest || (!dest.address && dest.lat == null)) {
      throw Object.assign(new Error(`Ride has no ${target} location yet`), { status: 409 });
    }
    await tesla.sendDestination(dest);
    const sent = { target, at: new Date().toISOString() };
    store.update(ride.id, { lastSentToCar: sent });
    return sent;
  }

  async function autoNav(ride, status) {
    if (autoNavigate === 'off' || !tesla?.configured) return;
    const target = status === 'accepted' ? 'pickup' : status === 'in_trip' ? 'dropoff' : null;
    if (!target) return;
    try {
      await navigate(ride, target);
      log.info?.(`auto-navigated Tesla to ${target} for ride ${ride.id}`);
    } catch (err) {
      log.warn?.(`auto-navigate failed: ${err.message}`);
      store.update(ride.id, { lastError: err.message });
    }
  }

  async function ingest(body) {
    const status = STATUSES.includes(body.status) ? body.status : 'request';
    const parsed = parseLyftRequest(body);
    Object.assign(parsed.pickup, coords(body.pickup));
    Object.assign(parsed.dropoff, coords(body.dropoff));

    if (status === 'request') {
      if (!parsed.isRideRequest && !body.force) return { ignored: true, reason: 'not a ride request' };
      const { raw, ...rest } = parsed;
      const ride = store.add({
        ...rest,
        status,
        source: body.source || 'unknown',
        score: scoreRide(parsed, prefs),
        rawText: raw.slice(0, 2000),
      });
      return { ride };
    }

    // Status change: applies to the given ride id, or the most recent ride.
    const ride = body.rideId ? store.get(body.rideId) : store.latest();
    if (!ride) return { ignored: true, reason: 'no ride to update' };
    mergeKnown(ride, parsed);
    ride.score = scoreRide(ride, prefs);
    store.update(ride.id, { status });
    autoNav(ride, status); // fire-and-forget so the phone gets a fast response
    return { ride };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });

      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
        return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
      }

      if (!path.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (!authorized(req, url)) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && path === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ latest: store.latest(), tesla: !!tesla?.configured })}\n\n`);
        const unsubscribe = store.subscribe((event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        });
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          unsubscribe();
        });
        return;
      }

      if (req.method === 'GET' && path === '/api/rides') return send(res, 200, { rides: store.list() });
      if (req.method === 'GET' && path === '/api/rides/latest') return send(res, 200, { ride: store.latest() });
      if (req.method === 'GET' && path === '/api/config') {
        return send(res, 200, { prefs, autoNavigate, tesla: !!tesla?.configured });
      }

      if (req.method === 'POST' && path === '/api/rides') {
        const result = await ingest(await readJson(req));
        return send(res, result.ride ? 201 : 202, result);
      }

      const navMatch = path.match(/^\/api\/rides\/([\w-]+)\/navigate$/);
      if (req.method === 'POST' && navMatch) {
        const ride = store.get(navMatch[1]);
        if (!ride) return send(res, 404, { error: 'ride not found' });
        const { target = 'pickup' } = await readJson(req);
        if (!['pickup', 'dropoff'].includes(target)) return send(res, 400, { error: 'bad target' });
        return send(res, 200, { sent: await navigate(ride, target) });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err.status && err.status < 600 ? err.status : 500;
      if (status >= 500) log.error?.(err);
      if (!res.headersSent) send(res, status >= 500 && status !== 501 ? 502 : status, { error: err.message });
    }
  });

  return { server, store };
}
