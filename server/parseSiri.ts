import { config } from "./config.ts"
import type { BusRoute, StopData } from "./types.ts"

interface MonitoredStopVisit {
  MonitoredVehicleJourney: {
    PublishedLineName: string[] | string
    DestinationName: string[] | string
    VehicleRef: string
    MonitoredCall: {
      ExpectedArrivalTime?: string
      ArrivalProximityText?: string
      Extensions: {
        Distances: {
          PresentableDistance: string
          StopsFromCall: number
        }
      }
    }
  }
}

interface SiriResponse {
  Siri: {
    ServiceDelivery: {
      StopMonitoringDelivery: Array<{
        MonitoredStopVisit?: MonitoredStopVisit[]
      }>
    }
  }
}

function computeMinutes(expectedArrival: string | undefined): { minutes: string; minutesNum: number } {
  if (!expectedArrival) return { minutes: "unknown", minutesNum: 999 }

  const diff = (new Date(expectedArrival).getTime() - Date.now()) / 60000
  const rounded = Math.max(0, Math.round(diff))

  if (rounded === 0) return { minutes: "approaching", minutesNum: 0 }
  if (rounded === 1) return { minutes: "1 minute", minutesNum: 1 }
  return { minutes: `${rounded} minutes`, minutesNum: rounded }
}

function parseStopsAway(visit: MonitoredStopVisit): string {
  const call = visit.MonitoredVehicleJourney.MonitoredCall
  const presentable = call.Extensions?.Distances?.PresentableDistance
  if (presentable) return presentable

  const stops = call.Extensions?.Distances?.StopsFromCall
  if (stops !== undefined) {
    if (stops === 0) return "at stop"
    return `${stops} stop${stops === 1 ? "" : "s"} away`
  }

  return ""
}

export async function fetchSiri(stopCode: string): Promise<StopData> {
  const url = `https://bustime.mta.info/api/siri/stop-monitoring.json?key=${encodeURIComponent(config.apiKey)}&MonitoringRef=${encodeURIComponent(stopCode)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`SIRI API returned ${res.status}`)

  const data = await res.json() as SiriResponse
  const visits = data.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit ?? []

  // Group by route + direction
  const routeMap = new Map<string, BusRoute>()

  for (const visit of visits) {
    const journey = visit.MonitoredVehicleJourney
    const rawLine = journey.PublishedLineName
    const route = Array.isArray(rawLine) ? rawLine[0] : rawLine ?? "Unknown"
    const rawDest = journey.DestinationName
    const direction = Array.isArray(rawDest) ? rawDest[0] : rawDest ?? ""
    const vehicleId = journey.VehicleRef ?? ""
    const expectedArrival = journey.MonitoredCall?.ExpectedArrivalTime
    const { minutes, minutesNum } = computeMinutes(expectedArrival)
    const stopsAway = parseStopsAway(visit)

    const key = `${route}|${direction}`
    if (!routeMap.has(key)) {
      routeMap.set(key, { route, direction, arrivals: [] })
    }

    routeMap.get(key)!.arrivals.push({ minutes, minutesNum, stopsAway, vehicleId })
  }

  // Sort arrivals within each route by minutesNum
  for (const busRoute of routeMap.values()) {
    busRoute.arrivals.sort((a, b) => a.minutesNum - b.minutesNum)
  }

  return {
    stopName: "", // SIRI doesn't return stop name in this endpoint
    routes: Array.from(routeMap.values()),
  }
}
