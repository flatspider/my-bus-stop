import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { SnapshotEntry } from "../server/types.ts"

const inputArg = process.argv[2]
const JSONL_PATH = inputArg
  ? path.resolve(inputArg)
  : path.join(process.cwd(), "data", "snapshots.jsonl")
const now = new Date()
const reportStamp = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`
const REPORT_PATH = path.join(process.cwd(), "data", `ghost-report-${reportStamp}.md`)

// --- Constants ---
const ETA_THRESHOLD_MIN = 20 // only care about predictions within 20 min
const ETA_DISAGREEMENT_MIN = 5 // GTFS-RT must be 5+ min more optimistic than SIRI

// --- Types ---

interface MisleadingMoment {
  timestamp: string
  route: string
  tripId: string | null
  vehicleId: string
  type: "phantom" | "eta_lie"
  gtfsEtaMin: number
  siriEtaMin: number | null // null for phantoms
  discrepancyMin: number // how far off GTFS-RT was
  isFallback: boolean
}

// --- Load snapshots ---
async function loadSnapshots(): Promise<SnapshotEntry[]> {
  const raw = await readFile(JSONL_PATH, "utf-8")
  const trimmed = raw.trim()

  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as SnapshotEntry[]
  }

  return trimmed
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SnapshotEntry)
}

// --- Scan every snapshot for misleading moments ---
function findMisleadingMoments(snapshots: SnapshotEntry[]): MisleadingMoment[] {
  const moments: MisleadingMoment[] = []

  for (const snap of snapshots) {
    const nowEpoch = Math.floor(new Date(snap.timestamp).getTime() / 1000)

    // Build set of tripIds SIRI is showing right now + their ETAs
    const siriTrips = new Map<string, { siriEta: number | null; vehicleId: string }>()
    for (const v of snap.vehicles) {
      if (v.tripId) {
        siriTrips.set(v.tripId, { siriEta: v.siriEtaMinutes, vehicleId: v.vehicleId })
      }
    }

    // Type 1: Phantom trips — GTFS-RT shows a trip with near-term ETA, SIRI has no record
    for (const g of snap.gtfsOnlyTrips) {
      if (g.arrivalTime == null) continue
      const gtfsEta = Math.round((g.arrivalTime - nowEpoch) / 60)
      if (gtfsEta < 0 || gtfsEta >= ETA_THRESHOLD_MIN) continue

      moments.push({
        timestamp: snap.timestamp,
        route: g.routeId,
        tripId: g.tripId,
        vehicleId: g.vehicleId,
        type: "phantom",
        gtfsEtaMin: gtfsEta,
        siriEtaMin: null,
        discrepancyMin: gtfsEta, // entire ETA is a lie — no SIRI bus at all
        isFallback: g.isFallback,
      })
    }

    // Type 2: ETA lies — both systems show the trip, but GTFS-RT is way more optimistic
    for (const v of snap.vehicles) {
      if (v.gtfsArrivalTime == null || v.siriEtaMinutes == null) continue
      const gtfsEta = Math.round((v.gtfsArrivalTime - nowEpoch) / 60)
      if (gtfsEta < 0 || v.siriEtaMinutes > ETA_THRESHOLD_MIN) continue

      const discrepancy = v.siriEtaMinutes - gtfsEta // positive = GTFS too optimistic
      if (discrepancy >= ETA_DISAGREEMENT_MIN) {
        moments.push({
          timestamp: snap.timestamp,
          route: v.route,
          tripId: v.tripId,
          vehicleId: v.vehicleId,
          type: "eta_lie",
          gtfsEtaMin: gtfsEta,
          siriEtaMin: v.siriEtaMinutes,
          discrepancyMin: discrepancy,
          isFallback: v.gtfsDelay === 0, // delay=0 is a strong fallback signal
        })
      }
    }
  }

  return moments
}

// --- Report ---
function generateReport(snapshots: SnapshotEntry[], moments: MisleadingMoment[]): string {
  const phantoms = moments.filter((m) => m.type === "phantom")
  const etaLies = moments.filter((m) => m.type === "eta_lie")

  const timeRange = snapshots.length > 0
    ? `${snapshots[0].timestamp} → ${snapshots[snapshots.length - 1].timestamp}`
    : "no data"

  // --- Metric A: Unique ghost trips ---
  // Denominator: unique tripIds seen in GTFS-RT with ETA < 20min
  const allGtfsTrips = new Set<string>()
  for (const snap of snapshots) {
    const nowEpoch = Math.floor(new Date(snap.timestamp).getTime() / 1000)
    for (const g of snap.gtfsOnlyTrips) {
      if (g.arrivalTime == null || !g.tripId) continue
      const eta = Math.round((g.arrivalTime - nowEpoch) / 60)
      if (eta >= 0 && eta < ETA_THRESHOLD_MIN) allGtfsTrips.add(g.tripId)
    }
    for (const v of snap.vehicles) {
      if (v.gtfsArrivalTime == null || !v.tripId) continue
      const eta = Math.round((v.gtfsArrivalTime - nowEpoch) / 60)
      if (eta >= 0 && eta < ETA_THRESHOLD_MIN) allGtfsTrips.add(v.tripId)
    }
  }

  // Numerator: unique tripIds with at least one misleading moment
  const ghostTrips = new Set(moments.map((m) => m.tripId).filter(Boolean))
  const ghostTripRate = allGtfsTrips.size > 0
    ? ((ghostTrips.size / allGtfsTrips.size) * 100).toFixed(1)
    : "0.0"

  // Unique trips by type
  const phantomTrips = new Set(phantoms.map((m) => m.tripId).filter(Boolean))
  const etaLieTrips = new Set(etaLies.map((m) => m.tripId).filter(Boolean))

  // --- Metric B: Snapshot exposure rate ---
  const snapshotsWithGhost = new Set(moments.map((m) => m.timestamp))
  const snapshotExposureRate = snapshots.length > 0
    ? ((snapshotsWithGhost.size / snapshots.length) * 100).toFixed(1)
    : "0.0"

  // --- Metric C: Route breakdown (unique trips) ---
  const routeMap = new Map<string, { phantomTrips: Set<string>; etaLieTrips: Set<string>; confirmedTrips: Set<string> }>()

  // First, collect all GTFS-RT trips per route
  for (const snap of snapshots) {
    const nowEpoch = Math.floor(new Date(snap.timestamp).getTime() / 1000)
    for (const g of snap.gtfsOnlyTrips) {
      if (g.arrivalTime == null || !g.tripId) continue
      const eta = Math.round((g.arrivalTime - nowEpoch) / 60)
      if (eta >= 0 && eta < ETA_THRESHOLD_MIN) {
        const r = routeMap.get(g.routeId) ?? { phantomTrips: new Set(), etaLieTrips: new Set(), confirmedTrips: new Set() }
        r.confirmedTrips.add(g.tripId) // will subtract ghosts below
        routeMap.set(g.routeId, r)
      }
    }
    for (const v of snap.vehicles) {
      if (v.gtfsArrivalTime == null || !v.tripId) continue
      const eta = Math.round((v.gtfsArrivalTime - nowEpoch) / 60)
      if (eta >= 0 && eta < ETA_THRESHOLD_MIN) {
        const r = routeMap.get(v.route) ?? { phantomTrips: new Set(), etaLieTrips: new Set(), confirmedTrips: new Set() }
        r.confirmedTrips.add(v.tripId)
        routeMap.set(v.route, r)
      }
    }
  }

  // Then, tag ghost trips per route
  for (const m of moments) {
    if (!m.tripId) continue
    const r = routeMap.get(m.route) ?? { phantomTrips: new Set(), etaLieTrips: new Set(), confirmedTrips: new Set() }
    if (m.type === "phantom") r.phantomTrips.add(m.tripId)
    else r.etaLieTrips.add(m.tripId)
    routeMap.set(m.route, r)
  }

  const routeRows = [...routeMap.entries()]
    .map(([route, s]) => {
      const ghostsOnRoute = new Set([...s.phantomTrips, ...s.etaLieTrips])
      const confirmed = [...s.confirmedTrips].filter((t) => !ghostsOnRoute.has(t)).length
      return { route, phantoms: s.phantomTrips.size, etaLies: s.etaLieTrips.size, ghosts: ghostsOnRoute.size, confirmed }
    })
    .sort((a, b) => b.ghosts - a.ghosts)
    .map((r) => `| ${r.route} | ${r.confirmed} | ${r.phantoms} | ${r.etaLies} | ${r.ghosts} |`)
    .join("\n")

  // Worst individual moments
  const worstMoments = [...moments]
    .sort((a, b) => b.discrepancyMin - a.discrepancyMin)
    .slice(0, 15)
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit" })
      if (m.type === "phantom") {
        return `| ${time} | ${m.route} | ${m.vehicleId} | GTFS: ${m.gtfsEtaMin}min | SIRI: *not shown* | phantom | ${m.isFallback ? "yes" : "no"} |`
      }
      return `| ${time} | ${m.route} | ${m.vehicleId} | GTFS: ${m.gtfsEtaMin}min | SIRI: ${m.siriEtaMin}min | off by ${m.discrepancyMin}min | ${m.isFallback ? "yes" : "no"} |`
    })
    .join("\n")

  // Phantom ETA distribution
  const phantomEtaBuckets = { "0-2min": 0, "3-5min": 0, "6-10min": 0, "11-19min": 0 }
  for (const m of phantoms) {
    if (m.gtfsEtaMin <= 2) phantomEtaBuckets["0-2min"]++
    else if (m.gtfsEtaMin <= 5) phantomEtaBuckets["3-5min"]++
    else if (m.gtfsEtaMin <= 10) phantomEtaBuckets["6-10min"]++
    else phantomEtaBuckets["11-19min"]++
  }

  return `# Ghost Bus Report — Passenger Pain Analysis

