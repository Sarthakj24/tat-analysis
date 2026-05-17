# Warehouse Now · TAT Dashboard

Interactive transit-time analyzer for the Warehouse Now → VinFast dealer network.
Compares two hubs (Bhiwandi → BOM airport, Sriperumbudur → MAA airport) and shows
cutoff/delivery times across 45 dealers and 4 daily flight slots.

## Live data sources

This dashboard reads two JSON files from `data/`:

- `flight_counts.json` — per-route per-slot flight frequency (from AeroAPI)
- `drive_times.json` — destination airport → dealer drive times (from Google Routes API)

If either file is missing, the dashboard falls back to baked-in defaults and shows
"EST." badges in the header instead of "LIVE".

## Setup

```bash
git clone <your-repo-url>
cd warehousenow-tat
cp .env.example .env
# Edit .env, paste your AEROAPI_KEY and GOOGLE_MAPS_API_KEY
```

## Refresh data (run monthly or before client meetings)

```bash
# Fetch latest flight frequencies (~$0.30 in AeroAPI credits)
node scripts/fetch_flights.js

# Fetch airport→dealer drive times with traffic (~$0.50 in Google Maps credit)
node scripts/fetch_drive_times.js

# Commit and push — Render auto-redeploys
git add data/
git commit -m "Refresh flight + drive time data"
git push
```

## Local preview

Open `index.html` in any browser. For local server (so JSON fetches work):

```bash
npx serve .
# Then open http://localhost:3000
```

## Deploy to Render

1. Push this repo to GitHub
2. On render.com, click "New" → "Static Site"
3. Connect your GitHub repo
4. **Build command:** leave empty
5. **Publish directory:** `./`
6. Click Deploy → Render gives you a `https://<name>.onrender.com` URL

Every `git push` auto-redeploys in ~60 seconds.

## File structure

```
.
├── index.html              ← The dashboard (single-file React app)
├── data/
│   ├── flight_counts.json  ← AeroAPI output (per-route per-slot)
│   ├── drive_times.json    ← Google Routes output (per-dealer)
│   └── dealer_coords.json  ← Source coordinates for the 45 dealers
├── scripts/
│   ├── fetch_flights.js    ← AeroAPI fetcher
│   └── fetch_drive_times.js ← Google Routes fetcher
├── .env.example            ← Template for API keys
├── .gitignore              ← Excludes .env and node_modules
└── README.md
```

## API key safety

- `.env` is gitignored. Your real keys NEVER get committed.
- Both API keys stay on your machine — they never reach the public dashboard.
- The browser dashboard only ever reads pre-computed JSON files.

## AI Analyst tab

The AI Analyst tab only works inside Claude's artifact environment because it
calls `api.anthropic.com` directly. On a hosted deployment, this tab will fail
with a CORS error. To enable it on hosted versions, you'd need a backend proxy
(small Node service on Render Web Service free tier) holding your Anthropic key.
Not built — ask if needed.

## Notes

- Slots are fixed: 01-12, 12-15, 15-18, 18-24 (IST).
- Flight counts in the "Slots × Flights" tab are editable inline.
- Per-dealer km / flight hour overrides available in the Master Table drilldown.
