import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { SnapshotEntry, SnapshotVehicle } from "../server/types.ts"
import { haversineMeters } from "../server/utils.ts"

const JSONL_PATH = path.join(process.cwd(), "data", "snapshots.jsonl")
const REPORT_PATH = path.join(process.cwd(), "data", "ghost-report.md")

// --- CLI flags ---
const VERBOSE = process.argv.includes("--verbose")

// --- Constants ---
const MIN_RELEVANT_SNAPSHOTS = 6
const MIN_RELEVANT_MINUTES = 3
const FRESH_VP_AGE_S = 90
const FROZEN_DISTANCE_M = 15
const FROZEN_DURATION_S = 120
const NEAR_STOP_M = 60
const GHOST_DISTANCE_FLOOR_M = 150
const DIST_TREND_MIN_PAIRS = 8
const DIST_TREND_MIN_ETA_SPAN = 6

// Default stop coordinates (402854) for snapshots that lack them
const DEFAULT_STOP = { latitude: 40.738982, longitude: -73.983129 }

// --- Types ---

type DetectionReason =
  | "NO_VP majority"
  | "STALE_VP majority"
  | "frozen position"
  | "disappeared with VP issues"
  | "ETA decreasing but not approaching stop"
  | "ETA at 0 but vehicle far from stop"

type Confidence = "high" | "low" | "insufficient"

type Classification = "ghost" | "suspect" | "tracking_anomaly"

interface VehicleObservation {
  timestamp: string
  siriEtaMinutes: number | null
  siriDistance: string
  flag: SnapshotVehicle["flag"]
  gtfsDelay: number | null
  vpLatitude: number | null
  vpLongitude: number | null
  vpTimestamp: number | null
  hasVehiclePosition: boolean
  // per-observation ghost tagging (set during detection)
  ghostSignal: boolean
}

interface VehicleLifecycle {
  vehicleId: string
  route: string
  tripId: string | null
  firstSeen: string
  lastSeen: string
  observations: VehicleObservation[]
  relevantObservations: VehicleObservation[]
  totalCount: number
  relevantCount: number
  // VP stats for relevant window
  noVpCount: number
  staleVpCount: number
  // VP stats for all observations
  allNoVpCount: number
  allStaleVpCount: number
  disappeared: boolean
  etaStalled: boolean
  frozenPosition: boolean
  ghostReason: string | null
  detectionReasons: DetectionReason[]
  confidence: Confidence
  // Ghost window timing
  relevantGhostWindowMinutes: number
  trackingDurationMinutes: number
  // Near-stop arrival
  arrivedAtStop: boolean
  // Two-tier classification
  classification: Classification
  distanceTrendFired: boolean
  minFreshVpDistance: number | null
}

// --- Parse snapshots (supports both JSON array and JSONL formats) ---
async function loadSnapshots(): Promise<SnapshotEntry[]> {
  const raw = await readFile(JSONL_PATH, "utf-8")
  const trimmed = raw.trim()

  // If the file starts with '[', it's a JSON array
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as SnapshotEntry[]
  }

  // Otherwise, treat as JSONL (one JSON object per line)
  return trimmed
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SnapshotEntry)
}

// --- Get stop coordinates from snapshot or fallback ---
function getStopCoords(snapshots: SnapshotEntry[]): { latitude: number; longitude: number } {
  for (const snap of snapshots) {
    if (snap.stopLatitude != null && snap.stopLongitude != null) {
      return { latitude: snap.stopLatitude, longitude: snap.stopLongitude }
    }
  }
  return DEFAULT_STOP
}

// --- VP age in seconds at observation time ---
function vpAgeAtObs(obs: VehicleObservation): number | null {
  if (!obs.vpTimestamp) return null
  const obsEpoch = Math.floor(new Date(obs.timestamp).getTime() / 1000)
  return obsEpoch - obs.vpTimestamp
}

// --- Is VP fresh at this observation? ---
function isFreshVp(obs: VehicleObservation): boolean {
  const age = vpAgeAtObs(obs)
  return age !== null && age <= FRESH_VP_AGE_S
}

