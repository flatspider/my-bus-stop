import { config } from "./config.ts"
import type { BusRoute, StopData } from "./types.ts"
const SIRI_DEBUG = process.env.SIRI_DEBUG === "1"

interface MonitoredStopVisit {
  MonitoredVehicleJourney: {
    PublishedLineName: string[] | string
    DestinationName: string[] | string
    DirectionRef?: string
    VehicleRef: string
    MonitoredCall: {
      ExpectedArrivalTime?: string
      StopPointName?: string[] | string
      ArrivalProximityText?: string
      Extensions: {
        Distances: {
          PresentableDistance: string
          StopsFromCall: number
        }
      }
    }
    OnwardCalls?: {
      OnwardCall?: Array<{
        StopPointName?: string[] | string | { value?: string; Text?: string; $?: string }
      }>
    }
  }
}

function toText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = toText(item).trim()
      if (text) return text
    }
    return ""
  }
  if (value && typeof value === "object") {
    const maybe = value as { value?: unknown; Text?: unknown; $?: unknown }
    return (
      toText(maybe.value).trim() ||
      toText(maybe.Text).trim() ||
      toText(maybe.$).trim()
    )
  }
  return ""
}

function firstText(value: string[] | string | undefined): string {
  return toText(value)
}

function parseStopName(visits: MonitoredStopVisit[]): string {
  for (const visit of visits) {
    const journey = visit.MonitoredVehicleJourney
    const fromCall = toText(journey.MonitoredCall?.StopPointName).trim()
    if (fromCall) return fromCall

    const onwardCalls = journey.OnwardCalls?.OnwardCall ?? []
    for (const call of onwardCalls) {
      const fromOnward = toText(call.StopPointName).trim()
      if (fromOnward) return fromOnward
    }
  }
  return ""
}

interface SiriResponse {
  Siri: {
    ServiceDelivery: {
      StopMonitoringDelivery: Array<{
        MonitoredStopVisit?: MonitoredStopVisit[]
        ErrorCondition?: unknown
        Status?: boolean
        ResponseMessage?: string
      }>
      ErrorCondition?: unknown
      Status?: boolean
      ResponseMessage?: string
    }
  }
}

function logSiriShape(stopCode: string, data: SiriResponse, visits: MonitoredStopVisit[]): void {
  if (!SIRI_DEBUG) return

  const firstDelivery = data.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]
  const firstVisit = visits[0]

  console.log(`[SIRI_DEBUG] stop=${stopCode} visits=${visits.length}`)
  console.log(
    "[SIRI_DEBUG] top-level keys:",
    Object.keys(data?.Siri?.ServiceDelivery ?? {}),
  )
  console.log(
    "[SIRI_DEBUG] first delivery keys:",
    firstDelivery ? Object.keys(firstDelivery) : [],
  )

  if (firstVisit) {
    console.log(
      "[SIRI_DEBUG] first visit (trimmed):",
      JSON.stringify(
        {
          journeyKeys: Object.keys(firstVisit.MonitoredVehicleJourney ?? {}),
          monitoredCall: firstVisit.MonitoredVehicleJourney?.MonitoredCall ?? null,
          publishedLineName:
            firstVisit.MonitoredVehicleJourney?.PublishedLineName ?? null,
          destinationName:
            firstVisit.MonitoredVehicleJourney?.DestinationName ?? null,
        },
        null,
        2,
      ),
    )
  } else {
    console.log("[SIRI_DEBUG] no MonitoredStopVisit records found")
  }
}

function getStopMonitoringDelivery(data: SiriResponse): SiriResponse["Siri"]["ServiceDelivery"]["StopMonitoringDelivery"][number] | undefined {
  return data.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]
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
  const rawStops = call.Extensions?.Distances?.StopsFromCall
  if (rawStops !== undefined && rawStops !== null) {
    const stops =
      typeof rawStops === "number" ? rawStops : Number.parseInt(String(rawStops), 10)
    if (!Number.isNaN(stops)) {
      if (stops <= 0) return "at stop"
      return `${stops} stop${stops === 1 ? "" : "s"} away`
    }
  }

  const presentable = call.Extensions?.Distances?.PresentableDistance
  if (presentable) return presentable

  return ""
}

export async function fetchSiri(stopCode: string): Promise<StopData> {
  const url = `https://bustime.mta.info/api/siri/stop-monitoring.json?key=${encodeURIComponent(config.apiKey)}&MonitoringRef=${encodeURIComponent(stopCode)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`SIRI API returned ${res.status}`)

  const data = await res.json() as SiriResponse
  const delivery = getStopMonitoringDelivery(data)
  const visits = delivery?.MonitoredStopVisit ?? []
  logSiriShape(stopCode, data, visits)
  const stopName = parseStopName(visits)
  if (SIRI_DEBUG) console.log(`[SIRI_DEBUG] parsed stopName="${stopName}"`)

  // Group by route + direction
  const routeMap = new Map<string, BusRoute>()

  for (const visit of visits) {
    const journey = visit.MonitoredVehicleJourney
    const route = firstText(journey.PublishedLineName) || "Unknown"
    const direction = firstText(journey.DestinationName)
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
    stopName,
    routes: Array.from(routeMap.values()),
  }
}
