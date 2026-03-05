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
const FETCH_TIMEOUT_MS = 6500
const LAYOUT_VERSION = "v3"
const CACHE_RENDER_REVISION = 2
const LEGACY_READY_CACHE_CANDIDATES = [
  { layoutVersion: "v2", renderRevision: 2 },
] as const
const MARKER_AXIS_DEADZONE_METERS = 1.2
const MARKER_QUADRANT_OVERRIDES: Partial<Record<string, MarkerQuadrant>> = {
  "402854": "nw",
}

type MiniMapUnavailableReason = "timeout" | "no_roads" | "low_quality" | "error"
type MarkerQuadrant = "nw" | "ne" | "sw" | "se"

type MiniMapResponse =
  | {
    status: "ready"
    code: string
    svg: string
    generatedAt: string
    source: "cache" | "generated"
    layoutVersion: "v3"
  }
  | {
    status: "unavailable"
    code: string
    reason: MiniMapUnavailableReason
  }

interface CacheMeta {
  status: "ready" | "unavailable"
  generatedAt: string
  layoutVersion: "v3"
  renderRevision: number
  reason?: MiniMapUnavailableReason
  pairRoadNames?: [string, string]
  markerQuadrant?: MarkerQuadrant
  rejectionReasonDetail?: string
}

interface LegacyReadyCacheMeta {
  status: "ready"
  generatedAt: string
  layoutVersion: "v2"
  renderRevision: number
  pairRoadNames?: [string, string]
  markerQuadrant?: MarkerQuadrant
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

interface SegmentProjection {
  nearestPoint: Point
  distance: number
  bearing: number
  unitDirection: Point
  signedStopOffset: number
}

interface CandidateRoad {
  id: number
  name: string
  points: Point[]
  distanceToStop: number
  bearing: number
  linePoint: Point
  direction: Point
  normal: Point
  signedStopOffset: number
}

interface SelectedRoadPair {
  horizontal: CandidateRoad
  vertical: CandidateRoad
  intersection: Point
  stopOffset: Point
  pairRoadNames: [string, string]
}

const inflight = new Map<string, Promise<MiniMapResponse>>()

const LEGIBILITY = {
  light: {
    bg: "#ececec",
    primary: "#ffffff",
    secondary: "#f5f5f5",
    label: "#999999",
    marker: "#555555",
  },
  dark: {
    bg: "#222222",
    primary: "#3a3a3a",
    secondary: "#2a2a2a",
    label: "#888888",
    marker: "#ffffff",
    context: "#636363",
  },
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y
}

function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x
}

function normalize(v: Point): Point {
  const len = Math.hypot(v.x, v.y)
  if (len <= 1e-9) return { x: 0, y: 0 }
  return { x: v.x / len, y: v.y / len }
}

function canonicalizeDirection(v: Point): Point {
  if (v.x < 0 || (Math.abs(v.x) <= 1e-9 && v.y < 0)) {
    return { x: -v.x, y: -v.y }
  }
  return v
}

function lonLatToMeters(originLat: number, originLon: number, lat: number, lon: number): Point {
  const metersPerDegLat = 111_132
  const metersPerDegLon = 111_320 * Math.cos(toRadians(originLat))
  return {
    x: (lon - originLon) * metersPerDegLon,
    y: -(lat - originLat) * metersPerDegLat,
  }
}

function normalizeAngleDiff(a: number, b: number): number {
  const raw = Math.abs(a - b) % 180
  return raw > 90 ? 180 - raw : raw
}

function segmentBearingDegrees(a: Point, b: Point): number {
  const angle = Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI)
  return (angle + 360) % 180
}

function projectStopToNearestSegment(points: Point[]): SegmentProjection | null {
  let bestDistance = Number.POSITIVE_INFINITY
  let best: SegmentProjection | null = null

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    const seg = { x: b.x - a.x, y: b.y - a.y }
    const len2 = seg.x * seg.x + seg.y * seg.y
    if (len2 <= 1e-6) continue

    const t = Math.max(0, Math.min(1, (-(a.x * seg.x + a.y * seg.y)) / len2))
    const nearestPoint = { x: a.x + t * seg.x, y: a.y + t * seg.y }
    const distance = Math.hypot(nearestPoint.x, nearestPoint.y)
    if (distance >= bestDistance) continue

    const direction = canonicalizeDirection(normalize(seg))
    const normal = { x: -direction.y, y: direction.x }
    const signedStopOffset = -dot(normal, nearestPoint)

    bestDistance = distance
    best = {
      nearestPoint,
      distance,
      bearing: segmentBearingDegrees(a, b),
      unitDirection: direction,
      signedStopOffset,
    }
  }

  return best
}