// --- Build relevant window with ? inclusion rules ---
function buildRelevantWindow(obs: VehicleObservation[]): VehicleObservation[] {
  // Step 1: initial relevant set — numeric ETA < 20, not FAR
  const initial = new Set<number>()
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i]
    if (o.flag !== "FAR" && o.siriEtaMinutes !== null && o.siriEtaMinutes < 20) {
      initial.add(i)
    }
  }

  // Step 2: include ? observations adjacent to numeric <20 within 180s
  const included = new Set(initial)
  for (let i = 0; i < obs.length; i++) {
    if (included.has(i)) continue
    if (obs[i].siriEtaMinutes !== null) continue // not a ? observation

    const obsTime = new Date(obs[i].timestamp).getTime()

    // Check previous neighbor
    if (i > 0 && initial.has(i - 1)) {
      const neighborTime = new Date(obs[i - 1].timestamp).getTime()
      if (Math.abs(obsTime - neighborTime) <= 180_000) {
        included.add(i)
        continue
      }
    }

    // Check next neighbor
    if (i < obs.length - 1 && initial.has(i + 1)) {
      const neighborTime = new Date(obs[i + 1].timestamp).getTime()
      if (Math.abs(obsTime - neighborTime) <= 180_000) {
        included.add(i)
      }
    }
  }

  // Return in order
  return obs.filter((_, i) => included.has(i))
}

// --- Build vehicle lifecycles ---
function buildLifecycles(snapshots: SnapshotEntry[]): VehicleLifecycle[] {
  const vehicleMap = new Map<string, { route: string; tripId: string | null; observations: VehicleObservation[] }>()

  for (const snap of snapshots) {
    for (const v of snap.vehicles) {
      if (v.vehicleId === "unknown") continue
      if ((v.flag as string) === "SUSPECT") continue

      const key = `${v.vehicleId}:${v.route}`
      if (!vehicleMap.has(key)) {
        vehicleMap.set(key, { route: v.route, tripId: v.tripId, observations: [] })
      }
      vehicleMap.get(key)!.observations.push({
        timestamp: snap.timestamp,
        siriEtaMinutes: v.siriEtaMinutes,
        siriDistance: v.siriDistance,
        flag: v.flag,
        gtfsDelay: v.gtfsDelay,
        vpLatitude: v.vpLatitude ?? null,
        vpLongitude: v.vpLongitude ?? null,
        vpTimestamp: v.vpTimestamp ?? null,
        hasVehiclePosition: v.hasVehiclePosition ?? false,
        ghostSignal: false,
      })
    }
  }

  const allTimestamps = snapshots.map((s) => s.timestamp)
  const lastTimestamp = allTimestamps[allTimestamps.length - 1]

  const lifecycles: VehicleLifecycle[] = []
  for (const [key, data] of vehicleMap) {
    const vehicleId = key.split(":")[0]
    const obs = data.observations
    const relevant = buildRelevantWindow(obs)

    const noVpCount = relevant.filter((o) => o.flag === "NO_VP").length
    const staleVpCount = relevant.filter((o) => o.flag === "STALE_VP").length
    const allNoVpCount = obs.filter((o) => o.flag === "NO_VP").length
    const allStaleVpCount = obs.filter((o) => o.flag === "STALE_VP").length

    const firstSeen = obs[0].timestamp
    const lastSeen = obs[obs.length - 1].timestamp

    const lastEta = obs[obs.length - 1].siriEtaMinutes
    const disappeared = lastSeen !== lastTimestamp && (lastEta === null || lastEta > 0)

    // ETA stalled
    let etaStalled = false
    if (relevant.length >= 2) {
      let stallCount = 0
      for (let i = 1; i < relevant.length; i++) {
        const prev = relevant[i - 1].siriEtaMinutes
        const curr = relevant[i].siriEtaMinutes
        if (prev !== null && curr !== null && curr >= prev) {
          stallCount++
        }
      }
      etaStalled = stallCount > 0 && stallCount >= (relevant.length - 1) / 2
    }

    const trackingDuration = waitMinutes(firstSeen, lastSeen)

    lifecycles.push({
      vehicleId,
      route: data.route,
      tripId: data.tripId,
      firstSeen,
      lastSeen,
      observations: obs,
      relevantObservations: relevant,
      totalCount: obs.length,
      relevantCount: relevant.length,
      noVpCount,
      staleVpCount,
      allNoVpCount,
      allStaleVpCount,
      disappeared,
      etaStalled,
      frozenPosition: false, // computed in findGhosts
      ghostReason: null,
      detectionReasons: [],
      confidence: "insufficient",
      relevantGhostWindowMinutes: 0,
      trackingDurationMinutes: trackingDuration,
      arrivedAtStop: false,
      classification: "suspect",
      distanceTrendFired: false,
      minFreshVpDistance: null,
    })
  }

  return lifecycles
}

