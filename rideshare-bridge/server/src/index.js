import { createApp } from './app.js';
import { TeslaClient } from './tesla.js';

const env = process.env;
const num = (v, d) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const tesla = new TeslaClient({
  baseUrl: env.TESLA_API_BASE || undefined,
  accessToken: env.TESLA_ACCESS_TOKEN,
  refreshToken: env.TESLA_REFRESH_TOKEN,
  clientId: env.TESLA_CLIENT_ID,
  vin: env.TESLA_VIN,
  locale: env.TESLA_LOCALE || 'en-US',
});

const { server } = createApp({
  token: env.BRIDGE_TOKEN,
  tesla,
  autoNavigate: env.AUTO_NAVIGATE || 'accepted',
  prefs: {
    minFare: num(env.MIN_FARE, 0),
    minPerMile: num(env.MIN_PER_MILE, 1.0),
    minPerHour: num(env.MIN_PER_HOUR, 25),
    maxPickupMin: num(env.MAX_PICKUP_MIN, 12),
    minRating: num(env.MIN_RIDER_RATING, 4.7),
  },
});

const port = num(env.PORT, 8787);
server.listen(port, () => {
  console.log(`RideBridge listening on :${port}  (Tesla ${tesla.configured ? 'configured' : 'not configured'})`);
});
