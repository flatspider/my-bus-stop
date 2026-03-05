import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { getStopMiniMapMeta } from "./stopsIndex.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.join(__dirname, "..", "data", "minimaps")
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_TTL_BY_REASON_MS: Record<MiniMapUnavailableReason, number> = {
  timeout: 5 * 60 * 1000,
  no_roads: CACHE_TTL_MS,
  low_quality: CACHE_TTL_MS,
  error: 0,
}
const OVERPASS_URL = "https://overpass-api.de/api/interpreter"
const OVERPASS_RADIUS_METERS = 170
const FETCH_TIMEOUT_MS = 3000

type MiniMapUnavailableReason = "timeout" | "no_roads" | "low_quality" | "error"

export type MiniMapResponse =
  | {
    status: "ready"
    code: string
    svg: string
    generatedAt: string
    source: "cache" | "generated"
  }
  | {
    status: "unavailable"
    code: string
    reason: MiniMapUnavailableReason
  }

interface CacheMeta {
  status: "ready" | "unavailable"
  generatedAt: string
  reason?: MiniMapUnavailableReason
}

interface OverpassNode {
  type: "node"
  id: number
  lat: number
  lon: number
}

interface OverpassWay {
  type: "way"
  id: number
  nodes: number[]
  tags?: Record<string, string>
}

interface OverpassResponse {
  elements?: Array<OverpassNode | OverpassWay>
}

interface Point {
  x: number
  y: number
}

interface CandidateRoad {
  name: string
  points: Point[]
  distanceToStop: number
  bearing: number
}

interface SelectedRoadPair {
  primary: CandidateRoad
  secondary: CandidateRoad
  angleDiff: number
}

const inflight = new Map<string, Promise<MiniMapResponse>>()

const LEGIBILITY = {
  light: {
    bg: "#fafafa",
    primary: "#3a3a3a",
    secondary: "#8a8a8a",
    label: "#5c5c5c",
    marker: "#1f1f1f",
  },
  dark: {
    bg: "#111111",
    primary: "#e6e6e6",
    secondary: "#b5b5b5",
    label: "#f2f2f2",
    marker: "#ffffff",
  },
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180
}

function lonLatToMeters(originLat: number, originLon: number, lat: number, lon: number): Point {
  const metersPerDegLat = 111_132
  const metersPerDegLon = 111_320 * Math.cos(toRadians(originLat))
  const x = (lon - originLon) * metersPerDegLon
  const y = -(lat - originLat) * metersPerDegLat
  return { x, y }
}

function normalizeAngleDiff(a: number, b: number): number {
  const raw = Math.abs(a - b) % 180
  return raw > 90 ? 180 - raw : raw
}

function segmentBearingDegrees(a: Point, b: Point): number {
  const angle = Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI)
  const normalized = (angle + 360) % 180
  return normalized
}

function closestDistanceToPolyline(points: Point[]): { distance: number, bearing: number } {
  let bestDistance = Number.POSITIVE_INFINITY
  let bestBearing = 0

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    const vx = b.x - a.x
    const vy = b.y - a.y
    const len2 = vx * vx + vy * vy
    if (len2 <= 1e-6) continue

    const t = Math.max(0, Math.min(1, (-(a.x * vx + a.y * vy)) / len2))
    const proj = {
      x: a.x + t * vx,
      y: a.y + t * vy,
    }
    const distance = Math.hypot(proj.x, proj.y)

    if (distance < bestDistance) {
      bestDistance = distance
      bestBearing = segmentBearingDegrees(a, b)
    }
  }

  return {
    distance: Number.isFinite(bestDistance) ? bestDistance : Number.POSITIVE_INFINITY,
    bearing: bestBearing,
  }
}

function simplifyPolyline(points: Point[], maxPoints = 18): Point[] {
  if (points.length <= maxPoints) return points
  const step = Math.ceil(points.length / maxPoints)
  const out: Point[] = []
  for (let i = 0; i < points.length; i += step) {
    out.push(points[i])
  }
  const last = points[points.length - 1]
  const tail = out[out.length - 1]
  if (!tail || tail.x !== last.x || tail.y !== last.y) {
    out.push(last)
  }
  return out
}

function clipPoints(points: Point[], extentMeters = 120): Point[] {
  return points.filter((point) => (
    Math.abs(point.x) <= extentMeters && Math.abs(point.y) <= extentMeters
  ))
}

function hexToRgb(hex: string): { r: number, g: number, b: number } {
  const normalized = hex.replace("#", "")
  const value = normalized.length === 3
    ? normalized.split("").map((c) => c + c).join("")
    : normalized
  const int = Number.parseInt(value, 16)
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  }
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  const normalize = (channel: number) => {
    const v = channel / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const R = normalize(r)
  const G = normalize(g)
  const B = normalize(b)
  return 0.2126 * R + 0.7152 * G + 0.0722 * B
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const high = Math.max(la, lb)
  const low = Math.min(la, lb)
  return (high + 0.05) / (low + 0.05)
}

