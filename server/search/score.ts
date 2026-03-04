import type { SearchDirection, SearchIndexedStop } from "../types.ts"

export interface ScoreOptions {
  queryCanonical: string
  queryTokens: string[]
  queryDirection: SearchDirection
  queryTrigrams: string[]
  distanceMeters?: number
  hasLocation: boolean
  recentCodes: Set<string>
}

export interface ScoredCandidate {
  score: number
  textScore: number
  directionScore: number
  trigramScore: number
  proximityScore: number
  recencyScore: number
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const aSet = new Set(a)
  const bSet = new Set(b)
  let overlap = 0
  for (const token of aSet) {
    if (bSet.has(token)) overlap += 1
  }
  const union = aSet.size + bSet.size - overlap
  if (union <= 0) return 0
  return overlap / union
}

function scoreTokenOverlap(queryTokens: string[], stopTokens: string[]): number {
  if (queryTokens.length === 0 || stopTokens.length === 0) return 0

  let score = 0
  for (const q of queryTokens) {
    let best = 0
    for (const s of stopTokens) {
      if (s === q) {
        best = Math.max(best, 12)
        continue
      }
      if (s.startsWith(q)) {
        best = Math.max(best, 7)
        continue
      }
      if (s.includes(q)) {
        best = Math.max(best, 4)
      }
    }
    score += best
  }

  return Math.min(60, score)
}

function scoreDirection(queryDirection: SearchDirection, stopDirection: SearchDirection): number {
  if (queryDirection === "unknown" || stopDirection === "unknown") return 0
  return queryDirection === stopDirection ? 20 : -10
}

function scoreProximity(distanceMeters: number | undefined, hasLocation: boolean): number {
  if (!hasLocation || distanceMeters === undefined) return 0
  return Math.max(0, 15 - distanceMeters / 2500)
}

export function scoreSearchStop(stop: SearchIndexedStop, options: ScoreOptions): ScoredCandidate {
  const canonical = stop.canonical
  const queryCanonical = options.queryCanonical

  let textScore = 0
  if (canonical === queryCanonical) textScore += 120
  else if (canonical.startsWith(queryCanonical)) textScore += 80
  else if (canonical.includes(queryCanonical)) textScore += 40

  textScore += scoreTokenOverlap(options.queryTokens, stop.tokenBag)

  const directionScore = scoreDirection(options.queryDirection, stop.direction)
  const trigramSimilarity = jaccardSimilarity(options.queryTrigrams, stop.trigrams)
  const trigramScore = trigramSimilarity * 25
  const proximityScore = scoreProximity(options.distanceMeters, options.hasLocation)
  const recencyScore = options.recentCodes.has(stop.code) ? 10 : 0

  return {
    score: textScore + directionScore + trigramScore + proximityScore + recencyScore,
    textScore,
    directionScore,
    trigramScore,
    proximityScore,
    recencyScore,
  }
}

