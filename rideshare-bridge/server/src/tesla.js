// Minimal Tesla Fleet API client for sending a destination to the car's navigation.
//
// Docs: https://developer.tesla.com/docs/fleet-api
// Most 2021+ vehicles require commands to be signed with the Vehicle Command Protocol.
// To do that, run Tesla's `tesla-http-proxy` (github.com/teslamotors/vehicle-command)
// and point TESLA_API_BASE at it, e.g. https://localhost:4443. The calls below are
// the same either way.

const DEFAULT_BASE = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const AUTH_URL = 'https://auth.tesla.com/oauth2/v3/token';

export class TeslaClient {
  constructor({
    baseUrl = DEFAULT_BASE,
    accessToken,
    refreshToken,
    clientId,
    vin,
    fetchImpl = globalThis.fetch,
    locale = 'en-US',
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.clientId = clientId;
    this.vin = vin;
    this.fetch = fetchImpl;
    this.locale = locale;
  }

  get configured() {
    return Boolean(this.vin && (this.accessToken || (this.refreshToken && this.clientId)));
  }

  async refresh() {
    if (!this.refreshToken || !this.clientId) throw new Error('Tesla refresh token / client id not set');
    const res = await this.fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        refresh_token: this.refreshToken,
      }),
    });
    if (!res.ok) throw new Error(`Tesla token refresh failed: ${res.status}`);
    const body = await res.json();
    this.accessToken = body.access_token;
    if (body.refresh_token) this.refreshToken = body.refresh_token;
  }

  async request(path, body, { retried = false } = {}) {
    if (!this.accessToken) await this.refresh();
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    });
    if (res.status === 401 && !retried && this.refreshToken) {
      await this.refresh();
      return this.request(path, body, { retried: true });
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Tesla API ${path} failed: ${res.status} ${json.error || ''}`.trim());
      err.status = res.status;
      throw err;
    }
    return json;
  }

  wake() {
    return this.request(`/api/1/vehicles/${this.vin}/wake_up`);
  }

  /** Navigate to exact coordinates. */
  navigateToCoords(lat, lon) {
    return this.request(`/api/1/vehicles/${this.vin}/command/navigation_gps_request`, {
      lat,
      lon,
      order: 1,
    });
  }

  /** Navigate to a free-text address; the car geocodes it (same as "share to car"). */
  navigateToAddress(address) {
    return this.request(`/api/1/vehicles/${this.vin}/command/navigation_request`, {
      type: 'share_ext_content_raw',
      locale: this.locale,
      timestamp_ms: String(Date.now()),
      value: { 'android.intent.extra.TEXT': address },
    });
  }

  /** Sends a ride's pickup (or dropoff) to the car, waking it first if it is asleep. */
  async sendDestination({ lat, lon, address }) {
    const send = () =>
      lat != null && lon != null ? this.navigateToCoords(lat, lon) : this.navigateToAddress(address);
    if (lat == null && !address) throw new Error('No destination to send');
    try {
      return await send();
    } catch (err) {
      // 408 = vehicle unavailable / asleep
      if (err.status !== 408) throw err;
      await this.wake();
      await new Promise((r) => setTimeout(r, 8000));
      return send();
    }
  }
}
