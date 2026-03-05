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

export interface StopSearchResult {
  code: string
  name: string
  distanceMeters?: number
  directionLabel?: string
  directionShort?: "NB" | "SB" | "EB" | "WB" | "VAR" | "UNK"
  directionConfidence?: "high" | "medium" | "low"
  directionSource?: "trip+cardinal" | "cardinal" | "trip" | "none"
}

export type MiniMapUnavailableReason = "timeout" | "no_roads" | "low_quality" | "error"

export type StopMiniMapResponse =
  | {
    status: "ready"
    code: string
    svg: string
    generatedAt: string
    source: "cache" | "generated"
  }
  | {
    status: "unavailable"
    code: string
    reason: MiniMapUnavailableReason
  }
