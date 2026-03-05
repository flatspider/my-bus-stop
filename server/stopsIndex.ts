import path from "node:path"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import type {
  EnrichedStopsArtifactV1,
  SearchIndexArtifactV1,
  SearchIndexedStop,
  StopSearchResult,
} from "./types.ts"
import { buildRuntimeSearchIndex, type RuntimeSearchIndex } from "./search/index.ts"
import { normalizeText } from "./search/normalize.ts"
import { parseIntersection } from "./search/parseQuery.ts"
import { scoreSearchStop } from "./search/score.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SEARCH_INDEX_PATH = path.join(__dirname, "..", "data", "stops-search-index.v1.json")
const DEFAULT_CORRECTIONS_PATH = path.join(__dirname, "..", "data", "search-corrections.json")
const DEFAULT_ENRICHED_STOPS_PATH = path.join(__dirname, "..", "data", "stops-enriched.json")

const MAX_LIMIT = 10
const DEFAULT_SEARCH_LIMIT = 8
const DEFAULT_NEARBY_LIMIT = 3
const DEFAULT_NEARBY_RADIUS_METERS = 1609
const DEBUG_QUERY_LIMIT = 5

let cachedStopsV2: SearchIndexedStop[] = []
let runtimeSearchIndex: RuntimeSearchIndex | null = null
let correctionMap: Record<string, string> = {}
let knownStopCodes = new Set<string>()
let hasWarnedSearchUnavailable = false
let hasWarnedNearbyUnavailable = false
let stopByCode = new Map<string, SearchIndexedStop>()
let enrichedDirectionByCode = new Map<string, {
  directionLabel: string
  directionShort: "NB" | "SB" | "EB" | "WB" | "VAR" | "UNK"
  directionConfidence: "high" | "medium" | "low"
  directionSource: "trip+cardinal" | "cardinal" | "trip" | "none"
}>()

export interface SearchOptions {
  lat?: number
  lon?: number
  limit?: number
  recentCodes?: string[]
}

export interface NearbyOptions {
  radius?: number
  limit?: number
}

export interface SearchDebugResult {
  engine: "v2"
  query: string
  normalizedQuery: string
  candidateCount: number
  parsedIntersection: {
    streetAKey: string
    streetBKey: string
    intersectionKey: string
    intersectionKeySorted: string
    direction: string
  } | null
  topScores: Array<{
    code: string
    score: number
    textScore: number
    directionScore: number
    trigramScore: number
    proximityScore: number
    recencyScore: number
  }>
  results: StopSearchResult[]
}

export interface StopMiniMapMeta {
  code: string
  name: string
  lat: number
  lon: number
  directionLabel?: string
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || Number.isNaN(limit)) return fallback
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
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

function formatResult(code: string, name: string, distanceMeters: number | undefined): StopSearchResult {
  const directionMeta = enrichedDirectionByCode.get(code)

  if (distanceMeters === undefined) {
    return {
      code,
      name,
      ...(directionMeta ?? {}),
    }
  }

  return {
    code,
    name,
    distanceMeters: Math.round(distanceMeters),
    ...(directionMeta ?? {}),
  }
}

function intersectSortedLists(lists: number[][]): number[] {
  if (lists.length === 0) return []

  const sorted = [...lists].sort((a, b) => a.length - b.length)
  let result = sorted[0]

  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i]
    const merged: number[] = []
    let a = 0
    let b = 0

    while (a < result.length && b < next.length) {
      const left = result[a]
      const right = next[b]

      if (left === right) {
        merged.push(left)
        a += 1
        b += 1
      } else if (left < right) {
        a += 1
      } else {
        b += 1
      }
    }

    result = merged
    if (result.length === 0) return []
  }

  return result
}

function unionSortedLists(lists: number[][]): number[] {
  const set = new Set<number>()
  for (const list of lists) {
    for (const id of list) set.add(id)
  }
  return Array.from(set.values()).sort((a, b) => a - b)
}