// --- Frozen position detection (improved) ---
function detectFrozen(relevant: VehicleObservation[]): boolean {
  // Only consider fresh VP observations with ETA < 20
  const freshVpObs = relevant.filter(
    (o) => o.hasVehiclePosition && o.vpLatitude !== null && o.vpLongitude !== null && isFreshVp(o)
  )
  if (freshVpObs.length < 2) return false

  let streakStart = freshVpObs[0]
  for (let i = 1; i < freshVpObs.length; i++) {
    const current = freshVpObs[i]
    const dist = haversineMeters(
      streakStart.vpLatitude!,
      streakStart.vpLongitude!,
      current.vpLatitude!,
      current.vpLongitude!
    )

    if (dist < FROZEN_DISTANCE_M) {
      const elapsed =
        (new Date(current.timestamp).getTime() - new Date(streakStart.timestamp).getTime()) / 1000
      if (elapsed >= FROZEN_DURATION_S) {
        return true
      }
    } else {
      // Reset streak
      streakStart = current
    }
  }
  return false
}

// --- Distance-to-stop trend detection ---
function detectDistanceTrend(
  relevant: VehicleObservation[],
  stopCoords: { latitude: number; longitude: number }
): boolean {
  // Build paired observations: numeric ETA + fresh VP
  const paired: { eta: number; dist: number; timestamp: string }[] = []
  for (const obs of relevant) {
    if (
      obs.siriEtaMinutes !== null &&
      obs.vpLatitude !== null &&
      obs.vpLongitude !== null &&
      isFreshVp(obs)
    ) {
      const dist = haversineMeters(obs.vpLatitude, obs.vpLongitude, stopCoords.latitude, stopCoords.longitude)
      // Skip observations within distance floor (arrival/dwell/GPS jitter zone)
      if (dist < GHOST_DISTANCE_FLOOR_M) continue
      paired.push({ eta: obs.siriEtaMinutes, dist, timestamp: obs.timestamp })
    }
  }

  if (paired.length < DIST_TREND_MIN_PAIRS) return false

  // Check ETA spans at least 6 minutes of decrease
  const etaValues = paired.map((p) => p.eta)
  const etaSpan = Math.max(...etaValues) - Math.min(...etaValues)
  if (etaSpan < DIST_TREND_MIN_ETA_SPAN) return false

  // Count deltas
  let etaDecreasing = 0
  let distApproaching = 0
  const steps = paired.length - 1

  for (let i = 1; i < paired.length; i++) {
    const etaDelta = paired[i].eta - paired[i - 1].eta
    const distDelta = paired[i].dist - paired[i - 1].dist

    if (etaDelta <= -1) etaDecreasing++
    if (distDelta <= -50) distApproaching++
  }

  // Flag: ETA decreasing >= 60% of steps AND distance approaching < 40%
  return etaDecreasing >= steps * 0.6 && distApproaching < steps * 0.4
}

// --- ETA==0 validation ---
function detectEtaZeroFar(
  relevant: VehicleObservation[],
  stopCoords: { latitude: number; longitude: number }
): boolean {
  for (const obs of relevant) {
    if (obs.siriEtaMinutes !== 0) continue

    // ETA == 0: check if vehicle is actually at the stop with fresh VP
    if (obs.vpLatitude !== null && obs.vpLongitude !== null && isFreshVp(obs)) {
      const dist = haversineMeters(obs.vpLatitude, obs.vpLongitude, stopCoords.latitude, stopCoords.longitude)
      if (dist >= NEAR_STOP_M) {
        return true // ETA 0 but far from stop
      }
    } else if (!obs.hasVehiclePosition || !isFreshVp(obs)) {
      // ETA 0 with no/stale VP — suspicious
      return true
    }
  }
  return false
}

// --- Near-stop arrival check ---
function checkNearStopArrival(
  relevant: VehicleObservation[],
  stopCoords: { latitude: number; longitude: number }
): boolean {
  for (const obs of relevant) {
    if (
      obs.vpLatitude !== null &&
      obs.vpLongitude !== null &&
      isFreshVp(obs)
    ) {
      const dist = haversineMeters(obs.vpLatitude, obs.vpLongitude, stopCoords.latitude, stopCoords.longitude)
      if (dist < NEAR_STOP_M) return true
    }
  }
  return false
}

