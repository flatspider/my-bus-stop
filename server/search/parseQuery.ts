import type { SearchDirection } from "./normalize.ts"
import { extractDirection } from "./normalize.ts"

const STREET_TYPES = new Set(["st", "av", "rd", "blvd", "dr", "pl", "ln", "pkwy"])
const COMPASS = new Set(["n", "s", "e", "w"])

export interface ParsedIntersection {
  streetAKey: string
  streetBKey: string
  intersectionKey: string
  intersectionKeySorted: string
  direction: SearchDirection
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function isStreetToken(token: string): boolean {
  return /^(?:[nsew])?\d+(?:st|av|rd|blvd|dr|pl|ln|pkwy)$/.test(token)
}

function toStreetKey(compass: string | null, numberToken: string, typeToken: string): string {
  return `${compass ?? ""}${numberToken}${typeToken}`
}

export function extractStreetKeys(tokens: string[]): string[] {
  const keys: string[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const current = tokens[i]
    const next = tokens[i + 1]
    const next2 = tokens[i + 2]

    if (isStreetToken(current)) {
      keys.push(current)
      continue
    }

    if (COMPASS.has(current) && next && next2 && /^\d+$/.test(next) && STREET_TYPES.has(next2)) {
      keys.push(toStreetKey(current, next, next2))
      continue
    }

    if (/^\d+$/.test(current) && next && STREET_TYPES.has(next)) {
      keys.push(toStreetKey(null, current, next))
      continue
    }
  }

  return unique(keys)
}

function buildIntersectionKeys(a: string, b: string): { key: string; keySorted: string } {
  const key = `${a}&${b}`
  const keySorted = [a, b].sort((x, y) => x.localeCompare(y)).join("&")
  return { key, keySorted }
}

function firstAvenueAndStreet(keys: string[]): { avenue?: string; street?: string } {
  let avenue: string | undefined
  let street: string | undefined

  for (const key of keys) {
    if (!avenue && key.endsWith("av")) {
      avenue = key
      continue
    }
    if (!street && key.endsWith("st")) {
      street = key
    }
  }

  return { avenue, street }
}

export function parseIntersection(tokens: string[]): ParsedIntersection | null {
  if (tokens.length === 0) return null

  const direction = extractDirection(tokens)
  const connectorIndex = tokens.indexOf("and")

  if (connectorIndex > 0 && connectorIndex < tokens.length - 1) {
    const leftKeys = extractStreetKeys(tokens.slice(0, connectorIndex))
    const rightKeys = extractStreetKeys(tokens.slice(connectorIndex + 1))

    if (leftKeys.length > 0 && rightKeys.length > 0) {
      const streetAKey = leftKeys[0]
      const streetBKey = rightKeys[0]
      if (streetAKey !== streetBKey) {
        const { key, keySorted } = buildIntersectionKeys(streetAKey, streetBKey)
        return {
          streetAKey,
          streetBKey,
          intersectionKey: key,
          intersectionKeySorted: keySorted,
          direction,
        }
      }
    }
  }

  const keys = extractStreetKeys(tokens)
  if (keys.length < 2) return null

  const semantic = firstAvenueAndStreet(keys)
  const streetAKey = semantic.avenue ?? keys[0]
  const streetBKey = semantic.street ?? keys.find((key) => key !== streetAKey) ?? keys[1]
  if (!streetBKey || streetAKey === streetBKey) return null

  const { key, keySorted } = buildIntersectionKeys(streetAKey, streetBKey)
  return {
    streetAKey,
    streetBKey,
    intersectionKey: key,
    intersectionKeySorted: keySorted,
    direction,
  }
}

