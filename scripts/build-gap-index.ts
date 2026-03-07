import { readdir, writeFile } from "node:fs/promises"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

interface StopSchedule {
  stopCode: string
  routes: string[]
  arrivals: number[]
  typicalHeadway: number
}

interface StopScheduleArtifact {
  version: 2
  generatedAt: string
  dayTypes: {
    weekday: StopSchedule[]
    saturday: StopSchedule[]
    sunday: StopSchedule[]
  }
}

type DayType = "weekday" | "saturday" | "sunday"

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === "\"") {
      const next = line[i + 1]
      if (inQuotes && next === "\"") {
        current += "\""
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (char === "," && !inQuotes) {
      values.push(current)
      current = ""
      continue
    }
    current += char
  }

  values.push(current)
  return values
}

async function streamCsv(
  filePath: string,
  onHeader: (headerMap: Map<string, number>) => void,
  onRow: (cols: string[], headerMap: Map<string, number>) => void,
): Promise<void> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  })

  let headerMap: Map<string, number> | null = null
  for await (const line of rl) {
    if (!line || !line.trim()) continue
    if (!headerMap) {
      const headers = parseCsvLine(line).map((h) => h.trim())
      headerMap = new Map(headers.map((h, i) => [h, i]))
      onHeader(headerMap)
      continue
    }
    onRow(parseCsvLine(line), headerMap)
  }
}

function trailingSix(stopId: string): string | null {
  const match = stopId.match(/(\d{6})$/)
  return match ? match[1] : null
}

function parseTimeToMinutes(timeStr: string): number | null {
  const parts = timeStr.trim().split(":")
  if (parts.length < 2) return null
  const h = Number.parseInt(parts[0], 10)
  const m = Number.parseInt(parts[1], 10)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}

