// Heuristic parser that turns raw Lyft Driver ride-request text (from an Android
// notification or the accessibility tree of the request card) into structured data.
//
// Lyft does not publish a format for this text and it changes between app versions,
// so every field is optional and the parser is deliberately tolerant.

const SERVICE_RE =
  /\b(Lyft\s+Lux\s+Black\s+XL|Lyft\s+Lux\s+Black|Lyft\s+Lux|Lux\s+Black\s+XL|Lux\s+Black|Lux|Lyft\s+XL|Extra\s+Comfort|Priority\s+Pickup|Wait\s*&\s*Save|Shared|Lyft\s+Pink|Lyft)\b/i;

// "6 min (1.8 mi)", "6 min · 1.8 mi", "1 hr 5 min (32.1 mi)", "12 mins - 4 miles"
const DURATION_DISTANCE_RE =
  /(?:(\d+)\s*h(?:ou)?rs?\s*)?(\d+)\s*mins?\b\s*(?:\(|·|•|-|–|,)?\s*(\d+(?:\.\d+)?)\s*(mi|miles?|km)\b\)?/gi;

const STREET_SUFFIX =
  '(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Cir|Circle|Sq|Square|Trl|Trail|Plaza|Loop|Row)\\.?';
const ADDRESS_RE = new RegExp(
  `\\b\\d{1,6}(?:-\\d{1,6})?\\s+(?:[NSEW]\\.?\\s+)?[A-Za-z0-9.'\\- ]{1,40}?\\s${STREET_SUFFIX}(?=\\b|,|$)[^\\n]*`,
  'i'
);
const LABELLED_RE = (labels) =>
  new RegExp(`^\\s*(?:${labels})\\s*[:\\-–]?\\s*(.+)$`, 'im');

function toMinutes(hours, minutes) {
  return (hours ? Number(hours) * 60 : 0) + Number(minutes);
}

function toMiles(value, unit) {
  const n = Number(value);
  return /km/i.test(unit) ? +(n * 0.621371).toFixed(2) : n;
}

function cleanAddress(s) {
  return s
    .replace(/\s*[·•|]\s*.*$/, '') // drop trailing "· 6 min" etc.
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,.]$/, '');
}

/**
 * @param {string|{title?:string,text?:string,bigText?:string,lines?:string[]}} input
 * @returns {object} parsed ride request
 */
