import path from "node:path"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { fetchSiri } from "./parseSiri.ts"
import { getStopByCode } from "./stopsIndex.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_GAP_INDEX_PATH = path.join(__dirname, "..", "data", "stop-gaps.v1.json")
const RESULT_CACHE_TTL_MS = 60_000
const MAX_SIRI_PROBES = 25
const LOCAL_HEADWAY_WINDOW = 5

export interface UnhappyStopResult {
  stopCode: string
  stopName: string
  lat: number
  lon: number
  overdueMinutes: number
  expectedHeadway: number
  relativeOverdue: number
  scheduledArrival: string
  nextScheduledArrival: string
  routes: string[]
  siriVerified: boolean
  computedAt: string
}

type DayType = "weekday" | "saturday" | "sunday"

interface StopSchedule {
  stopCode: string
  routes: string[]
  arrivals: number[]
  typicalHeadway: number
}

interface ScheduleArtifact {
  version: 2
  generatedAt: string
  dayTypes: Record<DayType, StopSchedule[]>
}

interface RankedCandidate {
  stop: StopSchedule
  overdueMinutes: number
  expectedHeadway: number
  relativeOverdue: number
  lastScheduledMin: number
  nextScheduledMin: number
}

let gapIndex: ScheduleArtifact | null = null
let cachedResult: UnhappyStopResult | null = null
let cachedResultAt = 0

export async function loadGapIndex(): Promise<void> {
  try {
    const raw = await readFile(DEFAULT_GAP_INDEX_PATH, "utf-8")
    const parsed = JSON.parse(raw) as ScheduleArtifact
    gapIndex = parsed.version === 2 ? parsed : null
    if (!gapIndex) {
      console.warn(`[unhappy] Unsupported schedule index version in ${DEFAULT_GAP_INDEX_PATH}`)
      return
    }
    const total =
      gapIndex.dayTypes.weekday.length +
      gapIndex.dayTypes.saturday.length +
      gapIndex.dayTypes.sunday.length
    console.log(`[unhappy] Loaded schedule index: ${total} stops from ${DEFAULT_GAP_INDEX_PATH}`)
  } catch {
    console.warn(`[unhappy] Schedule index unavailable at ${DEFAULT_GAP_INDEX_PATH}`)
    gapIndex = null
  }
}

function getDayType(date: Date): DayType {
  const day = date.getDay()
  if (day === 0) return "sunday"
  if (day === 6) return "saturday"
  return "weekday"
}

function minutesSinceMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

function formatMinutesAsTime(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440
  const h = Math.floor(normalized / 60)
  const m = normalized % 60
  const period = h >= 12 ? "PM" : "AM"
  const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${displayH}:${String(m).padStart(2, "0")} ${period}`
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function upperBound(values: number[], target: number): number {
  let low = 0
  let high = values.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (values[mid] <= target) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  return low
}

function collectLocalHeadways(arrivals: number[], boundaryIndex: number): number[] {
  const headways: number[] = []
  const start = Math.max(1, boundaryIndex - LOCAL_HEADWAY_WINDOW)
  const end = Math.min(arrivals.length - 1, boundaryIndex + LOCAL_HEADWAY_WINDOW)

  for (let i = start; i <= end; i += 1) {
    const gap = arrivals[i] - arrivals[i - 1]
    if (gap > 0) headways.push(gap)
  }

  return headways
}

function rankStop(stop: StopSchedule, nowMin: number): RankedCandidate | null {
  const nextIndex = upperBound(stop.arrivals, nowMin)
  if (nextIndex <= 0 || nextIndex >= stop.arrivals.length) return null

  const lastScheduledMin = stop.arrivals[nextIndex - 1]
  const nextScheduledMin = stop.arrivals[nextIndex]
  const scheduledGap = nextScheduledMin - lastScheduledMin
  if (scheduledGap <= 0) return null

  const overdueMinutes = nowMin - lastScheduledMin
  if (overdueMinutes <= 0) return null

  const localHeadways = collectLocalHeadways(stop.arrivals, nextIndex)
  const localTypical = median(localHeadways) || stop.typicalHeadway
  const expectedHeadway = Math.max(localTypical, scheduledGap)
  if (expectedHeadway <= 0) return null

  return {
    stop,
    overdueMinutes,
    expectedHeadway,
    relativeOverdue: overdueMinutes / expectedHeadway,
    lastScheduledMin,
    nextScheduledMin,
  }
}

function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  if (b.relativeOverdue !== a.relativeOverdue) {
    return b.relativeOverdue - a.relativeOverdue
  }
  if (b.overdueMinutes !== a.overdueMinutes) {
    return b.overdueMinutes - a.overdueMinutes
  }
  return a.stop.stopCode.localeCompare(b.stop.stopCode)
}

function hasBusAtStopNow(siri: Awaited<ReturnType<typeof fetchSiri>>): boolean {
  return siri.routes.some((route) =>
    route.arrivals.some((arrival) =>
      arrival.minutesNum <= 1 || arrival.stopsAway === "at stop",
    ),
  )
}

export async function computeUnhappiestStop(): Promise<UnhappyStopResult | null> {
  const now = Date.now()
  if (cachedResult && now - cachedResultAt < RESULT_CACHE_TTL_MS) {
    return cachedResult
  }

  if (!gapIndex) {
    cachedResult = null
    cachedResultAt = now
    return null
  }

  const date = new Date()
  const dayType = getDayType(date)
  const nowMin = minutesSinceMidnight(date)
  const schedules = gapIndex.dayTypes[dayType]

  const ranked = schedules
    .map((stop) => rankStop(stop, nowMin))
    .filter((candidate): candidate is RankedCandidate => candidate !== null)
    .sort(compareCandidates)
    .slice(0, MAX_SIRI_PROBES)

  for (const candidate of ranked) {
    const stop = getStopByCode(candidate.stop.stopCode)
    if (!stop) continue

    let siriVerified = false
    try {
      const siri = await fetchSiri(candidate.stop.stopCode)
      if (hasBusAtStopNow(siri)) continue
      siriVerified = true
    } catch {
      siriVerified = false
    }

    const result: UnhappyStopResult = {
      stopCode: candidate.stop.stopCode,
      stopName: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      overdueMinutes: candidate.overdueMinutes,
      expectedHeadway: Math.round(candidate.expectedHeadway * 10) / 10,
      relativeOverdue: Math.round(candidate.relativeOverdue * 100) / 100,
      scheduledArrival: formatMinutesAsTime(candidate.lastScheduledMin),
      nextScheduledArrival: formatMinutesAsTime(candidate.nextScheduledMin),
      routes: candidate.stop.routes,
      siriVerified,
      computedAt: new Date(now).toISOString(),
    }

    cachedResult = result
    cachedResultAt = now
    return result
  }

  cachedResult = null
  cachedResultAt = now
  return null
}
