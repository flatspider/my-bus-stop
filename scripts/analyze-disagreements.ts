import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { SnapshotEntry, GtfsOnlyTrip, SnapshotVehicle } from "../server/types.ts"
import { haversineMeters } from "../server/utils.ts"

const JSONL_PATH = path.join(process.cwd(), "data", "snapshots.jsonl")
const REPORT_PATH = path.join(process.cwd(), "data", "disagreement-report.md")

// --- Constants ---
const GTFS_ETA_THRESHOLD_MIN = 20
const ETA_DISAGREEMENT_THRESHOLD_MIN = 5
const VP_NEAR_STOP_M = 500

// Default stop coordinates (402854)
const DEFAULT_STOP = { latitude: 40.738982, longitude: -73.983129 }

// --- Types ---

interface CaseAResult {
  snapshotTimestamp: string
  tripId: string
  routeId: string
  vehicleId: string
  isFallback: boolean
  arrivalDelay: number | null
  arrivalTime: number | null
  gtfsEtaMinutes: number | null
  vpDistanceToStop: number | null
  hasVehiclePosition: boolean
  method: "arrivalTime" | "vpDistance" | "arrivalDelay"
}

interface CaseBResult {
  snapshotTimestamp: string
  vehicleId: string
  route: string
  tripId: string | null
  siriEtaMinutes: number
  gtfsEtaMinutes: number
  deltaMinutes: number
  gtfsArrivalTime: number
}

// --- Parse snapshots ---
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

// --- Get stop coordinates from snapshot or fallback ---
function getStopCoords(snapshots: SnapshotEntry[]): { latitude: number; longitude: number } {
  for (const snap of snapshots) {
    if (snap.stopLatitude != null && snap.stopLongitude != null) {
      return { latitude: snap.stopLatitude, longitude: snap.stopLongitude }
    }
  }
  return DEFAULT_STOP
}

// --- Extract short route name ---
function extractRouteName(gtfsRouteId: string): string {
  const underscoreIdx = gtfsRouteId.lastIndexOf("_")
  if (underscoreIdx !== -1) return gtfsRouteId.slice(underscoreIdx + 1)
  const spaceIdx = gtfsRouteId.lastIndexOf(" ")
  if (spaceIdx !== -1) return gtfsRouteId.slice(spaceIdx + 1)
  return gtfsRouteId
}

// --- Case A: GTFS-only buses near the stop ---
function findCaseA(
  snapshots: SnapshotEntry[],
  stopCoords: { latitude: number; longitude: number }
): CaseAResult[] {
  const results: CaseAResult[] = []

  for (const snap of snapshots) {
    const snapshotEpoch = Math.floor(new Date(snap.timestamp).getTime() / 1000)

    for (const trip of snap.gtfsOnlyTrips) {
      // Compute GTFS ETA from arrivalTime if available
      const gtfsEtaMinutes = computeGtfsEta(trip, snapshotEpoch)

      // Compute VP distance to stop if we have position data
      let vpDistanceToStop: number | null = null
      if (trip.vpLatitude != null && trip.vpLongitude != null) {
        vpDistanceToStop = haversineMeters(
          trip.vpLatitude, trip.vpLongitude,
          stopCoords.latitude, stopCoords.longitude
        )
      }

      // Determine if this trip qualifies as "near" by any method
      let qualifies = false
      let method: CaseAResult["method"] = "arrivalTime"

      if (gtfsEtaMinutes !== null && gtfsEtaMinutes >= 0 && gtfsEtaMinutes < GTFS_ETA_THRESHOLD_MIN) {
        qualifies = true
        method = "arrivalTime"
      } else if (vpDistanceToStop !== null && vpDistanceToStop < VP_NEAR_STOP_M) {
        qualifies = true
        method = "vpDistance"
      }

      if (!qualifies) continue

      results.push({
        snapshotTimestamp: snap.timestamp,
        tripId: trip.tripId,
        routeId: trip.routeId,
        vehicleId: trip.vehicleId,
        isFallback: trip.isFallback,
        arrivalDelay: trip.arrivalDelay,
        arrivalTime: (trip as GtfsOnlyTrip & { arrivalTime?: number | null }).arrivalTime ?? null,
        gtfsEtaMinutes,
        vpDistanceToStop: vpDistanceToStop !== null ? Math.round(vpDistanceToStop) : null,
        hasVehiclePosition: trip.hasVehiclePosition,
        method,
      })
    }
  }

  return results
}

