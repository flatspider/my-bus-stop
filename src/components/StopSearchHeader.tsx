import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { fetchNearbyStops, searchStops } from '../stopSearchApi'
import type { StopMiniMapResponse, StopSearchResult } from '../types'

const RECENT_STOPS_KEY = 'buswatch-stop-search-recents'
const SEARCH_LIMIT = 5
const NEARBY_LIMIT = 3
const MAX_VISIBLE_RESULTS = 5

interface StopSearchHeaderProps {
  stopName: string
  showStopTitle: boolean
  showMiniMap: boolean
  miniMapLoading: boolean
  miniMap: StopMiniMapResponse | null
  statusNode: ReactNode
  onSelectStop: (code: string) => void
  onExpandedChange?: (isExpanded: boolean) => void
}

interface GeoState {
  lat: number
  lon: number
}

type LocationState = 'idle' | 'requesting' | 'granted' | 'denied' | 'unavailable'

function loadRecents(): StopSearchResult[] {
  try {
    const raw = localStorage.getItem(RECENT_STOPS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((item): item is StopSearchResult => {
        if (!item || typeof item !== 'object') return false
        const maybe = item as Partial<StopSearchResult>
        return typeof maybe.code === 'string' && typeof maybe.name === 'string'
      })
      .slice(0, 3)
  } catch {
    return []
  }
}

function formatDistance(distanceMeters: number | undefined): string {
  if (distanceMeters === undefined) return ''

  const miles = distanceMeters / 1609.344
  if (miles >= 0.95) {
    return `${miles.toFixed(1)} mi`
  }

  return `${Math.max(0.05, miles).toFixed(2)} mi`
}

function dedupeResults(primary: StopSearchResult[], secondary: StopSearchResult[]): StopSearchResult[] {
  const seen = new Set(primary.map((item) => item.code))
  const merged = [...primary]
  for (const item of secondary) {
    if (seen.has(item.code)) continue
    seen.add(item.code)
    merged.push(item)
  }
  return merged
}

function formatStopName(raw: string): string {
  const upperTokens = new Set([
    'AV', 'ST', 'RD', 'BLVD', 'DR', 'PL', 'LN', 'PKWY',
    'NB', 'SB', 'EB', 'WB', 'E', 'W', 'N', 'S',
  ])

  const withDelimiters = raw
    .replace(/\//g, ' / ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

  return withDelimiters
    .split(' ')
    .map((token) => {
      if (!token) return ''
      if (token === '/' || token === '-' || token === '&') return token
      if (/^\d+$/.test(token)) return token

      const upper = token.toUpperCase()
      if (upperTokens.has(upper)) return upper

      return token.charAt(0).toUpperCase() + token.slice(1)
    })
    .join(' ')
    .replace(/\s+\/\s+/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractDirectionLabel(raw: string): string | null {
  const text = raw.toUpperCase()
  if (text.includes('NORTHBOUND') || /\bNB\b/.test(text)) return 'Northbound'
  if (text.includes('SOUTHBOUND') || /\bSB\b/.test(text)) return 'Southbound'
  if (text.includes('EASTBOUND') || /\bEB\b/.test(text)) return 'Eastbound'
  if (text.includes('WESTBOUND') || /\bWB\b/.test(text)) return 'Westbound'
  if (text.includes('UPTOWN')) return 'Uptown'
  if (text.includes('DOWNTOWN')) return 'Downtown'
  return null
}

function displayDirection(item: StopSearchResult): string | null {
  const direction = item.directionLabel ?? extractDirectionLabel(item.name)
  if (!direction || direction === 'Unknown direction') return null
  return direction
}

export default function StopSearchHeader({
  stopName,
  showStopTitle,
  showMiniMap,
  miniMapLoading,
  miniMap,
  statusNode,
  onSelectStop,
  onExpandedChange,
}: StopSearchHeaderProps) {
  const supportsGeolocation = typeof navigator !== 'undefined' && 'geolocation' in navigator
  const [isExpanded, setIsExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [geo, setGeo] = useState<GeoState | null>(null)
  const [locationState, setLocationState] = useState<LocationState>(
    supportsGeolocation ? 'idle' : 'unavailable',
  )
  const [nearestStops, setNearestStops] = useState<StopSearchResult[]>([])
  const [searchResults, setSearchResults] = useState<StopSearchResult[]>([])
  const [recents, setRecents] = useState<StopSearchResult[]>(() => loadRecents())
  const [statusMessage, setStatusMessage] = useState('')

  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const searchAbortRef = useRef<AbortController | null>(null)
  const nearbyAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort()
      nearbyAbortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    onExpandedChange?.(isExpanded)
  }, [isExpanded, onExpandedChange])

  useEffect(() => {
    if (!isExpanded) return

    function onPointerDown(event: MouseEvent) {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(event.target as Node)) {
        setIsExpanded(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [isExpanded])

  useEffect(() => {
    if (!geo || !isExpanded) return

    nearbyAbortRef.current?.abort()
    const controller = new AbortController()
    nearbyAbortRef.current = controller

    void fetchNearbyStops(geo.lat, geo.lon, {
      limit: NEARBY_LIMIT,
      signal: controller.signal,
    }).then((results) => {
      setNearestStops(results)
    }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setStatusMessage('Unable to load nearby stops right now.')
    })

    return () => controller.abort()
  }, [geo, isExpanded])

  useEffect(() => {
    if (!isExpanded) return

    const normalizedQuery = query.trim()
    searchAbortRef.current?.abort()

    if (!normalizedQuery) return

    const controller = new AbortController()
    searchAbortRef.current = controller

    const timer = window.setTimeout(() => {
      void searchStops(normalizedQuery, {
        lat: geo?.lat,
        lon: geo?.lon,
        limit: SEARCH_LIMIT,
        signal: controller.signal,
      }).then((results) => {
        setSearchResults(results)
      }).catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setStatusMessage('Search unavailable right now.')
      })
    }, 100)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [geo?.lat, geo?.lon, isExpanded, query])

  useEffect(() => {
    localStorage.setItem(RECENT_STOPS_KEY, JSON.stringify(recents.slice(0, 3)))
  }, [recents])

  const dropdownResults = useMemo(() => {
    const normalizedQuery = query.trim()
    if (normalizedQuery) return searchResults.slice(0, MAX_VISIBLE_RESULTS)
    return dedupeResults(nearestStops, recents).slice(0, MAX_VISIBLE_RESULTS)
  }, [nearestStops, query, recents, searchResults])

  function handleOpenSearch() {
    flushSync(() => {
      setIsExpanded(true)
      setStatusMessage('')
    })
    inputRef.current?.focus({ preventScroll: true })
  }

  function closeSearch() {
    setQuery('')
    setIsExpanded(false)
    setStatusMessage('')
  }

  function handleSelect(stop: StopSearchResult) {
    setRecents((prev) => {
      const deduped = [stop, ...prev.filter((entry) => entry.code !== stop.code)]
      return deduped.slice(0, 3)
    })

    onSelectStop(stop.code)
    closeSearch()
  }

  function requestLocationManually() {
    if (!supportsGeolocation) {
      setLocationState('unavailable')
      setStatusMessage('Location unavailable on this device.')
      return
    }

    setLocationState('requesting')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGeo({ lat: position.coords.latitude, lon: position.coords.longitude })
        setLocationState('granted')
        setStatusMessage('')
      },
      () => {
        setLocationState('denied')
        setStatusMessage('Location not enabled. You can still search any stop.')
      },
      {
        enableHighAccuracy: false,
        maximumAge: 120_000,
        timeout: 10_000,
      },
    )
  }

  return (
    <div className="stop-search" ref={wrapperRef}>
      {!isExpanded ? (
        <button
          type="button"
          className="stop-search__trigger"
          onClick={handleOpenSearch}
          aria-label="Search for a bus stop"
        >
          {statusNode}
          {showMiniMap ? (
            <span className="stop-search__mini-wrap" data-tutorial="default-stop">
              <span className="stop-search__mini">
                <span
                  className={`stop-search__mini-skeleton${miniMapLoading ? ' is-visible' : ''}`}
                  aria-hidden="true"
                >
                  <span className="stop-search__mini-line stop-search__mini-line--a" />
                  <span className="stop-search__mini-line stop-search__mini-line--b" />
                  <span className="stop-search__mini-marker" />
                </span>
                {miniMap?.status === 'ready' && (
                  <span
                    className="stop-search__mini-map is-ready"
                    // SVG is generated server-side from fixed geometry and labels.
                    dangerouslySetInnerHTML={{ __html: miniMap.svg }}
                  />
                )}
              </span>
              <span className="stop-search__mini-caption">
                {showStopTitle && stopName
                  ? stopName
                  : 'Search stop'}
              </span>
            </span>
          ) : (
            <>
              {showStopTitle && stopName && (
                <span className="stop-search__title-wrap" data-tutorial="default-stop">
                  <span className="stop-name">{stopName}</span>
                </span>
              )}
              {showStopTitle && !stopName && (
                <span className="stop-search__fallback" data-tutorial="default-stop">
                  Search stop
                </span>
              )}
              {!showStopTitle && (
                <span className="stop-search__fallback" data-tutorial="default-stop">
                  Search stop
                </span>
              )}
            </>
          )}
          <svg
            className="stop-search__chevron"
            width="7"
            height="12"
            viewBox="0 0 7 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M1 1l5 5-5 5" />
          </svg>
        </button>
      ) : (
        <div className="stop-search__input-shell">
          <input
            ref={inputRef}
            className="stop-search__input"
            type="text"
            placeholder="Search stop or street"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search stop or street"
          />
          <button
            type="button"
            className="stop-search__close-inline"
            onClick={closeSearch}
            aria-label="Close stop search"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      )}

      {isExpanded && (
        <div className="stop-search__dropdown" role="listbox" aria-label="Stop search results">
          {!query.trim() && locationState !== 'granted' && (
            <button
              type="button"
              className="stop-search__location-cta"
              onClick={requestLocationManually}
              disabled={locationState === 'requesting'}
            >
              {locationState === 'requesting' ? 'Locating...' : 'Use my location'}
            </button>
          )}

          {!query.trim() && nearestStops.length > 0 && (
            <div className="stop-search__section">
              <p className="stop-search__section-label">Nearest</p>
              {nearestStops.map((item) => (
                <button
                  type="button"
                  className="stop-search__result"
                  key={`near-${item.code}`}
                  onClick={() => handleSelect(item)}
                >
                  <span className="stop-search__result-main">
                    <span className="stop-search__result-line">
                      <span className="stop-search__result-name">{formatStopName(item.name)}</span>
                      {displayDirection(item) && (
                        <span className="stop-search__result-direction">{displayDirection(item)}</span>
                      )}
                    </span>
                  </span>
                  <span className="stop-search__result-meta">{formatDistance(item.distanceMeters)}</span>
                </button>
              ))}
            </div>
          )}

          {!query.trim() && recents.length > 0 && (
            <div className="stop-search__section">
              <p className="stop-search__section-label">Recent</p>
              {recents.map((item) => (
                <button
                  type="button"
                  className="stop-search__result"
                  key={`recent-${item.code}`}
                  onClick={() => handleSelect(item)}
                >
                  <span className="stop-search__result-main">
                    <span className="stop-search__result-line">
                      <span className="stop-search__result-name">{formatStopName(item.name)}</span>
                      {displayDirection(item) && (
                        <span className="stop-search__result-direction">{displayDirection(item)}</span>
                      )}
                    </span>
                  </span>
                  <span className="stop-search__result-meta" />
                </button>
              ))}
            </div>
          )}

          {query.trim() && dropdownResults.length > 0 && (
            <div className="stop-search__section">
              {dropdownResults.map((item) => (
                <button
                  type="button"
                  className="stop-search__result"
                  key={`search-${item.code}`}
                  onClick={() => handleSelect(item)}
                >
                  <span className="stop-search__result-main">
                    <span className="stop-search__result-line">
                      <span className="stop-search__result-name">{formatStopName(item.name)}</span>
                      {displayDirection(item) && (
                        <span className="stop-search__result-direction">{displayDirection(item)}</span>
                      )}
                    </span>
                  </span>
                  <span className="stop-search__result-meta">
                    {item.distanceMeters !== undefined ? formatDistance(item.distanceMeters) : ''}
                  </span>
                </button>
              ))}
            </div>
          )}

          {query.trim() && dropdownResults.length === 0 && (
            <p className="stop-search__empty">No stops found.</p>
          )}

          {!query.trim() && nearestStops.length === 0 && recents.length === 0 && locationState === 'granted' && (
            <p className="stop-search__empty">No nearby stops found.</p>
          )}

          {statusMessage && <p className="stop-search__status">{statusMessage}</p>}
          {!statusMessage && locationState === 'unavailable' && (
            <p className="stop-search__status">Location unavailable on this device.</p>
          )}
        </div>
      )}
    </div>
  )
}