// --- Tag individual observations with ghost signals ---
function tagGhostSignals(
  relevant: VehicleObservation[],
  reasons: DetectionReason[],
  stopCoords: { latitude: number; longitude: number }
): void {
  const reasonSet = new Set(reasons)

  for (const obs of relevant) {
    let isGhost = false

    if (reasonSet.has("NO_VP majority") && obs.flag === "NO_VP") isGhost = true
    if (reasonSet.has("STALE_VP majority") && obs.flag === "STALE_VP") isGhost = true

    if (reasonSet.has("ETA at 0 but vehicle far from stop") && obs.siriEtaMinutes === 0) {
      if (!obs.hasVehiclePosition || !isFreshVp(obs)) {
        isGhost = true
      } else if (obs.vpLatitude !== null && obs.vpLongitude !== null) {
        const dist = haversineMeters(obs.vpLatitude, obs.vpLongitude, stopCoords.latitude, stopCoords.longitude)
        if (dist >= NEAR_STOP_M) isGhost = true
      }
    }

    if (reasonSet.has("ETA decreasing but not approaching stop")) {
      // Tag observations that are part of the non-approaching trend
      if (obs.siriEtaMinutes !== null && obs.vpLatitude !== null && obs.vpLongitude !== null) {
        const dist = haversineMeters(obs.vpLatitude, obs.vpLongitude, stopCoords.latitude, stopCoords.longitude)
        if (dist >= NEAR_STOP_M) isGhost = true
      }
    }

    if (reasonSet.has("frozen position") && obs.hasVehiclePosition) isGhost = true
    if (reasonSet.has("disappeared with VP issues") && (obs.flag === "NO_VP" || obs.flag === "STALE_VP")) {
      isGhost = true
    }

    obs.ghostSignal = isGhost
  }
}

// --- Compute relevant ghost window ---
function computeGhostWindow(relevant: VehicleObservation[]): number {
  const ghostObs = relevant.filter((o) => o.ghostSignal)
  if (ghostObs.length < 2) return ghostObs.length > 0 ? 0 : 0
  return waitMinutes(ghostObs[0].timestamp, ghostObs[ghostObs.length - 1].timestamp)
}

// --- Detect ghost buses ---
function findGhosts(
  lifecycles: VehicleLifecycle[],
  stopCoords: { latitude: number; longitude: number }
): { ghosts: VehicleLifecycle[]; suspects: VehicleLifecycle[]; trackingAnomalies: VehicleLifecycle[] } {
  const ghosts: VehicleLifecycle[] = []
  const suspects: VehicleLifecycle[] = []
  const trackingAnomalies: VehicleLifecycle[] = []

  for (const lc of lifecycles) {
    const relevant = lc.relevantObservations
    if (relevant.length === 0) continue

    // Check minimum thresholds
    const relevantMinutes =
      relevant.length >= 2
        ? (new Date(relevant[relevant.length - 1].timestamp).getTime() -
            new Date(relevant[0].timestamp).getTime()) /
          60000
        : 0

    const meetsThresholds =
      relevant.length >= MIN_RELEVANT_SNAPSHOTS && relevantMinutes >= MIN_RELEVANT_MINUTES

    const reasons: DetectionReason[] = []

    // NO_VP majority
    if (lc.noVpCount > lc.relevantCount / 2) {
      reasons.push("NO_VP majority")
    }

    // STALE_VP majority
    if (lc.staleVpCount > lc.relevantCount / 2) {
      reasons.push("STALE_VP majority")
    }

    // Frozen position (improved: distance + time + VP freshness)
    const frozen = detectFrozen(relevant)
    lc.frozenPosition = frozen
    if (frozen) {
      reasons.push("frozen position")
    }

    // Disappeared with VP issues
    if (lc.disappeared && (lc.noVpCount > 0 || lc.staleVpCount > 0)) {
      reasons.push("disappeared with VP issues")
    }

    // Distance-to-stop trend
    const trendFired = detectDistanceTrend(relevant, stopCoords)
    lc.distanceTrendFired = trendFired
    if (trendFired) {
      reasons.push("ETA decreasing but not approaching stop")
    }

    // ETA==0 validation
    if (detectEtaZeroFar(relevant, stopCoords)) {
      reasons.push("ETA at 0 but vehicle far from stop")
    }

    if (reasons.length === 0) continue

    lc.detectionReasons = reasons
    lc.ghostReason = reasons.join(", ")

    // Tag individual observations
    tagGhostSignals(relevant, reasons, stopCoords)

    // Compute ghost window
    lc.relevantGhostWindowMinutes = computeGhostWindow(relevant)

    // Confidence
    if (!meetsThresholds) {
      lc.confidence = "insufficient"
    } else if (reasons.length >= 2) {
      lc.confidence = "high"
    } else {
      lc.confidence = "low"
    }

    // Near-stop arrival check
    lc.arrivedAtStop = checkNearStopArrival(relevant, stopCoords)

    // Compute min fresh VP distance
    lc.minFreshVpDistance = minDistanceToStop(relevant, stopCoords)

    // --- Classification: three-tier system ---
    // 1. Arrived at stop (within 60m, fresh VP) → tracking_anomaly
    if (lc.arrivedAtStop) {
      lc.classification = "tracking_anomaly"
      trackingAnomalies.push(lc)
    }
    // 2. Insufficient data → skip entirely
    else if (lc.confidence === "insufficient") {
      continue
    }
    // 3. Never within 150m AND distance trend fired → GHOST (iron-clad)
    else if (
      (lc.minFreshVpDistance === null || lc.minFreshVpDistance >= GHOST_DISTANCE_FLOOR_M) &&
      lc.distanceTrendFired
    ) {
      lc.classification = "ghost"
      ghosts.push(lc)
    }
    // 4. Everything else with reasons → SUSPECT
    else {
      lc.classification = "suspect"
      suspects.push(lc)
    }
  }

  return { ghosts, suspects, trackingAnomalies }
}