function passesDarkLegibilityGate(): boolean {
  const light = LEGIBILITY.light
  const dark = LEGIBILITY.dark

  const lightPrimaryContrast = contrastRatio(light.primary, light.bg)
  const lightLabelContrast = contrastRatio(light.label, light.bg)
  const darkPrimaryContrast = contrastRatio(dark.primary, dark.bg)
  const darkLabelContrast = contrastRatio(dark.label, dark.bg)
  const darkMarkerContrast = contrastRatio(dark.marker, dark.bg)
  const darkRoadSeparation = contrastRatio(dark.primary, dark.secondary)

  if (darkPrimaryContrast < lightPrimaryContrast) return false
  if (darkLabelContrast < lightLabelContrast) return false
  if (darkMarkerContrast < darkPrimaryContrast) return false
  if (darkRoadSeparation < 1.28) return false

  return true
}

function pickRoadPair(candidates: CandidateRoad[]): SelectedRoadPair | null {
  let best: SelectedRoadPair | null = null
  let bestScore = Number.NEGATIVE_INFINITY

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i]
      const b = candidates[j]
      if (a.name === b.name) continue

      const crossingAngle = normalizeAngleDiff(a.bearing, b.bearing)
      if (crossingAngle < 55 || crossingAngle > 125) continue

      const distancePenalty = (a.distanceToStop + b.distanceToStop) / 80
      const orthogonalityScore = 1 - Math.abs(90 - crossingAngle) / 45
      const score = orthogonalityScore - distancePenalty

      if (score > bestScore) {
        best = {
          primary: a.distanceToStop <= b.distanceToStop ? a : b,
          secondary: a.distanceToStop <= b.distanceToStop ? b : a,
          angleDiff: crossingAngle,
        }
        bestScore = score
      }
    }
  }

  return best
}

function labelFromName(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length <= 16) return trimmed
  return `${trimmed.slice(0, 15).trimEnd()}…`
}

