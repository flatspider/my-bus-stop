import { readdir, writeFile } from "node:fs/promises"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

type Cardinal = "NB" | "SB" | "EB" | "WB"
type DirectionId = "0" | "1"
type Confidence = "high" | "medium" | "low"

interface StopRow {
  stopId: string
  code: string
  name: string
  lat: number
  lon: number
  textDirection: Cardinal | null
}

interface FeedReport {
  feed: string
  stops: number
  trips: number
  stopTimes: number
}

interface EnrichedStop {
  code: string
  name: string
  lat: number
  lon: number
  feeds: string[]
  stopIds: string[]
  directionLabel: string
  directionShort: Cardinal | "VAR" | "UNK"
  directionConfidence: Confidence
  directionSource: "trip+cardinal" | "cardinal" | "trip" | "none"
  directionIds: DirectionId[]
  directionIdCounts: Record<DirectionId, number>
  cardinalCounts: Record<Cardinal, number>
  cardinalByDirectionId: Record<DirectionId, Record<Cardinal, number>>
  stats: {
    serviceRows: number
    stopDefinitions: number
    nameVariantCount: number
  }
}

interface EnrichedStopsArtifact {
  version: 1
  generatedAt: string
  gtfsRoot: string
  feedReports: FeedReport[]
  stopCount: number
  stops: EnrichedStop[]
}

interface Accumulator {
  code: string
  feeds: Set<string>
  stopIds: Set<string>
  nameCounts: Map<string, number>
  latSum: number
  lonSum: number
  latLonCount: number
  stopDefinitionCount: number
  serviceRows: number
  directionIdCounts: Record<DirectionId, number>
  cardinalCounts: Record<Cardinal, number>
  cardinalByDirectionId: Record<DirectionId, Record<Cardinal, number>>
  textDirectionCounts: Record<Cardinal, number>
}

const PREFERRED_FEED_ORDER = [
  "bronx",
  "brooklyn",
  "manhattan",
  "queens",
  "staten-island",
  "mtabc",
]

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
  onHeader: (headerMap: Map<string, number>) => Promise<void> | void,
  onRow: (cols: string[], headerMap: Map<string, number>) => Promise<void> | void,
): Promise<void> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  })

  let headerMap: Map<string, number> | null = null
  for await (const line of rl) {
    if (!line || !line.trim()) continue
    if (!headerMap) {
      const headers = parseCsvLine(line).map((header) => header.trim())
      headerMap = new Map(headers.map((header, index) => [header, index]))
      await onHeader(headerMap)
      continue
    }

    const cols = parseCsvLine(line)
    await onRow(cols, headerMap)
  }
}

function trailingSix(stopId: string): string | null {
  const match = stopId.match(/(\d{6})$/)
  return match ? match[1] : null
}

function detectTextDirection(text: string): Cardinal | null {
  const value = text.toUpperCase()
  if (/\bNORTHBOUND\b|\bNB\b|\bUPTOWN\b/.test(value)) return "NB"
  if (/\bSOUTHBOUND\b|\bSB\b|\bDOWNTOWN\b/.test(value)) return "SB"
  if (/\bEASTBOUND\b|\bEB\b/.test(value)) return "EB"
  if (/\bWESTBOUND\b|\bWB\b/.test(value)) return "WB"
  return null
}