// --- Compute wait time in minutes ---
function waitMinutes(firstSeen: string, lastSeen: string): number {
  return Math.round((new Date(lastSeen).getTime() - new Date(firstSeen).getTime()) / 60000)
}

// --- Format ETA progression (relevant window only) ---
function etaProgression(obs: VehicleObservation[]): string {
  return obs.map((o) => (o.siriEtaMinutes !== null ? `${o.siriEtaMinutes}m` : "?")).join(" → ")
}

// --- Format flag progression (relevant window only) ---
function flagProgression(obs: VehicleObservation[]): string {
  return obs.map((o) => o.flag).join(" → ")
}

// --- Compact lifecycle summary ---
function lifecycleSummary(lc: VehicleLifecycle): string {
  const etas = lc.observations
    .map((o) => o.siriEtaMinutes)
    .filter((e): e is number => e !== null)
  const etaRange =
    etas.length > 0 ? `ETA range: ${Math.max(...etas)}m → ${Math.min(...etas)}m` : "no ETAs"
  return `Lifecycle: ${lc.firstSeen} — ${lc.lastSeen} | ${lc.totalCount} total, ${lc.relevantCount} relevant | ${etaRange}`
}

// --- Minimum distance to stop from fresh VP ---
function minDistanceToStop(
  relevant: VehicleObservation[],
  stopCoords: { latitude: number; longitude: number }
): number | null {
  let minDist: number | null = null
  for (const obs of relevant) {
    if (obs.vpLatitude !== null && obs.vpLongitude !== null && isFreshVp(obs)) {
      const dist = haversineMeters(obs.vpLatitude, obs.vpLongitude, stopCoords.latitude, stopCoords.longitude)
      if (minDist === null || dist < minDist) minDist = dist
    }
  }
  return minDist
}

// --- Route breakdown ---
function routeBreakdown(
  lifecycles: VehicleLifecycle[],
  ghosts: VehicleLifecycle[],
  suspects: VehicleLifecycle[]
): Map<string, { total: number; ghost: number; suspect: number; noVp: number }> {
  const ghostSet = new Set(ghosts.map((g) => `${g.vehicleId}:${g.route}`))
  const suspectSet = new Set(suspects.map((s) => `${s.vehicleId}:${s.route}`))
  const breakdown = new Map<string, { total: number; ghost: number; suspect: number; noVp: number }>()

  for (const lc of lifecycles) {
    if (!breakdown.has(lc.route)) {
      breakdown.set(lc.route, { total: 0, ghost: 0, suspect: 0, noVp: 0 })
    }
    const entry = breakdown.get(lc.route)!
    entry.total++
    if (ghostSet.has(`${lc.vehicleId}:${lc.route}`)) entry.ghost++
    if (suspectSet.has(`${lc.vehicleId}:${lc.route}`)) entry.suspect++
    if (lc.noVpCount > 0) entry.noVp++
  }

  return breakdown
}

