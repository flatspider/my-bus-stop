export type BuswatchMode = "scrape" | "compare" | "api"

const raw = process.env.BUSWATCH_MODE ?? "scrape"
const apiKey = process.env.MTA_API_KEY ?? ""

function resolveMode(): BuswatchMode {
  if (raw !== "scrape" && raw !== "compare" && raw !== "api") {
    console.warn(`Unknown BUSWATCH_MODE "${raw}", falling back to "scrape"`)
    return "scrape"
  }

  if ((raw === "compare" || raw === "api") && !apiKey) {
    console.warn(`BUSWATCH_MODE="${raw}" requires MTA_API_KEY — falling back to "scrape"`)
    return "scrape"
  }

  return raw
}

export const config = {
  mode: resolveMode(),
  apiKey,
} as const
