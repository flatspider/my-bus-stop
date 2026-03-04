import type { IndexedStop, SearchDirection, SearchIndexArtifactV1, SearchIndexedStop } from "../types.ts"
import { extractStreetKeys, parseIntersection } from "./parseQuery.ts"
import { normalizeText } from "./normalize.ts"

export interface RuntimeSearchIndex {
  stops: SearchIndexedStop[]
  tokenPostings: Map<string, number[]>
  intersectionPostings: Map<string, number[]>
  trigramPostings: Map<string, number[]>
  tokenDictionary: string[]
}

interface BaseStopRecord {
  code: string
  name: string
  lat: number
  lon: number
}

function toUniqueArray(values: string[]): string[] {
  const set = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || set.has(value)) continue
    set.add(value)
    out.push(value)
  }
  return out
}

function toTrigrams(text: string): string[] {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) return []
  if (compact.length <= 3) return [compact]

  const grams: string[] = []
  for (let i = 0; i <= compact.length - 3; i += 1) {
    grams.push(compact.slice(i, i + 3))
  }
  return toUniqueArray(grams)
}

function expandCanonicalTokens(tokens: string[]): string {
  return tokens
    .map((token) => {
      if (token === "av") return "avenue"
      if (token === "st") return "street"
      if (token === "sb") return "southbound"
      if (token === "nb") return "northbound"
      if (token === "eb") return "eastbound"
      if (token === "wb") return "westbound"
      if (token === "e") return "east"
      if (token === "w") return "west"
      if (token === "n") return "north"
      if (token === "s") return "south"
      return token
    })
    .join(" ")
}

function buildAltForms(
  canonicalTokens: string[],
  streetKeys: string[],
  direction: SearchDirection,
): string[] {
  const canonical = canonicalTokens.join(" ")
  const expanded = expandCanonicalTokens(canonicalTokens)
  const forms = [canonical, expanded]

  if (streetKeys.length >= 2) {
    const first = streetKeys[0]
    const second = streetKeys[1]
    forms.push(`${first}&${second}`)
    forms.push(`${second}&${first}`)
    forms.push(`${first} and ${second}`)
    forms.push(`${second} and ${first}`)
    forms.push(`${first} @ ${second}`)
    forms.push(`${second} @ ${first}`)
  }

  if (direction !== "unknown") {
    forms.push(`${canonical} ${direction}`)
  }

  return toUniqueArray(forms)
}

function parseNumberFromStreetKey(streetKey: string, suffix: "av" | "st"): number | undefined {
  const pattern = suffix === "av" ? /^(?:[nsew])?(\d+)av$/ : /^(?:[nsew])?(\d+)st$/
  const match = streetKey.match(pattern)
  if (!match) return undefined
  const parsed = Number.parseInt(match[1], 10)
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function intersectionFromStreetKeys(streetKeys: string[]): {
  intersectionKey: string
  intersectionKeySorted: string
  avenueNumber?: number
  streetNumber?: number
} {
  if (streetKeys.length < 2) {
    return {
      intersectionKey: "",
      intersectionKeySorted: "",
    }
  }

  const first = streetKeys[0]
  const second = streetKeys[1]
  const sorted = [first, second].sort((a, b) => a.localeCompare(b))

  const avenueCandidate = streetKeys.find((key) => key.endsWith("av"))
  const streetCandidate = streetKeys.find((key) => key.endsWith("st"))

  return {
    intersectionKey: `${first}&${second}`,
    intersectionKeySorted: `${sorted[0]}&${sorted[1]}`,
    avenueNumber: avenueCandidate ? parseNumberFromStreetKey(avenueCandidate, "av") : undefined,
    streetNumber: streetCandidate ? parseNumberFromStreetKey(streetCandidate, "st") : undefined,
  }
}

function normalizeStopRecord(stop: BaseStopRecord, id: number): SearchIndexedStop {
  const normalized = normalizeText(stop.name)
  const parsed = parseIntersection(normalized.tokens)
  const streetKeys = parsed
    ? [parsed.streetAKey, parsed.streetBKey]
    : extractStreetKeys(normalized.tokens)
  const intersection = intersectionFromStreetKeys(streetKeys)
  const altForms = buildAltForms(normalized.tokens, streetKeys, normalized.direction)
  const trigramSource = toUniqueArray([normalized.normalized, ...altForms]).join(" ")

  return {
    id,
    code: stop.code,
    name: stop.name,
    canonical: normalized.normalized,
    altForms,
    tokenBag: normalized.tokens,
    intersectionKey: intersection.intersectionKey,
    intersectionKeySorted: intersection.intersectionKeySorted,
    direction: normalized.direction,
    avenueNumber: intersection.avenueNumber ?? normalized.avenueNumber,
    streetNumber: intersection.streetNumber ?? normalized.streetNumber,
    trigrams: toTrigrams(trigramSource),
    lat: stop.lat,
    lon: stop.lon,
  }
}

export function buildSearchArtifactFromStops(
  stops: BaseStopRecord[],
  sourceFile: string,
): SearchIndexArtifactV1 {
  const normalizedStops = stops.map((stop, idx) => normalizeStopRecord(stop, idx))
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceFile,
    stopCount: normalizedStops.length,
    stops: normalizedStops,
  }
}

export function buildSearchArtifactFromLegacyStops(
  stops: IndexedStop[],
  sourceFile = "legacy:data/stops-index.json",
): SearchIndexArtifactV1 {
  const base: BaseStopRecord[] = stops.map((stop) => ({
    code: stop.code,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
  }))

  return buildSearchArtifactFromStops(base, sourceFile)
}

function appendPosting(map: Map<string, number[]>, key: string, id: number): void {
  if (!key) return
  const existing = map.get(key)
  if (!existing) {
    map.set(key, [id])
    return
  }
  const last = existing[existing.length - 1]
  if (last !== id) existing.push(id)
}

function finalizePostings(map: Map<string, number[]>): void {
  for (const [key, ids] of map.entries()) {
    ids.sort((a, b) => a - b)
    const deduped: number[] = []
    let previous = -1
    for (const id of ids) {
      if (id !== previous) deduped.push(id)
      previous = id
    }
    map.set(key, deduped)
  }
}

export function buildRuntimeSearchIndex(stops: SearchIndexedStop[]): RuntimeSearchIndex {
  const tokenPostings = new Map<string, number[]>()
  const intersectionPostings = new Map<string, number[]>()
  const trigramPostings = new Map<string, number[]>()

  for (const stop of stops) {
    const tokenSet = new Set(stop.tokenBag)
    for (const token of tokenSet) {
      appendPosting(tokenPostings, token, stop.id)
    }

    if (stop.intersectionKey) appendPosting(intersectionPostings, stop.intersectionKey, stop.id)
    if (stop.intersectionKeySorted) appendPosting(intersectionPostings, stop.intersectionKeySorted, stop.id)

    const grams = new Set(stop.trigrams)
    for (const gram of grams) {
      appendPosting(trigramPostings, gram, stop.id)
    }
  }

  finalizePostings(tokenPostings)
  finalizePostings(intersectionPostings)
  finalizePostings(trigramPostings)

  return {
    stops,
    tokenPostings,
    intersectionPostings,
    trigramPostings,
    tokenDictionary: Array.from(tokenPostings.keys()).sort((a, b) => a.localeCompare(b)),
  }
}

