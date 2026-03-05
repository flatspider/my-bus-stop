const STREET_TYPE_LABELS: Record<string, string> = {
  AV: "Ave",
  AVE: "Ave",
  AVENUE: "Ave",
  ST: "St",
  STREET: "St",
  RD: "Rd",
  ROAD: "Rd",
  BLVD: "Blvd",
  BOULEVARD: "Blvd",
  DR: "Dr",
  DRIVE: "Dr",
  PL: "Pl",
  PLACE: "Pl",
  LN: "Ln",
  LANE: "Ln",
  PKWY: "Pkwy",
  PARKWAY: "Pkwy",
  CT: "Ct",
  COURT: "Ct",
  TER: "Ter",
  TERRACE: "Ter",
  HWY: "Hwy",
  HIGHWAY: "Hwy",
  SQ: "Sq",
}

const CARDINAL_LABELS: Record<string, string> = {
  N: "North",
  S: "South",
  E: "East",
  W: "West",
}

const UPPERCASE_TOKENS = new Set(["NB", "SB", "EB", "WB"])

function toOrdinal(value: string): string {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number)) return value

  const mod100 = number % 100
  if (mod100 >= 11 && mod100 <= 13) {
    return `${number}th`
  }

  const mod10 = number % 10
  if (mod10 === 1) return `${number}st`
  if (mod10 === 2) return `${number}nd`
  if (mod10 === 3) return `${number}rd`
  return `${number}th`
}

function formatWord(token: string): string {
  if (!token) return ""
  if (/^\d+$/.test(token)) return token

  const upper = token.toUpperCase()
  if (UPPERCASE_TOKENS.has(upper)) return upper

  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
}

function formatSegment(segment: string): string {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  const parts: string[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const upper = token.toUpperCase()
    const nextUpper = tokens[index + 1]?.toUpperCase()

    if (upper in CARDINAL_LABELS && tokens[index + 1] && /^\d+$/.test(tokens[index + 1])) {
      parts.push(CARDINAL_LABELS[upper])
      continue
    }

    if (/^\d+$/.test(token) && nextUpper) {
      if (nextUpper === "AV" || nextUpper === "AVE" || nextUpper === "AVENUE") {
        parts.push(toOrdinal(token))
        parts.push("Ave")
        index += 1
        continue
      }

      if (nextUpper === "ST" || nextUpper === "STREET") {
        parts.push(toOrdinal(token))
        parts.push("St")
        index += 1
        continue
      }
    }

    if (nextUpper && (upper === "ST" || upper === "SAINT") && /^[A-Z]/.test(nextUpper)) {
      parts.push("St")
      continue
    }

    parts.push(STREET_TYPE_LABELS[upper] ?? formatWord(token))
  }

  return parts.join(" ")
}

export function formatStopName(raw: string): string {
  return raw
    .replace(/\s*\/\s*/g, " / ")
    .split(" / ")
    .map((segment) => formatSegment(segment))
    .join(" and ")
    .replace(/\s+/g, " ")
    .trim()
}