## The Question

> If I check Apple Maps right now, what are the chances I see a ghost bus?

This report measures how often GTFS-RT (the data source for Apple Maps, Google Maps, Transit app) would mislead a passenger checking bus arrivals. Metrics are deduplicated to reflect actual passenger experience, not inflated snapshot counts.

## Summary

| Metric | Value |
|--------|-------|
| Time range | ${timeRange} |
| Snapshots analyzed | ${snapshots.length} |
| Unique GTFS-RT trips (ETA < ${ETA_THRESHOLD_MIN}min) | ${allGtfsTrips.size} |
| **Ghost trips** (phantom or ETA lie) | **${ghostTrips.size}** (${phantomTrips.size} phantoms, ${etaLieTrips.size} ETA lies) |
| **Ghost trip rate** | **${ghostTripRate}%** |
| Snapshots with a ghost visible | ${snapshotsWithGhost.size} of ${snapshots.length} |
| **Snapshot exposure rate** | **${snapshotExposureRate}%** |

> **Ghost trip rate** — out of every distinct bus trip GTFS-RT showed arriving within ${ETA_THRESHOLD_MIN} minutes, ${ghostTripRate}% were ghosts.
>
> **Snapshot exposure rate** — if you checked the app at a random moment during this window, there was a ${snapshotExposureRate}% chance you'd see at least one ghost bus.