function toTrigrams(text: string): string[] {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) return []
  if (compact.length <= 3) return [compact]

  const grams = new Set<string>()
  for (let i = 0; i <= compact.length - 3; i += 1) {
    grams.add(compact.slice(i, i + 3))
  }

  return Array.from(grams.values())
}

function parseCorrections(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {}

  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || typeof value !== "string") continue
    const normalizedKey = key.trim().toLowerCase()
    const normalizedValue = value.trim().toLowerCase()
    if (!normalizedKey || !normalizedValue) continue
    out[normalizedKey] = normalizedValue
  }

  return out
}

function parseV2Artifact(raw: unknown): SearchIndexArtifactV1 | null {
  if (!raw || typeof raw !== "object") return null
  const maybe = raw as Partial<SearchIndexArtifactV1>
  if (maybe.version !== 1) return null
  if (!Array.isArray(maybe.stops)) return null

  const stops: SearchIndexedStop[] = []
  for (const entry of maybe.stops) {
    if (!entry || typeof entry !== "object") continue
    const stop = entry as Partial<SearchIndexedStop>
    if (
      typeof stop.id !== "number" ||
      typeof stop.code !== "string" ||
      typeof stop.name !== "string" ||
      typeof stop.canonical !== "string" ||
      !Array.isArray(stop.altForms) ||
      !Array.isArray(stop.tokenBag) ||
      typeof stop.intersectionKey !== "string" ||
      typeof stop.intersectionKeySorted !== "string" ||
      typeof stop.direction !== "string" ||
      !Array.isArray(stop.trigrams) ||
      typeof stop.lat !== "number" ||
      typeof stop.lon !== "number"
    ) {
      continue
    }

    stops.push({
      id: stop.id,
      code: stop.code,
      name: stop.name,
      canonical: stop.canonical,
      altForms: stop.altForms.filter((value): value is string => typeof value === "string"),
      tokenBag: stop.tokenBag.filter((value): value is string => typeof value === "string"),
      intersectionKey: stop.intersectionKey,
      intersectionKeySorted: stop.intersectionKeySorted,
      direction: stop.direction as SearchIndexedStop["direction"],
      streetNumber: typeof stop.streetNumber === "number" ? stop.streetNumber : undefined,
      avenueNumber: typeof stop.avenueNumber === "number" ? stop.avenueNumber : undefined,
      trigrams: stop.trigrams.filter((value): value is string => typeof value === "string"),
      lat: stop.lat,
      lon: stop.lon,
    })
  }

  return {
    version: 1,
    generatedAt: typeof maybe.generatedAt === "string" ? maybe.generatedAt : new Date().toISOString(),
    sourceFile: typeof maybe.sourceFile === "string" ? maybe.sourceFile : "unknown",
    stopCount: stops.length,
    stops,
  }
}

function parseEnrichedStopsArtifact(raw: unknown): EnrichedStopsArtifactV1 | null {
  if (!raw || typeof raw !== "object") return null
  const maybe = raw as Partial<EnrichedStopsArtifactV1>
  if (maybe.version !== 1) return null
  if (!Array.isArray(maybe.stops)) return null

  const validDirections = new Set(["NB", "SB", "EB", "WB", "VAR", "UNK"])
  const validConfidences = new Set(["high", "medium", "low"])
  const validSources = new Set(["trip+cardinal", "cardinal", "trip", "none"])

  const stops = maybe.stops
    .filter((entry): entry is EnrichedStopsArtifactV1["stops"][number] => {
      if (!entry || typeof entry !== "object") return false
      const stop = entry as Partial<EnrichedStopsArtifactV1["stops"][number]>
      return (
        typeof stop.code === "string" &&
        typeof stop.directionLabel === "string" &&
        typeof stop.directionShort === "string" &&
        validDirections.has(stop.directionShort) &&
        typeof stop.directionConfidence === "string" &&
        validConfidences.has(stop.directionConfidence) &&
        typeof stop.directionSource === "string" &&
        validSources.has(stop.directionSource)
      )
    })
    .map((entry) => ({
      code: entry.code,
      directionLabel: entry.directionLabel,
      directionShort: entry.directionShort,
      directionConfidence: entry.directionConfidence,
      directionSource: entry.directionSource,
    }))

  return {
    version: 1,
    generatedAt: typeof maybe.generatedAt === "string" ? maybe.generatedAt : new Date().toISOString(),
    gtfsRoot: typeof maybe.gtfsRoot === "string" ? maybe.gtfsRoot : "unknown",
    stopCount: typeof maybe.stopCount === "number" ? maybe.stopCount : stops.length,
    stops,
  }
}

