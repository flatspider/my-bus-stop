export type BuswatchMode = "default" | "compare"

const raw = process.env.BUSWATCH_MODE ?? "default"
const apiKey = process.env.MTA_API_KEY ?? ""

if (!apiKey) {
  console.error("MTA_API_KEY is required. Set it in .env.local or environment.")
  process.exit(1)
}

function resolveMode(): BuswatchMode {
  if (raw === "compare") return "compare"
  if (raw !== "default" && raw !== "") {
    console.warn(`Unknown BUSWATCH_MODE "${raw}", falling back to "default"`)
  }
  return "default"
}

export const config = {
  mode: resolveMode(),
  apiKey,
} as const