function simplifyPolyline(points: Point[], maxPoints = 20): Point[] {
  if (points.length <= maxPoints) return points
  const step = Math.ceil(points.length / maxPoints)
  const out: Point[] = []
  for (let i = 0; i < points.length; i += step) {
    out.push(points[i])
  }
  const tail = points[points.length - 1]
  const last = out[out.length - 1]
  if (!last || last.x !== tail.x || last.y !== tail.y) {
    out.push(tail)
  }
  return out
}

function clipPoints(points: Point[], extentMeters = 220): Point[] {
  return points.filter((point) => Math.abs(point.x) <= extentMeters && Math.abs(point.y) <= extentMeters)
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
  const normalizeChannel = (value: number) => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const R = normalizeChannel(r)
  const G = normalizeChannel(g)
  const B = normalizeChannel(b)
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
  const darkContextContrast = contrastRatio(dark.context, dark.bg)

  if (darkPrimaryContrast < lightPrimaryContrast) return false
  if (darkLabelContrast < lightLabelContrast) return false
  if (darkMarkerContrast < darkPrimaryContrast) return false
  if (darkRoadSeparation < 1.25) return false
  if (darkContextContrast < 2.5) return false

  return true
}

function parseRoads(raw: OverpassResponse, lat: number, lon: number): CandidateRoad[] {
  const nodes = new Map<number, OverpassNode>()
  const ways: OverpassWay[] = []

  for (const element of raw.elements ?? []) {
    if (element.type === "node") {
      nodes.set(element.id, element)
    } else if (element.type === "way") {
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

    const projection = projectStopToNearestSegment(clipped)
    if (!projection || !Number.isFinite(projection.distance) || projection.distance > 65) continue

    const normal = { x: -projection.unitDirection.y, y: projection.unitDirection.x }

    candidates.push({
      id: way.id,
      name,
      points: clipped,
      distanceToStop: projection.distance,
      bearing: projection.bearing,
      linePoint: projection.nearestPoint,
      direction: projection.unitDirection,
      normal,
      signedStopOffset: projection.signedStopOffset,
    })
  }

  return candidates
}

function intersectionOfLines(aPoint: Point, aDir: Point, bPoint: Point, bDir: Point): Point | null {
  const denom = cross(aDir, bDir)
  if (Math.abs(denom) < 0.15) return null

  const delta = { x: bPoint.x - aPoint.x, y: bPoint.y - aPoint.y }
  const t = cross(delta, bDir) / denom
  return {
    x: aPoint.x + t * aDir.x,
    y: aPoint.y + t * aDir.y,
  }
}

function markerQuadrantFromOffset(offset: Point, deadzone = MARKER_AXIS_DEADZONE_METERS): MarkerQuadrant | null {
  if (Math.abs(offset.x) < deadzone || Math.abs(offset.y) < deadzone) return null
  if (offset.x < 0 && offset.y < 0) return "nw"
  if (offset.x >= 0 && offset.y < 0) return "ne"
  if (offset.x < 0 && offset.y >= 0) return "sw"
  return "se"
}

function resolveAxisDirection<TNegative extends string, TPositive extends string>(
  offset: number,
  deadzone: number,
  fallbackRoadCoordinate: number,
  negativeDirection: TNegative,
  positiveDirection: TPositive,
): TNegative | TPositive {
  if (Math.abs(offset) >= deadzone) {
    return offset < 0 ? negativeDirection : positiveDirection
  }

  if (Math.abs(fallbackRoadCoordinate) >= 0.35) {
    // If road centerline is east/south of stop (+), stop is on opposite side.
    return fallbackRoadCoordinate > 0 ? negativeDirection : positiveDirection
  }

  return positiveDirection
}

function resolveMarkerQuadrant(stopCode: string, pair: SelectedRoadPair): MarkerQuadrant {
  const override = MARKER_QUADRANT_OVERRIDES[stopCode]
  if (override) return override

  const geometry = markerQuadrantFromOffset(pair.stopOffset)
  if (geometry) return geometry

  const horizontalSide = resolveAxisDirection(
    pair.stopOffset.x,
    MARKER_AXIS_DEADZONE_METERS,
    pair.vertical.linePoint.x,
    "w",
    "e",
  )
  const verticalSide = resolveAxisDirection(
    pair.stopOffset.y,
    MARKER_AXIS_DEADZONE_METERS,
    pair.horizontal.linePoint.y,
    "n",
    "s",
  )

  return `${verticalSide}${horizontalSide}` as MarkerQuadrant
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
      if (crossingAngle < 55) continue

      const intersection = intersectionOfLines(a.linePoint, a.direction, b.linePoint, b.direction)
      if (!intersection) continue

      const stopOffset = { x: -intersection.x, y: -intersection.y }
      const aHorizontalScore = Math.abs(a.direction.x) - Math.abs(a.direction.y)
      const bHorizontalScore = Math.abs(b.direction.x) - Math.abs(b.direction.y)
      const horizontal = aHorizontalScore >= bHorizontalScore ? a : b
      const vertical = horizontal.id === a.id ? b : a

      const orientationPenalty = Math.abs(Math.abs(horizontal.direction.y) - 0)
      const distancePenalty = (a.distanceToStop + b.distanceToStop) / 95
      const orthogonalityScore = 1 - Math.abs(90 - crossingAngle) / 42
      const score = orthogonalityScore - distancePenalty - orientationPenalty * 0.25

      if (score > bestScore) {
        bestScore = score
        best = {
          horizontal,
          vertical,
          intersection,
          stopOffset,
          pairRoadNames: [horizontal.name, vertical.name],
        }
      }
    }
  }

  return best
}