export async function loadStopsIndex(): Promise<void> {
  try {
    const rawCorrections = await readFile(DEFAULT_CORRECTIONS_PATH, "utf-8")
    correctionMap = parseCorrections(JSON.parse(rawCorrections))
    console.log(`[stops] Loaded ${Object.keys(correctionMap).length} search corrections from ${DEFAULT_CORRECTIONS_PATH}`)
  } catch (error) {
    correctionMap = {}
    console.warn(`[stops] Search corrections unavailable at ${DEFAULT_CORRECTIONS_PATH}:`, error)
  }

  try {
    const rawEnriched = await readFile(DEFAULT_ENRICHED_STOPS_PATH, "utf-8")
    const parsed = parseEnrichedStopsArtifact(JSON.parse(rawEnriched))
    if (parsed) {
      enrichedDirectionByCode = new Map(
        parsed.stops.map((stop) => [
          stop.code,
          {
            directionLabel: stop.directionLabel,
            directionShort: stop.directionShort,
            directionConfidence: stop.directionConfidence,
            directionSource: stop.directionSource,
          },
        ]),
      )
      console.log(`[stops] Loaded enriched direction labels for ${enrichedDirectionByCode.size} stops from ${DEFAULT_ENRICHED_STOPS_PATH}`)
    } else {
      enrichedDirectionByCode = new Map()
      console.warn(`[stops] Enriched stop artifact at ${DEFAULT_ENRICHED_STOPS_PATH} was invalid; direction metadata disabled.`)
    }
  } catch (error) {
    enrichedDirectionByCode = new Map()
    console.warn(`[stops] Enriched stop artifact unavailable at ${DEFAULT_ENRICHED_STOPS_PATH}:`, error)
  }

  try {
    const raw = await readFile(DEFAULT_SEARCH_INDEX_PATH, "utf-8")
    const parsed = parseV2Artifact(JSON.parse(raw))
    if (parsed) {
      cachedStopsV2 = parsed.stops
      runtimeSearchIndex = buildRuntimeSearchIndex(cachedStopsV2)
      hasWarnedSearchUnavailable = false
      hasWarnedNearbyUnavailable = false
      rebuildKnownStopCodes()
      console.log(`[stops] Loaded ${cachedStopsV2.length} v2 indexed stops from ${DEFAULT_SEARCH_INDEX_PATH}`)
      return
    }
    throw new Error("Search artifact JSON did not match expected schema")
  } catch (error) {
    console.error(`[stops] Failed to load v2 stop search index at ${DEFAULT_SEARCH_INDEX_PATH}:`, error)
  }

  cachedStopsV2 = []
  runtimeSearchIndex = null
  rebuildKnownStopCodes()
  return
}

function rebuildKnownStopCodes(): void {
  const next = new Set<string>()
  const nextStops = new Map<string, SearchIndexedStop>()
  for (const stop of cachedStopsV2) {
    next.add(stop.code)
    if (!nextStops.has(stop.code)) {
      nextStops.set(stop.code, stop)
    }
  }
  for (const code of enrichedDirectionByCode.keys()) {
    next.add(code)
  }
  knownStopCodes = next
  stopByCode = nextStops
}

