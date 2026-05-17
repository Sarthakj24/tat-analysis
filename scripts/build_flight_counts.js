#!/usr/bin/env node
/**
 * build_flight_counts.js
 * -----------------------------------------------------------------
 * Builds the canonical data/flight_counts.json by combining:
 *   - data/route_schedule_supplement.json  (scraped flightconnections.com,
 *                                            authoritative for daily count
 *                                            and flight duration)
 *   - data/flight_counts.aeroapi.json      (optional, observed slot mix
 *                                            from AeroAPI historical fetch)
 *
 * If AeroAPI per-slot proportions exist for a route, they're scaled to
 * match the supplement's daily count. Otherwise we distribute the daily
 * count across slots using a default morning-heavy split.
 *
 * Usage: node scripts/build_flight_counts.js
 * -----------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const SUPPLEMENT_PATH = path.join(__dirname, '..', 'data', 'route_schedule_supplement.json');
const AEROAPI_PATH    = path.join(__dirname, '..', 'data', 'flight_counts.aeroapi.json');
const OUT_PATH        = path.join(__dirname, '..', 'data', 'flight_counts.json');

const SLOTS = [
  { id: 1, label: '01-12', start: 1,  end: 12 },
  { id: 2, label: '12-15', start: 12, end: 15 },
  { id: 3, label: '15-18', start: 15, end: 18 },
  { id: 4, label: '18-24', start: 18, end: 24 }
];

// Default distribution when AeroAPI gives no observed split: mirrors typical
// Indian domestic schedule (morning + evening peaks, smaller midday lull).
const DEFAULT_SLOT_WEIGHTS = { 1: 0.38, 2: 0.12, 3: 0.15, 4: 0.35 };

function frequencyFromWeekly(weekly) {
  if (weekly === 0) return { code: 'none',           note: 'No direct flights' };
  if (weekly >= 7)  return { code: 'daily',          note: 'Operates daily (' + weekly + '/week)' };
  if (weekly >= 5)  return { code: 'near-daily',     note: 'Operates ' + weekly + ' days/week' };
  if (weekly >= 3)  return { code: 'alternate-day',  note: 'Operates ' + weekly + ' days/week (roughly every other day)' };
  return { code: 'infrequent', note: 'Only ' + weekly + ' flights/week' };
}

function buildSlotsFromAeroapi(aeroapiRoute, supplementDaily) {
  if (!aeroapiRoute || !Array.isArray(aeroapiRoute.slots)) return null;
  const aeroapiTotal = aeroapiRoute.slots.reduce((s, x) => s + (x.avg_per_day || 0), 0);
  if (aeroapiTotal <= 0) return null;
  const scale = supplementDaily / aeroapiTotal;
  return aeroapiRoute.slots.map(s => {
    const avg = (s.avg_per_day || 0) * scale;
    return {
      slot:           s.slot,
      avg_per_day:    Math.round(avg * 100) / 100,
      rounded_avg:    Math.round(avg),
      flights:        Math.round(avg)
    };
  });
}

function buildSlotsFromDefault(supplementDaily) {
  return SLOTS.map(s => {
    const avg = supplementDaily * DEFAULT_SLOT_WEIGHTS[s.id];
    return {
      slot:        s.label,
      avg_per_day: Math.round(avg * 100) / 100,
      rounded_avg: Math.round(avg),
      flights:     Math.round(avg)
    };
  });
}

function main() {
  const supplement = JSON.parse(fs.readFileSync(SUPPLEMENT_PATH, 'utf8'));
  let aeroapi = null;
  if (fs.existsSync(AEROAPI_PATH)) {
    aeroapi = JSON.parse(fs.readFileSync(AEROAPI_PATH, 'utf8'));
  }

  const out = {
    fetched_at: new Date().toISOString(),
    source: 'flightconnections.com (daily count, duration) + AeroAPI (slot distribution where available)',
    supplement_scraped_at: supplement.scraped_at,
    window_note: 'Daily counts and flight durations sourced from airline-published schedules. Slot distribution follows observed historical pattern (AeroAPI) where present, else a default morning/evening-heavy split.',
    slots: SLOTS,
    routes: {}
  };

  const targetAirports = new Set();
  for (const key of Object.keys(supplement.routes)) {
    const [, dest] = key.split('-');
    targetAirports.add(dest);
  }

  const hubs = ['BOM', 'MAA'];
  for (const hub of hubs) {
    for (const dest of targetAirports) {
      const key = hub + '-' + dest;
      if (hub === dest) {
        out.routes[key] = { origin: hub, destination: dest, same_airport: true };
        continue;
      }
      const sup = supplement.routes[key];
      if (!sup) continue;
      const aeroapiRoute = aeroapi && aeroapi.routes ? aeroapi.routes[key] : null;
      const slots = buildSlotsFromAeroapi(aeroapiRoute, sup.daily)
                 || buildSlotsFromDefault(sup.daily);
      const freq = frequencyFromWeekly(sup.weekly);
      out.routes[key] = {
        origin:            hub,
        destination:       dest,
        weekly_flights:    sup.weekly,
        avg_daily_flights: sup.daily,
        avg_flight_hours:  sup.duration_hours || null,
        airlines:          sup.airlines || '',
        days_observed:     Math.min(7, sup.weekly),
        days_window:       7,
        frequency:         freq.code,
        frequency_note:    freq.note,
        slots,
        total_flights:     sup.weekly,
        per_day_totals:    null
      };
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log('Written:', OUT_PATH);

  // Pretty summary
  console.log('\nRoute'.padEnd(13) + 'Weekly  Daily  Hrs    Frequency');
  console.log('-'.repeat(60));
  for (const [k, r] of Object.entries(out.routes)) {
    if (r.same_airport) { console.log(k.padEnd(13) + 'road only'); continue; }
    console.log(k.padEnd(13)
      + String(r.weekly_flights).padStart(6)
      + String(r.avg_daily_flights).padStart(7)
      + (r.avg_flight_hours ? r.avg_flight_hours.toFixed(2) + 'h' : '   -  ').padStart(8)
      + '   ' + r.frequency);
  }

  const nonDaily = Object.entries(out.routes).filter(([, r]) =>
    !r.same_airport && r.weekly_flights > 0 && r.frequency !== 'daily'
  );
  if (nonDaily.length) {
    console.log('\nNon-daily routes (' + nonDaily.length + '):');
    for (const [k, r] of nonDaily) {
      console.log('  ' + k.padEnd(12) + r.frequency.padEnd(16) + r.frequency_note);
    }
  }
  const zero = Object.entries(out.routes).filter(([, r]) =>
    !r.same_airport && r.weekly_flights === 0
  );
  if (zero.length) {
    console.log('\nNo-direct-flight routes (' + zero.length + ') — road only or via connection:');
    for (const [k] of zero) console.log('  ' + k);
  }
}

main();
