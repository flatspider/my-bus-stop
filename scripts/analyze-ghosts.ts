import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { SnapshotEntry, SnapshotVehicle } from "../server/types.ts"

const JSONL_PATH = path.join(process.cwd(), "data", "snapshots.jsonl")
const REPORT_PATH = path.join(process.cwd(), "data", "ghost-report.md")

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
}

interface VehicleLifecycle {
  vehicleId: string
  route: string
  tripId: string | null
  firstSeen: string
  lastSeen: string
  observations: VehicleObservation[]
  totalCount: number
  relevantCount: number
  noVpCount: number
  staleVpCount: number
  disappeared: boolean
  etaStalled: boolean
  frozenPosition: boolean
  ghostReason: string | null
}

// --- Parse JSONL ---
async function loadSnapshots(): Promise<SnapshotEntry[]> {
  const raw = await readFile(JSONL_PATH, "utf-8")
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SnapshotEntry)
}

// --- Build vehicle lifecycles ---
function buildLifecycles(snapshots: SnapshotEntry[]): VehicleLifecycle[] {
  const vehicleMap = new Map<string, { route: string; tripId: string | null; observations: VehicleObservation[] }>()

  for (const snap of snapshots) {
    for (const v of snap.vehicles) {
      if (v.vehicleId === "unknown") continue

      // Skip legacy observations with old flag schema
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
      })
    }
  }

  const allTimestamps = snapshots.map((s) => s.timestamp)
  const lastTimestamp = allTimestamps[allTimestamps.length - 1]

  const lifecycles: VehicleLifecycle[] = []
  for (const [key, data] of vehicleMap) {
    const vehicleId = key.split(":")[0]
    const obs = data.observations

    // Only consider observations where ETA < 20 minutes (skip FAR buses)
    const relevant = obs.filter((o) => o.flag !== "FAR" && o.siriEtaMinutes !== null && o.siriEtaMinutes < 20)
    const noVpCount = relevant.filter((o) => o.flag === "NO_VP").length
    const staleVpCount = relevant.filter((o) => o.flag === "STALE_VP").length

    const firstSeen = obs[0].timestamp
    const lastSeen = obs[obs.length - 1].timestamp

    // Disappeared: last observation is before final snapshot AND ETA hadn't reached 0
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

    // Frozen position: lat/lon identical across 3+ consecutive VP-bearing observations
    let frozenPosition = false
    const vpObs = relevant.filter((o) => o.hasVehiclePosition)
    if (vpObs.length >= 3) {
      let consecutive = 1
      for (let i = 1; i < vpObs.length; i++) {
        if (vpObs[i].vpLatitude === vpObs[i - 1].vpLatitude && vpObs[i].vpLongitude === vpObs[i - 1].vpLongitude) {
          consecutive++
          if (consecutive >= 3) {
            frozenPosition = true
            break
          }
        } else {
          consecutive = 1
        }
      }
    }

    lifecycles.push({
      vehicleId,
      route: data.route,
      tripId: data.tripId,
      firstSeen,
      lastSeen,
      observations: obs,
      totalCount: obs.length,
      relevantCount: relevant.length,
      noVpCount,
      staleVpCount,
      disappeared,
      etaStalled,
      frozenPosition,
      ghostReason: null,
    })
  }

  return lifecycles
}

// --- Detect ghost buses ---
function findGhosts(lifecycles: VehicleLifecycle[]): VehicleLifecycle[] {
  return lifecycles.filter((lc) => {
    // Need at least 1 relevant observation (ETA < 20min)
    if (lc.relevantCount === 0) return false

    const reasons: string[] = []

    // Majority of relevant observations have NO_VP
    if (lc.noVpCount > lc.relevantCount / 2) {
      reasons.push("NO_VP majority")
    }

    // Majority of relevant observations have STALE_VP
    if (lc.staleVpCount > lc.relevantCount / 2) {
      reasons.push("STALE_VP majority")
    }

    // Frozen position
    if (lc.frozenPosition) {
      reasons.push("frozen position")
    }

    // Disappeared + had VP issues
    if (lc.disappeared && (lc.noVpCount > 0 || lc.staleVpCount > 0)) {
      reasons.push("disappeared with VP issues")
    }

    if (reasons.length > 0) {
      lc.ghostReason = reasons.join(", ")
      return true
    }
    return false
  })
}

