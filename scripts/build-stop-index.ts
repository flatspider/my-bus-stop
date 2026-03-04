import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

interface RawStop {
  stop_id: string
  stop_name: string
  stop_lat: string
  stop_lon: string
}

interface IndexedStop {
  code: string
  name: string
  normalizedName: string
  lat: number
  lon: number
}

function normalize(text: string): string {
  return text
    .toUpperCase()
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/[^A-Z0-9\s/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]

    if (char === '"') {
      const next = line[i + 1]
      if (inQuotes && next === '"') {
        current += '"'
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

function parseStopsCsv(raw: string): RawStop[] {
  const lines = raw.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) return []

  const headers = parseCsvLine(lines[0])
  const rows: RawStop[] = []

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

async function main() {
  const sourcePath = process.argv[2]
  if (!sourcePath) {
    console.error("Usage: bun scripts/build-stop-index.ts <path-to-stops.txt>")
    process.exit(1)
  }

  const outputPath = process.argv[3] ?? path.join(process.cwd(), "data", "stops-index.json")

  const raw = await readFile(sourcePath, "utf-8")
  const rows = parseStopsCsv(raw)

  const byCode = new Map<string, IndexedStop>()

  for (const row of rows) {
    const code = normalizeStopCode(row.stop_id)
    if (!code) continue

    const lat = Number.parseFloat(row.stop_lat)
    const lon = Number.parseFloat(row.stop_lon)
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue

    const existing = byCode.get(code)
    if (existing) {
      continue
    }

    const name = row.stop_name.trim()
    if (!name) continue

    byCode.set(code, {
      code,
      name,
      normalizedName: normalize(name),
      lat,
      lon,
    })
  }

  const output = Array.from(byCode.values()).sort((a, b) => a.code.localeCompare(b.code))
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8")
  console.log(`[build-stop-index] Wrote ${output.length} stops to ${outputPath}`)
}

main().catch((error) => {
  console.error("[build-stop-index] Failed:", error)
  process.exit(1)
})
