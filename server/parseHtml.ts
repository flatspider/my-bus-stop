import { parse } from "node-html-parser"
import type { BusArrival, BusRoute, StopData } from "./types.ts"

function parseMinutesNum(text: string): number {
  if (text.toLowerCase().includes("approaching")) return 0
  if (text.includes("<")) return 0.5
  const num = parseFloat(text)
  return isNaN(num) ? 999 : num
}

function parseStopsAway(distanceText: string): string {
  const stopsMatch = distanceText.match(/([\d<]+)\s*stops?\s*away/i)
  if (stopsMatch) return `${stopsMatch[1]} stops away`

  if (distanceText.toLowerCase().includes("approaching")) return "Approaching"

  const milesMatch = distanceText.match(/([\d.]+)\s*miles?\s*away/i)
  if (milesMatch) {
    const miles = parseFloat(milesMatch[1])
    const stops = Math.max(1, Math.round(miles * 8))
    return `~${stops} stops away`
  }

  return distanceText
}

function parseStopName(root: ReturnType<typeof parse>): string {
  const h3s = root.querySelectorAll("h3")
  for (const h3 of h3s) {
    if (h3.textContent?.includes("Bus Stop:")) {
      // In node-html-parser, iterate childNodes of parent to find text after the h3
      const parent = h3.parentNode
      if (!parent) continue
      const siblings = parent.childNodes
      let foundH3 = false
      for (const node of siblings) {
        if (node === h3) {
          foundH3 = true
          continue
        }
        if (foundH3) {
          const text = node.textContent?.trim()
          if (text) return text
        }
      }
    }
  }
  return ""
}

export function parseHtml(html: string): StopData {
  const root = parse(html)

  const stopName = parseStopName(root)
  const directions = root.querySelectorAll(".directionAtStop")
  const routes: BusRoute[] = []

  for (const dir of directions) {
    const headerEl = dir.querySelector("p strong")
    if (!headerEl) continue

    const headerText = headerEl.textContent?.trim() ?? ""
    const match = headerText.match(/^(\S+)\s+(.+)/)
    if (!match) continue

    const route = match[1]
    const direction = match[2]

    const arrivals: BusArrival[] = []
    const ols = dir.querySelectorAll("ol")
    for (const ol of ols) {
      const li = ol.querySelector("li")
      if (!li) continue

      const minutesEl = li.querySelector("strong")
      const minutes = minutesEl?.textContent?.trim() ?? ""

      const vehicleEl = li.querySelector("small")
      const vehicleId = vehicleEl?.textContent?.trim().replace("Vehicle ", "") ?? ""

      const fullText = li.textContent ?? ""
      const distanceMatch = fullText.match(/minutes?\s*,\s*(.+?)(?:\s*Vehicle|\s*$)/)
      const rawDistance = distanceMatch?.[1]?.trim() ?? ""

      arrivals.push({
        minutes,
        minutesNum: parseMinutesNum(minutes),
        stopsAway: parseStopsAway(rawDistance),
        vehicleId,
      })
    }

    routes.push({ route, direction, arrivals })
  }

  return { stopName, routes }
}
