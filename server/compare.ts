import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { normalizeVehicleId } from "./utils.ts"
import type { StopData, GtfsRtArrival, GtfsRtTripSummary, VehiclePositionData, SnapshotVehicle, SnapshotEntry, GtfsOnlyTrip, CorridorSnapshot, CorridorStopSiri } from "./types.ts"

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data")
const LOG_PATH = path.join(DATA_DIR, "comparison-log.md")
const JSONL_PATH = path.join(DATA_DIR, "snapshots.jsonl")
const CORRIDOR_JSONL_PATH = path.join(DATA_DIR, "corridor-snapshots.jsonl")

export { JSONL_PATH, CORRIDOR_JSONL_PATH }

const ETA_THRESHOLD = 20
const STALE_THRESHOLD_S = 90

// Known stop coordinates for ghost analysis distance calculations
const STOP_COORDINATES: Record<string, { latitude: number; longitude: number }> = {
  "402854": { latitude: 40.738982, longitude: -73.983129 },
}

export async function compareAndLog(
  stopCode: string,
  siriData: StopData,
  stopArrivals: GtfsRtArrival[],
  tripSummaries: GtfsRtTripSummary[],
  vehiclePositions: Map<string, VehiclePositionData>
): Promise<void> {
  const timestamp = new Date().toISOString()
  const nowEpoch = Math.floor(Date.now() / 1000)

  // --- Trip-Level Fallback Analysis ---
  const tripLines: string[] = []
  const routesWithFallback = new Set<string>()
  const routesWithRealtime = new Set<string>()
  const gtfsRouteIds = new Set(tripSummaries.map((t) => t.routeId))

  for (const summary of tripSummaries) {
    const shortRoute = extractRouteName(summary.routeId)
    if (summary.isFallbackSuspected) {
      routesWithFallback.add(shortRoute)
      tripLines.push(
        `- **ALERT: ${shortRoute} trip ${summary.tripId}** — ${summary.stopsWithDelay0 + summary.stopsWithNoData}/${summary.totalStops} stops show delay=0 or NO_DATA → SCHEDULE FALLBACK`
      )
    } else {
      routesWithRealtime.add(shortRoute)
      const realtime = summary.totalStops - summary.stopsWithDelay0 - summary.stopsWithNoData - summary.stopsWithNullDelay
      tripLines.push(
        `- ${shortRoute} trip ${summary.tripId} — ${realtime}/${summary.totalStops} stops have real-time delays → OK`
      )
    }
  }

  // Check for SIRI routes missing from GTFS-RT
  for (const siriRoute of siriData.routes) {
    const hasGtfs = [...gtfsRouteIds].some((rid) => rid.endsWith(siriRoute.route))
    if (!hasGtfs) {
      const vehicleCount = siriRoute.arrivals.length
      tripLines.push(
        `- **${siriRoute.route}** — no GTFS-RT trips found (SIRI has ${vehicleCount} vehicle${vehicleCount === 1 ? "" : "s"})`
      )
    }
  }

  // --- Stop-Level Comparison ---
  const gtfsByVehicle = new Map<string, GtfsRtArrival>()
  const gtfsByRoute = new Map<string, GtfsRtArrival[]>()
  for (const a of stopArrivals) {
    if (a.vehicleId) gtfsByVehicle.set(a.vehicleId, a)
    const short = extractRouteName(a.routeId)
    if (!gtfsByRoute.has(short)) gtfsByRoute.set(short, [])
    gtfsByRoute.get(short)!.push(a)
  }

  const tableRows: string[] = []
  const snapshotVehicles: SnapshotVehicle[] = []
  for (const siriRoute of siriData.routes) {
    for (const arrival of siriRoute.arrivals) {
      const normalizedId = arrival.vehicleId ? normalizeVehicleId(arrival.vehicleId) : ""
      const etaMinutes = arrival.minutesNum === 999 ? null : arrival.minutesNum

      // Try matching by vehicle ID first, then by route
      let gtfsMatch = arrival.vehicleId ? gtfsByVehicle.get(arrival.vehicleId) : undefined
      if (!gtfsMatch) {
        const routeArrivals = gtfsByRoute.get(siriRoute.route)
        if (routeArrivals?.length) {
          gtfsMatch = routeArrivals.shift()
        }
      }

      // VP-based flag logic
      const vpData = normalizedId ? vehiclePositions.get(normalizedId) : undefined
      let flag: SnapshotVehicle["flag"] = "NO_GTFS_RT"

      if (etaMinutes !== null && etaMinutes >= ETA_THRESHOLD) {
        flag = "FAR"
      } else if (!vpData) {
        flag = "NO_VP"
      } else {
        const vpAge = nowEpoch - vpData.timestamp
        flag = vpAge > STALE_THRESHOLD_S ? "STALE_VP" : "OK"
      }

      const vpAge = vpData ? `${nowEpoch - vpData.timestamp}s` : "—"

      tableRows.push(
        `| ${siriRoute.route} | ${normalizedId || "—"} | ${arrival.minutes} | ${arrival.stopsAway} | ${vpAge} | ${vpData?.currentStatus ?? "—"} | ${flag} |`
      )

      snapshotVehicles.push({
        vehicleId: normalizedId || "unknown",
        route: siriRoute.route,
        siriEtaMinutes: etaMinutes,
        siriDistance: arrival.stopsAway,
        gtfsDelay: gtfsMatch?.arrivalDelay ?? null,
        gtfsStatus: gtfsMatch?.scheduleRelationship ?? null,
        gtfsArrivalTime: gtfsMatch?.arrivalTime ?? null,
        flag,
        tripId: gtfsMatch?.tripId ?? null,
        vpLatitude: vpData?.latitude ?? null,
        vpLongitude: vpData?.longitude ?? null,
        vpTimestamp: vpData?.timestamp ?? null,
        hasVehiclePosition: !!vpData,
      })
    }
  }

  // --- Reverse Comparison: GTFS-RT → SIRI ---
  // Find trips that appear in GTFS-RT but have no matching SIRI vehicle
  const siriVehicleIds = new Set<string>()
  for (const siriRoute of siriData.routes) {
    for (const arrival of siriRoute.arrivals) {
      if (arrival.vehicleId) {
        siriVehicleIds.add(normalizeVehicleId(arrival.vehicleId))
      }
    }
  }

  const gtfsOnlyTrips: GtfsOnlyTrip[] = []
  const gtfsOnlyLines: string[] = []
  const tripSummaryMap = new Map(tripSummaries.map((t) => [t.tripId, t]))

  for (const arrival of stopArrivals) {
    const normalizedId = arrival.vehicleId ? normalizeVehicleId(arrival.vehicleId) : ""
    if (!normalizedId || siriVehicleIds.has(normalizedId)) continue

    const tripSummary = tripSummaryMap.get(arrival.tripId)
    const isFallback = tripSummary?.isFallbackSuspected ?? false
    const vpData = vehiclePositions.get(normalizedId)
    const shortRoute = extractRouteName(arrival.routeId)

    gtfsOnlyTrips.push({
      tripId: arrival.tripId,
      routeId: arrival.routeId,
      vehicleId: normalizedId,
      isFallback,
      arrivalDelay: arrival.arrivalDelay,
      arrivalTime: arrival.arrivalTime,
      scheduleRelationship: arrival.scheduleRelationship,
      hasVehiclePosition: !!vpData,
      vpLatitude: vpData?.latitude ?? null,
      vpLongitude: vpData?.longitude ?? null,
      vpTimestamp: vpData?.timestamp ?? null,
    })

    const fallbackTag = isFallback ? " **FALLBACK**" : ""
    const vpTag = vpData ? `VP age ${nowEpoch - vpData.timestamp}s` : "NO VP"
    gtfsOnlyLines.push(
      `| ${shortRoute} | ${normalizedId} | ${arrival.tripId} | ${arrival.arrivalDelay ?? "—"} | ${vpTag} | ${arrival.scheduleRelationship}${fallbackTag} |`
    )
  }

  // --- Summary ---
  const siriRouteNames = new Set(siriData.routes.map((r) => r.route))
  const fallbackCount = [...siriRouteNames].filter((r) => routesWithFallback.has(r)).length
  const realtimeCount = [...siriRouteNames].filter((r) => routesWithRealtime.has(r)).length
  const noGtfsCount = siriRouteNames.size - fallbackCount - realtimeCount

  const entry = `
## Stop ${stopCode} @ ${timestamp}

### Trip-Level Fallback Analysis
${tripLines.length > 0 ? tripLines.join("\n") : "No GTFS-RT trip data available"}

### Stop-Level Comparison (Stop ${stopCode})
| Route | Vehicle | SIRI ETA | SIRI Distance | VP Age | VP Status | Flag |
|-------|---------|----------|---------------|--------|-----------|------|
${tableRows.length > 0 ? tableRows.join("\n") : "| — | — | — | — | — | — | No data |"}

### GTFS-RT Only (not in SIRI) — ${gtfsOnlyTrips.length} trip${gtfsOnlyTrips.length === 1 ? "" : "s"}
${gtfsOnlyLines.length > 0 ? `| Route | Vehicle | Trip | Delay | VP | Status |
|-------|---------|------|-------|----|--------|
${gtfsOnlyLines.join("\n")}` : "None — all GTFS-RT trips matched a SIRI vehicle"}

### Summary
Routes: ${siriRouteNames.size} | Fallback suspected: ${fallbackCount} | Real-time: ${realtimeCount} | No GTFS-RT: ${noGtfsCount} | GTFS-only: ${gtfsOnlyTrips.length} | VP entries: ${vehiclePositions.size}
---
`

  await mkdir(path.dirname(LOG_PATH), { recursive: true })
  await appendFile(LOG_PATH, entry, "utf-8")

  // Write structured JSONL for analysis
  const stopCoords = STOP_COORDINATES[stopCode]
  const snapshot: SnapshotEntry = {
    timestamp,
    stopCode,
    ...(stopCoords && { stopLatitude: stopCoords.latitude, stopLongitude: stopCoords.longitude }),
    vehicles: snapshotVehicles,
    gtfsOnlyTrips,
  }
  await appendFile(JSONL_PATH, JSON.stringify(snapshot) + "\n", "utf-8")
}

