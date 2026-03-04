import path from "node:path"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import type { IndexedStop, StopSearchResult } from "./types.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_INDEX_PATH = path.join(__dirname, "..", "data", "stops-index.json")

const MAX_LIMIT = 10
const DEFAULT_SEARCH_LIMIT = 8
const DEFAULT_NEARBY_LIMIT = 3
const DEFAULT_NEARBY_RADIUS_METERS = 1609

let cachedStops: IndexedStop[] = []

export interface SearchOptions {
  lat?: number
  lon?: number
  limit?: number
}

export interface NearbyOptions {
  radius?: number
  limit?: number
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || Number.isNaN(limit)) return fallback
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

function normalize(text: string): string {
  return text
    .toUpperCase()
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/\bNORTHBOUND\b/g, "NB")
    .replace(/\bSOUTHBOUND\b/g, "SB")
    .replace(/\bEASTBOUND\b/g, "EB")
    .replace(/\bWESTBOUND\b/g, "WB")
    .replace(/[^A-Z0-9\s/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokenize(text: string): string[] {
  return normalize(text).split(" ").filter(Boolean)
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

function tokenScore(queryTokens: string[], stopTokens: string[]): number {
  if (queryTokens.length === 0) return 0

  let score = 0
  for (const queryToken of queryTokens) {
    let best = 0
    for (const stopToken of stopTokens) {
      if (stopToken === queryToken) {
        best = Math.max(best, 16)
        continue
      }
      if (stopToken.startsWith(queryToken)) {
        best = Math.max(best, 10)
        continue
      }
      if (stopToken.includes(queryToken)) {
        best = Math.max(best, 5)
      }
    }
    score += best
  }

  return score
}

function scoreStop(stop: IndexedStop, query: string, queryTokens: string[]): number {
  if (!query) return 0

  let score = 0
  const normalized = stop.normalizedName

  if (normalized === query) score += 120
  else if (normalized.startsWith(query)) score += 80
  else if (normalized.includes(query)) score += 40

  score += tokenScore(queryTokens, stop.normalizedName.split(" "))

  return score
}

function formatResult(stop: IndexedStop, distanceMeters: number | undefined): StopSearchResult {
  if (distanceMeters === undefined) {
    return { code: stop.code, name: stop.name }
  }

  return {
    code: stop.code,
    name: stop.name,
    distanceMeters: Math.round(distanceMeters),
  }
}

export async function loadStopsIndex(indexPath = DEFAULT_INDEX_PATH): Promise<void> {
  try {
    const raw = await readFile(indexPath, "utf-8")
    const parsed = JSON.parse(raw) as Array<Partial<IndexedStop>>

    cachedStops = parsed
      .filter((entry): entry is IndexedStop => (
        typeof entry.code === "string" &&
        typeof entry.name === "string" &&
        typeof entry.normalizedName === "string" &&
        typeof entry.lat === "number" &&
        typeof entry.lon === "number"
      ))
      .map((entry) => ({
        code: entry.code,
        name: entry.name,
        normalizedName: normalize(entry.normalizedName),
        lat: entry.lat,
        lon: entry.lon,
      }))

    console.log(`[stops] Loaded ${cachedStops.length} indexed stops from ${indexPath}`)
  } catch (error) {
    cachedStops = []
    console.error(`[stops] Failed to load stop index at ${indexPath}:`, error)
  }
}

export function getStopsIndexCount(): number {
  return cachedStops.length
}

export function searchStops(query: string, options: SearchOptions = {}): StopSearchResult[] {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return []

  const queryTokens = tokenize(normalizedQuery)
  const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT)
  const hasLocation = options.lat !== undefined && options.lon !== undefined

  const ranked = cachedStops
    .map((stop) => {
      const textScore = scoreStop(stop, normalizedQuery, queryTokens)
      if (textScore <= 0) return null

      const distanceMeters = hasLocation
        ? haversineMeters(options.lat as number, options.lon as number, stop.lat, stop.lon)
        : undefined

      // Proximity is a secondary boost, capped to avoid defeating text relevance.
      const proximityScore = distanceMeters !== undefined
        ? Math.max(0, 12 - (distanceMeters / 2500))
        : 0

      return {
        stop,
        textScore,
        proximityScore,
        distanceMeters,
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  ranked.sort((a, b) => {
    const aScore = a.textScore + a.proximityScore
    const bScore = b.textScore + b.proximityScore

    if (bScore !== aScore) return bScore - aScore
    if (a.distanceMeters !== undefined && b.distanceMeters !== undefined && a.distanceMeters !== b.distanceMeters) {
      return a.distanceMeters - b.distanceMeters
    }
    return a.stop.code.localeCompare(b.stop.code)
  })

  return ranked.slice(0, limit).map((entry) => formatResult(entry.stop, entry.distanceMeters))
}

export function nearbyStops(lat: number, lon: number, options: NearbyOptions = {}): StopSearchResult[] {
  const radius = options.radius !== undefined && !Number.isNaN(options.radius)
    ? Math.max(100, options.radius)
    : DEFAULT_NEARBY_RADIUS_METERS
  const limit = clampLimit(options.limit, DEFAULT_NEARBY_LIMIT)

  const results = cachedStops
    .map((stop) => {
      const distanceMeters = haversineMeters(lat, lon, stop.lat, stop.lon)
      return { stop, distanceMeters }
    })
    .filter((entry) => entry.distanceMeters <= radius)

  results.sort((a, b) => {
    if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters - b.distanceMeters
    return a.stop.code.localeCompare(b.stop.code)
  })

  return results.slice(0, limit).map((entry) => formatResult(entry.stop, entry.distanceMeters))
}
