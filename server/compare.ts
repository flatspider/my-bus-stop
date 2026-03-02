import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { StopData, BusRoute, BusArrival } from "./types.ts"

const LOG_PATH = path.join(process.cwd(), "data", "comparison-log.md")

interface ArrivalDiff {
  field: string
  html: string
  siri: string
}

function compareArrivals(html: BusArrival, siri: BusArrival): ArrivalDiff[] {
  const diffs: ArrivalDiff[] = []

  // Minutes: fuzzy ±1 min tolerance
  if (Math.abs(html.minutesNum - siri.minutesNum) > 1) {
    diffs.push({ field: "minutes", html: html.minutes, siri: siri.minutes })
  }

  if (html.stopsAway !== siri.stopsAway) {
    diffs.push({ field: "stopsAway", html: html.stopsAway, siri: siri.stopsAway })
  }

  if (html.vehicleId !== siri.vehicleId) {
    diffs.push({ field: "vehicleId", html: html.vehicleId, siri: siri.vehicleId })
  }

  return diffs
}

function formatRow(source: string, route: string, direction: string, arrival: BusArrival): string {
  return `| ${source} | ${route} | ${direction} | ${arrival.minutes} | ${arrival.stopsAway} | ${arrival.vehicleId} |`
}

export async function compareAndLog(stopCode: string, htmlData: StopData, siriData: StopData): Promise<void> {
  const timestamp = new Date().toISOString()
  const allDiffs: ArrivalDiff[] = []
  const rows: string[] = []

  // Index SIRI routes by route name for matching
  const siriByRoute = new Map<string, BusRoute>()
  for (const r of siriData.routes) {
    siriByRoute.set(r.route, r)
  }

  const matchedSiriRoutes = new Set<string>()

  for (const htmlRoute of htmlData.routes) {
    const siriRoute = siriByRoute.get(htmlRoute.route)
    if (!siriRoute) {
      // Route in HTML but not SIRI
      for (const a of htmlRoute.arrivals) {
        rows.push(formatRow("HTML", htmlRoute.route, htmlRoute.direction, a))
        rows.push(`| SIRI | ${htmlRoute.route} | — | — | — | — |`)
        allDiffs.push({ field: "route_missing_siri", html: htmlRoute.route, siri: "—" })
      }
      continue
    }

    matchedSiriRoutes.add(htmlRoute.route)

    const maxLen = Math.max(htmlRoute.arrivals.length, siriRoute.arrivals.length)
    for (let i = 0; i < maxLen; i++) {
      const ha = htmlRoute.arrivals[i]
      const sa = siriRoute.arrivals[i]

      if (ha && sa) {
        rows.push(formatRow("HTML", htmlRoute.route, htmlRoute.direction, ha))
        rows.push(formatRow("SIRI", siriRoute.route, siriRoute.direction, sa))
        allDiffs.push(...compareArrivals(ha, sa))
      } else if (ha) {
        rows.push(formatRow("HTML", htmlRoute.route, htmlRoute.direction, ha))
        rows.push(`| SIRI | ${htmlRoute.route} | — | — | — | — |`)
        allDiffs.push({ field: "extra_html_arrival", html: ha.minutes, siri: "—" })
      } else if (sa) {
        rows.push(`| HTML | ${siriRoute.route} | — | — | — | — |`)
        rows.push(formatRow("SIRI", siriRoute.route, siriRoute.direction, sa))
        allDiffs.push({ field: "extra_siri_arrival", html: "—", siri: sa.minutes })
      }
    }
  }

  // Routes in SIRI but not HTML
  for (const siriRoute of siriData.routes) {
    if (matchedSiriRoutes.has(siriRoute.route)) continue
    for (const a of siriRoute.arrivals) {
      rows.push(`| HTML | ${siriRoute.route} | — | — | — | — |`)
      rows.push(formatRow("SIRI", siriRoute.route, siriRoute.direction, a))
      allDiffs.push({ field: "route_missing_html", html: "—", siri: siriRoute.route })
    }
  }

  const status = allDiffs.length === 0 ? "MATCH" : "DIFF"
  const diffSummary = allDiffs.length === 0
    ? "None"
    : allDiffs.map((d) => `- **${d.field}**: HTML="${d.html}" vs SIRI="${d.siri}"`).join("\n")

  const entry = `
## Stop ${stopCode} @ ${timestamp} — ${status}

| Source | Route | Direction | Minutes | Stops Away | Vehicle |
|--------|-------|-----------|---------|------------|---------|
${rows.join("\n")}

Differences: ${diffSummary}

---
`

  await mkdir(path.dirname(LOG_PATH), { recursive: true })
  await appendFile(LOG_PATH, entry, "utf-8")
}
