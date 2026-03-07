import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { normalizeVehicleId } from "./utils.ts"
import type { StopData, GtfsRtArrival, VehiclePositionData, SnapshotVehicle, SnapshotEntry, GtfsOnlyTrip, CorridorSnapshot, CorridorStopSiri } from "./types.ts"

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
  timestamp: string,
  stopCode: string,
  siriData: StopData,
  stopArrivals: GtfsRtArrival[],
  vehiclePositions: Map<string, VehiclePositionData>
): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000)

  // --- Stop-Level Comparison ---
  const gtfsByVehicle = new Map<string, GtfsRtArrival>()
  for (const a of stopArrivals) {
    const normalizedId = a.vehicleId ? normalizeVehicleId(a.vehicleId) : ""
    if (normalizedId) gtfsByVehicle.set(normalizedId, a)
  }

  const tableRows: string[] = []
  const snapshotVehicles: SnapshotVehicle[] = []
  for (const siriRoute of siriData.routes) {
    for (const arrival of siriRoute.arrivals) {
      const normalizedId = arrival.vehicleId ? normalizeVehicleId(arrival.vehicleId) : ""
      const etaMinutes = arrival.minutesNum === 999 ? null : arrival.minutesNum

      // Only trust an explicit vehicle ID match. Route-order matching produced
      // duplicate trip assignments and polluted the downstream analysis.
      const gtfsMatch = normalizedId ? gtfsByVehicle.get(normalizedId) : undefined

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

  for (const arrival of stopArrivals) {
    const normalizedId = arrival.vehicleId ? normalizeVehicleId(arrival.vehicleId) : ""
    if (!normalizedId || siriVehicleIds.has(normalizedId)) continue

    const vpData = vehiclePositions.get(normalizedId)
    const shortRoute = extractRouteName(arrival.routeId)

    gtfsOnlyTrips.push({
      tripId: arrival.tripId,
      routeId: arrival.routeId,
      vehicleId: normalizedId,
      arrivalDelay: arrival.arrivalDelay,
      arrivalTime: arrival.arrivalTime,
      scheduleRelationship: arrival.scheduleRelationship,
      hasVehiclePosition: !!vpData,
      vpLatitude: vpData?.latitude ?? null,
      vpLongitude: vpData?.longitude ?? null,
      vpTimestamp: vpData?.timestamp ?? null,
    })

    const vpTag = vpData ? `VP age ${nowEpoch - vpData.timestamp}s` : "NO VP"
    gtfsOnlyLines.push(
      `| ${shortRoute} | ${normalizedId} | ${arrival.tripId} | ${arrival.arrivalDelay ?? "—"} | ${vpTag} | ${arrival.scheduleRelationship} |`
    )
  }

  const entry = `
## Stop ${stopCode} @ ${timestamp}

### Stop-Level Comparison (Stop ${stopCode})
| Route | Vehicle | SIRI ETA | SIRI Distance | VP Age | VP Status | Flag |
|-------|---------|----------|---------------|--------|-----------|------|
${tableRows.length > 0 ? tableRows.join("\n") : "| — | — | — | — | — | — | No data |"}

### GTFS-RT Only (not in SIRI) — ${gtfsOnlyTrips.length} trip${gtfsOnlyTrips.length === 1 ? "" : "s"}
${gtfsOnlyLines.length > 0 ? `| Route | Vehicle | Trip | Delay | VP | Status |
|-------|---------|------|-------|----|--------|
${gtfsOnlyLines.join("\n")}` : "None — all GTFS-RT trips matched a SIRI vehicle"}

### Summary
Routes: ${siriData.routes.length} | GTFS-only: ${gtfsOnlyTrips.length} | VP entries: ${vehiclePositions.size}
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
  timestamp: string,
  corridorStops: { before: string; primary: string; after: string },
  siriResults: { stopCode: string; role: "before" | "primary" | "after"; data: StopData }[],
  primaryArrivals: GtfsRtArrival[],
  vehiclePositions: Map<string, VehiclePositionData>,
): Promise<void> {
  const MAX_STOPS_AWAY = 5

  const siriStops: CorridorStopSiri[] = siriResults.map((s) => ({
    stopCode: s.stopCode,
    role: s.role,
    vehicles: s.data.routes.flatMap((r) =>
      r.arrivals
        .filter((a) => {
          if (a.stopsAway === "at stop") return true
          const match = a.stopsAway.match(/^(\d+) stop/)
          return match ? parseInt(match[1], 10) <= MAX_STOPS_AWAY : false
        })
        .map((a) => ({
          vehicleId: normalizeVehicleId(a.vehicleId),
          route: r.route,
          etaMinutes: a.minutesNum === 999 ? null : a.minutesNum,
          stopsAway: a.stopsAway,
        }))
    ),
  }))

  // Only keep vehicle positions for buses that appear in nearby SIRI or GTFS arrivals
  const relevantVehicleIds = new Set<string>()
  for (const stop of siriStops) {
    for (const v of stop.vehicles) {
      relevantVehicleIds.add(v.vehicleId)
    }
  }
  for (const a of primaryArrivals) {
    if (a.vehicleId) relevantVehicleIds.add(a.vehicleId)
  }

  const snapshot: CorridorSnapshot = {
    timestamp,
    corridor: corridorStops,
    siriStops,
    gtfsArrivals: primaryArrivals,
    tripSummaries: primaryArrivals.map((a) => ({
      tripId: a.tripId,
      routeId: a.routeId,
      vehicleId: a.vehicleId,
    })),
    vehiclePositions: [...vehiclePositions.values()]
      .filter((vp) => relevantVehicleIds.has(vp.vehicleId))
      .map((vp) => ({
        vehicleId: vp.vehicleId,
        routeId: vp.routeId,
        tripId: vp.tripId,
        latitude: vp.latitude,
        longitude: vp.longitude,
        timestamp: vp.timestamp,
        currentStatus: vp.currentStatus,
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