export function parseLyftRequest(input) {
  const raw =
    typeof input === 'string'
      ? input
      : [input.title, input.text, input.bigText, ...(input.lines || [])]
          .filter(Boolean)
          .join('\n');
  const text = raw.replace(/\r/g, '');
  const ride = {
    isRideRequest: false,
    service: null,
    riderRating: null,
    fare: null,
    pickup: { address: null, etaMin: null, distanceMi: null },
    dropoff: { address: null },
    trip: { durationMin: null, distanceMi: null },
    raw: text,
  };

  const service = text.match(SERVICE_RE);
  if (service) ride.service = service[1].replace(/\s+/g, ' ');

  const rating = text.match(/(\d\.\d{1,2})\s*(?:★|⭐|stars?\b)|\brating[:\s]+(\d\.\d{1,2})/i);
  if (rating) ride.riderRating = Number(rating[1] || rating[2]);

  const fare = text.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/);
  if (fare) ride.fare = Number(fare[1]);

  // Collect every "duration (distance)" pair along with the text around it.
  const pairs = [];
  for (const m of text.matchAll(DURATION_DISTANCE_RE)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    pairs.push({
      minutes: toMinutes(m[1], m[2]),
      miles: toMiles(m[3], m[4]),
      context: `${before} ${after}`.toLowerCase(),
    });
  }
  const isPickup = (p) => /away|pickup|pick-up|to rider/.test(p.context);
  const isTrip = (p) => /trip|ride\b|long|total/.test(p.context);
  const pickupPair = pairs.find(isPickup) || pairs.find((p) => !isTrip(p));
  const tripPair =
    pairs.find((p) => p !== pickupPair && isTrip(p)) || pairs.find((p) => p !== pickupPair);
  if (pickupPair) {
    ride.pickup.etaMin = pickupPair.minutes;
    ride.pickup.distanceMi = pickupPair.miles;
  }
  if (tripPair) {
    ride.trip.durationMin = tripPair.minutes;
    ride.trip.distanceMi = tripPair.miles;
  }

  const pickupLabel = text.match(LABELLED_RE('pick\\s?-?up(?:\\s+at)?|pickup location'));
  const dropLabel = text.match(LABELLED_RE('drop\\s?-?off(?:\\s+at)?|destination|heading to'));
  if (pickupLabel) ride.pickup.address = cleanAddress(pickupLabel[1]);
  if (dropLabel) ride.dropoff.address = cleanAddress(dropLabel[1]);

  if (!ride.pickup.address || !ride.dropoff.address) {
    const addressLines = text
      .split('\n')
      .map((l) => l.match(ADDRESS_RE))
      .filter(Boolean)
      .map((m) => cleanAddress(m[0]))
      .filter((a) => a !== ride.pickup.address && a !== ride.dropoff.address);
    if (!ride.pickup.address && addressLines.length) ride.pickup.address = addressLines.shift();
    if (!ride.dropoff.address && addressLines.length) ride.dropoff.address = addressLines.shift();
  }
  // Pickup text like "6 min away · Mission St & 16th St" has no house number.
  if (!ride.pickup.address) {
    const near = text.match(/away\s*[·•\-–,]\s*([^\n·•]{4,80})/i);
    if (near && !/\$|\bmin\b/.test(near[1])) ride.pickup.address = cleanAddress(near[1]);
  }

  ride.isRideRequest =
    /\b(ride|trip)?\s*request\b|\bnew ride\b|\baccept\b/i.test(text) ||
    (ride.pickup.etaMin != null && (ride.fare != null || ride.service != null));

  return ride;
}

/**
 * Adds earnings metrics and a simple go / maybe / skip verdict.
 * The verdict is advisory only: the driver still accepts in the Lyft app.
 */
export function scoreRide(ride, prefs = {}) {
  const {
    minFare = 0,
    minPerMile = 1.0,
    minPerHour = 25,
    maxPickupMin = 12,
    minRating = 4.7,
  } = prefs;
  const totalMin = (ride.pickup.etaMin || 0) + (ride.trip.durationMin || 0);
  const totalMi = (ride.pickup.distanceMi || 0) + (ride.trip.distanceMi || 0);
  const metrics = {
    perMile: ride.fare != null && totalMi > 0 ? +(ride.fare / totalMi).toFixed(2) : null,
    perHour: ride.fare != null && totalMin > 0 ? +((ride.fare / totalMin) * 60).toFixed(2) : null,
    totalMin: totalMin || null,
    totalMi: totalMi ? +totalMi.toFixed(2) : null,
  };

  const reasons = [];
  if (ride.fare != null && ride.fare < minFare) reasons.push(`fare under $${minFare}`);
  if (metrics.perMile != null && metrics.perMile < minPerMile)
    reasons.push(`$${metrics.perMile}/mi under $${minPerMile}`);
  if (metrics.perHour != null && metrics.perHour < minPerHour)
    reasons.push(`$${metrics.perHour}/hr under $${minPerHour}`);
  if (ride.pickup.etaMin != null && ride.pickup.etaMin > maxPickupMin)
    reasons.push(`pickup ${ride.pickup.etaMin} min away`);
  if (ride.riderRating != null && ride.riderRating < minRating)
    reasons.push(`rider rating ${ride.riderRating}`);

  const known = [metrics.perMile, metrics.perHour, ride.pickup.etaMin].filter((v) => v != null);
  const verdict = reasons.length >= 2 ? 'skip' : reasons.length === 1 || known.length === 0 ? 'maybe' : 'go';
  return { ...metrics, verdict, reasons };
}
