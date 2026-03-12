export type BuswatchMode = "default" | "compare"

const raw = process.env.BUSWATCH_MODE ?? "default"
const apiKey = process.env.MTA_API_KEY ?? ""
const rawSiteUrl = process.env.SITE_URL?.trim() || "https://bauhausbus.com"
const siteUrl = rawSiteUrl.replace(/\/+$/, "")

if (!apiKey) {
  console.warn("⚠ MTA_API_KEY not set — API routes will return 503")
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
  siteUrl,
} as const
