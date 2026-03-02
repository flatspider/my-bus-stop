import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { normalizeVehicleId } from "./utils.ts"
import type { StopData, GtfsRtArrival, GtfsRtTripSummary, VehiclePositionData, SnapshotVehicle, SnapshotEntry } from "./types.ts"

const LOG_PATH = path.join(process.cwd(), "data", "comparison-log.md")
const JSONL_PATH = path.join(process.cwd(), "data", "snapshots.jsonl")

const ETA_THRESHOLD = 20
const STALE_THRESHOLD_S = 90

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
        flag,
        tripId: gtfsMatch?.tripId ?? null,
        vpLatitude: vpData?.latitude ?? null,
        vpLongitude: vpData?.longitude ?? null,
        vpTimestamp: vpData?.timestamp ?? null,
        hasVehiclePosition: !!vpData,
      })
    }
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

### Summary
Routes: ${siriRouteNames.size} | Fallback suspected: ${fallbackCount} | Real-time: ${realtimeCount} | No GTFS-RT: ${noGtfsCount} | VP entries: ${vehiclePositions.size}
---
`

  await mkdir(path.dirname(LOG_PATH), { recursive: true })
  await appendFile(LOG_PATH, entry, "utf-8")

  // Write structured JSONL for analysis
  const snapshot: SnapshotEntry = {
    timestamp,
    stopCode,
    vehicles: snapshotVehicles,
  }
  await appendFile(JSONL_PATH, JSON.stringify(snapshot) + "\n", "utf-8")
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
