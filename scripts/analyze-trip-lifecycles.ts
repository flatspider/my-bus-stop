import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { SnapshotEntry, GtfsOnlyTrip, SnapshotVehicle } from "../server/types.ts"
import { haversineMeters } from "../server/utils.ts"

const JSONL_PATH = path.join(process.cwd(), "data", "snapshots.jsonl")
const REPORT_PATH = path.join(process.cwd(), "data", "lifecycle-report.md")

// --- Constants ---
const ETA_CLOSE_THRESHOLD_MIN = 15
const ETA_FAR_THRESHOLD_MIN = 30
const VP_CLOSE_M = 500
const MIN_OBSERVATIONS = 3
const MIN_SPAN_MS = 2 * 60 * 1000 // 2 minutes

// Default stop coordinates (402854)
const DEFAULT_STOP = { latitude: 40.738982, longitude: -73.983129 }

// --- Types ---

type TripSource = "gtfs_only" | "siri_matched"

interface TripObservation {
  timestamp: string
  epochMs: number
  source: TripSource
  // From GtfsOnlyTrip
  isFallback: boolean
  arrivalTime: number | null
  arrivalDelay: number | null
  // VP data
  vpLatitude: number | null
  vpLongitude: number | null
  vpTimestamp: number | null
  hasVehiclePosition: boolean
  // SIRI data (only for siri_matched)
  siriEtaMinutes: number | null
  // Computed
  gtfsEtaMinutes: number | null
  vpDistanceToStop: number | null
}

type TripClassification =
  | "ghost (fallback)"
  | "ghost (real-time)"
  | "late_pickup"
  | "siri_throughout"
  | "too_far"
  | "insufficient_data"

