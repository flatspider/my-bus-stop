import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { SnapshotEntry } from "../server/types.ts"

const JSONL_PATH = path.join(process.cwd(), "data", "snapshots.jsonl")
const REPORT_PATH = path.join(process.cwd(), "data", "ghost-report.md")

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