function labelFromName(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length <= 20) return trimmed
  return `${trimmed.slice(0, 19).trimEnd()}…`
}

function signedDistanceFromPointToLine(point: Point, line: CandidateRoad): number {
  const delta = { x: point.x - line.linePoint.x, y: point.y - line.linePoint.y }
  return dot(line.normal, delta)
}

function selectContextOffsets(
  roads: CandidateRoad[],
  pair: SelectedRoadPair,
): { horizontal: number[], vertical: number[] } | null {
  const spacingMeters = 34
  const maxPerAxis = 2

  const horizontalOffsets: number[] = []
  const verticalOffsets: number[] = []

  const candidates = roads.filter((road) => road.name !== pair.horizontal.name && road.name !== pair.vertical.name)
  if (candidates.length > 16) {
    return null
  }

  for (const road of candidates) {
    const toHorizontal = normalizeAngleDiff(road.bearing, pair.horizontal.bearing)
    const toVertical = normalizeAngleDiff(road.bearing, pair.vertical.bearing)

    if (Math.min(toHorizontal, toVertical) > 20) continue

    if (toHorizontal <= toVertical) {
      const offset = signedDistanceFromPointToLine(pair.intersection, road)
      if (Math.abs(offset) < 20) continue
      const tooClose = horizontalOffsets.some((value) => Math.abs(value - offset) < spacingMeters)
      if (!tooClose) horizontalOffsets.push(offset)
    } else {
      const offset = signedDistanceFromPointToLine(pair.intersection, road)
      if (Math.abs(offset) < 20) continue
      const tooClose = verticalOffsets.some((value) => Math.abs(value - offset) < spacingMeters)
      if (!tooClose) verticalOffsets.push(offset)
    }
  }

  horizontalOffsets.sort((a, b) => Math.abs(a) - Math.abs(b))
  verticalOffsets.sort((a, b) => Math.abs(a) - Math.abs(b))

  return {
    horizontal: horizontalOffsets.slice(0, maxPerAxis),
    vertical: verticalOffsets.slice(0, maxPerAxis),
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function renderSvgFromRoadNames(
  pairRoadNames: [string, string],
  contextOffsets: { horizontal: number[], vertical: number[] },
  markerQuadrant: MarkerQuadrant,
): string {
  const width = 420
  const height = 108
  const intersectionX = 112
  const intersectionY = 41
  const pxPerMeter = 0.28
  const horizontalRoadWidth = 8
  const verticalRoadWidth = 8
  const markerRadius = 4.2
  const markerGap = 1.5

  const xDirection = markerQuadrant.endsWith("e") ? 1 : -1
  const yDirection = markerQuadrant.startsWith("s") ? 1 : -1
  const markerX = intersectionX + xDirection * (verticalRoadWidth / 2 + markerRadius + markerGap)
  const markerY = intersectionY + yDirection * (horizontalRoadWidth / 2 + markerRadius + markerGap)

  const hLabel = labelFromName(pairRoadNames[0])
  const vLabel = labelFromName(pairRoadNames[1])
  const horizontalLabelX = intersectionX + 120
  const horizontalLabelY = intersectionY - 14
  const verticalLabelX = intersectionX - 13
  const verticalLabelY = intersectionY + 48

  const contextHorizontal = contextOffsets.horizontal
    .map((offset, index) => {
      const y = intersectionY + offset * pxPerMeter
      if (y <= -8 || y >= height + 8) return ""
      return `<line class="mini-map__context mini-map__context--h" x1="-16" y1="${y.toFixed(2)}" x2="436" y2="${y.toFixed(2)}" data-i="${index}" />`
    })
    .filter(Boolean)

  const contextVertical = contextOffsets.vertical
    .map((offset, index) => {
      const x = intersectionX + offset * pxPerMeter
      if (x <= -8 || x >= width + 8) return ""
      return `<line class="mini-map__context mini-map__context--v" x1="${x.toFixed(2)}" y1="-16" x2="${x.toFixed(2)}" y2="124" data-i="${index}" />`
    })
    .filter(Boolean)

  return [
    `<svg class="mini-map-svg mini-map-svg--schematic" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mini map snapshot">`,
    ...contextHorizontal,
    ...contextVertical,
    `<line class="mini-map__road mini-map__road--primary mini-map__road--horizontal" x1="-20" y1="${intersectionY}" x2="442" y2="${intersectionY}" />`,
    `<line class="mini-map__road mini-map__road--secondary mini-map__road--vertical" x1="${intersectionX}" y1="-20" x2="${intersectionX}" y2="128" />`,
    `<circle class="mini-map__marker" cx="${markerX.toFixed(2)}" cy="${markerY.toFixed(2)}" r="${markerRadius.toFixed(2)}" />`,
    `<text class="mini-map__label mini-map__label--horizontal" x="${horizontalLabelX.toFixed(2)}" y="${horizontalLabelY.toFixed(2)}" text-anchor="middle" dominant-baseline="middle">${escapeXml(hLabel)}</text>`,
    `<text class="mini-map__label mini-map__label--vertical" x="${verticalLabelX.toFixed(2)}" y="${verticalLabelY.toFixed(2)}" transform="rotate(-90 ${verticalLabelX.toFixed(2)} ${verticalLabelY.toFixed(2)})" text-anchor="middle" dominant-baseline="middle">${escapeXml(vLabel)}</text>`,
    `</svg>`,
  ].join("")
}

function renderSvg(
  pair: SelectedRoadPair,
  contextOffsets: { horizontal: number[], vertical: number[] },
  markerQuadrant: MarkerQuadrant,
): string {
  return renderSvgFromRoadNames(pair.pairRoadNames, contextOffsets, markerQuadrant)
}

function cachePaths(stopCode: string): { svgPath: string, metaPath: string } {
  const stem = `${stopCode}.${LAYOUT_VERSION}.r${CACHE_RENDER_REVISION}`
  return {
    svgPath: path.join(CACHE_DIR, `${stem}.svg`),
    metaPath: path.join(CACHE_DIR, `${stem}.meta.json`),
  }
}

function legacyCacheMetaPath(
  stopCode: string,
  layoutVersion: "v2",
  renderRevision: number,
): string {
  const stem = `${stopCode}.${layoutVersion}.r${renderRevision}`
  return path.join(CACHE_DIR, `${stem}.meta.json`)
}

async function readLegacyReadyComposition(
  stopCode: string,
): Promise<{ pairRoadNames: [string, string], markerQuadrant: MarkerQuadrant } | null> {
  for (const candidate of LEGACY_READY_CACHE_CANDIDATES) {
    try {
      const rawMeta = await readFile(
        legacyCacheMetaPath(stopCode, candidate.layoutVersion, candidate.renderRevision),
        "utf-8",
      )
      const meta = JSON.parse(rawMeta) as LegacyReadyCacheMeta
      if (meta.status !== "ready") continue
      if (
        !Array.isArray(meta.pairRoadNames) ||
        meta.pairRoadNames.length !== 2 ||
        typeof meta.pairRoadNames[0] !== "string" ||
        typeof meta.pairRoadNames[1] !== "string"
      ) {
        continue
      }
      if (!meta.markerQuadrant) continue

      return {
        pairRoadNames: meta.pairRoadNames,
        markerQuadrant: meta.markerQuadrant,
      }
    } catch {
      continue
    }
  }

  return null
}

async function readCache(stopCode: string): Promise<MiniMapResponse | null> {
  const { svgPath, metaPath } = cachePaths(stopCode)

  try {
    const rawMeta = await readFile(metaPath, "utf-8")
    const meta = JSON.parse(rawMeta) as CacheMeta
    if (meta.layoutVersion !== LAYOUT_VERSION) return null
    if (meta.renderRevision !== CACHE_RENDER_REVISION) return null

    if (meta.status === "ready") {
      const svg = await readFile(svgPath, "utf-8")
      return {
        status: "ready",
        code: stopCode,
        svg,
        generatedAt: meta.generatedAt,
        source: "cache",
        layoutVersion: LAYOUT_VERSION,
      }
    }

    if (meta.status === "unavailable" && meta.reason) {
      const ttl = CACHE_TTL_BY_REASON_MS[meta.reason] ?? 0
      if (ttl <= 0) return null

      const generatedAtMs = new Date(meta.generatedAt).getTime()
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

async function writeUnavailable(
  stopCode: string,
  reason: MiniMapUnavailableReason,
  detail: string,
): Promise<MiniMapResponse> {
  await mkdir(CACHE_DIR, { recursive: true })
  const generatedAt = new Date().toISOString()
  const { metaPath } = cachePaths(stopCode)
  const meta: CacheMeta = {
    status: "unavailable",
    generatedAt,
    layoutVersion: LAYOUT_VERSION,
    renderRevision: CACHE_RENDER_REVISION,
    reason,
    rejectionReasonDetail: detail,
  }
  await writeFile(metaPath, `${JSON.stringify(meta)}\n`, "utf-8")
  return {
    status: "unavailable",
    code: stopCode,
    reason,
  }
}

async function writeReady(
  stopCode: string,
  svg: string,
  pairRoadNames: [string, string],
  markerQuadrant: MarkerQuadrant,
): Promise<MiniMapResponse> {
  await mkdir(CACHE_DIR, { recursive: true })
  const generatedAt = new Date().toISOString()
  const { svgPath, metaPath } = cachePaths(stopCode)
  const meta: CacheMeta = {
    status: "ready",
    generatedAt,
    layoutVersion: LAYOUT_VERSION,
    renderRevision: CACHE_RENDER_REVISION,
    pairRoadNames,
    markerQuadrant,
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
    layoutVersion: LAYOUT_VERSION,
  }
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

    if (!response.ok) return []

    const payload = await response.json() as OverpassResponse
    return parseRoads(payload, lat, lon)
  } finally {
    clearTimeout(timeout)
  }
}

async function generateMiniMap(stopCode: string): Promise<MiniMapResponse> {
  if (!passesDarkLegibilityGate()) {
    return writeUnavailable(stopCode, "low_quality", "dark-legibility-gate")
  }

  const stop = getStopMiniMapMeta(stopCode)
  if (!stop) {
    return writeUnavailable(stopCode, "error", "missing-stop-metadata")
  }

  const renderLegacyFallback = async (): Promise<MiniMapResponse | null> => {
    const legacy = await readLegacyReadyComposition(stopCode)
    if (!legacy) return null
    const svg = renderSvgFromRoadNames(
      legacy.pairRoadNames,
      { horizontal: [], vertical: [] },
      legacy.markerQuadrant,
    )
    return writeReady(stopCode, svg, legacy.pairRoadNames, legacy.markerQuadrant)
  }

  try {
    const roads = await fetchRoadGeometry(stop.lat, stop.lon)
    if (roads.length < 2) {
      return writeUnavailable(stopCode, "no_roads", "insufficient-road-candidates")
    }

    const pair = pickRoadPair(roads)
    if (!pair) {
      return writeUnavailable(stopCode, "low_quality", "no-stable-road-pair")
    }

    const contextOffsets = selectContextOffsets(roads, pair)
    if (!contextOffsets) {
      return writeUnavailable(stopCode, "low_quality", "context-density-over-limit")
    }

    const markerQuadrant = resolveMarkerQuadrant(stopCode, pair)
    const svg = renderSvg(pair, contextOffsets, markerQuadrant)
    if (!svg) {
      return writeUnavailable(stopCode, "low_quality", "svg-render-failed")
    }

    return writeReady(stopCode, svg, pair.pairRoadNames, markerQuadrant)
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      const fallback = await renderLegacyFallback()
      if (fallback) return fallback
      return writeUnavailable(stopCode, "timeout", "overpass-timeout")
    }

    const fallback = await renderLegacyFallback()
    if (fallback) return fallback
    return writeUnavailable(stopCode, "error", "generation-exception")
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
  if (cached) return cached

  const running = inflight.get(stopCode)
  if (running) return running

  const promise = generateMiniMap(stopCode)
  inflight.set(stopCode, promise)
  try {
    return await promise
  } finally {
    inflight.delete(stopCode)
  }
}