## What Are These?

**Phantom buses** — GTFS-RT tells the passenger a bus is coming (ETA < ${ETA_THRESHOLD_MIN} min) but SIRI has no record of it at all. The passenger sees a bus on Apple Maps that doesn't exist in the MTA's own real-time system.

**ETA lies** — Both GTFS-RT and SIRI show the same bus, but GTFS-RT says it's ${ETA_DISAGREEMENT_MIN}+ minutes closer than SIRI does. The passenger expects the bus much sooner than it will actually arrive.

## Route Breakdown (Unique Trips)

| Route | Confirmed Trips | Phantom Trips | ETA Lie Trips | Total Ghosts |
|-------|-----------------|---------------|---------------|--------------|
${routeRows || "| — | — | — | — | — |"}

## Worst Moments

| Time | Route | Vehicle | GTFS-RT says | SIRI says | Result | Fallback? |
|------|-------|---------|-------------|-----------|--------|-----------|
${worstMoments || "| — | — | — | — | — | — | — |"}

## Phantom Bus ETA Distribution

When a phantom bus appears, how imminent does GTFS-RT claim it is?

| ETA Range | Count |
|-----------|-------|
| 0–2 min (imminent!) | ${phantomEtaBuckets["0-2min"]} |
| 3–5 min | ${phantomEtaBuckets["3-5min"]} |
| 6–10 min | ${phantomEtaBuckets["6-10min"]} |
| 11–19 min | ${phantomEtaBuckets["11-19min"]} |

