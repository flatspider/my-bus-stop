export type SearchDirection = "nb" | "sb" | "eb" | "wb" | "unknown"

export interface NormalizedText {
  normalized: string
  tokens: string[]
  compactStreetTokens: string[]
  direction: SearchDirection
  avenueNumber?: number
  streetNumber?: number
}

export interface NormalizeOptions {
  corrections?: Record<string, string>
}

const TOKEN_REPLACEMENTS: Record<string, string> = {
  st: "st",
  str: "st",
  strt: "st",
  street: "st",
  av: "av",
  ave: "av",
  avenue: "av",
  rd: "rd",
  road: "rd",
  blvd: "blvd",
  boulevard: "blvd",
  nb: "nb",
  northbound: "nb",
  sb: "sb",
  southbound: "sb",
  eb: "eb",
  eastbound: "eb",
  wb: "wb",
  westbound: "wb",
  uptown: "nb",
  downtown: "sb",
  east: "e",
  west: "w",
  north: "n",
  south: "s",
  e: "e",
  w: "w",
  n: "n",
  s: "s",
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
}

const CARDINAL_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
}

const COMPASS_TOKENS = new Set(["n", "s", "e", "w"])
const STREET_TYPE_TOKENS = new Set(["st", "av", "rd", "blvd", "dr", "pl", "ln", "pkwy"])

export function ordinalToCardinal(token: string): string {
  const ordinalMatch = token.match(/^(\d+)(st|nd|rd|th)$/)
  if (ordinalMatch) return ordinalMatch[1]

  const ordinalWordValue = ORDINAL_WORDS[token]
  if (ordinalWordValue !== undefined) return String(ordinalWordValue)

  const cardinalValue = CARDINAL_WORDS[token]
  if (cardinalValue !== undefined) return String(cardinalValue)

  return token
}

export function normalizeToken(
  rawToken: string,
  corrections: Record<string, string> = {},
): string {
  const cleaned = rawToken
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim()
  if (!cleaned) return ""

  const corrected = corrections[cleaned] ?? cleaned
  const cardinal = ordinalToCardinal(corrected)
  return TOKEN_REPLACEMENTS[cardinal] ?? cardinal
}

export function extractDirection(tokens: string[]): SearchDirection {
  if (tokens.includes("sb")) return "sb"
  if (tokens.includes("nb")) return "nb"
  if (tokens.includes("eb")) return "eb"
  if (tokens.includes("wb")) return "wb"
  return "unknown"
}

function preprocessText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\bs\/b\b/g, " sb ")
    .replace(/\bn\/b\b/g, " nb ")
    .replace(/\be\/b\b/g, " eb ")
    .replace(/\bw\/b\b/g, " wb ")
    .replace(/[&@]/g, " and ")
    .replace(/[/,.–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function uniqueTokens(tokens: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of tokens) {
    if (!token || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

function compactStreetToken(parts: string[]): string | null {
  if (parts.length === 2) {
    const [numberToken, typeToken] = parts
    if (!/^\d+$/.test(numberToken) || !STREET_TYPE_TOKENS.has(typeToken)) return null
    return `${numberToken}${typeToken}`
  }
  if (parts.length === 3) {
    const [compass, numberToken, typeToken] = parts
    if (!COMPASS_TOKENS.has(compass) || !/^\d+$/.test(numberToken) || !STREET_TYPE_TOKENS.has(typeToken)) return null
    return `${compass}${numberToken}${typeToken}`
  }
  return null
}

export function buildCompactStreetTokens(tokens: string[]): string[] {
  const compact: string[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    const next = tokens[i + 1]
    const next2 = tokens[i + 2]

    const noCompass = compactStreetToken([token, next])
    if (noCompass) {
      compact.push(noCompass)
    }

    const withCompass = compactStreetToken([token, next, next2])
    if (withCompass) {
      compact.push(withCompass)
    }
  }

  return uniqueTokens(compact)
}

function findFirstNumberForType(tokens: string[], targetType: "st" | "av"): number | undefined {
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i]
    const next = tokens[i + 1]

    if (!/^\d+$/.test(token) || next !== targetType) continue
    const parsed = Number.parseInt(token, 10)
    if (Number.isNaN(parsed)) continue
    return parsed
  }
  return undefined
}

export function normalizeText(raw: string, options: NormalizeOptions = {}): NormalizedText {
  const preprocessed = preprocessText(raw)
  if (!preprocessed) {
    return {
      normalized: "",
      tokens: [],
      compactStreetTokens: [],
      direction: "unknown",
    }
  }

  const normalizedTokens = preprocessed
    .split(" ")
    .map((token) => normalizeToken(token, options.corrections))
    .filter(Boolean)

  const compactStreetTokens = buildCompactStreetTokens(normalizedTokens)
  const tokens = uniqueTokens([...normalizedTokens, ...compactStreetTokens])

  return {
    normalized: tokens.join(" ").trim(),
    tokens,
    compactStreetTokens,
    direction: extractDirection(tokens),
    avenueNumber: findFirstNumberForType(normalizedTokens, "av"),
    streetNumber: findFirstNumberForType(normalizedTokens, "st"),
  }
}
