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

const COORDS_PATH = path.join(__dirname, '..', 'data', 'dealer_coords.json');
const OUT_PATH    = path.join(__dirname, '..', 'data', 'drive_times.json');

const coords = JSON.parse(fs.readFileSync(COORDS_PATH, 'utf8'));
const dealers = coords.dealers;
const airports = coords.airports;

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

async function main() {
  const departureTime = nextTuesday9amIST_RFC3339();
  console.log('Departure time for traffic-aware calc: ' + departureTime + ' (next Tuesday 09:00 IST)\n');

  const out = {
    fetched_at:     new Date().toISOString(),
    source:         'google_routes_api_traffic_aware',
    departure_time: departureTime,
    note:           "hours = traffic-aware drive time (next Tuesday 09:00 IST). hours_no_traffic = ideal/empty road.",
    dealers:        {}
  };

  const dealerIds = Object.keys(dealers).sort((a, b) => +a - +b);
  let done = 0;
  let failed = 0;
  for (const id of dealerIds) {
    const d = dealers[id];
    const apt = airports[d.apt];
    done++;
    process.stdout.write('[' + done + '/' + dealerIds.length + '] ' +
      d.code.padEnd(10) + ' ' + d.city.padEnd(15) + ' from ' + d.apt + ' ... ');
    try {
      const result = await fetchOne(apt.lat, apt.lng, d.lat, d.lng, departureTime);
      if (!result) {
        console.log('NO ROUTE');
        failed++;
      } else {
        out.dealers[id] = {
          dealer_code:  d.code,
          city:         d.city,
          apt:          d.apt,
          km:           result.km,
          hours:        result.hours_with_traffic,
          hours_no_traffic: result.hours_no_traffic
        };
        console.log(result.km + ' km · ' +
          result.hours_with_traffic + 'h (traffic) · ' +
          result.hours_no_traffic + 'h (free)');
      }
    } catch (e) {
      console.log('ERROR ' + e.message);
      failed++;
    }
    await new Promise(r => setTimeout(r, 250));
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log('\nWritten: ' + OUT_PATH);
  console.log('Success: ' + (dealerIds.length - failed) + '/' + dealerIds.length);

  // Summary
  console.log('\nLongest drives (top 10):');
  const all = Object.entries(out.dealers).map(([id, v]) => ({ id, ...v }));
  all.sort((a, b) => b.hours - a.hours);
  for (const d of all.slice(0, 10)) {
    console.log('  ' + d.dealer_code.padEnd(10) + ' ' + d.city.padEnd(15) +
      ' ' + d.km + 'km / ' + d.hours + 'h');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