// --- Case B: ETA disagreements for matched buses ---
function findCaseB(snapshots: SnapshotEntry[]): CaseBResult[] {
  const results: CaseBResult[] = []

  for (const snap of snapshots) {
    const snapshotEpoch = Math.floor(new Date(snap.timestamp).getTime() / 1000)

    for (const vehicle of snap.vehicles) {
      const v = vehicle as SnapshotVehicle & { gtfsArrivalTime?: number | null }
      if (v.gtfsArrivalTime == null) continue
      if (v.siriEtaMinutes == null) continue

      const gtfsEtaMinutes = (v.gtfsArrivalTime - snapshotEpoch) / 60
      // Skip negative ETAs (bus already past)
      if (gtfsEtaMinutes < 0) continue

      const delta = Math.abs(gtfsEtaMinutes - v.siriEtaMinutes)
      if (delta < ETA_DISAGREEMENT_THRESHOLD_MIN) continue

      results.push({
        snapshotTimestamp: snap.timestamp,
        vehicleId: v.vehicleId,
        route: v.route,
        tripId: v.tripId,
        siriEtaMinutes: v.siriEtaMinutes,
        gtfsEtaMinutes: Math.round(gtfsEtaMinutes * 10) / 10,
        deltaMinutes: Math.round(delta * 10) / 10,
        gtfsArrivalTime: v.gtfsArrivalTime,
      })
    }
  }

  return results
}

// --- Compute GTFS ETA in minutes ---
function computeGtfsEta(
  trip: GtfsOnlyTrip,
  snapshotEpoch: number
): number | null {
  const t = trip as GtfsOnlyTrip & { arrivalTime?: number | null }
  if (t.arrivalTime != null) {
    return (t.arrivalTime - snapshotEpoch) / 60
  }
  return null
}

// --- Count snapshots with arrivalTime data ---
function countArrivalTimeData(snapshots: SnapshotEntry[]): {
  snapshotsWithArrivalTime: number
  totalGtfsOnlyWithArrivalTime: number
  totalMatchedWithArrivalTime: number
} {
  let snapshotsWithArrivalTime = 0
  let totalGtfsOnlyWithArrivalTime = 0
  let totalMatchedWithArrivalTime = 0

  for (const snap of snapshots) {
    let hasAny = false

    for (const trip of snap.gtfsOnlyTrips) {
      const t = trip as GtfsOnlyTrip & { arrivalTime?: number | null }
      if (t.arrivalTime != null) {
        totalGtfsOnlyWithArrivalTime++
        hasAny = true
      }
    }

    for (const vehicle of snap.vehicles) {
      const v = vehicle as SnapshotVehicle & { gtfsArrivalTime?: number | null }
      if (v.gtfsArrivalTime != null) {
        totalMatchedWithArrivalTime++
        hasAny = true
      }
    }

    if (hasAny) snapshotsWithArrivalTime++
  }

  return { snapshotsWithArrivalTime, totalGtfsOnlyWithArrivalTime, totalMatchedWithArrivalTime }
}

