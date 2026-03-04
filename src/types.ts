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
}
