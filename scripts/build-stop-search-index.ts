import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { buildSearchArtifactFromStops } from "../server/search/index.ts"

interface RawStopCsv {
  stop_id: string
  stop_name: string
  stop_lat: string
  stop_lon: string
}

interface LegacyIndexedStop {
  code: string
  name: string
  lat: number
  lon: number
}

interface BaseStop {
  code: string
  name: string
  lat: number
  lon: number
}

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === "\"") {
      const next = line[i + 1]
      if (inQuotes && next === "\"") {
        current += "\""
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === "," && !inQuotes) {
      values.push(current)
      current = ""
      continue
    }

    current += char
  }

  values.push(current)
  return values
}

function parseStopsCsv(raw: string): RawStopCsv[] {
  const lines = raw.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) return []

  const headers = parseCsvLine(lines[0])
  const rows: RawStopCsv[] = []

  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i])
    const row: Record<string, string> = {}
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = values[j] ?? ""
    }

    rows.push({
      stop_id: row.stop_id,
      stop_name: row.stop_name,
      stop_lat: row.stop_lat,
      stop_lon: row.stop_lon,
    })
  }

  return rows
}

function normalizeStopCode(stopId: string): string | null {
  const match = stopId.match(/(\d{6})$/)
  return match ? match[1] : null
}

function fromCsvRows(rows: RawStopCsv[]): BaseStop[] {
  const byCode = new Map<string, BaseStop>()
  for (const row of rows) {
    const code = normalizeStopCode(row.stop_id)
    if (!code || byCode.has(code)) continue

    const name = row.stop_name.trim()
    const lat = Number.parseFloat(row.stop_lat)
    const lon = Number.parseFloat(row.stop_lon)
    if (!name || Number.isNaN(lat) || Number.isNaN(lon)) continue

    byCode.set(code, { code, name, lat, lon })
  }

  return Array.from(byCode.values()).sort((a, b) => a.code.localeCompare(b.code))
}

function fromLegacyJson(raw: unknown): BaseStop[] {
  if (!Array.isArray(raw)) return []

  const stops: BaseStop[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const stop = entry as Partial<LegacyIndexedStop>
    if (
      typeof stop.code !== "string" ||
      typeof stop.name !== "string" ||
      typeof stop.lat !== "number" ||
      typeof stop.lon !== "number"
    ) {
      continue
    }
    stops.push({
      code: stop.code,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
    })
  }

  return stops.sort((a, b) => a.code.localeCompare(b.code))
}

async function loadBaseStops(sourcePath: string): Promise<BaseStop[]> {
  const raw = await readFile(sourcePath, "utf-8")

  if (sourcePath.toLowerCase().endsWith(".json")) {
    return fromLegacyJson(JSON.parse(raw))
  }

  return fromCsvRows(parseStopsCsv(raw))
}

async function main() {
  const sourcePath = process.argv[2]
  if (!sourcePath) {
    console.error("Usage: bun scripts/build-stop-search-index.ts <path-to-stops.txt|path-to-legacy.json>")
    process.exit(1)
  }

  const outputPath = process.argv[3] ?? path.join(process.cwd(), "data", "stops-search-index.v1.json")
  const baseStops = await loadBaseStops(sourcePath)
  const artifact = buildSearchArtifactFromStops(baseStops, sourcePath)

  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")
  console.log(`[build-stop-search-index] Wrote ${artifact.stopCount} stops to ${outputPath}`)
}

main().catch((error) => {
  console.error("[build-stop-search-index] Failed:", error)
  process.exit(1)
})