// --- Compute wait time in minutes ---
function waitMinutes(firstSeen: string, lastSeen: string): number {
  return Math.round((new Date(lastSeen).getTime() - new Date(firstSeen).getTime()) / 60000)
}

// --- Format ETA progression ---
function etaProgression(obs: VehicleObservation[]): string {
  return obs.map((o) => (o.siriEtaMinutes !== null ? `${o.siriEtaMinutes}m` : "?")).join(" → ")
}

// --- Format flag progression ---
function flagProgression(obs: VehicleObservation[]): string {
  return obs.map((o) => o.flag).join(" → ")
}

// --- Route breakdown ---
function routeBreakdown(lifecycles: VehicleLifecycle[], ghosts: VehicleLifecycle[]): Map<string, { total: number; ghost: number; noVp: number }> {
  const ghostSet = new Set(ghosts.map((g) => `${g.vehicleId}:${g.route}`))
  const breakdown = new Map<string, { total: number; ghost: number; noVp: number }>()

  for (const lc of lifecycles) {
    if (!breakdown.has(lc.route)) {
      breakdown.set(lc.route, { total: 0, ghost: 0, noVp: 0 })
    }
    const entry = breakdown.get(lc.route)!
    entry.total++
    if (ghostSet.has(`${lc.vehicleId}:${lc.route}`)) entry.ghost++
    if (lc.noVpCount > 0) entry.noVp++
  }

  return breakdown
}

// --- Generate report ---
function generateReport(snapshots: SnapshotEntry[], lifecycles: VehicleLifecycle[], ghosts: VehicleLifecycle[]): string {
  const totalVehicles = lifecycles.length
  const vehiclesWithVpIssues = lifecycles.filter((lc) => lc.noVpCount > 0 || lc.staleVpCount > 0).length
  const ghostCount = ghosts.length
  const pctVpIssues = totalVehicles > 0 ? ((vehiclesWithVpIssues / totalVehicles) * 100).toFixed(1) : "0"
  const pctGhost = totalVehicles > 0 ? ((ghostCount / totalVehicles) * 100).toFixed(1) : "0"

  const timeRange =
    snapshots.length > 0
      ? `${snapshots[0].timestamp} → ${snapshots[snapshots.length - 1].timestamp}`
      : "no data"

  const longestWait = ghosts.reduce((max, g) => {
    const w = waitMinutes(g.firstSeen, g.lastSeen)
    return w > max ? w : max
  }, 0)

  // Route breakdown table
  const breakdown = routeBreakdown(lifecycles, ghosts)
  const routeRows = [...breakdown.entries()]
    .sort((a, b) => b[1].ghost - a[1].ghost)
    .map(([route, stats]) => `| ${route} | ${stats.total} | ${stats.noVp} | ${stats.ghost} |`)
    .join("\n")

  // Ghost bus stories
  const ghostStories = ghosts
    .sort((a, b) => waitMinutes(b.firstSeen, b.lastSeen) - waitMinutes(a.firstSeen, a.lastSeen))
    .slice(0, 10)
    .map((g, i) => {
      const wait = waitMinutes(g.firstSeen, g.lastSeen)
      const progression = etaProgression(g.observations)
      const flags = flagProgression(g.observations)

      return `### Ghost #${i + 1}: Vehicle ${g.vehicleId} (${g.route})

- **Tracked for:** ${wait} minutes across ${g.totalCount} snapshots (${g.relevantCount} relevant, ETA<20min)
- **First seen:** ${g.firstSeen}
- **Last seen:** ${g.lastSeen}
- **ETA progression:** ${progression}
- **Flag progression:** ${flags}
- **Detection reason:** ${g.ghostReason}
- **VP stats:** NO_VP: ${g.noVpCount}, STALE_VP: ${g.staleVpCount}, frozen: ${g.frozenPosition ? "yes" : "no"}
- **Trip ID:** ${g.tripId ?? "unknown"}`
    })
    .join("\n\n")

  return `# Ghost Bus Report (VP-Based Detection)

## Summary

| Metric | Value |
|--------|-------|
| Time range | ${timeRange} |
| Snapshots collected | ${snapshots.length} |
| Unique vehicles tracked | ${totalVehicles} |
| Vehicles with VP issues | ${vehiclesWithVpIssues} (${pctVpIssues}%) |
| Confirmed ghost buses | ${ghostCount} (${pctGhost}%) |
| Longest ghost wait | ${longestWait} minutes |

## Route Breakdown

| Route | Vehicles | VP Issues | Ghost |
|-------|----------|-----------|-------|
${routeRows || "| — | — | — | — |"}

## Ghost Bus Stories

${ghostStories || "No ghost buses detected in this dataset."}

## Detection Methodology

This report uses **VehiclePosition (VP) feed** data as ground truth instead of TripUpdate delay values.

### Why VP-Based Detection?

The previous approach (flagging delay=0 + SCHEDULED) produced nearly 100% false positives because that's the MTA's default state for all buses, not just ghosts. The VP feed provides actual GPS positions and timestamps — much stronger evidence of whether a bus is real.

### Ghost Criteria

A bus is flagged as a ghost when **SIRI ETA < 20 minutes** AND any of:

1. **NO_VP** — VehiclePosition feed has no entity for this vehicle. The bus exists in SIRI but has no GPS position at all.
2. **STALE_VP** — VP entity exists but its timestamp is >90 seconds old. The bus's GPS hasn't reported recently.
3. **FROZEN** — Vehicle's lat/lon is identical across 3+ consecutive snapshots. The "bus" is stationary despite SIRI claiming it's approaching.

Buses with ETA >= 20 minutes are excluded (flagged "FAR") since they're too distant for reliable ghost detection.

### Why Ghost Buses Happen

1. **GPS signal loss** — The bus loses its GPS fix. No position to report.
2. **Driver didn't log into CAD/AVL** — The onboard computer requires login for tracking.
3. **Trip cancelled but not in dispatch** — Scheduled trip persists in the feed.
4. **Onboard hardware failure** — GPS transponder or cellular modem failed.
5. **Bus pulled mid-route** — Removed from service but trip never cancelled.

---

*Generated by BusWatch VP-based ghost analysis — ${new Date().toISOString()}*
`
}

