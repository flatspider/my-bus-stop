import type { BusArrival, BusRoute } from './types'

export interface ArrivalCardItem {
  id: string
  route: string
  direction: string
  arrival: BusArrival
  minutesNum: number
}

export function deriveArrivalCards(routes: BusRoute[], maxPerRoute = 2): ArrivalCardItem[] {
  const flattened: ArrivalCardItem[] = []

  for (const routeEntry of routes) {
    routeEntry.arrivals.forEach((arrival, arrivalIndex) => {
      const hasVehicleId = arrival.vehicleId.trim().length > 0
      const stableId = hasVehicleId
        ? `${routeEntry.route}|${arrival.vehicleId}`
        : `${routeEntry.route}|${routeEntry.direction}|${arrival.minutesNum}|${arrivalIndex}`

      flattened.push({
        id: stableId,
        route: routeEntry.route,
        direction: routeEntry.direction,
        arrival,
        minutesNum: arrival.minutesNum,
      })
    })
  }

  flattened.sort((a, b) => {
    if (a.minutesNum !== b.minutesNum) return a.minutesNum - b.minutesNum
    if (a.route !== b.route) return a.route.localeCompare(b.route)
    return a.id.localeCompare(b.id)
  })

  const routeCounts = new Map<string, number>()
  const limited: ArrivalCardItem[] = []

  for (const item of flattened) {
    const currentCount = routeCounts.get(item.route) ?? 0
    if (currentCount >= maxPerRoute) continue
    routeCounts.set(item.route, currentCount + 1)
    limited.push(item)
  }

  return limited
}