// --- Generate report ---
function generateReport(
  snapshots: SnapshotEntry[],
  lifecycles: VehicleLifecycle[],
  ghosts: VehicleLifecycle[],
  suspects: VehicleLifecycle[],
  trackingAnomalies: VehicleLifecycle[],
  stopCoords: { latitude: number; longitude: number }
): string {
  const totalVehicles = lifecycles.length

  const timeRange =
    snapshots.length > 0
      ? `${snapshots[0].timestamp} → ${snapshots[snapshots.length - 1].timestamp}`
      : "no data"

  // Route breakdown table
  const breakdown = routeBreakdown(lifecycles, ghosts, suspects)
  const routeRows = [...breakdown.entries()]
    .sort((a, b) => (b[1].ghost + b[1].suspect) - (a[1].ghost + a[1].suspect))
    .map(([route, stats]) => `| ${route} | ${stats.total} | ${stats.noVp} | ${stats.ghost} | ${stats.suspect} |`)
    .join("\n")

  // --- Ghost Bus Cases (iron-clad) ---
  const ghostStories = ghosts
    .sort((a, b) => b.relevantGhostWindowMinutes - a.relevantGhostWindowMinutes)
    .slice(0, 10)
    .map((g, i) => {
      const relevantEta = etaProgression(g.relevantObservations)
      const relevantFlags = flagProgression(g.relevantObservations)
      const etas = g.relevantObservations
        .map((o) => o.siriEtaMinutes)
        .filter((e): e is number => e !== null)
      const maxEta = etas.length > 0 ? Math.max(...etas) : 0
      const minEta = etas.length > 0 ? Math.min(...etas) : 0
      const minDist = g.minFreshVpDistance !== null ? `${Math.round(g.minFreshVpDistance)}m` : "no fresh VP"

      let story = `### Ghost #${i + 1}: Vehicle ${g.vehicleId} (${g.route})

> Vehicle never came within ${minDist} of stop while ETA decreased from ${maxEta}m to ${minEta}m over ${g.relevantGhostWindowMinutes} minutes.

- **${lifecycleSummary(g)}**
- **Tracking duration:** ${g.trackingDurationMinutes} min
- **Relevant ghost window:** ${g.relevantGhostWindowMinutes} min
- **Relevant ETA progression:** ${relevantEta}
- **Relevant flag progression:** ${relevantFlags}
- **Detection reasons:** ${g.ghostReason}
- **Min distance to stop (fresh VP):** ${minDist}
- **VP stats (relevant):** NO_VP: ${g.noVpCount}, STALE_VP: ${g.staleVpCount}, frozen: ${g.frozenPosition ? "yes" : "no"}
- **Trip ID:** ${g.tripId ?? "unknown"}`

      if (VERBOSE) {
        story += `\n- **Full ETA progression:** ${etaProgression(g.observations)}`
        story += `\n- **Full flag progression:** ${flagProgression(g.observations)}`
      }

      return story
    })
    .join("\n\n")

  // --- Suspect Bus section ---
  let suspectSection = ""
  if (suspects.length > 0) {
    const suspectItems = suspects
      .sort((a, b) => b.relevantGhostWindowMinutes - a.relevantGhostWindowMinutes)
      .slice(0, 10)
      .map((s, i) => {
        const minDist = s.minFreshVpDistance !== null ? `${Math.round(s.minFreshVpDistance)}m` : "no fresh VP"
        const relevantEta = etaProgression(s.relevantObservations)
        const whyNot: string[] = []
        if (s.minFreshVpDistance !== null && s.minFreshVpDistance < GHOST_DISTANCE_FLOOR_M) {
          whyNot.push(`min distance ${Math.round(s.minFreshVpDistance)}m, below ${GHOST_DISTANCE_FLOOR_M}m floor`)
        }
        if (!s.distanceTrendFired) {
          whyNot.push("distance trend did not fire")
        }
        const whyNotStr = whyNot.length > 0 ? whyNot.join("; ") : "unknown"

        let story = `### Suspect #${i + 1}: Vehicle ${s.vehicleId} (${s.route})

- **Why not ghost:** ${whyNotStr}
- **${lifecycleSummary(s)}**
- **Relevant ghost window:** ${s.relevantGhostWindowMinutes} min
- **Relevant ETA progression:** ${relevantEta}
- **Detection reasons:** ${s.ghostReason}
- **Min distance to stop (fresh VP):** ${minDist}
- **VP stats (relevant):** NO_VP: ${s.noVpCount}, STALE_VP: ${s.staleVpCount}, frozen: ${s.frozenPosition ? "yes" : "no"}
- **Trip ID:** ${s.tripId ?? "unknown"}`

        if (VERBOSE) {
          story += `\n- **Full ETA progression:** ${etaProgression(s.observations)}`
        }

        return story
      })
      .join("\n\n")

    suspectSection = `## Suspect Buses

${suspects.length} vehicle(s) had detection signals but did not meet iron-clad ghost criteria. These may still represent real problems but could also be GPS jitter or dwell behavior.

${suspectItems}${suspects.length > 10 ? `\n\n...and ${suspects.length - 10} more` : ""}
`
  }

  // --- Tracking Anomaly section ---
  let anomalySection = ""
  if (trackingAnomalies.length > 0) {
    const anomalyItems = trackingAnomalies
      .slice(0, 5)
      .map((a) => {
        return `- **Vehicle ${a.vehicleId} (${a.route})** — arrived at stop but had VP issues: ${a.ghostReason} | ${a.relevantCount} relevant obs`
      })
      .join("\n")

    anomalySection = `## Tracking Anomalies (arrived at stop, not ghosts)

${trackingAnomalies.length} vehicle(s) had VP issues but were confirmed within ${NEAR_STOP_M}m of the stop with fresh VP data.

${anomalyItems}${trackingAnomalies.length > 5 ? `\n\n...and ${trackingAnomalies.length - 5} more` : ""}
`
  }

  return `# Ghost Bus Report (VP-Based Detection)

## Summary

| Metric | Value |
|--------|-------|
| Time range | ${timeRange} |
| Snapshots collected | ${snapshots.length} |
| Unique vehicles tracked | ${totalVehicles} |
| Ghost buses (iron-clad) | ${ghosts.length} |
| Suspect buses | ${suspects.length} |
| Tracking anomalies | ${trackingAnomalies.length} |
| Min relevant threshold | ${MIN_RELEVANT_SNAPSHOTS} snapshots AND ${MIN_RELEVANT_MINUTES} minutes |

## Route Breakdown

| Route | Vehicles | VP Issues | Ghost | Suspect |
|-------|----------|-----------|-------|---------|
${routeRows || "| — | — | — | — | — |"}

## Ghost Bus Cases (Iron-Clad)

${ghostStories || "No iron-clad ghost buses detected in this dataset. All flagged vehicles are classified as suspects — see below."}

${suspectSection}
${anomalySection}
## Detection Methodology

This report uses a **two-tier classification system** based on VehiclePosition (VP) feed data as ground truth.

### Classification Tiers

- **Ghost bus (iron-clad)**: The vehicle was **never within ${GHOST_DISTANCE_FLOOR_M}m** of the stop (based on fresh VP data) AND its **ETA was counting down while distance wasn't decreasing** over several minutes. This combination is unarguable — the bus was far away the entire time while SIRI reported it approaching.
- **Suspect bus**: The vehicle has detection signals (VP issues, ETA anomalies, etc.) but did not meet both iron-clad criteria. These may represent real ghost buses, but could also be explained by GPS jitter, dwell behavior, or edge cases.
- **Tracking anomaly**: VP data had issues but the vehicle was confirmed within ${NEAR_STOP_M}m of the stop with fresh GPS. The bus arrived — the tracking was just broken.

### Detection Signals

A vehicle is flagged when it has sufficient data (>= ${MIN_RELEVANT_SNAPSHOTS} relevant snapshots spanning >= ${MIN_RELEVANT_MINUTES} min) AND any of:

1. **NO_VP majority** — Over half of relevant observations have no VehiclePosition entity.
2. **STALE_VP majority** — Over half of relevant observations have VP age > ${FRESH_VP_AGE_S}s.
3. **Frozen position** — VP moves < ${FROZEN_DISTANCE_M}m over >= ${FROZEN_DURATION_S}s with fresh VP data.
4. **Disappeared with VP issues** — Vehicle vanished from feed before ETA reached 0.
5. **ETA decreasing but not approaching stop** — ETA counts down but distance to stop isn't decreasing (only fires when all observations are >${GHOST_DISTANCE_FLOOR_M}m from stop).
6. **ETA at 0 but vehicle far from stop** — SIRI says arrived but vehicle is >= ${NEAR_STOP_M}m away (or VP missing/stale).

### Ghost Promotion Criteria

To be classified as a ghost (not just a suspect), a vehicle must satisfy **both**:
1. **Distance floor**: Never observed within ${GHOST_DISTANCE_FLOOR_M}m of the stop (fresh VP).
2. **Distance trend**: Signal #5 fired — ETA decreased while distance didn't, sustained over ${DIST_TREND_MIN_PAIRS}+ paired observations spanning ${DIST_TREND_MIN_ETA_SPAN}+ minutes of ETA decrease.

### Near-Stop Exception

If a vehicle's fresh VP is ever within ${NEAR_STOP_M}m of the stop during the relevant window, it is classified as a **tracking anomaly** regardless of other signals.

---

*Generated by BusWatch VP-based ghost analysis — ${new Date().toISOString()}*
`
}

