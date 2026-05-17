#!/usr/bin/env node
/**
 * fetch_drive_times.js
 * -----------------------------------------------------------------
 * Fetches traffic-aware drive times from each destination airport
 * to each dealer's ship-to location using Google Routes API.
 *
 * Reads:  data/dealer_coords.json
 * Writes: data/drive_times.json
 *
 * Usage:
 *   GOOGLE_MAPS_API_KEY=xxx node scripts/fetch_drive_times.js
 *
 * Cost: 45 calls × ~$0.005 = ~$0.23 per refresh
 *   (Routes API: https://mapsplatform.google.com/pricing/)
 *   First $200/month is free credit. Easily within free tier.
 * -----------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!API_KEY) {
  console.error('Missing GOOGLE_MAPS_API_KEY. Set it in .env first.');
  process.exit(1);
}

const COORDS_PATH    = path.join(__dirname, '..', 'data', 'dealer_coords.json');
const OVERRIDES_PATH = path.join(__dirname, '..', 'data', 'dealer_transport_overrides.json');
const OUT_PATH       = path.join(__dirname, '..', 'data', 'drive_times.json');

const coords = JSON.parse(fs.readFileSync(COORDS_PATH, 'utf8'));
const dealers = coords.dealers;
const airports = coords.airports;
const warehouses = coords.warehouses || {};
const overrides = fs.existsSync(OVERRIDES_PATH)
  ? JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'))
  : { hubs: {} };

// Departure time: next Tuesday at 9:00 IST (a representative weekday morning).
// Routes API uses RFC3339; we send a future UTC timestamp.
function nextTuesday9amIST_RFC3339() {
  const now = new Date();
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // IST 09:00 = UTC 03:30
  utc.setUTCHours(3, 30, 0, 0);
  // Roll forward until Tuesday (2)
  while (utc.getUTCDay() !== 2 || utc.getTime() <= Date.now()) {
    utc.setUTCDate(utc.getUTCDate() + 1);
  }
  return utc.toISOString();
}

function postRoutes(body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'routes.googleapis.com',
      path: '/directions/v2:computeRoutes',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.staticDuration'
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 500)));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function fetchOne(originLat, originLng, destLat, destLng, departureTime) {
  const body = {
    origin: { location: { latLng: { latitude: originLat, longitude: originLng } } },
    destination: { location: { latLng: { latitude: destLat, longitude: destLng } } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    departureTime,
    languageCode: 'en-IN',
    units: 'METRIC'
  };
  const resp = await postRoutes(body);
  if (!resp.routes || !resp.routes.length) return null;
  const r = resp.routes[0];
  // duration is a string like "1234s"
  const durSec = parseInt(r.duration);
  const staticSec = r.staticDuration ? parseInt(r.staticDuration) : durSec;
  return {
    km:                 Math.round((r.distanceMeters / 1000) * 10) / 10,
    hours_with_traffic: Math.round((durSec / 3600) * 100) / 100,
    hours_no_traffic:   Math.round((staticSec / 3600) * 100) / 100,
    raw_duration_sec:   durSec
  };
}

// Build extra leg list from overrides:
//   - "via_airport" => need intermediate_airport -> dealer drive
//   - "road_only"   => need warehouse -> dealer drive (covered by warehouse loop)
function buildExtraLegs() {
  const legs = new Map(); // key = `${airportCode}-${dealerId}` -> { airport, dealerId }
  for (const hub of Object.values(overrides.hubs || {})) {
    for (const [dealerId, rule] of Object.entries(hub.overrides || {})) {
      if (rule.mode === 'via_airport' && rule.intermediate) {
        const k = rule.intermediate + '-' + dealerId;
        if (!legs.has(k)) legs.set(k, { airport: rule.intermediate, dealerId });
      }
    }
  }
  return [...legs.values()];
}

async function main() {
  const departureTime = nextTuesday9amIST_RFC3339();
  console.log('Departure time for traffic-aware calc: ' + departureTime + ' (next Tuesday 09:00 IST)\n');

  const out = {
    fetched_at:     new Date().toISOString(),
    source:         'google_routes_api_traffic_aware',
    departure_time: departureTime,
    note:           "hours = traffic-aware drive time (next Tuesday 09:00 IST). hours_no_traffic = ideal/empty road. dealers[id] = dealer's own airport -> dealer. warehouses[hubKey].dealers[id] = warehouse -> dealer. intermediate_airport_to_dealer[airportCode][dealerId] = override transshipment leg.",
    dealers:        {},
    warehouses:     {},
    intermediate_airport_to_dealer: {}
  };

  const dealerIds = Object.keys(dealers).sort((a, b) => +a - +b);

  // Leg 1: dealer.apt -> dealer (existing behavior)
  let done = 0;
  let failed = 0;
  console.log('=== Leg 1: dealer airport -> dealer ('+dealerIds.length+' calls) ===');
  for (const id of dealerIds) {
    const d = dealers[id];
    const apt = airports[d.apt];
    done++;
    process.stdout.write('[' + done + '/' + dealerIds.length + '] ' +
      d.code.padEnd(10) + ' ' + d.city.padEnd(15) + ' from ' + d.apt + ' ... ');
    try {
      const result = await fetchOne(apt.lat, apt.lng, d.lat, d.lng, departureTime);
      if (!result) { console.log('NO ROUTE'); failed++; }
      else {
        out.dealers[id] = {
          dealer_code: d.code, city: d.city, apt: d.apt,
          km: result.km, hours: result.hours_with_traffic, hours_no_traffic: result.hours_no_traffic
        };
        console.log(result.km + 'km · ' + result.hours_with_traffic + 'h');
      }
    } catch (e) { console.log('ERROR ' + e.message); failed++; }
    await new Promise(r => setTimeout(r, 200));
  }

  // Leg 2: warehouse -> all dealers (for road-only mode + <500km default rule)
  for (const [hubKey, wh] of Object.entries(warehouses)) {
    console.log('\n=== Leg 2: ' + wh.name + ' -> all dealers ('+dealerIds.length+' calls) ===');
    out.warehouses[hubKey] = { name: wh.name, lat: wh.lat, lng: wh.lng, dealers: {} };
    let n = 0;
    for (const id of dealerIds) {
      const d = dealers[id];
      n++;
      process.stdout.write('[' + n + '/' + dealerIds.length + '] ' + wh.name + ' -> ' +
        d.code.padEnd(10) + ' ' + d.city.padEnd(15) + ' ... ');
      try {
        const result = await fetchOne(wh.lat, wh.lng, d.lat, d.lng, departureTime);
        if (!result) { console.log('NO ROUTE'); failed++; }
        else {
          out.warehouses[hubKey].dealers[id] = {
            dealer_code: d.code, city: d.city,
            km: result.km, hours: result.hours_with_traffic, hours_no_traffic: result.hours_no_traffic
          };
          console.log(result.km + 'km · ' + result.hours_with_traffic + 'h');
        }
      } catch (e) { console.log('ERROR ' + e.message); failed++; }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Leg 3: intermediate airport -> dealer (only for explicit via_airport overrides)
  const extraLegs = buildExtraLegs();
  console.log('\n=== Leg 3: intermediate airport -> dealer ('+extraLegs.length+' calls) ===');
  let m = 0;
  for (const { airport, dealerId } of extraLegs) {
    const apt = airports[airport];
    const d = dealers[dealerId];
    if (!apt || !d) continue;
    m++;
    process.stdout.write('[' + m + '/' + extraLegs.length + '] ' + airport + ' -> ' +
      d.code.padEnd(10) + ' ' + d.city.padEnd(15) + ' ... ');
    try {
      const result = await fetchOne(apt.lat, apt.lng, d.lat, d.lng, departureTime);
      if (!result) { console.log('NO ROUTE'); failed++; }
      else {
        if (!out.intermediate_airport_to_dealer[airport]) out.intermediate_airport_to_dealer[airport] = {};
        out.intermediate_airport_to_dealer[airport][dealerId] = {
          dealer_code: d.code, city: d.city,
          km: result.km, hours: result.hours_with_traffic, hours_no_traffic: result.hours_no_traffic
        };
        console.log(result.km + 'km · ' + result.hours_with_traffic + 'h');
      }
    } catch (e) { console.log('ERROR ' + e.message); failed++; }
    await new Promise(r => setTimeout(r, 200));
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log('\nWritten: ' + OUT_PATH);
  const totalCalls = dealerIds.length + dealerIds.length * Object.keys(warehouses).length + extraLegs.length;
  console.log('Total calls: ' + totalCalls + ' · failures: ' + failed);

  // Summary: longest dealer-side drives
  console.log('\nLongest dealer airport -> dealer drives (top 10):');
  const all = Object.entries(out.dealers).map(([id, v]) => ({ id, ...v }));
  all.sort((a, b) => b.hours - a.hours);
  for (const d of all.slice(0, 10)) {
    console.log('  ' + d.dealer_code.padEnd(10) + ' ' + d.city.padEnd(15) + ' ' + d.km + 'km / ' + d.hours + 'h');
  }

  // Summary: warehouse -> dealer where < 500km (default road-only candidates)
  for (const [hubKey, w] of Object.entries(out.warehouses)) {
    console.log('\n' + w.name + ' road candidates (warehouse-to-dealer <= 500km):');
    const within = Object.entries(w.dealers)
      .map(([id, v]) => ({ id, ...v }))
      .filter(x => x.km <= 500)
      .sort((a, b) => a.km - b.km);
    for (const d of within) {
      console.log('  ' + d.dealer_code.padEnd(10) + ' ' + d.city.padEnd(15) + ' ' + d.km + 'km / ' + d.hours + 'h');
    }
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
