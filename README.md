# 82AD Talent Spotter

Small Next.js app for scanning public CRCON Hell Let Loose game stats and storing high-KPM player sightings.
Spotted players are enriched with their HLLRecords 180d competitive KPM when their profile can be scraped.

## Spotting Rules

A player is stored when:

- Kills are greater than `40`
- KPM is greater than `1.00`
- At least `70%` of kills are from:
  - `infantry`
  - `sniper`
  - `machine_gun`
- The player is not on any active HCA roster in the shared database

## Local Setup

```powershell
npm install
copy .env.example .env
npx prisma migrate dev
npm run dev
```

## Railway

1. Use the same Railway Postgres database as HCA-Roster, or a database containing the HCA `Player` and `RosterEntry` tables.
2. Set `DATABASE_URL` on the app service.
3. Deploy this repo.
4. Use the default start command, or set Railway's start command to:

```bash
npm start
```

`npm start` runs `prisma migrate deploy` before starting Next.js, so the app tables are created in the shared database.
It also starts the background poller. By default, tracked servers are checked every 2 hours; override this with
`POLL_INTERVAL_MINUTES`.
HLLRecords KPM enrichment runs separately every 30 minutes in small batches; override the interval with
`HLLRECORDS_KPM_INTERVAL_MINUTES` and batch size with `HLLRECORDS_REFRESH_LIMIT`.
The 82AD tab reads its two server URLs from `EIGHTYSECOND_SERVER_URLS` and scans a recent page size set by
`EIGHTYSECOND_SCAN_PAGE_LIMIT`.

The included Dockerfile installs Python, Playwright, and Chromium for the HLLRecords profile KPM scrape.

## Useful Test URLs

```text
https://greyrcon.de:81/games/5774
https://server1.82nd.gg/games/83554
```

## Notes

- Add a tracked server by base URL, e.g. `https://server1.82nd.gg`.
- `Scan recent games` reads `/api/get_scoreboard_maps` and skips games already processed.
- `Scan one game` accepts a direct `/games/<id>` link.
- Framed stats domains such as `http://stats.fll.fi` are resolved to their real CRCON backend URL automatically.
- If a tracked server returns HTML or a temporary 502 instead of JSON, the poll records that server as failed and keeps scanning the others.
