import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchNearbyStops, searchStops } from '../stopSearchApi'
import type { StopSearchResult } from '../types'

const RECENT_STOPS_KEY = 'buswatch-stop-search-recents'
const LOCATION_PROMPTED_KEY = 'buswatch-stop-search-location-prompted'
const SEARCH_LIMIT = 8
const NEARBY_LIMIT = 3

interface StopSearchHeaderProps {
  stopName: string
  showStopTitle: boolean
  statusNode: ReactNode
  onSelectStop: (code: string) => void
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

export default function StopSearchHeader({
  stopName,
  showStopTitle,
  statusNode,
  onSelectStop,
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
    if (!isExpanded) return

    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
    }, 40)

    return () => window.clearTimeout(timer)
  }, [isExpanded])

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
    if (!isExpanded) return
    if (locationState === 'requesting' || locationState === 'granted' || locationState === 'denied') return
    if (!supportsGeolocation) return

    const prompted = localStorage.getItem(LOCATION_PROMPTED_KEY) === 'true'
    if (prompted) return

    localStorage.setItem(LOCATION_PROMPTED_KEY, 'true')

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
  }, [isExpanded, locationState, supportsGeolocation])

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
    if (normalizedQuery) return searchResults
    return dedupeResults(nearestStops, recents)
  }, [nearestStops, query, recents, searchResults])

  function handleOpenSearch() {
    setIsExpanded(true)
    setStatusMessage('')
  }

  function handleSelect(stop: StopSearchResult) {
    setRecents((prev) => {
      const deduped = [stop, ...prev.filter((entry) => entry.code !== stop.code)]
      return deduped.slice(0, 3)
    })

    onSelectStop(stop.code)
    setIsExpanded(false)
    setQuery('')
    setStatusMessage('')
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
          {showStopTitle && stopName && (
            <span className="stop-search__title-wrap">
              <span className="stop-name">{stopName}</span>
            </span>
          )}
          {showStopTitle && !stopName && <span className="stop-search__fallback">Search stop</span>}
          {!showStopTitle && <span className="stop-search__fallback">Search stop</span>}
        </button>
      ) : (
        <div className="stop-search__input-wrap">
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
            className="stop-search__close"
            onClick={() => {
              setIsExpanded(false)
              setQuery('')
            }}
            aria-label="Close stop search"
          >
            Cancel
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
                  <span className="stop-search__result-name">{item.name}</span>
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
                  <span className="stop-search__result-name">{item.name}</span>
                  <span className="stop-search__result-meta">Stop {item.code}</span>
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
                  <span className="stop-search__result-name">{item.name}</span>
                  <span className="stop-search__result-meta">
                    {item.distanceMeters !== undefined ? formatDistance(item.distanceMeters) : `Stop ${item.code}`}
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