// --- Main ---
async function main() {
  console.log("Loading snapshots from", JSONL_PATH)
  if (VERBOSE) console.log("Verbose mode enabled — full progressions will be shown")

  let snapshots: SnapshotEntry[]
  try {
    snapshots = await loadSnapshots()
  } catch (err) {
    console.error("Failed to read snapshots. Have you run the comparison mode first?")
    console.error("Start the server with BUSWATCH_MODE=compare and let it collect data.")
    process.exit(1)
  }

  console.log(`Loaded ${snapshots.length} snapshots`)

  const stopCoords = getStopCoords(snapshots)
  console.log(`Stop coordinates: ${stopCoords.latitude}, ${stopCoords.longitude}`)

  const lifecycles = buildLifecycles(snapshots)
  console.log(`Tracked ${lifecycles.length} unique vehicles`)

  const { ghosts, suspects, trackingAnomalies } = findGhosts(lifecycles, stopCoords)
  console.log(`Found ${ghosts.length} ghosts, ${suspects.length} suspects, ${trackingAnomalies.length} tracking anomalies`)

  const report = generateReport(snapshots, lifecycles, ghosts, suspects, trackingAnomalies, stopCoords)

  await mkdir(path.dirname(REPORT_PATH), { recursive: true })
  await writeFile(REPORT_PATH, report, "utf-8")
  console.log(`Report written to ${REPORT_PATH}`)

  // Print quick summary to console
  console.log("\n--- Quick Summary ---")
  console.log(`Snapshots: ${snapshots.length}`)
  console.log(`Vehicles tracked: ${lifecycles.length}`)
  console.log(`Ghost buses (iron-clad): ${ghosts.length}`)
  console.log(`Suspect buses: ${suspects.length}`)
  console.log(`Tracking anomalies: ${trackingAnomalies.length}`)
  if (ghosts.length > 0) {
    console.log(`\nGhost cases:`)
    ghosts
      .sort((a, b) => b.relevantGhostWindowMinutes - a.relevantGhostWindowMinutes)
      .slice(0, 5)
      .forEach((g) => {
        const minDist = g.minFreshVpDistance !== null ? `${Math.round(g.minFreshVpDistance)}m` : "no fresh VP"
        console.log(
          `  Vehicle ${g.vehicleId} (${g.route}) — ghost window: ${g.relevantGhostWindowMinutes}min, min dist: ${minDist}, reasons: ${g.ghostReason}`
        )
      })
  }
  if (suspects.length > 0) {
    console.log(`\nTop suspects:`)
    suspects
      .sort((a, b) => b.relevantGhostWindowMinutes - a.relevantGhostWindowMinutes)
      .slice(0, 5)
      .forEach((s) => {
        const minDist = s.minFreshVpDistance !== null ? `${Math.round(s.minFreshVpDistance)}m` : "no fresh VP"
        console.log(
          `  Vehicle ${s.vehicleId} (${s.route}) — ghost window: ${s.relevantGhostWindowMinutes}min, min dist: ${minDist}, reasons: ${s.ghostReason}`
        )
      })
  }
}

main()
