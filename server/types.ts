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