interface TripLifecycle {
  tripId: string
  routeId: string
  vehicleId: string
  observations: TripObservation[]
  firstSeen: string
  lastSeen: string
  spanMs: number
  gtfsOnlyCount: number
  siriMatchedCount: number
  siriEverAcknowledged: boolean
  isFallback: boolean
  classification: TripClassification
  // ETA tracking
  minEtaMinutes: number | null
  maxEtaMinutes: number | null
  // VP tracking
  minVpDistanceToStop: number | null
  // For late_pickup: how long before SIRI picked it up
  siriPickupDelayMs: number | null
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

// --- Step 1: Index all observations by tripId ---
function indexByTripId(
  snapshots: SnapshotEntry[],
  stopCoords: { latitude: number; longitude: number }
): Map<string, { routeId: string; vehicleId: string; observations: TripObservation[] }> {
  const tripMap = new Map<string, { routeId: string; vehicleId: string; observations: TripObservation[] }>()

  for (const snap of snapshots) {
    const snapshotEpochS = Math.floor(new Date(snap.timestamp).getTime() / 1000)
    const snapshotEpochMs = new Date(snap.timestamp).getTime()

    // Scan gtfsOnlyTrips
    for (const trip of snap.gtfsOnlyTrips) {
      if (!trip.tripId) continue

      const gtfsEtaMinutes = trip.arrivalTime != null
        ? (trip.arrivalTime - snapshotEpochS) / 60
        : null

      let vpDistanceToStop: number | null = null
      if (trip.vpLatitude != null && trip.vpLongitude != null) {
        vpDistanceToStop = haversineMeters(
          trip.vpLatitude, trip.vpLongitude,
          stopCoords.latitude, stopCoords.longitude
        )
      }

      if (!tripMap.has(trip.tripId)) {
        tripMap.set(trip.tripId, {
          routeId: trip.routeId,
          vehicleId: trip.vehicleId,
          observations: [],
        })
      }

      tripMap.get(trip.tripId)!.observations.push({
        timestamp: snap.timestamp,
        epochMs: snapshotEpochMs,
        source: "gtfs_only",
        isFallback: trip.isFallback,
        arrivalTime: trip.arrivalTime,
        arrivalDelay: trip.arrivalDelay,
        vpLatitude: trip.vpLatitude,
        vpLongitude: trip.vpLongitude,
        vpTimestamp: trip.vpTimestamp,
        hasVehiclePosition: trip.hasVehiclePosition,
        siriEtaMinutes: null,
        gtfsEtaMinutes,
        vpDistanceToStop,
      })
    }

    // Scan vehicles (siri_matched) — only those with a tripId
    for (const v of snap.vehicles) {
      if (!v.tripId) continue

      const gtfsEtaMinutes = v.gtfsArrivalTime != null
        ? (v.gtfsArrivalTime - snapshotEpochS) / 60
        : null

      let vpDistanceToStop: number | null = null
      if (v.vpLatitude != null && v.vpLongitude != null) {
        vpDistanceToStop = haversineMeters(
          v.vpLatitude, v.vpLongitude,
          stopCoords.latitude, stopCoords.longitude
        )
      }

      if (!tripMap.has(v.tripId)) {
        tripMap.set(v.tripId, {
          routeId: v.route,
          vehicleId: v.vehicleId,
          observations: [],
        })
      }

      tripMap.get(v.tripId)!.observations.push({
        timestamp: snap.timestamp,
        epochMs: snapshotEpochMs,
        source: "siri_matched",
        isFallback: false,
        arrivalTime: v.gtfsArrivalTime ?? null,
        arrivalDelay: v.gtfsDelay,
        vpLatitude: v.vpLatitude,
        vpLongitude: v.vpLongitude,
        vpTimestamp: v.vpTimestamp,
        hasVehiclePosition: v.hasVehiclePosition,
        siriEtaMinutes: v.siriEtaMinutes,
        gtfsEtaMinutes,
        vpDistanceToStop,
      })
    }
  }

  return tripMap
}

// --- Step 2: Build lifecycles ---
function buildLifecycles(
  tripMap: Map<string, { routeId: string; vehicleId: string; observations: TripObservation[] }>
): TripLifecycle[] {
  const lifecycles: TripLifecycle[] = []

  for (const [tripId, data] of tripMap) {
    const obs = data.observations.sort((a, b) => a.epochMs - b.epochMs)

    const gtfsOnlyCount = obs.filter((o) => o.source === "gtfs_only").length
    const siriMatchedCount = obs.filter((o) => o.source === "siri_matched").length
    const siriEverAcknowledged = siriMatchedCount > 0

    // isFallback: true if ANY gtfs_only observation has isFallback
    const isFallback = obs.some((o) => o.source === "gtfs_only" && o.isFallback)

    // ETA tracking — use gtfsEtaMinutes for gtfs_only, siriEtaMinutes for siri_matched
    const allEtas: number[] = []
    for (const o of obs) {
      if (o.source === "siri_matched" && o.siriEtaMinutes != null) {
        allEtas.push(o.siriEtaMinutes)
      }
      if (o.gtfsEtaMinutes != null) {
        allEtas.push(o.gtfsEtaMinutes)
      }
    }
    const minEtaMinutes = allEtas.length > 0 ? Math.min(...allEtas) : null
    const maxEtaMinutes = allEtas.length > 0 ? Math.max(...allEtas) : null

    // VP distance tracking
    const vpDistances = obs
      .map((o) => o.vpDistanceToStop)
      .filter((d): d is number => d !== null)
    const minVpDistanceToStop = vpDistances.length > 0 ? Math.min(...vpDistances) : null

    // For late_pickup: time from first observation to first SIRI observation
    let siriPickupDelayMs: number | null = null
    if (siriEverAcknowledged && gtfsOnlyCount > 0) {
      const firstObs = obs[0]
      const firstSiri = obs.find((o) => o.source === "siri_matched")
      if (firstObs.source === "gtfs_only" && firstSiri) {
        siriPickupDelayMs = firstSiri.epochMs - firstObs.epochMs
      }
    }

    const firstSeen = obs[0].timestamp
    const lastSeen = obs[obs.length - 1].timestamp
    const spanMs = obs[obs.length - 1].epochMs - obs[0].epochMs

    lifecycles.push({
      tripId,
      routeId: data.routeId,
      vehicleId: data.vehicleId,
      observations: obs,
      firstSeen,
      lastSeen,
      spanMs,
      gtfsOnlyCount,
      siriMatchedCount,
      siriEverAcknowledged,
      isFallback,
      classification: "insufficient_data", // placeholder, classified next
      minEtaMinutes,
      maxEtaMinutes,
      minVpDistanceToStop,
      siriPickupDelayMs,
    })
  }

  return lifecycles
}

// --- Step 3: Classify each lifecycle (waterfall) ---
function classifyLifecycles(lifecycles: TripLifecycle[]): void {
  for (const lc of lifecycles) {
    // Insufficient data: < 3 observations or < 2 min span
    if (lc.observations.length < MIN_OBSERVATIONS || lc.spanMs < MIN_SPAN_MS) {
      lc.classification = "insufficient_data"
      continue
    }

    // siri_throughout: SIRI had it from the start (first observation is siri_matched)
    if (lc.observations[0].source === "siri_matched" && lc.siriMatchedCount >= lc.gtfsOnlyCount) {
      lc.classification = "siri_throughout"
      continue
    }

    // late_pickup: started GTFS-only but SIRI eventually picked it up
    if (lc.siriEverAcknowledged && lc.observations[0].source === "gtfs_only") {
      lc.classification = "late_pickup"
      continue
    }

    // Now it's SIRI-never-acknowledged territory. Check proximity.
    const etaGotClose = lc.minEtaMinutes !== null && lc.minEtaMinutes < ETA_CLOSE_THRESHOLD_MIN
    const vpGotClose = lc.minVpDistanceToStop !== null && lc.minVpDistanceToStop < VP_CLOSE_M

    // too_far: ETA never dropped below 30min AND no VP within 500m
    const etaAlwaysFar = lc.minEtaMinutes === null || lc.minEtaMinutes >= ETA_FAR_THRESHOLD_MIN
    const vpAlwaysFar = lc.minVpDistanceToStop === null || lc.minVpDistanceToStop >= VP_CLOSE_M
    if (etaAlwaysFar && vpAlwaysFar) {
      lc.classification = "too_far"
      continue
    }

    // ghost: SIRI never acknowledged AND (ETA got within 15min OR VP within 500m)
    if (!lc.siriEverAcknowledged && (etaGotClose || vpGotClose)) {
      if (lc.isFallback) {
        lc.classification = "ghost (fallback)"
      } else {
        lc.classification = "ghost (real-time)"
      }
      continue
    }

    // Fallthrough: didn't meet ghost proximity thresholds clearly but not too_far either
    // These are borderline — classify as too_far since we can't confirm ghost
    lc.classification = "too_far"
  }
}

// --- Report generation ---
function generateReport(
  snapshots: SnapshotEntry[],
  lifecycles: TripLifecycle[],
  stopCoords: { latitude: number; longitude: number }
): string {
  const timeRange = snapshots.length > 0
    ? `${snapshots[0].timestamp} → ${snapshots[snapshots.length - 1].timestamp}`
    : "no data"

  const ghosts = lifecycles.filter((lc) =>
    lc.classification === "ghost (fallback)" || lc.classification === "ghost (real-time)"
  )
  const ghostFallback = lifecycles.filter((lc) => lc.classification === "ghost (fallback)")
  const ghostRealtime = lifecycles.filter((lc) => lc.classification === "ghost (real-time)")
  const latePickups = lifecycles.filter((lc) => lc.classification === "late_pickup")
  const siriThroughout = lifecycles.filter((lc) => lc.classification === "siri_throughout")
  const tooFar = lifecycles.filter((lc) => lc.classification === "too_far")
  const insufficient = lifecycles.filter((lc) => lc.classification === "insufficient_data")

  // Ghost rate: what % of trips that approached this stop are ghosts?
  const approachingTrips = ghosts.length + latePickups.length + siriThroughout.length
  const ghostRate = approachingTrips > 0
    ? ((ghosts.length / approachingTrips) * 100).toFixed(1)
    : "N/A"

  // Route breakdown
  const routeStats = new Map<string, { total: number; ghost: number; ghostFallback: number; ghostRealtime: number; latePickup: number; siri: number }>()
  for (const lc of lifecycles) {
    if (lc.classification === "insufficient_data" || lc.classification === "too_far") continue
    const route = extractRouteName(lc.routeId)
    if (!routeStats.has(route)) {
      routeStats.set(route, { total: 0, ghost: 0, ghostFallback: 0, ghostRealtime: 0, latePickup: 0, siri: 0 })
    }
    const s = routeStats.get(route)!
    s.total++
    if (lc.classification === "ghost (fallback)") { s.ghost++; s.ghostFallback++ }
    if (lc.classification === "ghost (real-time)") { s.ghost++; s.ghostRealtime++ }
    if (lc.classification === "late_pickup") s.latePickup++
    if (lc.classification === "siri_throughout") s.siri++
  }

  const routeRows = [...routeStats.entries()]
    .sort((a, b) => b[1].ghost - a[1].ghost)
    .map(([route, s]) => {
      const routeGhostRate = s.total > 0 ? ((s.ghost / s.total) * 100).toFixed(0) : "0"
      return `| ${route} | ${s.total} | ${s.ghost} | ${s.ghostFallback} | ${s.ghostRealtime} | ${s.latePickup} | ${s.siri} | ${routeGhostRate}% |`
    })
    .join("\n")

  // Ghost details
  const ghostDetails = ghosts
    .sort((a, b) => (a.minEtaMinutes ?? 999) - (b.minEtaMinutes ?? 999))
    .slice(0, 20)
    .map((g, i) => {
      const route = extractRouteName(g.routeId)
      const etaProgression = g.observations
        .map((o) => {
          const eta = o.gtfsEtaMinutes != null ? `${Math.round(o.gtfsEtaMinutes * 10) / 10}m` : "—"
          const src = o.source === "gtfs_only" ? "G" : "S"
          return `${eta}[${src}]`
        })
        .join(" → ")

      const minDist = g.minVpDistanceToStop != null ? `${Math.round(g.minVpDistanceToStop)}m` : "no VP"
      const minEta = g.minEtaMinutes != null ? `${Math.round(g.minEtaMinutes * 10) / 10} min` : "—"
      const spanMin = Math.round(g.spanMs / 60000)

      return `### Ghost #${i + 1}: Trip ${g.tripId} (${route})

- **Classification:** ${g.classification}
- **Vehicle:** ${g.vehicleId}
- **Tracked for:** ${spanMin} min (${g.observations.length} observations)
- **GTFS-only observations:** ${g.gtfsOnlyCount} | **SIRI matched:** ${g.siriMatchedCount}
- **Fallback trip:** ${g.isFallback ? "yes" : "no"}
- **Min GTFS ETA:** ${minEta}
- **Min VP distance to stop:** ${minDist}
- **ETA countdown:** ${etaProgression}`
    })
    .join("\n\n")

  // Late pickup details
  const latePickupDetails = latePickups
    .sort((a, b) => (b.siriPickupDelayMs ?? 0) - (a.siriPickupDelayMs ?? 0))
    .slice(0, 10)
    .map((lp, i) => {
      const route = extractRouteName(lp.routeId)
      const delayMin = lp.siriPickupDelayMs != null ? Math.round(lp.siriPickupDelayMs / 60000) : "?"
      const spanMin = Math.round(lp.spanMs / 60000)
      return `| ${route} | ${lp.tripId} | ${lp.vehicleId} | ${delayMin} min | ${lp.gtfsOnlyCount} | ${lp.siriMatchedCount} | ${spanMin} min |`
    })
    .join("\n")

  return `# GTFS-rt Trip Lifecycle Report

## Summary

| Metric | Value |
|--------|-------|
| Time range | ${timeRange} |
| Snapshots analyzed | ${snapshots.length} |
| Total unique trips tracked | ${lifecycles.length} |
| **Ghost trips** | **${ghosts.length}** (${ghostFallback.length} fallback, ${ghostRealtime.length} real-time) |
| **Ghost rate** | **${ghostRate}%** of trips approaching this stop |
| Late pickups (SIRI eventually caught up) | ${latePickups.length} |
| SIRI throughout | ${siriThroughout.length} |
| Too far to confirm | ${tooFar.length} |
| Insufficient data | ${insufficient.length} |

> **Ghost rate** = ghost trips / (ghost + late_pickup + siri_throughout). This is the percentage of GTFS-rt trips that appeared to approach this stop but were never confirmed by SIRI.

## Route Breakdown

| Route | Approaching | Ghosts | Fallback | Real-time | Late Pickup | SIRI | Ghost Rate |
|-------|-------------|--------|----------|-----------|-------------|------|------------|
${routeRows || "| — | — | — | — | — | — | — | — |"}

## Ghost Trip Cases

${ghosts.length === 0 ? "No ghost trips detected in this dataset." : `${ghosts.length} trip(s) appeared in GTFS-rt approaching this stop but SIRI never acknowledged them.\n\n${ghostDetails}${ghosts.length > 20 ? `\n\n...and ${ghosts.length - 20} more ghost trips` : ""}`}

## Late Pickup Cases

${latePickups.length === 0 ? "No late pickup cases — all SIRI-confirmed trips were visible from the start." : `${latePickups.length} trip(s) started as GTFS-only but SIRI eventually picked them up. These are real buses where SIRI was slow to report.

| Route | Trip ID | Vehicle | SIRI Pickup Delay | GTFS-only Obs | SIRI Obs | Tracked |
|-------|---------|---------|-------------------|---------------|----------|---------|
${latePickupDetails}${latePickups.length > 10 ? `\n\n...and ${latePickups.length - 10} more` : ""}`}

## Classification Counts

| Classification | Count | Description |
|---------------|-------|-------------|
| ghost (fallback) | ${ghostFallback.length} | GTFS-rt serving schedule data for a non-existent bus. \`isFallback: true\`. |
| ghost (real-time) | ${ghostRealtime.length} | Has real-time data but SIRI never showed it. Rarer, more alarming. |
| late_pickup | ${latePickups.length} | Started GTFS-only, SIRI eventually caught up. Bus was real. |
| siri_throughout | ${siriThroughout.length} | SIRI had it from the start. Any GTFS-only is post-arrival noise. |
| too_far | ${tooFar.length} | ETA never dropped below ${ETA_FAR_THRESHOLD_MIN}min AND no VP within ${VP_CLOSE_M}m. Can't confirm ghost. |
| insufficient_data | ${insufficient.length} | < ${MIN_OBSERVATIONS} observations or < ${MIN_SPAN_MS / 60000} min span. |

## Methodology

### What is a ghost bus?

A bus that GTFS-rt reports as approaching a stop (visible in Apple Maps) but SIRI never confirms (not visible in MTA BusTime). **SIRI is ground truth** — if SIRI doesn't show it, the bus doesn't exist for riders using BusTime.

### How this analysis works

1. **Index by tripId** across all snapshots. For each snapshot, scan both \`gtfsOnlyTrips\` (GTFS-rt only) and \`vehicles\` (SIRI-matched with tripId). Build a timeline per trip.

2. **Build a lifecycle** per tripId tracking: ETA progression, count of GTFS-only vs SIRI-matched observations, whether SIRI ever acknowledged it, \`isFallback\` status, and VP distance to stop.

3. **Classify** each lifecycle using a waterfall:
   - **insufficient_data** — < ${MIN_OBSERVATIONS} observations or < ${MIN_SPAN_MS / 60000} min span
   - **siri_throughout** — first observation was SIRI-matched, SIRI had it from the start
   - **late_pickup** — started GTFS-only, but SIRI eventually picked it up
   - **ghost** — SIRI never acknowledged AND (ETA got within ${ETA_CLOSE_THRESHOLD_MIN}min OR VP within ${VP_CLOSE_M}m)
     - **ghost (fallback)** — \`isFallback: true\`, scheduled data for a non-existent bus
     - **ghost (real-time)** — real-time data but SIRI still never showed it
   - **too_far** — ETA never dropped below ${ETA_FAR_THRESHOLD_MIN}min AND no VP within ${VP_CLOSE_M}m

### Key thresholds

| Parameter | Value | Meaning |
|-----------|-------|---------|
| ETA close | ${ETA_CLOSE_THRESHOLD_MIN} min | Trip must have ETA under this to qualify as ghost |
| ETA far | ${ETA_FAR_THRESHOLD_MIN} min | If ETA never dropped below this, classified as too_far |
| VP close | ${VP_CLOSE_M}m | VP within this distance qualifies as approaching |
| Min observations | ${MIN_OBSERVATIONS} | Minimum snapshots to analyze a trip |
| Min span | ${MIN_SPAN_MS / 60000} min | Minimum time span to analyze a trip |

---

*Generated by BusWatch trip lifecycle analysis — ${new Date().toISOString()}*
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

  // Step 1: Index by tripId
  const tripMap = indexByTripId(snapshots, stopCoords)
  console.log(`Found ${tripMap.size} unique trips`)

  // Step 2: Build lifecycles
  const lifecycles = buildLifecycles(tripMap)
  console.log(`Built ${lifecycles.length} trip lifecycles`)

  // Step 3: Classify
  classifyLifecycles(lifecycles)

  const ghosts = lifecycles.filter((lc) =>
    lc.classification === "ghost (fallback)" || lc.classification === "ghost (real-time)"
  )
  const ghostFallback = ghosts.filter((lc) => lc.classification === "ghost (fallback)")
  const ghostRealtime = ghosts.filter((lc) => lc.classification === "ghost (real-time)")
  const latePickups = lifecycles.filter((lc) => lc.classification === "late_pickup")
  const siriThroughout = lifecycles.filter((lc) => lc.classification === "siri_throughout")
  const tooFar = lifecycles.filter((lc) => lc.classification === "too_far")
  const insufficient = lifecycles.filter((lc) => lc.classification === "insufficient_data")

  console.log(`\nClassification results:`)
  console.log(`  Ghost (fallback): ${ghostFallback.length}`)
  console.log(`  Ghost (real-time): ${ghostRealtime.length}`)
  console.log(`  Late pickup: ${latePickups.length}`)
  console.log(`  SIRI throughout: ${siriThroughout.length}`)
  console.log(`  Too far: ${tooFar.length}`)
  console.log(`  Insufficient data: ${insufficient.length}`)

  // Generate report
  const report = generateReport(snapshots, lifecycles, stopCoords)

  await mkdir(path.dirname(REPORT_PATH), { recursive: true })
  await writeFile(REPORT_PATH, report, "utf-8")
  console.log(`\nReport written to ${REPORT_PATH}`)

  // Console summary
  const approachingTrips = ghosts.length + latePickups.length + siriThroughout.length
  const ghostRate = approachingTrips > 0
    ? ((ghosts.length / approachingTrips) * 100).toFixed(1)
    : "N/A"
  console.log(`\n--- Quick Summary ---`)
  console.log(`Ghost rate: ${ghostRate}% (${ghosts.length} of ${approachingTrips} approaching trips)`)

  if (ghosts.length > 0) {
    console.log(`\nTop ghost trips:`)
    ghosts
      .sort((a, b) => (a.minEtaMinutes ?? 999) - (b.minEtaMinutes ?? 999))
      .slice(0, 5)
      .forEach((g) => {
        const route = extractRouteName(g.routeId)
        const minEta = g.minEtaMinutes != null ? `${Math.round(g.minEtaMinutes * 10) / 10}min` : "—"
        const minDist = g.minVpDistanceToStop != null ? `${Math.round(g.minVpDistanceToStop)}m` : "no VP"
        console.log(`  ${route} trip ${g.tripId} — min ETA: ${minEta}, min VP dist: ${minDist}, fallback: ${g.isFallback}`)
      })
  }

  if (latePickups.length > 0) {
    console.log(`\nTop late pickups:`)
    latePickups
      .sort((a, b) => (b.siriPickupDelayMs ?? 0) - (a.siriPickupDelayMs ?? 0))
      .slice(0, 3)
      .forEach((lp) => {
        const route = extractRouteName(lp.routeId)
        const delay = lp.siriPickupDelayMs != null ? `${Math.round(lp.siriPickupDelayMs / 60000)}min` : "?"
        console.log(`  ${route} trip ${lp.tripId} — SIRI pickup delay: ${delay}`)
      })
  }
}

main()