function toCardinal(lat1: number, lon1: number, lat2: number, lon2: number): Cardinal | null {
  const dLat = lat2 - lat1
  const dLon = lon2 - lon1
  if (!Number.isFinite(dLat) || !Number.isFinite(dLon)) return null
  if (Math.abs(dLat) < 1e-7 && Math.abs(dLon) < 1e-7) return null
  if (Math.abs(dLat) >= Math.abs(dLon)) return dLat >= 0 ? "NB" : "SB"
  return dLon >= 0 ? "EB" : "WB"
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000
  const toRad = (value: number) => (value * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function isOpposite(a: Cardinal, b: Cardinal): boolean {
  return (
    (a === "NB" && b === "SB") ||
    (a === "SB" && b === "NB") ||
    (a === "EB" && b === "WB") ||
    (a === "WB" && b === "EB")
  )
}

function createAccumulator(code: string): Accumulator {
  return {
    code,
    feeds: new Set<string>(),
    stopIds: new Set<string>(),
    nameCounts: new Map<string, number>(),
    latSum: 0,
    lonSum: 0,
    latLonCount: 0,
    stopDefinitionCount: 0,
    serviceRows: 0,
    directionIdCounts: { "0": 0, "1": 0 },
    cardinalCounts: { NB: 0, SB: 0, EB: 0, WB: 0 },
    cardinalByDirectionId: {
      "0": { NB: 0, SB: 0, EB: 0, WB: 0 },
      "1": { NB: 0, SB: 0, EB: 0, WB: 0 },
    },
    textDirectionCounts: { NB: 0, SB: 0, EB: 0, WB: 0 },
  }
}

function incrementNameCount(acc: Accumulator, name: string, weight = 1): void {
  const trimmed = name.trim()
  if (!trimmed) return
  acc.nameCounts.set(trimmed, (acc.nameCounts.get(trimmed) ?? 0) + weight)
}

function updateDirectionSignal(
  acc: Accumulator,
  directionId: DirectionId | null,
  cardinal: Cardinal | null,
): void {
  if (directionId) {
    acc.directionIdCounts[directionId] += 1
  }

  if (!cardinal) return
  acc.cardinalCounts[cardinal] += 1
  if (directionId) {
    acc.cardinalByDirectionId[directionId][cardinal] += 1
  }
}

function dominantCardinalFromCounts(counts: Record<Cardinal, number>): {
  cardinal: Cardinal | null
  share: number
} {
  const entries = (Object.entries(counts) as Array<[Cardinal, number]>)
    .sort((a, b) => b[1] - a[1])
  if (entries.length === 0 || entries[0][1] <= 0) {
    return { cardinal: null, share: 0 }
  }

  const total = entries.reduce((sum, [, value]) => sum + value, 0)
  return {
    cardinal: entries[0][0],
    share: entries[0][1] / Math.max(1, total),
  }
}

function directionLabelFromCardinal(cardinal: Cardinal): string {
  if (cardinal === "NB") return "Northbound"
  if (cardinal === "SB") return "Southbound"
  if (cardinal === "EB") return "Eastbound"
  return "Westbound"
}

function summarizeDirection(acc: Accumulator): {
  label: string
  short: Cardinal | "VAR" | "UNK"
  confidence: Confidence
  source: "trip+cardinal" | "cardinal" | "trip" | "none"
  directionIds: DirectionId[]
} {
  const directionIds = (["0", "1"] as const).filter((id) => acc.directionIdCounts[id] > 0)
  const overall = dominantCardinalFromCounts(acc.cardinalCounts)
  const byDir0 = dominantCardinalFromCounts(acc.cardinalByDirectionId["0"])
  const byDir1 = dominantCardinalFromCounts(acc.cardinalByDirectionId["1"])

  if (directionIds.length === 1) {
    const onlyDir = directionIds[0]
    const byDir = onlyDir === "0" ? byDir0 : byDir1
    const chosen = byDir.cardinal ?? overall.cardinal
    if (chosen) {
      const share = byDir.cardinal ? byDir.share : overall.share
      const confidence: Confidence = share >= 0.75 ? "high" : "medium"
      return {
        label: directionLabelFromCardinal(chosen),
        short: chosen,
        confidence,
        source: "trip+cardinal",
        directionIds,
      }
    }

    return {
      label: "Direction known (non-cardinal)",
      short: "VAR",
      confidence: "low",
      source: "trip",
      directionIds,
    }
  }

  if (directionIds.length === 2) {
    if (byDir0.cardinal && byDir1.cardinal && isOpposite(byDir0.cardinal, byDir1.cardinal)) {
      const axis = [byDir0.cardinal, byDir1.cardinal].includes("NB") ? "Northbound/Southbound" : "Eastbound/Westbound"
      const pairConfidence: Confidence = Math.min(byDir0.share, byDir1.share) >= 0.65 ? "medium" : "low"
      return {
        label: `${axis} (varies by route)`,
        short: "VAR",
        confidence: pairConfidence,
        source: "trip+cardinal",
        directionIds,
      }
    }

    return {
      label: "Direction varies",
      short: "VAR",
      confidence: "low",
      source: overall.cardinal ? "trip+cardinal" : "trip",
      directionIds,
    }
  }

  if (overall.cardinal) {
    const confidence: Confidence = overall.share >= 0.75 ? "medium" : "low"
    return {
      label: directionLabelFromCardinal(overall.cardinal),
      short: overall.cardinal,
      confidence,
      source: "cardinal",
      directionIds: [],
    }
  }

  const text = dominantCardinalFromCounts(acc.textDirectionCounts)
  if (text.cardinal) {
    return {
      label: directionLabelFromCardinal(text.cardinal),
      short: text.cardinal,
      confidence: "low",
      source: "none",
      directionIds: [],
    }
  }

  return {
    label: "Unknown direction",
    short: "UNK",
    confidence: "low",
    source: "none",
    directionIds: [],
  }
}

function pickRepresentativeName(nameCounts: Map<string, number>): string {
  let bestName = ""
  let bestCount = -1
  for (const [name, count] of nameCounts.entries()) {
    if (count > bestCount) {
      bestCount = count
      bestName = name
    }
  }
  return bestName
}

function sortFeeds(feeds: string[]): string[] {
  const rank = new Map(PREFERRED_FEED_ORDER.map((feed, index) => [feed, index]))
  return [...feeds].sort((a, b) => {
    const aRank = rank.get(a)
    const bRank = rank.get(b)
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank
    if (aRank !== undefined) return -1
    if (bRank !== undefined) return 1
    return a.localeCompare(b)
  })
}

async function loadStopRows(stopsPath: string): Promise<Map<string, StopRow>> {
  const rows = new Map<string, StopRow>()
  await streamCsv(
    stopsPath,
    (headerMap) => {
      for (const required of ["stop_id", "stop_name", "stop_lat", "stop_lon"]) {
        if (!headerMap.has(required)) {
          throw new Error(`${stopsPath}: missing required column ${required}`)
        }
      }
    },
    (cols, headerMap) => {
      const stopId = (cols[headerMap.get("stop_id") as number] ?? "").trim()
      const code = trailingSix(stopId)
      if (!code) return

      const name = (cols[headerMap.get("stop_name") as number] ?? "").trim()
      const desc = headerMap.has("stop_desc") ? (cols[headerMap.get("stop_desc") as number] ?? "").trim() : ""
      const lat = Number.parseFloat((cols[headerMap.get("stop_lat") as number] ?? "").trim())
      const lon = Number.parseFloat((cols[headerMap.get("stop_lon") as number] ?? "").trim())
      if (!name || Number.isNaN(lat) || Number.isNaN(lon)) return

      const textDirection = detectTextDirection(desc) ?? detectTextDirection(name)
      rows.set(stopId, { stopId, code, name, lat, lon, textDirection })
    },
  )
  return rows
}

async function loadTrips(tripsPath: string): Promise<Map<string, DirectionId | null>> {
  const trips = new Map<string, DirectionId | null>()
  await streamCsv(
    tripsPath,
    (headerMap) => {
      if (!headerMap.has("trip_id")) {
        throw new Error(`${tripsPath}: missing required column trip_id`)
      }
      if (!headerMap.has("direction_id")) {
        throw new Error(`${tripsPath}: missing required column direction_id`)
      }
    },
    (cols, headerMap) => {
      const tripId = (cols[headerMap.get("trip_id") as number] ?? "").trim()
      if (!tripId) return
      const rawDirection = (cols[headerMap.get("direction_id") as number] ?? "").trim()
      const directionId: DirectionId | null = rawDirection === "0" || rawDirection === "1" ? rawDirection : null
      trips.set(tripId, directionId)
    },
  )
  return trips
}

async function main() {
  const gtfsRoot = process.argv[2] ?? path.join(process.cwd(), "data", "gtfs")
  const outputPath = process.argv[3] ?? path.join(process.cwd(), "data", "stops-enriched.json")

  const entries = await readdir(gtfsRoot, { withFileTypes: true })
  const feeds = sortFeeds(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  if (feeds.length === 0) {
    console.error(`[build-enriched-stops] No feed directories found under ${gtfsRoot}`)
    process.exit(1)
  }

  const accumulators = new Map<string, Accumulator>()
  const feedReports: FeedReport[] = []

  for (const feed of feeds) {
    const feedRoot = path.join(gtfsRoot, feed)
    const stopsPath = path.join(feedRoot, "stops.txt")
    const tripsPath = path.join(feedRoot, "trips.txt")
    const stopTimesPath = path.join(feedRoot, "stop_times.txt")
    const shapesPath = path.join(feedRoot, "shapes.txt")

    for (const requiredPath of [stopsPath, tripsPath, stopTimesPath, shapesPath]) {
      if (!fs.existsSync(requiredPath)) {
        console.error(`[build-enriched-stops] Missing required file: ${requiredPath}`)
        process.exit(1)
      }
    }

    const stopRows = await loadStopRows(stopsPath)
    const tripDirections = await loadTrips(tripsPath)

    let stopTimesRows = 0
    const LOOP_THRESHOLD_METERS = 200

    for (const stop of stopRows.values()) {
      const existing = accumulators.get(stop.code) ?? createAccumulator(stop.code)
      existing.feeds.add(feed)
      existing.stopIds.add(stop.stopId)
      existing.latSum += stop.lat
      existing.lonSum += stop.lon
      existing.latLonCount += 1
      existing.stopDefinitionCount += 1
      incrementNameCount(existing, stop.name, 1)
      if (stop.textDirection) {
        existing.textDirectionCounts[stop.textDirection] += 1
      }
      accumulators.set(stop.code, existing)
    }

    // --- Pass 1: Find first/last stop per trip and collect all stops per trip ---
    interface TripSummary {
      firstStopId: string
      lastStopId: string
      firstSequence: number
      lastSequence: number
      stopIds: string[]
    }
    const tripSummaries = new Map<string, TripSummary>()

    await streamCsv(
      stopTimesPath,
      (headerMap) => {
        for (const required of ["trip_id", "stop_id", "stop_sequence"]) {
          if (!headerMap.has(required)) {
            throw new Error(`${stopTimesPath}: missing required column ${required}`)
          }
        }
      },
      (cols, headerMap) => {
        stopTimesRows += 1

        const tripId = (cols[headerMap.get("trip_id") as number] ?? "").trim()
        const stopId = (cols[headerMap.get("stop_id") as number] ?? "").trim()
        const rawSequence = (cols[headerMap.get("stop_sequence") as number] ?? "").trim()
        const sequence = Number.parseFloat(rawSequence)
        if (!tripId || !stopId || Number.isNaN(sequence)) return

        const existing = tripSummaries.get(tripId)
        if (!existing) {
          tripSummaries.set(tripId, {
            firstStopId: stopId,
            lastStopId: stopId,
            firstSequence: sequence,
            lastSequence: sequence,
            stopIds: [stopId],
          })
          return
        }

        existing.stopIds.push(stopId)
        if (sequence < existing.firstSequence) {
          existing.firstSequence = sequence
          existing.firstStopId = stopId
        }
        if (sequence > existing.lastSequence) {
          existing.lastSequence = sequence
          existing.lastStopId = stopId
        }
      },
    )

    // --- Pass 2: Compute route-level direction per trip and assign to each stop ---
    for (const [tripId, summary] of tripSummaries.entries()) {
      const directionId = tripDirections.get(tripId) ?? null
      const firstStop = stopRows.get(summary.firstStopId)
      const lastStop = stopRows.get(summary.lastStopId)

      // Compute route-level cardinal from first to last stop
      let routeCardinal: Cardinal | null = null
      if (firstStop && lastStop) {
        const distMeters = haversineMeters(firstStop.lat, firstStop.lon, lastStop.lat, lastStop.lon)
        if (distMeters > LOOP_THRESHOLD_METERS) {
          routeCardinal = toCardinal(firstStop.lat, firstStop.lon, lastStop.lat, lastStop.lon)
        }
      }

      // Apply route-level direction to every stop on this trip
      for (const stopId of summary.stopIds) {
        const stop = stopRows.get(stopId)
        if (!stop) continue

        const acc = accumulators.get(stop.code) ?? createAccumulator(stop.code)
        acc.serviceRows += 1
        incrementNameCount(acc, stop.name, 1)
        updateDirectionSignal(acc, directionId, routeCardinal)
        accumulators.set(stop.code, acc)
      }
    }

    feedReports.push({
      feed,
      stops: stopRows.size,
      trips: tripDirections.size,
      stopTimes: stopTimesRows,
    })
  }

  const enrichedStops: EnrichedStop[] = Array.from(accumulators.values())
    .map((acc) => {
      const summary = summarizeDirection(acc)
      const representativeName = pickRepresentativeName(acc.nameCounts)
      const lat = acc.latSum / Math.max(1, acc.latLonCount)
      const lon = acc.lonSum / Math.max(1, acc.latLonCount)
      const feedList = sortFeeds(Array.from(acc.feeds.values()))
      const stopIds = Array.from(acc.stopIds.values()).sort((a, b) => a.localeCompare(b))

      return {
        code: acc.code,
        name: representativeName,
        lat: Number(lat.toFixed(6)),
        lon: Number(lon.toFixed(6)),
        feeds: feedList,
        stopIds,
        directionLabel: summary.label,
        directionShort: summary.short,
        directionConfidence: summary.confidence,
        directionSource: summary.source,
        directionIds: summary.directionIds,
        directionIdCounts: acc.directionIdCounts,
        cardinalCounts: acc.cardinalCounts,
        cardinalByDirectionId: acc.cardinalByDirectionId,
        stats: {
          serviceRows: acc.serviceRows,
          stopDefinitions: acc.stopDefinitionCount,
          nameVariantCount: acc.nameCounts.size,
        },
      }
    })
    .sort((a, b) => a.code.localeCompare(b.code))

  const artifact: EnrichedStopsArtifact = {
    version: 1,
    generatedAt: new Date().toISOString(),
    gtfsRoot,
    feedReports,
    stopCount: enrichedStops.length,
    stops: enrichedStops,
  }

  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")

  const directionShortCounts = { NB: 0, SB: 0, EB: 0, WB: 0, VAR: 0, UNK: 0 }
  for (const stop of enrichedStops) {
    directionShortCounts[stop.directionShort] += 1
  }

  console.log(`[build-enriched-stops] Wrote ${artifact.stopCount} enriched stops to ${outputPath}`)
  console.log(`[build-enriched-stops] Direction summary: ${JSON.stringify(directionShortCounts)}`)
}

main().catch((error) => {
  console.error("[build-enriched-stops] Failed:", error)
  process.exit(1)
})