## Fallback Analysis

${(() => {
  const fallbackPhantoms = phantoms.filter((m) => m.isFallback).length
  const realtimePhantoms = phantoms.filter((m) => !m.isFallback).length
  const fallbackLies = etaLies.filter((m) => m.isFallback).length
  const realtimeLies = etaLies.filter((m) => !m.isFallback).length
  return `| Source | Phantoms | ETA Lies | Total |
|--------|----------|----------|-------|
| Fallback (schedule data) | ${fallbackPhantoms} | ${fallbackLies} | ${fallbackPhantoms + fallbackLies} |
| Real-time | ${realtimePhantoms} | ${realtimeLies} | ${realtimePhantoms + realtimeLies} |`
})()}

Fallback = GTFS-RT is serving static schedule data as if it's real-time. This is the most common cause of ghost buses — the schedule says a bus should be there, but no bus is actually running.

## Ghost Trip Log

Every unique trip that GTFS-RT showed arriving at this stop but SIRI did not corroborate. Sorted by first appearance.

| Route | Vehicle | First Seen | Last Seen | ETA Range | Snapshots | Fallback? |
|-------|---------|------------|-----------|-----------|-----------|-----------|
${(() => {
  // Build per-trip summary
  const tripMap = new Map<string, {
    route: string; vehicle: string; firstSeen: string; lastSeen: string;
    minEta: number; maxEta: number; count: number; isFallback: boolean;
  }>()
  for (const snap of snapshots) {
    const nowEpoch = Math.floor(new Date(snap.timestamp).getTime() / 1000)
    for (const g of snap.gtfsOnlyTrips) {
      if (g.arrivalTime == null || !g.tripId) continue
      const eta = Math.round((g.arrivalTime - nowEpoch) / 60)
      if (eta < 0 || eta >= ETA_THRESHOLD_MIN) continue
      const existing = tripMap.get(g.tripId)
      if (existing) {
        existing.lastSeen = snap.timestamp
        existing.minEta = Math.min(existing.minEta, eta)
        existing.maxEta = Math.max(existing.maxEta, eta)
        existing.count++
        existing.isFallback = existing.isFallback && g.isFallback
      } else {
        const route = g.routeId.includes("_") ? g.routeId.split("_").pop()! : g.routeId
        tripMap.set(g.tripId, {
          route, vehicle: g.vehicleId,
          firstSeen: snap.timestamp, lastSeen: snap.timestamp,
          minEta: eta, maxEta: eta, count: 1, isFallback: g.isFallback,
        })
      }
    }
  }
  return [...tripMap.values()]
    .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen))
    .map((t) => {
      const first = new Date(t.firstSeen).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })
      const last = t.firstSeen === t.lastSeen ? "—" : new Date(t.lastSeen).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })
      const etaRange = t.minEta === t.maxEta ? `${t.minEta}min` : `${t.minEta}–${t.maxEta}min`
      return `| ${t.route} | ${t.vehicle} | ${first} | ${last} | ${etaRange} | ${t.count} | ${t.isFallback ? "yes" : "**no**"} |`
    })
    .join("\n")
})()}