export function getStopMiniMapMeta(stopCode: string): StopMiniMapMeta | null {
  if (!/^\d{6}$/.test(stopCode)) return null
  const stop = stopByCode.get(stopCode)
  if (!stop) return null

  const directionMeta = enrichedDirectionByCode.get(stopCode)
  return {
    code: stop.code,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
    ...(directionMeta?.directionLabel ? { directionLabel: directionMeta.directionLabel } : {}),
  }
}

export function stopCodeExists(stopCode: string): boolean {
  if (!/^\d{6}$/.test(stopCode)) return false
  return knownStopCodes.has(stopCode)
}

export function getStopsIndexCount(): number {
  return cachedStopsV2.length
}

function postingsForToken(index: RuntimeSearchIndex, queryToken: string): number[] {
  const exact = index.tokenPostings.get(queryToken)
  if (exact && exact.length > 0) return exact

  if (queryToken.length < 2) return []

  const prefixMatches: number[][] = []
  for (const token of index.tokenDictionary) {
    if (!token.startsWith(queryToken)) continue
    const posting = index.tokenPostings.get(token)
    if (!posting || posting.length === 0) continue
    prefixMatches.push(posting)
    if (prefixMatches.length >= 24) break
  }

  if (prefixMatches.length === 0) return []
  return unionSortedLists(prefixMatches)
}

function informativeTokens(tokens: string[]): string[] {
  const stopwords = new Set(["and", "the", "at", "bus", "stop"])
  const out: string[] = []
  for (const token of tokens) {
    if (stopwords.has(token)) continue
    if (token.length === 1 && !["n", "s", "e", "w"].includes(token)) continue
    out.push(token)
  }
  return out
}

function buildV2CandidateSet(index: RuntimeSearchIndex, tokens: string[], intersection: ReturnType<typeof parseIntersection>, queryTrigrams: string[]): number[] {
  const tokenLists = informativeTokens(tokens)
    .map((token) => postingsForToken(index, token))
    .filter((list) => list.length > 0)

  let candidates = tokenLists.length > 0 ? intersectSortedLists(tokenLists) : []

  const intersectionLists: number[][] = []
  if (intersection) {
    const direct = index.intersectionPostings.get(intersection.intersectionKey)
    const sorted = index.intersectionPostings.get(intersection.intersectionKeySorted)
    if (direct && direct.length > 0) intersectionLists.push(direct)
    if (sorted && sorted.length > 0) intersectionLists.push(sorted)
  }

  if (intersectionLists.length > 0) {
    const intersectionUnion = unionSortedLists(intersectionLists)
    if (candidates.length > 0) {
      candidates = intersectSortedLists([candidates, intersectionUnion])
    } else {
      candidates = intersectionUnion
    }
  }

  if (candidates.length === 0 && tokenLists.length > 0) {
    candidates = unionSortedLists(tokenLists.slice(0, 4))
  }

  if (candidates.length === 0 && queryTrigrams.length > 0) {
    const gramLists = queryTrigrams
      .map((gram) => index.trigramPostings.get(gram))
      .filter((list): list is number[] => Array.isArray(list) && list.length > 0)
    if (gramLists.length > 0) {
      candidates = unionSortedLists(gramLists)
    }
  }

  return candidates
}

