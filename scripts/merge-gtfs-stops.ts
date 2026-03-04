import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const PREFERRED_FEED_ORDER = [
  "bronx",
  "brooklyn",
  "manhattan",
  "queens",
  "staten-island",
  "mtabc",
]

interface FeedFile {
  feed: string
  filePath: string
}

const OUTPUT_COLUMNS = ["stop_id", "stop_name", "stop_lat", "stop_lon"] as const

function splitLines(raw: string): string[] {
  return raw.split(/\r?\n/)
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

function toCsvLine(values: string[]): string {
  return values
    .map((value) => {
      if (/[",\n]/.test(value)) {
        return `"${value.replace(/"/g, "\"\"")}"`
      }
      return value
    })
    .join(",")
}

function sortFeeds(feeds: string[]): string[] {
  const priority = new Map(PREFERRED_FEED_ORDER.map((feed, idx) => [feed, idx]))

  return [...feeds].sort((a, b) => {
    const aRank = priority.get(a)
    const bRank = priority.get(b)
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank
    if (aRank !== undefined) return -1
    if (bRank !== undefined) return 1
    return a.localeCompare(b)
  })
}

async function findStopsFiles(gtfsRoot: string): Promise<FeedFile[]> {
  const entries = await readdir(gtfsRoot, { withFileTypes: true })
  const feedNames = sortFeeds(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  )

  const files: FeedFile[] = []
  for (const feed of feedNames) {
    const filePath = path.join(gtfsRoot, feed, "stops.txt")
    try {
      await readFile(filePath, "utf-8")
      files.push({ feed, filePath })
    } catch {
      // Ignore feeds without stops.txt.
    }
  }

  return files
}

async function main() {
  const gtfsRoot = process.argv[2] ?? path.join(process.cwd(), "data", "gtfs")
  const outputPath = process.argv[3] ?? path.join(gtfsRoot, "stops-all.txt")

  const files = await findStopsFiles(gtfsRoot)
  if (files.length === 0) {
    console.error(`[merge-gtfs-stops] No stops.txt files found under ${gtfsRoot}`)
    process.exit(1)
  }

  const mergedRows: string[] = []
  let totalInputRows = 0
  let totalOutputRows = 0

  for (const file of files) {
    const raw = await readFile(file.filePath, "utf-8")
    const lines = splitLines(raw).filter((line) => line.trim().length > 0)
    if (lines.length === 0) continue

    const headers = parseCsvLine(lines[0]).map((column) => column.trim())
    const indexByColumn = new Map(headers.map((column, index) => [column, index]))
    const missingColumn = OUTPUT_COLUMNS.find((column) => !indexByColumn.has(column))
    if (missingColumn) {
      console.error(`[merge-gtfs-stops] Missing required column "${missingColumn}" in ${file.filePath}`)
      process.exit(1)
    }

    const dataLines = lines.slice(1)
    totalInputRows += dataLines.length

    for (const dataLine of dataLines) {
      const values = parseCsvLine(dataLine)
      const selected = OUTPUT_COLUMNS.map((column) => {
        const index = indexByColumn.get(column)
        return index !== undefined ? (values[index] ?? "") : ""
      })

      const stopId = selected[0].trim()
      const stopName = selected[1].trim()
      const lat = Number.parseFloat(selected[2])
      const lon = Number.parseFloat(selected[3])
      if (!stopId || !stopName || Number.isNaN(lat) || Number.isNaN(lon)) continue

      mergedRows.push(toCsvLine(selected))
      totalOutputRows += 1
    }
  }

  if (mergedRows.length === 0) {
    console.error("[merge-gtfs-stops] No valid stop rows found.")
    process.exit(1)
  }

  const output = `${OUTPUT_COLUMNS.join(",")}\n${mergedRows.join("\n")}\n`
  await writeFile(outputPath, output, "utf-8")

  console.log(
    `[merge-gtfs-stops] Wrote ${mergedRows.length} rows (from ${files.length} feeds; ${totalInputRows} input rows, ${totalOutputRows} valid rows) to ${outputPath}`,
  )
}

main().catch((error) => {
  console.error("[merge-gtfs-stops] Failed:", error)
  process.exit(1)
})