## Time-of-Day Distribution

When do ghost buses appear? (Eastern Time, aggregated across all days)

${(() => {
  const hourSnapshots = new Map<number, number>()
  const hourGhosts = new Map<number, number>()
  for (const snap of snapshots) {
    const dt = new Date(snap.timestamp)
    const etHour = (dt.getUTCHours() - 5 + 24) % 24
    hourSnapshots.set(etHour, (hourSnapshots.get(etHour) ?? 0) + 1)
    const nowEpoch = Math.floor(dt.getTime() / 1000)
    let hasGhost = false
    for (const g of snap.gtfsOnlyTrips) {
      if (g.arrivalTime == null) continue
      const eta = Math.round((g.arrivalTime - nowEpoch) / 60)
      if (eta >= 0 && eta < ETA_THRESHOLD_MIN) { hasGhost = true; break }
    }
    if (hasGhost) hourGhosts.set(etHour, (hourGhosts.get(etHour) ?? 0) + 1)
  }
  const rows = []
  for (let h = 5; h < 29; h++) {
    const hour = h % 24
    const total = hourSnapshots.get(hour) ?? 0
    const ghosts = hourGhosts.get(hour) ?? 0
    if (total === 0) continue
    const rate = ((ghosts / total) * 100).toFixed(1)
    const label = `${String(hour).padStart(2, "0")}:00`
    rows.push(`| ${label} | ${total} | ${ghosts} | ${rate}% |`)
  }
  return `| Hour (ET) | Snapshots | With Ghost | Rate |
|----------|-----------|------------|------|
${rows.join("\n")}`
})()}

---

## Data Sources & Methodology

### Scope

This report analyzes ghost bus events at a **single MTA bus stop**: stop code **${snapshots[0]?.stopCode ?? "402854"}**${snapshots[0]?.stopLatitude ? ` (${snapshots[0].stopLatitude.toFixed(4)}, ${snapshots[0].stopLongitude?.toFixed(4)})` : ""}. All ghost events listed above were observed at this stop, serving the M101, M102, and M103 routes.

### Data Sources

**GTFS-RT (General Transit Feed Specification — Realtime)**
The MTA's realtime transit feed, served as protocol buffers. This is the data source that powers **Apple Maps, Google Maps, Transit app**, and all third-party arrival predictions. We fetch two sub-feeds:
- **Trip Updates** (gtfsrt.prod.obanyc.com/tripUpdates): predicted arrival times per stop
- **Vehicle Positions** (gtfsrt.prod.obanyc.com/vehiclePositions): GPS coordinates and status

**SIRI (Service Interface for Real-time Information)**
The MTA's own real-time bus tracking API — the same system behind **BusTime.mta.info** and the official MTA Bus Time app. Endpoint: bustime.mta.info/api/siri/stop-monitoring.json. SIRI only reports vehicles that the MTA's Clever Devices vehicle tracking system has confirmed are **actively operating on a route**.

### Collection Protocol

| Parameter | Value |
|-----------|-------|
| Poll interval | **60 seconds** |
| GTFS-RT cache TTL | 30 seconds |
| Feeds per cycle | SIRI + GTFS-RT Trip Updates + Vehicle Positions (fetched simultaneously) |
| Duration | ${timeRange} |
| Total snapshots | ${snapshots.length} |

Both feeds are fetched in the same call within each 60-second cycle, ensuring the comparison reflects the same moment in time (within network latency, typically < 1 second).

### What Counts as a Ghost