function searchStopsV2Detailed(query: string, options: SearchOptions = {}): SearchDebugResult {
  const index = runtimeSearchIndex
  const normalized = normalizeText(query, { corrections: correctionMap })
  const parsedIntersection = parseIntersection(normalized.tokens)
  const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT)

  if (!index) {
    if (!hasWarnedSearchUnavailable) {
      hasWarnedSearchUnavailable = true
      console.error("[stops] Search V2 index unavailable. Returning empty search results.")
    }
    return {
      engine: "v2",
      query,
      normalizedQuery: normalized.normalized,
      candidateCount: 0,
      parsedIntersection,
      topScores: [],
      results: [],
    }
  }

  if (!normalized.normalized) {
    return {
      engine: "v2",
      query,
      normalizedQuery: normalized.normalized,
      candidateCount: 0,
      parsedIntersection,
      topScores: [],
      results: [],
    }
  }

  const queryTrigrams = toTrigrams(normalized.normalized)
  const hasLocation = options.lat !== undefined && options.lon !== undefined
  const recentCodes = new Set(options.recentCodes ?? [])
  const candidateIds = buildV2CandidateSet(index, normalized.tokens, parsedIntersection, queryTrigrams)

  const scored = candidateIds
    .map((id) => {
      const stop = index.stops[id]
      if (!stop) return null

      const distanceMeters = hasLocation
        ? haversineMeters(options.lat as number, options.lon as number, stop.lat, stop.lon)
        : undefined

      const score = scoreSearchStop(stop, {
        queryCanonical: normalized.normalized,
        queryTokens: normalized.tokens,
        queryDirection: normalized.direction,
        queryTrigrams,
        distanceMeters,
        hasLocation,
        recentCodes,
      })

      return {
        stop,
        distanceMeters,
        ...score,
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .filter((entry) => entry.score > 0)

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.distanceMeters !== undefined && b.distanceMeters !== undefined && a.distanceMeters !== b.distanceMeters) {
      return a.distanceMeters - b.distanceMeters
    }
    return a.stop.code.localeCompare(b.stop.code)
  })

  const results = scored
    .slice(0, limit)
    .map((entry) => formatResult(entry.stop.code, entry.stop.name, entry.distanceMeters))

  return {
    engine: "v2",
    query,
    normalizedQuery: normalized.normalized,
    candidateCount: candidateIds.length,
    parsedIntersection,
    topScores: scored.slice(0, DEBUG_QUERY_LIMIT).map((entry) => ({
      code: entry.stop.code,
      score: Number(entry.score.toFixed(2)),
      textScore: Number(entry.textScore.toFixed(2)),
      directionScore: Number(entry.directionScore.toFixed(2)),
      trigramScore: Number(entry.trigramScore.toFixed(2)),
      proximityScore: Number(entry.proximityScore.toFixed(2)),
      recencyScore: Number(entry.recencyScore.toFixed(2)),
    })),
    results,
  }
}

export function searchStopsWithDebug(query: string, options: SearchOptions = {}): SearchDebugResult {
  return searchStopsV2Detailed(query, options)
}

export function searchStops(query: string, options: SearchOptions = {}): StopSearchResult[] {
  return searchStopsV2Detailed(query, options).results
}

export function nearbyStops(lat: number, lon: number, options: NearbyOptions = {}): StopSearchResult[] {
  const radius = options.radius !== undefined && !Number.isNaN(options.radius)
    ? Math.max(100, options.radius)
    : DEFAULT_NEARBY_RADIUS_METERS
  const limit = clampLimit(options.limit, DEFAULT_NEARBY_LIMIT)

  if (cachedStopsV2.length === 0) {
    if (!hasWarnedNearbyUnavailable) {
      hasWarnedNearbyUnavailable = true
      console.error("[stops] Nearby search index unavailable. Returning empty nearby results.")
    }
    return []
  }

  const results = cachedStopsV2
    .map((stop) => {
      const distanceMeters = haversineMeters(lat, lon, stop.lat, stop.lon)
      return { stop, distanceMeters }
    })
    .filter((entry) => entry.distanceMeters <= radius)

  results.sort((a, b) => {
    if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters - b.distanceMeters
    return a.stop.code.localeCompare(b.stop.code)
  })

  return results.slice(0, limit).map((entry) => formatResult(entry.stop.code, entry.stop.name, entry.distanceMeters))
}
