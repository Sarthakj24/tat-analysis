#!/usr/bin/env node
/**
 * fetch_flights.js
 * -----------------------------------------------------------------
 * Fetches per-route flight counts averaged over the last 7 IST days
 * using AeroAPI's /airports/{icao}/flights/departures (historical actuals).
 *
 * Strategy: pull all past departures from each hub for a 7-day
 * historical window, bucket by (destination, IST date, IST slot), then
 * compute per-slot averages and a frequency label per route.
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

const IST_OFFSET_MIN = 330;

// Parse a UTC ISO string and return { istDate: 'YYYY-MM-DD', istHour: float }
function toIST(isoString) {
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return null;
  const ist = new Date(t + IST_OFFSET_MIN * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  const istHour = ist.getUTCHours() + ist.getUTCMinutes() / 60;
  return { istDate: `${y}-${m}-${d}`, istHour };
}

function slotOf(hr) {
  for (const s of SLOTS) if (hr >= s.start && hr < s.end) return s.id;
  return null;
}

// Build the list of past IST dates we want (most recent COMPLETE day backwards).
function pastIstDates(nDays) {
  // "Today" in IST
  const nowMs = Date.now();
  const nowIst = new Date(nowMs + IST_OFFSET_MIN * 60 * 1000);
  // Start from yesterday (today in IST may be incomplete)
  const result = [];
  for (let i = nDays; i >= 1; i--) {
    const dt = new Date(nowIst);
    dt.setUTCDate(dt.getUTCDate() - i);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    result.push(`${y}-${m}-${d}`);
  }
  return result;
}

// Given the inclusive IST date range, compute the UTC start (exclusive lower bound
// of the first IST day at 00:00 IST) and UTC end (00:00 IST after the last day).
function istRangeToUtcWindow(istDates) {
  const first = istDates[0];
  const last = istDates[istDates.length - 1];
  const [fy, fm, fd] = first.split('-').map(Number);
  const [ly, lm, ld] = last.split('-').map(Number);
  // 00:00 IST = previous day 18:30 UTC
  const startMs = Date.UTC(fy, fm - 1, fd, 0, 0, 0) - IST_OFFSET_MIN * 60 * 1000;
  const endMs   = Date.UTC(ly, lm - 1, ld, 0, 0, 0) - IST_OFFSET_MIN * 60 * 1000 + 24 * 3600 * 1000;
  return { startISO: new Date(startMs).toISOString(), endISO: new Date(endMs).toISOString() };
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

async function fetchDeparturesInWindow(origin, startISO, endISO, maxPages = 400) {
  console.log(`Fetching historical departures from ${origin} (${startISO} → ${endISO})...`);
  const all = [];
  const seenIds = new Set();
  const params = new URLSearchParams({ start: startISO, end: endISO, max_pages: '1' });
  let cursor = `/airports/${origin}/flights/departures?${params.toString()}`;
  let pageCount = 0;
  while (cursor && pageCount < maxPages) {
    pageCount++;
    let data;
    try { data = await apiGet(cursor); }
    catch (e) { console.log('  page ' + pageCount + ' FAILED: ' + e.message); break; }
    const rows = data.departures || data.scheduled_departures || [];
    let added = 0;
    for (const f of rows) {
      const id = f.fa_flight_id || (f.ident + '-' + f.scheduled_out);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      all.push(f);
      added++;
    }
    if (pageCount % 10 === 0 || added === 0) {
      console.log(`  page ${pageCount}: +${added} (total ${all.length})`);
    }
    cursor = data.links?.next || null;
    if (cursor && !cursor.startsWith('/')) cursor = '/' + cursor.replace(/^\/aeroapi/, '');
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`  Done: ${all.length} flights across ${pageCount} pages`);
  return all;
}

function frequencyLabel(daysObserved, daysWindow) {
  if (daysObserved === 0) return { code: 'none', note: 'No departures observed in window' };
  if (daysObserved === daysWindow) return { code: 'daily', note: `Operates every day (${daysObserved}/${daysWindow})` };
  if (daysObserved >= daysWindow - 1) return { code: 'near-daily', note: `Operates ${daysObserved}/${daysWindow} days` };
  if (daysObserved >= Math.ceil(daysWindow * 0.5)) return { code: 'alternate-day', note: `Operates ${daysObserved}/${daysWindow} days (roughly every other day)` };
  if (daysObserved >= 2) return { code: 'infrequent', note: `Only ${daysObserved}/${daysWindow} days had departures` };
  return { code: 'rare', note: `Only ${daysObserved}/${daysWindow} days had departures` };
}

async function main() {
  const istDates = pastIstDates(DAYS);
  const { startISO, endISO } = istRangeToUtcWindow(istDates);
  console.log(`Window: ${istDates[0]} → ${istDates[istDates.length - 1]} IST (${DAYS} days)`);
  console.log(`UTC: ${startISO} → ${endISO}\n`);

  const result = {
    fetched_at: new Date().toISOString(),
    source: 'aeroapi_departures_historical',
    window: { ist_dates: istDates, utc_start: startISO, utc_end: endISO, days: DAYS },
    window_note: `Per-slot counts are rounded daily averages over the past ${DAYS} IST days.`,
    slots: SLOTS,
    routes: {}
  };
  const stats = {};

  for (const origin of ORIGINS) {
    const originIATA = ORIGIN_IATA[origin];
    let flights;
    try { flights = await fetchDeparturesInWindow(origin, startISO, endISO); }
    catch (e) { console.log('  FAILED entirely: ' + e.message); continue; }

    // route -> istDate -> { slotId: count, total: count }
    const perRouteDay = {};
    // route -> [durations in hours] (block time, preferring actual over scheduled)
    const perRouteDurations = {};
    let inScope = 0;
    for (const f of flights) {
      const dest = f.destination?.code_iata;
      if (!dest || !TARGET_DESTS.has(dest)) continue;
      const dep = f.scheduled_out || f.actual_out;
      if (!dep) continue;
      const ist = toIST(dep);
      if (!ist || !istDates.includes(ist.istDate)) continue;
      const slot = slotOf(ist.istHour);
      if (!slot) continue;
      inScope++;
      const key = originIATA + '-' + dest;
      if (!perRouteDay[key]) perRouteDay[key] = {};
      if (!perRouteDay[key][ist.istDate]) perRouteDay[key][ist.istDate] = { 1: 0, 2: 0, 3: 0, 4: 0, total: 0 };
      perRouteDay[key][ist.istDate][slot]++;
      perRouteDay[key][ist.istDate].total++;

      // Block-to-block duration: prefer actuals, fall back to scheduled
      const outT = Date.parse(f.actual_out || f.scheduled_out);
      const inT  = Date.parse(f.actual_in  || f.scheduled_in);
      if (Number.isFinite(outT) && Number.isFinite(inT) && inT > outT) {
        const hrs = (inT - outT) / 3600000;
        if (hrs > 0.1 && hrs < 12) {  // sanity: 6 min to 12 hours
          if (!perRouteDurations[key]) perRouteDurations[key] = [];
          perRouteDurations[key].push(hrs);
        }
      }
    }

    stats[originIATA] = {
      total_departures_in_window: flights.length,
      in_scope_to_targets:        inScope,
      days_in_window:             DAYS
    };

    for (const [key, byDay] of Object.entries(perRouteDay)) {
      const [o, d] = key.split('-');
      const daysObserved = Object.keys(byDay).length;
      const slotTotals = { 1: 0, 2: 0, 3: 0, 4: 0 };
      const perDayTotals = istDates.map(date => byDay[date]?.total || 0);
      const totalFlights = perDayTotals.reduce((a, b) => a + b, 0);
      for (const counts of Object.values(byDay)) {
        for (const s of [1, 2, 3, 4]) slotTotals[s] += counts[s];
      }
      const freq = frequencyLabel(daysObserved, DAYS);
      const durs = perRouteDurations[key] || [];
      const avgDuration = durs.length
        ? durs.reduce((a, b) => a + b, 0) / durs.length
        : null;
      result.routes[key] = {
        origin: o,
        destination: d,
        days_observed: daysObserved,
        days_window: DAYS,
        frequency: freq.code,
        frequency_note: freq.note,
        avg_flight_hours: avgDuration != null ? Math.round(avgDuration * 100) / 100 : null,
        duration_sample_size: durs.length,
        slots: SLOTS.map(s => {
          const total = slotTotals[s.id];
          const avg = total / DAYS;
          return {
            slot:         s.label,
            total_flights: total,
            avg_per_day:   Math.round(avg * 100) / 100,
            rounded_avg:   Math.round(avg),
            // legacy alias: dashboard falls back to .flights if rounded_avg missing
            flights:       Math.round(avg)
          };
        }),
        total_flights:     totalFlights,
        avg_daily_flights: Math.round((totalFlights / DAYS) * 100) / 100,
        per_day_totals:    perDayTotals
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
          days_observed: 0, days_window: DAYS,
          frequency: 'none',
          frequency_note: 'No direct flights observed in 7-day window',
          slots: SLOTS.map(s => ({
            slot: s.label, total_flights: 0, avg_per_day: 0, rounded_avg: 0, flights: 0
          })),
          total_flights: 0,
          avg_daily_flights: 0,
          per_day_totals: istDates.map(() => 0)
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
    console.log(`  ${origin} hub: ${s.total_departures_in_window} total deps · ${s.in_scope_to_targets} to target dealer airports over ${s.days_in_window} days`);
  }
  console.log(`\nPer-route averages (avg per day over ${DAYS} IST days):`);
  console.log('Route'.padEnd(12) + SLOTS.map(s => s.label.padStart(8)).join('') + '  Avg/day  Days  FlightHrs  Frequency');
  console.log('-'.repeat(92));
  for (const [key, r] of Object.entries(result.routes)) {
    if (r.same_airport) { console.log(key.padEnd(12) + '   road only'); continue; }
    if (r.total_flights === 0) continue;
    const cells = r.slots.map(s => (s.avg_per_day.toFixed(1)).padStart(8)).join('');
    const flightHrsStr = r.avg_flight_hours != null ? r.avg_flight_hours.toFixed(2) + 'h' : '   —  ';
    console.log(key.padEnd(12) + cells +
      ('  ' + r.avg_daily_flights.toFixed(1)).padStart(9) +
      ('  ' + r.days_observed + '/' + r.days_window).padStart(6) +
      ('  ' + flightHrsStr).padStart(11) +
      '  ' + r.frequency);
  }

  // Routes that are not daily get a special call-out
  const nonDaily = Object.entries(result.routes).filter(([, r]) =>
    !r.same_airport && r.total_flights > 0 && r.frequency !== 'daily'
  );
  if (nonDaily.length) {
    console.log(`\nNon-daily routes (${nonDaily.length}):`);
    for (const [key, r] of nonDaily) {
      console.log(`  ${key.padEnd(12)} ${r.frequency.padEnd(15)} — ${r.frequency_note}`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