function getDayTypes(cal: {
  monday: boolean
  tuesday: boolean
  wednesday: boolean
  thursday: boolean
  friday: boolean
  saturday: boolean
  sunday: boolean
}): DayType[] {
  const types: DayType[] = []
  if (cal.monday || cal.tuesday || cal.wednesday || cal.thursday || cal.friday) {
    types.push("weekday")
  }
  if (cal.saturday) types.push("saturday")
  if (cal.sunday) types.push("sunday")
  return types
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function computeTypicalHeadway(arrivals: number[]): number {
  const headways: number[] = []
  for (let i = 1; i < arrivals.length; i += 1) {
    const gap = arrivals[i] - arrivals[i - 1]
    if (gap > 0) headways.push(gap)
  }

  const typical = median(headways)
  return typical > 0 ? Math.round(typical * 10) / 10 : 0
}

const FEEDS = ["manhattan", "bronx", "brooklyn", "queens", "staten-island", "mtabc"]
const SERVICE_START_MIN = 360
const SERVICE_END_MIN = 1440
const MIN_ARRIVALS_PER_STOP = 3
const EXPRESS_PREFIXES = ["BM", "BxM", "QM", "SIM", "X"]

function isExpress(route: string): boolean {
  return EXPRESS_PREFIXES.some((p) => route.startsWith(p))
}

async function main() {
  const gtfsRoot = process.argv[2] ?? path.join(process.cwd(), "data", "gtfs")
  const outputPath = process.argv[3] ?? path.join(process.cwd(), "data", "stop-gaps.v1.json")

  const entries = await readdir(gtfsRoot, { withFileTypes: true })
  const feeds = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => FEEDS.includes(name))

  if (feeds.length === 0) {
    console.error("[build-gap-index] No feed directories found")
    process.exit(1)
  }

  const arrivalsByStop = new Map<string, Map<DayType, number[]>>()
  const routesByStop = new Map<string, Set<string>>()
  const midRouteStops = new Set<string>()

  for (const feed of feeds) {
    const feedRoot = path.join(gtfsRoot, feed)
    const calendarPath = path.join(feedRoot, "calendar.txt")
    const tripsPath = path.join(feedRoot, "trips.txt")
    const routesPath = path.join(feedRoot, "routes.txt")
    const stopTimesPath = path.join(feedRoot, "stop_times.txt")

    for (const p of [calendarPath, tripsPath, routesPath, stopTimesPath]) {
      if (!fs.existsSync(p)) {
        console.warn(`[build-gap-index] Missing ${p}, skipping feed ${feed}`)
        continue
      }
    }

    const serviceDayTypes = new Map<string, DayType[]>()
    await streamCsv(calendarPath, () => {}, (cols, hm) => {
      const serviceId = (cols[hm.get("service_id")!] ?? "").trim()
      if (!serviceId) return
      const cal = {
        monday: cols[hm.get("monday")!]?.trim() === "1",
        tuesday: cols[hm.get("tuesday")!]?.trim() === "1",
        wednesday: cols[hm.get("wednesday")!]?.trim() === "1",
        thursday: cols[hm.get("thursday")!]?.trim() === "1",
        friday: cols[hm.get("friday")!]?.trim() === "1",
        saturday: cols[hm.get("saturday")!]?.trim() === "1",
        sunday: cols[hm.get("sunday")!]?.trim() === "1",
      }
      serviceDayTypes.set(serviceId, getDayTypes(cal))
    })

    const routeNames = new Map<string, string>()
    await streamCsv(routesPath, () => {}, (cols, hm) => {
      const routeId = (cols[hm.get("route_id")!] ?? "").trim()
      const shortName = (cols[hm.get("route_short_name")!] ?? "").trim()
      if (routeId && shortName) routeNames.set(routeId, shortName)
    })

    const trips = new Map<string, { routeId: string; serviceId: string }>()
    await streamCsv(tripsPath, () => {}, (cols, hm) => {
      const tripId = (cols[hm.get("trip_id")!] ?? "").trim()
      const routeId = (cols[hm.get("route_id")!] ?? "").trim()
      const serviceId = (cols[hm.get("service_id")!] ?? "").trim()
      if (tripId) trips.set(tripId, { routeId, serviceId })
    })

    const tripMaxSeq = new Map<string, number>()
    console.log(`[build-gap-index] ${feed}: pass 1 — scanning stop_times for trip max sequences...`)
    await streamCsv(stopTimesPath, () => {}, (cols, hm) => {
      const tripId = (cols[hm.get("trip_id")!] ?? "").trim()
      const seq = Number.parseInt((cols[hm.get("stop_sequence")!] ?? "").trim(), 10)
      if (!tripId || Number.isNaN(seq)) return
      const existing = tripMaxSeq.get(tripId)
      if (existing === undefined || seq > existing) {
        tripMaxSeq.set(tripId, seq)
      }
    })

    let rowCount = 0
    console.log(`[build-gap-index] ${feed}: pass 2 — accumulating arrivals...`)
    await streamCsv(stopTimesPath, () => {}, (cols, hm) => {
      rowCount += 1
      const tripId = (cols[hm.get("trip_id")!] ?? "").trim()
      const rawStopId = (cols[hm.get("stop_id")!] ?? "").trim()
      const arrivalStr = (cols[hm.get("arrival_time")!] ?? "").trim()
      const seq = Number.parseInt((cols[hm.get("stop_sequence")!] ?? "").trim(), 10)
      if (!tripId || !rawStopId || !arrivalStr || Number.isNaN(seq)) return

      const stopCode = trailingSix(rawStopId)
      if (!stopCode) return

      const maxSeq = tripMaxSeq.get(tripId)
      const isMidRoute = seq > 1 && maxSeq !== undefined && seq < maxSeq
      if (isMidRoute) midRouteStops.add(stopCode)

      const trip = trips.get(tripId)
      if (!trip) return

      const dayTypes = serviceDayTypes.get(trip.serviceId)
      if (!dayTypes || dayTypes.length === 0) return

      const minutes = parseTimeToMinutes(arrivalStr)
      if (minutes === null || minutes < SERVICE_START_MIN || minutes > SERVICE_END_MIN) return

      let stopMap = arrivalsByStop.get(stopCode)
      if (!stopMap) {
        stopMap = new Map()
        arrivalsByStop.set(stopCode, stopMap)
      }

      for (const dt of dayTypes) {
        let arrivals = stopMap.get(dt)
        if (!arrivals) {
          arrivals = []
          stopMap.set(dt, arrivals)
        }
        arrivals.push(minutes)
      }

      const routeName = routeNames.get(trip.routeId)
      if (routeName) {
        let routes = routesByStop.get(stopCode)
        if (!routes) {
          routes = new Set()
          routesByStop.set(stopCode, routes)
        }
        routes.add(routeName)
      }
    })

    console.log(`[build-gap-index] ${feed}: ${rowCount} stop_time rows, ${tripMaxSeq.size} trips`)
  }

  const schedulesByDayType: Record<DayType, StopSchedule[]> = {
    weekday: [],
    saturday: [],
    sunday: [],
  }

  for (const [stopCode, dayTypeMap] of arrivalsByStop) {
    if (!midRouteStops.has(stopCode)) continue

    const routes = routesByStop.get(stopCode)
    const localRoutes = routes ? Array.from(routes).filter((r) => !isExpress(r)).sort() : []
    if (localRoutes.length === 0) continue

    for (const [dayType, arrivals] of dayTypeMap) {
      if (arrivals.length < MIN_ARRIVALS_PER_STOP) continue
      const sorted = [...arrivals].sort((a, b) => a - b)
      const typicalHeadway = computeTypicalHeadway(sorted)
      if (typicalHeadway <= 0) continue

      schedulesByDayType[dayType].push({
        stopCode,
        routes: localRoutes,
        arrivals: sorted,
        typicalHeadway,
      })
    }
  }

  for (const dt of ["weekday", "saturday", "sunday"] as DayType[]) {
    schedulesByDayType[dt].sort((a, b) => a.stopCode.localeCompare(b.stopCode))
  }

  const artifact: StopScheduleArtifact = {
    version: 2,
    generatedAt: new Date().toISOString(),
    dayTypes: schedulesByDayType,
  }

  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")

  console.log(`[build-gap-index] Wrote ${outputPath}`)
  for (const dt of ["weekday", "saturday", "sunday"] as DayType[]) {
    const count = schedulesByDayType[dt].length
    const sample = schedulesByDayType[dt][0]
    const summary = sample
      ? `${sample.stopCode} arrivals=${sample.arrivals.length} typical=${sample.typicalHeadway}min`
      : "none"
    console.log(`[build-gap-index] ${dt}: ${count} stops, sample: ${summary}`)
  }
}

main().catch((err) => {
  console.error("[build-gap-index] Failed:", err)
  process.exit(1)
})