**Counted (real mismatch):**
A trip appears in GTFS-RT with a predicted arrival **under ${ETA_THRESHOLD_MIN} minutes** at this stop, but SIRI has **no record of that vehicle**. A passenger checking Apple Maps sees a bus; the MTA's own BusTime does not show it.

**Not counted (benign mismatch):**

| Scenario | Why excluded |
|----------|-------------|
| GTFS-RT trip with ETA ≥ ${ETA_THRESHOLD_MIN} min | Too far out to affect a passenger's decision to walk to the stop |
| Both feeds show the trip, ETAs differ by < ${ETA_DISAGREEMENT_MIN} min | Normal prediction variance, not a misleading discrepancy |
| SIRI shows a bus, GTFS-RT doesn't | The bus exists — under-reporting is a different problem |
| Negative ETA (bus already passed) | Stale data, but no one is being misled about a future arrival |

### How We Account for Route Starts

**The concern:** A bus beginning its route at a terminal might appear in GTFS-RT before the driver logs in, briefly absent from SIRI.

**Why this does not invalidate the findings:**
1. **Fallback detection catches this.** A not-yet-active bus shows delay=0 on all stops — our analysis flags these as "fallback." This is precisely the problem: GTFS-RT publishing schedule data as real-time, regardless of cause.
2. **The ${ETA_THRESHOLD_MIN}-minute window is a natural filter.** A bus leaving a distant terminal typically has an ETA well beyond ${ETA_THRESHOLD_MIN} minutes for mid-route stops.
3. **Vehicle Position cross-check.** Each snapshot records whether the GTFS-RT vehicle has a GPS signal. A truly operating bus should have one.
4. **The passenger impact is real regardless of cause.** Whether caused by schedule fallback or a slow login, the rider sees a bus on Apple Maps that BusTime doesn't show. A passenger who walks to the stop based on that prediction waits for a bus that may not come.

---

*Generated by BusWatch ghost analysis — ${new Date().toISOString()}*
`
}

// --- Main ---
async function main() {
  console.log("Loading snapshots from", JSONL_PATH)

  let snapshots: SnapshotEntry[]
  try {
    snapshots = await loadSnapshots()
  } catch {
    console.error("Failed to read snapshots. Run comparison mode first to collect data.")
    process.exit(1)
  }

  console.log(`Loaded ${snapshots.length} snapshots`)

  const moments = findMisleadingMoments(snapshots)
  const phantoms = moments.filter((m) => m.type === "phantom")
  const etaLies = moments.filter((m) => m.type === "eta_lie")

  // Write report
  const report = generateReport(snapshots, moments)
  await mkdir(path.dirname(REPORT_PATH), { recursive: true })
  await writeFile(REPORT_PATH, report, "utf-8")
  console.log(`Report written to ${REPORT_PATH}`)

  // Console summary
  console.log("\n--- Ghost Bus Summary ---")
  console.log(`Misleading moments: ${moments.length}`)
  console.log(`  Phantom buses: ${phantoms.length}`)
  console.log(`  ETA lies (${ETA_DISAGREEMENT_MIN}+ min off): ${etaLies.length}`)

  if (moments.length > 0) {
    console.log("\nWorst moments:")
    const worst = [...moments].sort((a, b) => b.discrepancyMin - a.discrepancyMin).slice(0, 10)
    for (const m of worst) {
      const time = new Date(m.timestamp).toLocaleTimeString("en-US", { hour12: true })
      if (m.type === "phantom") {
        console.log(`  ${m.route} ${m.vehicleId} @ ${time} — GTFS: ${m.gtfsEtaMin}min, SIRI: NOT SHOWN (phantom, fallback=${m.isFallback})`)
      } else {
        console.log(`  ${m.route} ${m.vehicleId} @ ${time} — GTFS: ${m.gtfsEtaMin}min, SIRI: ${m.siriEtaMin}min (off by ${m.discrepancyMin}min, fallback=${m.isFallback})`)
      }
    }
  }
}

main()
