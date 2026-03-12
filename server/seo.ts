import type { SearchIndexedStop } from "./types.ts"
import { formatStopName } from "../src/formatStopName.ts"

export interface PageMetadata {
  title: string
  description: string
  canonicalUrl: string
  ogType?: "website" | "article"
  robots?: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function joinUrl(baseUrl: string, pathname: string): string {
  return new URL(pathname, `${baseUrl}/`).toString()
}

function buildStopDescription(stopName: string, stopCode: string): string {
  return `Live NYC bus arrivals for ${stopName} (stop ${stopCode}). Fast, readable real-time departure info from Bauhaus Bus.`
}

export function buildStopMetadata(
  baseUrl: string,
  pathname: string,
  stop: SearchIndexedStop,
): PageMetadata {
  const stopName = formatStopName(stop.name)

  return {
    title: `${stopName} Bus Arrivals | Bauhaus Bus`,
    description: buildStopDescription(stopName, stop.code),
    canonicalUrl: joinUrl(baseUrl, pathname),
    ogType: "website",
  }
}

export function buildDefaultMetadata(baseUrl: string, pathname = "/"): PageMetadata {
  return {
    title: "Bauhaus Bus | Live NYC Bus Arrivals",
    description: "Real-time NYC bus arrivals at a glance. Beautiful, fast, and Bauhaus-inspired.",
    canonicalUrl: joinUrl(baseUrl, pathname),
    ogType: "website",
  }
}

export function buildUnhappyMetadata(baseUrl: string, pathname: string): PageMetadata {
  return {
    title: "NYC's Unhappiest Bus Stop | Bauhaus Bus",
    description: "See which NYC bus stop is currently the most overdue based on live and scheduled service data.",
    canonicalUrl: joinUrl(baseUrl, pathname),
    ogType: "website",
  }
}

export function buildNotFoundMetadata(baseUrl: string, pathname: string): PageMetadata {
  return {
    title: "Stop Not Found | Bauhaus Bus",
    description: "This bus stop could not be found in Bauhaus Bus.",
    canonicalUrl: joinUrl(baseUrl, pathname),
    ogType: "website",
    robots: "noindex, nofollow",
  }
}

export function applyMetadataToHtmlDocument(html: string, metadata: PageMetadata): string {
  const escapedTitle = escapeHtml(metadata.title)
  const escapedDescription = escapeHtml(metadata.description)
  const escapedCanonicalUrl = escapeHtml(metadata.canonicalUrl)
  const escapedRobots = metadata.robots ? escapeHtml(metadata.robots) : null
  const ogType = metadata.ogType ?? "website"

  let next = html
  next = next.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapedTitle}</title>`)
  next = next.replace(
    /<meta name="description" content="[^"]*"\s*\/>/,
    `<meta name="description" content="${escapedDescription}" />`,
  )
  next = next.replace(
    /<meta property="og:type" content="[^"]*"\s*\/>/,
    `<meta property="og:type" content="${ogType}" />`,
  )
  next = next.replace(
    /<meta property="og:url" content="[^"]*"\s*\/>/,
    `<meta property="og:url" content="${escapedCanonicalUrl}" />`,
  )
  next = next.replace(
    /<meta property="og:title" content="[^"]*"\s*\/>/,
    `<meta property="og:title" content="${escapedTitle}" />`,
  )
  next = next.replace(
    /<meta property="og:description" content="[^"]*"\s*\/>/,
    `<meta property="og:description" content="${escapedDescription}" />`,
  )
  next = next.replace(
    /<meta name="twitter:url" content="[^"]*"\s*\/>/,
    `<meta name="twitter:url" content="${escapedCanonicalUrl}" />`,
  )
  next = next.replace(
    /<meta name="twitter:title" content="[^"]*"\s*\/>/,
    `<meta name="twitter:title" content="${escapedTitle}" />`,
  )
  next = next.replace(
    /<meta name="twitter:description" content="[^"]*"\s*\/>/,
    `<meta name="twitter:description" content="${escapedDescription}" />`,
  )

  const canonicalTag = `    <link rel="canonical" href="${escapedCanonicalUrl}" />`
  if (/<link rel="canonical"/.test(next)) {
    next = next.replace(/<link rel="canonical" href="[^"]*"\s*\/>/, canonicalTag)
  } else {
    next = next.replace("</head>", `${canonicalTag}\n</head>`)
  }

  if (escapedRobots) {
    const robotsTag = `    <meta name="robots" content="${escapedRobots}" />`
    if (/<meta name="robots"/.test(next)) {
      next = next.replace(/<meta name="robots" content="[^"]*"\s*\/>/, robotsTag)
    } else {
      next = next.replace("</head>", `${robotsTag}\n</head>`)
    }
  }

  return next
}