// --- Generate report ---
function generateReport(
  snapshots: SnapshotEntry[],
  caseAResults: CaseAResult[],
  caseBResults: CaseBResult[],
  arrivalTimeStats: ReturnType<typeof countArrivalTimeData>
): string {
  const timeRange = snapshots.length > 0
    ? `${snapshots[0].timestamp} → ${snapshots[snapshots.length - 1].timestamp}`
    : "no data"

  // Case A breakdown
  const caseAByMethod = {
    arrivalTime: caseAResults.filter((r) => r.method === "arrivalTime"),
    vpDistance: caseAResults.filter((r) => r.method === "vpDistance"),
  }

  const caseAFallback = caseAResults.filter((r) => r.isFallback)
  const caseARealtime = caseAResults.filter((r) => !r.isFallback)

  // Case A: group by route for summary
  const caseAByRoute = new Map<string, CaseAResult[]>()
  for (const r of caseAResults) {
    const route = extractRouteName(r.routeId)
    if (!caseAByRoute.has(route)) caseAByRoute.set(route, [])
    caseAByRoute.get(route)!.push(r)
  }

  const caseARouteRows = [...caseAByRoute.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([route, results]) => {
      const fallback = results.filter((r) => r.isFallback).length
      const realtime = results.length - fallback
      const withArrivalTime = results.filter((r) => r.method === "arrivalTime").length
      const withVpDistance = results.filter((r) => r.method === "vpDistance").length
      return `| ${route} | ${results.length} | ${realtime} | ${fallback} | ${withArrivalTime} | ${withVpDistance} |`
    })
    .join("\n")

  // Case A: top examples (non-fallback, sorted by ETA)
  const caseAExamples = caseARealtime
    .filter((r) => r.gtfsEtaMinutes !== null)
    .sort((a, b) => (a.gtfsEtaMinutes ?? 99) - (b.gtfsEtaMinutes ?? 99))
    .slice(0, 15)
    .map((r) => {
      const route = extractRouteName(r.routeId)
      const eta = r.gtfsEtaMinutes !== null ? `${Math.round(r.gtfsEtaMinutes * 10) / 10} min` : "—"
      const vpDist = r.vpDistanceToStop !== null ? `${r.vpDistanceToStop}m` : "no VP"
      const time = new Date(r.snapshotTimestamp).toLocaleTimeString()
      return `| ${route} | ${r.vehicleId} | ${eta} | ${vpDist} | ${r.method} | ${time} |`
    })
    .join("\n")

  // Case A: VP-only examples (for old data without arrivalTime)
  const caseAVpExamples = caseAByMethod.vpDistance
    .filter((r) => !r.isFallback)
    .sort((a, b) => (a.vpDistanceToStop ?? 9999) - (b.vpDistanceToStop ?? 9999))
    .slice(0, 10)
    .map((r) => {
      const route = extractRouteName(r.routeId)
      const vpDist = r.vpDistanceToStop !== null ? `${r.vpDistanceToStop}m` : "—"
      const time = new Date(r.snapshotTimestamp).toLocaleTimeString()
      return `| ${route} | ${r.vehicleId} | ${vpDist} | ${r.isFallback ? "yes" : "no"} | ${time} |`
    })
    .join("\n")

  // Case B: top disagreements
  const caseBSorted = caseBResults
    .sort((a, b) => b.deltaMinutes - a.deltaMinutes)
    .slice(0, 15)

  const caseBRows = caseBSorted
    .map((r) => {
      const time = new Date(r.snapshotTimestamp).toLocaleTimeString()
      return `| ${r.route} | ${r.vehicleId} | ${r.siriEtaMinutes} min | ${r.gtfsEtaMinutes} min | ${r.deltaMinutes} min | ${time} |`
    })
    .join("\n")

  // Case B: route breakdown
  const caseBByRoute = new Map<string, CaseBResult[]>()
  for (const r of caseBResults) {
    if (!caseBByRoute.has(r.route)) caseBByRoute.set(r.route, [])
    caseBByRoute.get(r.route)!.push(r)
  }

  const caseBRouteRows = [...caseBByRoute.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([route, results]) => {
      const avgDelta = results.reduce((sum, r) => sum + r.deltaMinutes, 0) / results.length
      return `| ${route} | ${results.length} | ${Math.round(avgDelta * 10) / 10} min |`
    })
    .join("\n")

  return `# GTFS-rt vs SIRI Disagreement Report

## Summary

| Metric | Value |
|--------|-------|
| Time range | ${timeRange} |
| Snapshots analyzed | ${snapshots.length} |
| Snapshots with arrivalTime data | ${arrivalTimeStats.snapshotsWithArrivalTime} |
| Case A: GTFS-only near stop | ${caseAResults.length} (${caseARealtime.length} real-time, ${caseAFallback.length} fallback) |
| Case B: ETA disagreements | ${caseBResults.length} |

## Data Quality

${arrivalTimeStats.snapshotsWithArrivalTime === 0
    ? `> **No snapshots contain arrivalTime data.** This means all existing data was collected before the arrivalTime field was added to the snapshot format. Case A uses VP distance as a proxy. Case B analysis requires arrivalTime data — collect new snapshots by restarting the server.`
    : `${arrivalTimeStats.snapshotsWithArrivalTime} of ${snapshots.length} snapshots have arrivalTime data. GTFS-only trips with arrivalTime: ${arrivalTimeStats.totalGtfsOnlyWithArrivalTime}. Matched vehicles with gtfsArrivalTime: ${arrivalTimeStats.totalMatchedWithArrivalTime}.`}

---

## Case A: GTFS-only Buses Near Stop

These are trips that appear in GTFS-rt (what Apple Maps uses) with an ETA under ${GTFS_ETA_THRESHOLD_MIN} minutes or VP within ${VP_NEAR_STOP_M}m of the stop, but **SIRI does not mention them at all**. This is the "Apple Maps says a bus is coming, BusTime doesn't" scenario.

### Route Breakdown

| Route | Total | Real-time | Fallback | Via arrivalTime | Via VP distance |
|-------|-------|-----------|----------|-----------------|-----------------|
${caseARouteRows || "| — | — | — | — | — | — |"}

> **Note on fallback trips:** ${caseAFallback.length} of ${caseAResults.length} Case A results are from trips flagged as schedule fallback (arrivalDelay=0 on all stops). These likely represent scheduled-but-not-running trips that GTFS-rt includes by default. SIRI correctly omits them.

${caseARealtime.length > 0 ? `### Real-time GTFS-only Examples (sorted by ETA)

These are the most concerning — trips with real-time data that SIRI doesn't show:

| Route | Vehicle | GTFS ETA | VP Distance | Method | Time |
|-------|---------|----------|-------------|--------|------|
${caseAExamples || "| — | — | — | — | — | — |"}
` : "### No real-time GTFS-only trips found with arrivalTime data.\n"}
${caseAByMethod.vpDistance.length > 0 ? `### VP Distance Proxy Results (old data without arrivalTime)

For snapshots without arrivalTime, these trips had VP within ${VP_NEAR_STOP_M}m of the stop:

| Route | Vehicle | VP Distance | Fallback? | Time |
|-------|---------|-------------|-----------|------|
${caseAVpExamples || "| — | — | — | — | — |"}
` : ""}
---

## Case B: ETA Disagreements (Both Feeds)

Buses present in both SIRI and GTFS-rt where the ETA estimates differ by more than ${ETA_DISAGREEMENT_THRESHOLD_MIN} minutes. Requires arrivalTime data in snapshots.

${caseBResults.length === 0
    ? arrivalTimeStats.snapshotsWithArrivalTime === 0
      ? "> **Cannot analyze.** No snapshots have arrivalTime data. Restart the server and collect new snapshots to enable Case B analysis."
      : "> No disagreements exceeding the threshold were found."
    : `### Largest Disagreements

| Route | Vehicle | SIRI ETA | GTFS ETA | Delta | Time |
|-------|---------|----------|----------|-------|------|
${caseBRows}

### Route Breakdown

| Route | Disagreements | Avg Delta |
|-------|--------------|-----------|
${caseBRouteRows || "| — | — | — |"}`}

---

## Methodology

### Case A — GTFS-only Detection
A trip qualifies if it appears in \`gtfsOnlyTrips\` (present in GTFS-rt but not SIRI) AND meets either:
1. **arrivalTime method**: \`(arrivalTime - snapshotEpoch) / 60 < ${GTFS_ETA_THRESHOLD_MIN}\` minutes (new data only)
2. **VP distance method**: Vehicle position is within ${VP_NEAR_STOP_M}m of the stop (fallback for old data)

Fallback-suspected trips (arrivalDelay=0 on all stops) are counted separately as they likely represent schedule data, not real buses.

### Case B — ETA Disagreement Detection
For buses present in both feeds, compares:
- **SIRI ETA**: \`siriEtaMinutes\` from the snapshot
- **GTFS ETA**: \`(gtfsArrivalTime - snapshotEpoch) / 60\`

Flags when \`|GTFS ETA - SIRI ETA| > ${ETA_DISAGREEMENT_THRESHOLD_MIN}\` minutes. Requires \`gtfsArrivalTime\` field (only in new snapshots).

---

*Generated by BusWatch disagreement analysis — ${new Date().toISOString()}*
`
}

