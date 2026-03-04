export interface BusArrival {
  minutes: string
  minutesNum: number
  stopsAway: string
  vehicleId: string
}

export interface BusRoute {
  route: string
  direction: string
  arrivals: BusArrival[]
}

export interface StopData {
  stopName: string
  routes: BusRoute[]
}

export interface IndexedStop {
  code: string
  name: string
  normalizedName: string
  lat: number
  lon: number
}

export type SearchDirection = "nb" | "sb" | "eb" | "wb" | "unknown"

export interface SearchIndexedStop {
  id: number
  code: string
  name: string
  canonical: string
  altForms: string[]
  tokenBag: string[]
  intersectionKey: string
  intersectionKeySorted: string
  direction: SearchDirection
  streetNumber?: number
  avenueNumber?: number
  trigrams: string[]
  lat: number
  lon: number
}

export interface SearchIndexArtifactV1 {
  version: 1
  generatedAt: string
  sourceFile: string
  stopCount: number
  stops: SearchIndexedStop[]
}

export interface StopSearchResult {
  code: string
  name: string
  distanceMeters?: number
  directionLabel?: string
  directionShort?: "NB" | "SB" | "EB" | "WB" | "VAR" | "UNK"
  directionConfidence?: "high" | "medium" | "low"
  directionSource?: "trip+cardinal" | "cardinal" | "trip" | "none"
}

export interface EnrichedStopDirection {
  code: string
  directionLabel: string
  directionShort: "NB" | "SB" | "EB" | "WB" | "VAR" | "UNK"
  directionConfidence: "high" | "medium" | "low"
  directionSource: "trip+cardinal" | "cardinal" | "trip" | "none"
}

export interface EnrichedStopsArtifactV1 {
  version: 1
  generatedAt: string
  gtfsRoot: string
  stopCount: number
  stops: Array<EnrichedStopDirection>
}

export interface GtfsRtArrival {
  routeId: string
  tripId: string
  vehicleId: string
  arrivalTime: number | null
  arrivalDelay: number | null
  scheduleRelationship: string
}

export interface GtfsRtTripSummary {
  tripId: string
  routeId: string
  vehicleId: string
  totalStops: number
  stopsWithDelay0: number
  stopsWithNoData: number
  stopsWithNullDelay: number
  isFallbackSuspected: boolean
}

export interface VehiclePositionData {
  vehicleId: string
  tripId: string
  routeId: string
  latitude: number
  longitude: number
  timestamp: number
  speed: number | null
  currentStatus: string | null
}

export interface SnapshotVehicle {
  vehicleId: string
  route: string
  siriEtaMinutes: number | null
  siriDistance: string
  gtfsDelay: number | null
  gtfsStatus: string | null
  gtfsArrivalTime: number | null
  flag: "OK" | "NO_VP" | "STALE_VP" | "FAR" | "NO_GTFS_RT"
  tripId: string | null
  vpLatitude: number | null
  vpLongitude: number | null
  vpTimestamp: number | null
  hasVehiclePosition: boolean
}

export interface GtfsOnlyTrip {
  tripId: string
  routeId: string
  vehicleId: string
  isFallback: boolean
  arrivalDelay: number | null
  arrivalTime: number | null
  scheduleRelationship: string
  hasVehiclePosition: boolean
  vpLatitude: number | null
  vpLongitude: number | null
  vpTimestamp: number | null
}

export interface SnapshotEntry {
  timestamp: string
  stopCode: string
  stopLatitude?: number
  stopLongitude?: number
  vehicles: SnapshotVehicle[]
  gtfsOnlyTrips: GtfsOnlyTrip[]
}
