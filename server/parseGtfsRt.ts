import GtfsRealtimeBindings from "gtfs-realtime-bindings"
import { config } from "./config.ts"
import { normalizeVehicleId } from "./utils.ts"
import type { GtfsRtArrival, VehiclePositionData } from "./types.ts"

const GTFS_RT_URL = `https://gtfsrt.prod.obanyc.com/tripUpdates`
const VP_URL = `https://gtfsrt.prod.obanyc.com/vehiclePositions`
const CACHE_TTL_MS = 30_000

const SCHEDULE_RELATIONSHIP_NAMES: Record<number, string> = {
  0: "SCHEDULED",
  1: "SKIPPED",
  2: "NO_DATA",
  3: "UNSCHEDULED",
}

// Module-level cache
let cachedFeed: ReturnType<typeof GtfsRealtimeBindings.transit_realtime.FeedMessage.decode> | null = null
let cachedAt = 0

async function getFeed() {
  const now = Date.now()
  if (cachedFeed && now - cachedAt < CACHE_TTL_MS) {
    return cachedFeed
  }

  const res = await fetch(`${GTFS_RT_URL}?key=${encodeURIComponent(config.apiKey)}`)
  if (!res.ok) throw new Error(`GTFS-RT fetch failed: ${res.status}`)

  const buffer = await res.arrayBuffer()
  cachedFeed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer))
  cachedAt = now
  return cachedFeed
}

function resolveScheduleRelationship(value: number | null | undefined): string {
  if (value == null) return "SCHEDULED"
  return SCHEDULE_RELATIONSHIP_NAMES[value] ?? `UNKNOWN(${value})`
}

export async function fetchGtfsRtForStop(stopCode: string): Promise<GtfsRtArrival[]> {
  const feed = await getFeed()
  const arrivals: GtfsRtArrival[] = []

  // Try exact match first, then MTA_ prefix
  const candidates = [stopCode, `MTA_${stopCode}`]

  let matchCount = 0

  for (const entity of feed.entity) {
    const tu = entity.tripUpdate
    if (!tu?.stopTimeUpdate) continue

    const routeId = tu.trip?.routeId ?? ""
    const tripId = tu.trip?.tripId ?? ""
    const vehicleId = tu.vehicle?.id ?? ""

    for (const stu of tu.stopTimeUpdate) {
      const sid = stu.stopId ?? ""
      if (!candidates.some((c) => sid === c || sid.endsWith(`_${c}`))) continue

      matchCount++
      arrivals.push({
        routeId,
        tripId,
        vehicleId,
        arrivalTime: stu.arrival?.time != null ? Number(stu.arrival.time) : null,
        arrivalDelay: stu.arrival?.delay ?? null,
        scheduleRelationship: resolveScheduleRelationship(stu.scheduleRelationship),
      })
    }
  }

  if (matchCount === 0) {
    console.warn(`[GTFS-RT] No stop_id matches for "${stopCode}" (tried: ${candidates.join(", ")})`)
  }

  return arrivals
}


// --- Vehicle Position Feed ---

const VEHICLE_STATUS_NAMES: Record<number, string> = {
  0: "INCOMING_AT",
  1: "STOPPED_AT",
  2: "IN_TRANSIT_TO",
}

let cachedVpFeed: ReturnType<typeof GtfsRealtimeBindings.transit_realtime.FeedMessage.decode> | null = null
let cachedVpAt = 0

async function getVpFeed() {
  const now = Date.now()
  if (cachedVpFeed && now - cachedVpAt < CACHE_TTL_MS) {
    return cachedVpFeed
  }

  const res = await fetch(`${VP_URL}?key=${encodeURIComponent(config.apiKey)}`)
  if (!res.ok) throw new Error(`GTFS-RT VP fetch failed: ${res.status}`)

  const buffer = await res.arrayBuffer()
  cachedVpFeed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer))
  cachedVpAt = now
  return cachedVpFeed
}

export async function fetchVehiclePositions(): Promise<Map<string, VehiclePositionData>> {
  const feed = await getVpFeed()
  const positions = new Map<string, VehiclePositionData>()

  for (const entity of feed.entity) {
    const vp = entity.vehicle
    if (!vp) continue

    const rawId = vp.vehicle?.id ?? ""
    if (!rawId) continue

    const vehicleId = normalizeVehicleId(rawId)
    const pos = vp.position

    positions.set(vehicleId, {
      vehicleId,
      tripId: vp.trip?.tripId ?? "",
      routeId: vp.trip?.routeId ?? "",
      latitude: pos?.latitude ?? 0,
      longitude: pos?.longitude ?? 0,
      timestamp: vp.timestamp != null ? Number(vp.timestamp) : 0,
      speed: pos?.speed ?? null,
      currentStatus: vp.currentStatus != null ? (VEHICLE_STATUS_NAMES[vp.currentStatus] ?? `UNKNOWN(${vp.currentStatus})`) : null,
    })
  }

  return positions
}