// --- Main ---
async function main() {
  console.log("Loading snapshots from", JSONL_PATH)

  let snapshots: SnapshotEntry[]
  try {
    snapshots = await loadSnapshots()
  } catch (err) {
    console.error("Failed to read snapshots. Have you run the comparison mode first?")
    console.error("Start the server with BUSWATCH_MODE=compare and let it collect data.")
    process.exit(1)
  }

  console.log(`Loaded ${snapshots.length} snapshots`)

  const stopCoords = getStopCoords(snapshots)
  console.log(`Stop coordinates: ${stopCoords.latitude}, ${stopCoords.longitude}`)

  // Check arrivalTime data availability
  const arrivalTimeStats = countArrivalTimeData(snapshots)
  console.log(`Snapshots with arrivalTime: ${arrivalTimeStats.snapshotsWithArrivalTime} of ${snapshots.length}`)

  // Case A: GTFS-only buses near stop
  const caseAResults = findCaseA(snapshots, stopCoords)
  const caseAFallback = caseAResults.filter((r) => r.isFallback).length
  const caseARealtime = caseAResults.length - caseAFallback
  console.log(`Case A: ${caseAResults.length} GTFS-only trips near stop (${caseARealtime} real-time, ${caseAFallback} fallback)`)

  // Case B: ETA disagreements
  const caseBResults = findCaseB(snapshots)
  console.log(`Case B: ${caseBResults.length} ETA disagreements > ${ETA_DISAGREEMENT_THRESHOLD_MIN} min`)

  // Generate report
  const report = generateReport(snapshots, caseAResults, caseBResults, arrivalTimeStats)

  await mkdir(path.dirname(REPORT_PATH), { recursive: true })
  await writeFile(REPORT_PATH, report, "utf-8")
  console.log(`\nReport written to ${REPORT_PATH}`)

  // Console summary
  console.log("\n--- Quick Summary ---")
  console.log(`Snapshots: ${snapshots.length}`)
  console.log(`arrivalTime coverage: ${arrivalTimeStats.snapshotsWithArrivalTime} snapshots`)
  console.log(`Case A (GTFS-only near stop): ${caseAResults.length} (${caseARealtime} real-time, ${caseAFallback} fallback)`)
  console.log(`Case B (ETA disagreements): ${caseBResults.length}`)

  if (caseARealtime > 0) {
    console.log("\nTop Case A (real-time, non-fallback):")
    caseAResults
      .filter((r) => !r.isFallback && r.gtfsEtaMinutes !== null)
      .sort((a, b) => (a.gtfsEtaMinutes ?? 99) - (b.gtfsEtaMinutes ?? 99))
      .slice(0, 5)
      .forEach((r) => {
        const route = extractRouteName(r.routeId)
        const eta = r.gtfsEtaMinutes !== null ? `${Math.round(r.gtfsEtaMinutes * 10) / 10}min` : "—"
        const vpDist = r.vpDistanceToStop !== null ? `${r.vpDistanceToStop}m` : "no VP"
        console.log(`  ${route} vehicle ${r.vehicleId} — GTFS ETA: ${eta}, VP dist: ${vpDist} (${r.method})`)
      })
  }

  if (caseBResults.length > 0) {
    console.log("\nTop Case B disagreements:")
    caseBResults
      .sort((a, b) => b.deltaMinutes - a.deltaMinutes)
      .slice(0, 5)
      .forEach((r) => {
        console.log(`  ${r.route} vehicle ${r.vehicleId} — SIRI: ${r.siriEtaMinutes}min, GTFS: ${r.gtfsEtaMinutes}min (delta: ${r.deltaMinutes}min)`)
      })
  }
}

main()