// --- Main ---
async function main() {
  console.log("Loading snapshots from", JSONL_PATH)

  let snapshots: SnapshotEntry[]
  try {
    snapshots = await loadSnapshots()
  } catch (err) {
    console.error("Failed to read snapshots. Have you run the comparison mode first?")
    console.error("Start the server with BUSWATCH_MODE=compare and let it collect data.")
    process.exit(1)
  }

  console.log(`Loaded ${snapshots.length} snapshots`)

  const lifecycles = buildLifecycles(snapshots)
  console.log(`Tracked ${lifecycles.length} unique vehicles`)

  const ghosts = findGhosts(lifecycles)
  console.log(`Found ${ghosts.length} ghost buses`)

  const report = generateReport(snapshots, lifecycles, ghosts)

  await mkdir(path.dirname(REPORT_PATH), { recursive: true })
  await writeFile(REPORT_PATH, report, "utf-8")
  console.log(`Report written to ${REPORT_PATH}`)

  // Print quick summary to console
  console.log("\n--- Quick Summary ---")
  console.log(`Snapshots: ${snapshots.length}`)
  console.log(`Vehicles tracked: ${lifecycles.length}`)
  console.log(`Ghost buses: ${ghosts.length}`)
  if (ghosts.length > 0) {
    const longestWait = ghosts.reduce((max, g) => {
      const w = waitMinutes(g.firstSeen, g.lastSeen)
      return w > max ? w : max
    }, 0)
    console.log(`Longest ghost wait: ${longestWait} minutes`)
    console.log(`\nTop ghosts:`)
    ghosts
      .sort((a, b) => waitMinutes(b.firstSeen, b.lastSeen) - waitMinutes(a.firstSeen, a.lastSeen))
      .slice(0, 5)
      .forEach((g) => {
        console.log(`  Vehicle ${g.vehicleId} (${g.route}) — ${waitMinutes(g.firstSeen, g.lastSeen)}min, reason: ${g.ghostReason}`)
      })
  }
}

main()
