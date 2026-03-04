# Search V2 Ops Runbook

Search is now V2-only. There is no runtime V1 fallback path.

## Runtime Artifacts

The search runtime requires:

- `data/stops-search-index.v1.json` (primary V2 index)
- `data/search-corrections.json` (query correction dictionary)
- `data/stops-enriched.json` (direction metadata enrichment)

Optional/analysis artifacts are not required for search serving.

## Prerequisites

1. Full MTA GTFS `stops.txt` file available locally.
2. `bun` installed for data build scripts.
3. Deploy pipeline that ships required `data/` artifacts with the app.

## Build Artifacts

From repo root:

```bash
bun run data:build-stop-search-index -- /path/to/stops.txt data/stops-search-index.v1.json
```

Optional enrichment refresh:

```bash
bun run data:build-enriched-stops -- data/gtfs data/stops-enriched.json
```

Optional sanity check:

```bash
npm run build
```

## Deploy

Deploy/restart normally. No search mode env toggles are needed.

## Verification Checklist

Run these checks after deployment:

1. Basic endpoint health:
   - `GET /api/stops/search?q=3%20av%2023%20st`
2. Typo tolerance:
   - `GET /api/stops/search?q=thrid%20av%2023%20strt`
3. Intersection parsing:
   - `GET /api/stops/search?q=3rd%20avenue%20and%2023rd%20street%20southbound`
4. Nearby endpoint:
   - `GET /api/stops/nearby?lat=40.739&lon=-73.983`
5. Non-prod debug payload:
   - `GET /api/stops/search?q=thrid%20av&debug=1`

Expected:
- Normal search response is array of `{ code, name, distanceMeters? }`.
- Debug response reports `engine: "v2"`.
- Relevant stops are returned for misspellings and intersection phrasing.

## Failure Behavior

If `data/stops-search-index.v1.json` is missing or invalid, search and nearby endpoints return empty result sets and log server errors until the artifact is restored.

## Updating Corrections

Edit `data/search-corrections.json`, then rebuild and deploy:

```bash
bun run data:build-stop-search-index -- /path/to/stops.txt data/stops-search-index.v1.json
```
