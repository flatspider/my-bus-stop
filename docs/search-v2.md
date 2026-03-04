# Search V2 Ops Runbook

This runbook covers how to build, deploy, verify, and roll back Search V2.

## What Search V2 uses

- `data/stops-index.json` (legacy index, still used for compatibility)
- `data/stops-search-index.v1.json` (rich V2 artifact)
- `data/search-corrections.json` (misspelling/correction dictionary)

## Prerequisites

1. Full MTA GTFS `stops.txt` file available locally.
2. `bun` installed for data build scripts.
3. Deploy pipeline that ships `data/` artifacts with the app.

## Build Artifacts

From repo root:

```bash
bun run data:build-stop-index -- /path/to/stops.txt data/stops-index.json
bun run data:build-stop-search-index -- /path/to/stops.txt data/stops-search-index.v1.json
```

Optional quick sanity check:

```bash
npm run build
```

## Deploy and Rollout

### 1) Deploy with V2 disabled (safe default)

Set env:

```bash
SEARCH_V2_ENABLED=false
```

Deploy normally.

### 2) Enable shadow compare (recommended before full cutover)

Set env:

```bash
SEARCH_V2_ENABLED=true
SEARCH_V2_SHADOW_COMPARE=true
```

This serves V2 results and logs top-result differences vs V1.

### 3) Full V2 rollout

Set env:

```bash
SEARCH_V2_ENABLED=true
SEARCH_V2_SHADOW_COMPARE=false
```

## Verification Checklist

Run these checks after deployment:

1. Basic endpoint health:
   - `GET /api/stops/search?q=3%20av%2023%20st`
2. Typo tolerance:
   - `GET /api/stops/search?q=thrid%20av%2023%20strt`
3. Intersection parsing:
   - `GET /api/stops/search?q=3rd%20avenue%20and%2023rd%20street%20southbound`
4. Nearby endpoint unchanged:
   - `GET /api/stops/nearby?lat=40.739&lon=-73.983`
5. Non-prod debug payload:
   - `GET /api/stops/search?q=thrid%20av&debug=1`

Expected:
- Response shape for normal search remains array of `{ code, name, distanceMeters? }`.
- Relevant stops are returned for misspellings and intersection phrasing.

## Rollback

If ranking quality regresses or latency spikes:

1. Set:

```bash
SEARCH_V2_ENABLED=false
SEARCH_V2_SHADOW_COMPARE=false
```

2. Redeploy/restart service.

3. Verify legacy behavior:
   - `GET /api/stops/search?q=3%20av%2023%20st`

No schema migration rollback is needed because Search V1 path remains intact.

## Updating Corrections

Edit `data/search-corrections.json` with new mappings, then rebuild artifact:

```bash
bun run data:build-stop-search-index -- /path/to/stops.txt data/stops-search-index.v1.json
```

Deploy updated artifacts.
