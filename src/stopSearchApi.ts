import type { StopSearchResult } from './types'

interface RequestOptions {
  signal?: AbortSignal
}

interface NearbyOptions extends RequestOptions {
  radius?: number
  limit?: number
}

interface SearchOptions extends RequestOptions {
  lat?: number
  lon?: number
  limit?: number
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    query.set(key, String(value))
  }
  return query.toString()
}

async function fetchResults(url: string, signal?: AbortSignal): Promise<StopSearchResult[]> {
  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`Stop search request failed: ${res.status}`)
  }

  const data = await res.json() as unknown
  if (!Array.isArray(data)) return []

  return data
    .filter((item): item is StopSearchResult => {
      if (!item || typeof item !== 'object') return false
      const maybe = item as Partial<StopSearchResult>
      return typeof maybe.code === 'string' && typeof maybe.name === 'string'
    })
    .map((item) => ({
      code: item.code,
      name: item.name,
      ...(typeof item.distanceMeters === 'number' ? { distanceMeters: item.distanceMeters } : {}),
      ...(typeof item.directionLabel === 'string' ? { directionLabel: item.directionLabel } : {}),
      ...(typeof item.directionShort === 'string' ? { directionShort: item.directionShort } : {}),
      ...(typeof item.directionConfidence === 'string' ? { directionConfidence: item.directionConfidence } : {}),
      ...(typeof item.directionSource === 'string' ? { directionSource: item.directionSource } : {}),
    }))
}

export async function fetchNearbyStops(
  lat: number,
  lon: number,
  options: NearbyOptions = {},
): Promise<StopSearchResult[]> {
  const query = buildQuery({
    lat,
    lon,
    radius: options.radius,
    limit: options.limit,
  })

  return fetchResults(`/api/stops/nearby?${query}`, options.signal)
}

export async function searchStops(
  q: string,
  options: SearchOptions = {},
): Promise<StopSearchResult[]> {
  const query = buildQuery({
    q,
    lat: options.lat,
    lon: options.lon,
    limit: options.limit,
  })

  return fetchResults(`/api/stops/search?${query}`, options.signal)
}

export async function stopCodeExists(code: string, signal?: AbortSignal): Promise<boolean> {
  const query = buildQuery({ code })
  const res = await fetch(`/api/stops/exists?${query}`, { signal })
  if (!res.ok) return false
  const data = await res.json() as unknown
  if (!data || typeof data !== "object") return false
  const maybe = data as { exists?: unknown }
  return maybe.exists === true
}
