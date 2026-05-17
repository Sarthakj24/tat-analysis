#!/usr/bin/env node
/**
 * fetch_flights.js
 * -----------------------------------------------------------------
 * Fetches flight counts per route per slot using AeroAPI's
 * /airports/{icao}/flights/scheduled_departures endpoint.
 *
 * Strategy: 2 API "trees" total (one per hub airport). Each tree
 * fetches every scheduled departure from that airport, then we
 * filter locally to target dealer airports and bucket by slot.
 * This is far cheaper than 60 origin-destination queries.
 *
 * Output: data/flight_counts.json
 *
 * Usage:
 *   AEROAPI_KEY=xxx node scripts/fetch_flights.js
 *   AEROAPI_KEY=xxx node scripts/fetch_flights.js --days=7
 * -----------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const AEROAPI_KEY = process.env.AEROAPI_KEY;
if (!AEROAPI_KEY) {
  console.error('Missing AEROAPI_KEY. Set it in .env or pass inline.');
  process.exit(1);
}

const DAYS = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '7');

const ORIGINS = ['VABB', 'VOMM'];
const ORIGIN_IATA = { VABB: 'BOM', VOMM: 'MAA' };

const TARGET_DESTS = new Set([
  'COK','MAA','BLR','STV','PNQ','VGA','HYD','BBI','DEL','CCU','AMD','AGR',
  'JAI','BOM','NAG','VTZ','IXC','BDQ','IXJ','IXM','RAJ','DED','RPR','IDR',
  'LKO','ISK','KLH','MYQ','CJB','PAT'
]);

const SLOTS = [
  { id: 1, label: '01-12', start: 1,  end: 12 },
  { id: 2, label: '12-15', start: 12, end: 15 },
  { id: 3, label: '15-18', start: 15, end: 18 },
  { id: 4, label: '18-24', start: 18, end: 24 }
];

function utcToIST(isoString) {
  const m = isoString.match(/T(\d{2}):(\d{2}):\d{2}(Z|[+-]\d{2}:?\d{2})/);
  if (!m) return NaN;
  const utcHr = parseInt(m[1]);
  const utcMin = parseInt(m[2]);
  const tz = m[3];
  let totalMin = utcHr * 60 + utcMin;
  if (tz === 'Z') {
    totalMin += 330;
  } else {
    const om = tz.match(/([+-])(\d{2}):?(\d{2})/);
    if (om) {
      const sign = om[1] === '+' ? 1 : -1;
      const offMin = sign * (parseInt(om[2]) * 60 + parseInt(om[3]));
      totalMin = (totalMin - offMin) + 330;
    }
  }
  totalMin = ((totalMin % 1440) + 1440) % 1440;
  return totalMin / 60;
}

function slotOf(hr) {
  for (const s of SLOTS) if (hr >= s.start && hr < s.end) return s.id;
  return null;
}

function apiGet(reqPath) {
  return new Promise((resolve, reject) => {
    https.request({
      hostname: 'aeroapi.flightaware.com',
      path: '/aeroapi' + reqPath,
      method: 'GET',
      headers: { 'x-apikey': AEROAPI_KEY }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 300)));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Parse: ' + e.message)); }
      });
    }).on('error', reject).end();
  });
}

async function fetchAllDepartures(origin, maxPages = 50) {
  console.log('Fetching scheduled departures from ' + origin + '...');
  let all = [];
  let cursor = '/airports/' + origin + '/flights/scheduled_departures?max_pages=1';
  let pageCount = 0;
  const seenIds = new Set();
  while (cursor && pageCount < maxPages) {
    pageCount++;
    process.stdout.write('  page ' + pageCount + '... ');
    let data;
    try { data = await apiGet(cursor); }
    catch (e) { console.log('FAILED: ' + e.message); break; }
    const rows = data.scheduled_departures || [];
    let added = 0;
    for (const f of rows) {
      const id = f.fa_flight_id || (f.ident + '-' + f.scheduled_out);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      all.push(f);
      added++;
    }
    console.log('+' + added + ' (total ' + all.length + ')');
    cursor = data.links?.next || null;
    if (cursor && !cursor.startsWith('/')) cursor = '/' + cursor.replace(/^\/aeroapi/, '');
    await new Promise(r => setTimeout(r, 300));
  }
  return all;
}

async function main() {
  const result = {
    fetched_at: new Date().toISOString(),
    source: 'aeroapi_scheduled_departures',
    window_note: 'Single-day snapshot. Daily count = total flights observed.',
    slots: SLOTS,
    routes: {}
  };
  const stats = {};

  for (const origin of ORIGINS) {
    const originIATA = ORIGIN_IATA[origin];
    let flights;
    try { flights = await fetchAllDepartures(origin); }
    catch (e) { console.log('  FAILED entirely: ' + e.message); continue; }
    console.log('  Got ' + flights.length + ' total departures from ' + originIATA + '\n');

    const byDestSlot = {};
    let inScope = 0;
    for (const f of flights) {
      const dest = f.destination?.code_iata;
      if (!dest || !TARGET_DESTS.has(dest)) continue;
      const dep = f.scheduled_out;
      if (!dep) continue;
      const hr = utcToIST(dep);
      const slot = slotOf(hr);
      if (!slot) continue;
      inScope++;
      const key = originIATA + '-' + dest;
      if (!byDestSlot[key]) byDestSlot[key] = { 1: 0, 2: 0, 3: 0, 4: 0 };
      byDestSlot[key][slot]++;
    }

    stats[originIATA] = { total_departures: flights.length, in_scope_to_targets: inScope };

    // Emit found routes
    for (const [key, buckets] of Object.entries(byDestSlot)) {
      const [o, d] = key.split('-');
      const total = Object.values(buckets).reduce((a, b) => a + b, 0);
      const freq = total >= 4 ? 'daily' : total >= 2 ? 'low-frequency' : 'alt-day';
      result.routes[key] = {
        origin: o, destination: d,
        slots: SLOTS.map(s => ({ slot: s.label, flights: buckets[s.id], rounded_avg: buckets[s.id] })),
        total_daily: total,
        frequency: freq
      };
    }
    // Emit zero entries for routes with no flights observed (so dashboard knows about them)
    for (const dest of TARGET_DESTS) {
      const key = originIATA + '-' + dest;
      if (originIATA === dest) {
        result.routes[key] = { origin: originIATA, destination: dest, same_airport: true };
        continue;
      }
      if (!result.routes[key]) {
        result.routes[key] = {
          origin: originIATA, destination: dest,
          slots: SLOTS.map(s => ({ slot: s.label, flights: 0, rounded_avg: 0 })),
          note: 'No direct flights observed in snapshot window',
          total_daily: 0, frequency: 'none'
        };
      }
    }
  }

  result.stats = stats;
  const outPath = path.join(__dirname, '..', 'data', 'flight_counts.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\nWritten: ' + outPath);

  // Pretty summary
  console.log('\nSummary:');
  for (const [origin, s] of Object.entries(stats)) {
    console.log('  ' + origin + ' hub: ' + s.total_departures + ' total deps · ' + s.in_scope_to_targets + ' to target dealer airports');
  }
  console.log('\nPer-route slot counts (today\'s snapshot):');
  console.log('Route'.padEnd(12) + SLOTS.map(s => s.label.padStart(8)).join('') + '   Total');
  console.log('-'.repeat(52));
  for (const [key, r] of Object.entries(result.routes)) {
    if (r.same_airport) { console.log(key.padEnd(12) + '   road only'); continue; }
    if (r.total_daily === 0) continue;
    const cells = r.slots.map(s => String(s.flights).padStart(8)).join('');
    console.log(key.padEnd(12) + cells + ('   ' + r.total_daily).padStart(8));
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