export async function logCorridorSnapshot(
  corridorStops: { before: string; primary: string; after: string },
  siriResults: { stopCode: string; role: "before" | "primary" | "after"; data: StopData }[],
  primaryArrivals: GtfsRtArrival[],
  tripSummaries: GtfsRtTripSummary[],
  vehiclePositions: Map<string, VehiclePositionData>,
): Promise<void> {
  const timestamp = new Date().toISOString()

  const siriStops: CorridorStopSiri[] = siriResults.map((s) => ({
    stopCode: s.stopCode,
    role: s.role,
    vehicles: s.data.routes.flatMap((r) =>
      r.arrivals.map((a) => ({
        vehicleId: normalizeVehicleId(a.vehicleId),
        route: r.route,
        etaMinutes: a.minutesNum === 999 ? null : a.minutesNum,
        stopsAway: a.stopsAway,
      }))
    ),
  }))

  const snapshot: CorridorSnapshot = {
    timestamp,
    corridor: corridorStops,
    siriStops,
    gtfsArrivals: primaryArrivals,
    tripSummaries: tripSummaries.map((t) => ({
      tripId: t.tripId,
      routeId: t.routeId,
      vehicleId: t.vehicleId,
      isFallbackSuspected: t.isFallbackSuspected,
    })),
    vehiclePositions: [...vehiclePositions.values()].map((vp) => ({
      vehicleId: vp.vehicleId,
      latitude: vp.latitude,
      longitude: vp.longitude,
      timestamp: vp.timestamp,
    })),
  }

  await mkdir(path.dirname(CORRIDOR_JSONL_PATH), { recursive: true })
  await appendFile(CORRIDOR_JSONL_PATH, JSON.stringify(snapshot) + "\n", "utf-8")
}

function extractRouteName(gtfsRouteId: string): string {
  // "MTA NYCT_M101" → "M101"
  const underscoreIdx = gtfsRouteId.lastIndexOf("_")
  if (underscoreIdx !== -1) return gtfsRouteId.slice(underscoreIdx + 1)
  // "MTA NYCT M101" with space
  const spaceIdx = gtfsRouteId.lastIndexOf(" ")
  if (spaceIdx !== -1) return gtfsRouteId.slice(spaceIdx + 1)
  return gtfsRouteId
}