function pointsToPath(points: Point[], width: number, height: number): string {
  if (points.length < 2) return ""

  const centerX = width * 0.46
  const centerY = height * 0.53
  const metersToPx = 0.52

  const path = points
    .map((point, index) => {
      const x = centerX + point.x * metersToPx
      const y = centerY + point.y * metersToPx
      const cmd = index === 0 ? "M" : "L"
      return `${cmd}${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(" ")

  return path
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function renderSvg(pair: SelectedRoadPair, directionLabel?: string): string {
  const width = 220
  const height = 64
  const primaryPath = pointsToPath(pair.primary.points, width, height)
  const secondaryPath = pointsToPath(pair.secondary.points, width, height)
  const primaryLabel = labelFromName(pair.primary.name)
  const secondaryLabel = labelFromName(pair.secondary.name)

  if (!primaryPath || !secondaryPath) return ""

  const directionText = directionLabel ? `<text class="mini-map__label" x="143" y="58">${escapeXml(directionLabel)}</text>` : ""

  return [
    `<svg class="mini-map-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mini map snapshot">`,
    `<path class="mini-map__road mini-map__road--primary" d="${primaryPath}" />`,
    `<path class="mini-map__road mini-map__road--secondary" d="${secondaryPath}" />`,
    `<circle class="mini-map__marker" cx="101" cy="34" r="3.5" />`,
    `<text class="mini-map__label" x="16" y="53">${escapeXml(primaryLabel)}</text>`,
    `<text class="mini-map__label" x="127" y="18">${escapeXml(secondaryLabel)}</text>`,
    directionText,
    `</svg>`,
  ].join("")
}

function cachePaths(stopCode: string): { svgPath: string, metaPath: string } {
  const stem = `${stopCode}.v1`
  return {
    svgPath: path.join(CACHE_DIR, `${stem}.svg`),
    metaPath: path.join(CACHE_DIR, `${stem}.meta.json`),
  }
}

async function readCache(stopCode: string): Promise<MiniMapResponse | null> {
  const { svgPath, metaPath } = cachePaths(stopCode)

  try {
    const rawMeta = await readFile(metaPath, "utf-8")
    const meta = JSON.parse(rawMeta) as CacheMeta

    if (meta.status === "ready") {
      const svg = await readFile(svgPath, "utf-8")
      return {
        status: "ready",
        code: stopCode,
        svg,
        generatedAt: meta.generatedAt,
        source: "cache",
      }
    }

    if (meta.status === "unavailable" && meta.reason) {
      const generatedAtMs = new Date(meta.generatedAt).getTime()
      const ttl = CACHE_TTL_BY_REASON_MS[meta.reason] ?? 0
      if (ttl <= 0) return null
      if (Number.isFinite(generatedAtMs) && Date.now() - generatedAtMs < ttl) {
        return {
          status: "unavailable",
          code: stopCode,
          reason: meta.reason,
        }
      }
    }
  } catch {
    return null
  }

  return null
}

async function writeUnavailable(stopCode: string, reason: MiniMapUnavailableReason): Promise<MiniMapResponse> {
  await mkdir(CACHE_DIR, { recursive: true })
  const generatedAt = new Date().toISOString()
  const { metaPath } = cachePaths(stopCode)
  const meta: CacheMeta = {
    status: "unavailable",
    generatedAt,
    reason,
  }
  await writeFile(metaPath, `${JSON.stringify(meta)}\n`, "utf-8")
  return {
    status: "unavailable",
    code: stopCode,
    reason,
  }
}

async function writeReady(stopCode: string, svg: string): Promise<MiniMapResponse> {
  await mkdir(CACHE_DIR, { recursive: true })
  const generatedAt = new Date().toISOString()
  const { svgPath, metaPath } = cachePaths(stopCode)
  const meta: CacheMeta = {
    status: "ready",
    generatedAt,
  }

  await Promise.all([
    writeFile(svgPath, svg, "utf-8"),
    writeFile(metaPath, `${JSON.stringify(meta)}\n`, "utf-8"),
  ])

  return {
    status: "ready",
    code: stopCode,
    svg,
    generatedAt,
    source: "generated",
  }
}

function parseRoads(raw: OverpassResponse, lat: number, lon: number): CandidateRoad[] {
  const nodes = new Map<number, OverpassNode>()
  const ways: OverpassWay[] = []

  for (const element of raw.elements ?? []) {
    if (element.type === "node") {
      nodes.set(element.id, element)
      continue
    }

    if (element.type === "way") {
      ways.push(element)
    }
  }

  const candidates: CandidateRoad[] = []
  for (const way of ways) {
    const name = way.tags?.name?.trim()
    const highway = way.tags?.highway
    if (!name || !highway || way.nodes.length < 2) continue

    const points = way.nodes
      .map((nodeId) => {
        const node = nodes.get(nodeId)
        if (!node) return null
        return lonLatToMeters(lat, lon, node.lat, node.lon)
      })
      .filter((point): point is Point => point !== null)

    const clipped = simplifyPolyline(clipPoints(points))
    if (clipped.length < 2) continue

    const nearest = closestDistanceToPolyline(clipped)
    if (!Number.isFinite(nearest.distance) || nearest.distance > 55) continue

    candidates.push({
      name,
      points: clipped,
      distanceToStop: nearest.distance,
      bearing: nearest.bearing,
    })
  }

  return candidates
}

async function fetchRoadGeometry(lat: number, lon: number): Promise<CandidateRoad[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  const query = [
    "[out:json][timeout:15];",
    `way(around:${OVERPASS_RADIUS_METERS},${lat},${lon})[highway][name];`,
    "(._;>;);",
    "out body;",
  ].join("\n")

  try {
    const response = await fetch(OVERPASS_URL, {
      method: "POST",
      body: query,
      headers: { "content-type": "text/plain" },
      signal: controller.signal,
    })

    if (!response.ok) {
      return []
    }

    const payload = await response.json() as OverpassResponse
    return parseRoads(payload, lat, lon)
  } finally {
    clearTimeout(timeout)
  }
}

async function generateMiniMap(stopCode: string): Promise<MiniMapResponse> {
  if (!passesDarkLegibilityGate()) {
    return writeUnavailable(stopCode, "low_quality")
  }

  const stop = getStopMiniMapMeta(stopCode)
  if (!stop) {
    return writeUnavailable(stopCode, "error")
  }

  try {
    const roads = await fetchRoadGeometry(stop.lat, stop.lon)
    if (roads.length < 2) {
      return writeUnavailable(stopCode, "no_roads")
    }

    const pair = pickRoadPair(roads)
    if (!pair) {
      return writeUnavailable(stopCode, "low_quality")
    }

    if (pair.primary.points.length + pair.secondary.points.length > 34) {
      return writeUnavailable(stopCode, "low_quality")
    }

    const svg = renderSvg(pair, stop.directionLabel)
    if (!svg) {
      return writeUnavailable(stopCode, "low_quality")
    }

    return writeReady(stopCode, svg)
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return writeUnavailable(stopCode, "timeout")
    }
    return writeUnavailable(stopCode, "error")
  }
}

export async function getStopMiniMap(stopCode: string): Promise<MiniMapResponse> {
  if (!/^\d{6}$/.test(stopCode)) {
    return {
      status: "unavailable",
      code: stopCode,
      reason: "error",
    }
  }

  const cached = await readCache(stopCode)
  if (cached) {
    return cached
  }

  const running = inflight.get(stopCode)
  if (running) {
    return running
  }

  const promise = generateMiniMap(stopCode)
  inflight.set(stopCode, promise)
  try {
    return await promise
  } finally {
    inflight.delete(stopCode)
  }
}
