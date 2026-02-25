import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { AUTO_REFRESH_INTERVAL_MS, MIN_REQUEST_GAP_MS } from './refreshPolicy'

interface BusArrival {
  minutes: string
  minutesNum: number
  stopsAway: string
  vehicleId: string
}

interface BusRoute {
  route: string
  arrivals: BusArrival[]
}

const STOP_CODE = '402854'
function parseMinutesNum(text: string): number {
  if (text.toLowerCase().includes('approaching')) return 0
  if (text.includes('<')) return 0.5
  const num = parseFloat(text)
  return isNaN(num) ? 999 : num
}

function parseStopsAway(distanceText: string): string {
  const stopsMatch = distanceText.match(/([\d<]+)\s*stops?\s*away/i)
  if (stopsMatch) return `${stopsMatch[1]} stops away`

  if (distanceText.toLowerCase().includes('approaching')) return 'Approaching'

  const milesMatch = distanceText.match(/([\d.]+)\s*miles?\s*away/i)
  if (milesMatch) {
    const miles = parseFloat(milesMatch[1])
    const stops = Math.max(1, Math.round(miles * 8))
    return `~${stops} stops away`
  }

  return distanceText
}

function parseBusData(html: string): BusRoute[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const directions = doc.querySelectorAll('.directionAtStop')
  const routes: BusRoute[] = []

  directions.forEach((dir) => {
    const headerEl = dir.querySelector('p strong')
    if (!headerEl) return

    const headerText = headerEl.textContent?.trim() ?? ''
    const match = headerText.match(/^(\S+)\s/)
    if (!match) return

    const route = match[1]

    const arrivals: BusArrival[] = []
    const ols = dir.querySelectorAll('ol')
    ols.forEach((ol) => {
      const li = ol.querySelector('li')
      if (!li) return

      const minutesEl = li.querySelector('strong')
      const minutes = minutesEl?.textContent?.trim() ?? ''

      const vehicleEl = li.querySelector('small')
      const vehicleId = vehicleEl?.textContent?.trim().replace('Vehicle ', '') ?? ''

      const fullText = li.textContent ?? ''
      const distanceMatch = fullText.match(/minutes?\s*,\s*(.+?)(?:\s*Vehicle|\s*$)/)
      const rawDistance = distanceMatch?.[1]?.trim() ?? ''

      arrivals.push({
        minutes,
        minutesNum: parseMinutesNum(minutes),
        stopsAway: parseStopsAway(rawDistance),
        vehicleId,
      })
    })

    routes.push({ route, arrivals })
  })

  return routes
}

function getRouteColor(route: string): string {
  switch (route) {
    case 'M101': return '#0039A6'
    case 'M102': return '#00933C'
    case 'M103': return '#B933AD'
    default: return '#666'
  }
}

function BusCard({ data, route }: { data: BusRoute | undefined; route: string }) {
  const color = getRouteColor(route)

  if (!data) {
    return (
      <div className="bus-card bus-card--empty">
        <div className="bus-card__header" style={{ backgroundColor: color }}>
          <span className="bus-card__route">{route}</span>
        </div>
        <div className="bus-card__body">
          <p className="bus-card__no-data">No buses en route</p>
        </div>
      </div>
    )
  }

  const closest = data.arrivals[0]
  const next = data.arrivals[1]

  return (
    <div className="bus-card">
      <div className="bus-card__header" style={{ backgroundColor: color }}>
        <span className="bus-card__route">{data.route}</span>
      </div>
      <div className="bus-card__body">
        {closest ? (
          <>
            <div className="bus-card__primary">
              <span className="bus-card__minutes">{closest.minutes}</span>
              <span className="bus-card__distance">{closest.stopsAway}</span>
            </div>
            {next && (
              <div className="bus-card__next">
                Then: {next.minutes}, {next.stopsAway}
              </div>
            )}
          </>
        ) : (
          <p className="bus-card__no-data">No buses en route</p>
        )}
      </div>
    </div>
  )
}

export default function Home() {
  const [routes, setRoutes] = useState<BusRoute[]>([])
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [nextAllowedRefreshAt, setNextAllowedRefreshAt] = useState(0)
  const [nowMs, setNowMs] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [stopCode, setStopCode] = useState('')
  const lastRequestAtRef = useRef(0)
  const inFlightRequestRef = useRef<Promise<void> | null>(null)
  const navigate = useNavigate()

  const fetchBusData = useCallback(async () => {
    if (inFlightRequestRef.current) {
      return inFlightRequestRef.current
    }

    const now = Date.now()
    if (now - lastRequestAtRef.current < MIN_REQUEST_GAP_MS) {
      return
    }

    lastRequestAtRef.current = now
    setNextAllowedRefreshAt(now + MIN_REQUEST_GAP_MS)
    setIsRefreshing(true)

    const request = (async () => {
      try {
        const res = await fetch(`/api/bustime?q=${STOP_CODE}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const html = await res.text()
        const parsed = parseBusData(html)
        setRoutes(parsed)
        setLastUpdated(new Date())
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to fetch')
      } finally {
        setLoading(false)
        setIsRefreshing(false)
      }
    })()

    inFlightRequestRef.current = request

    try {
      await request
    } finally {
      inFlightRequestRef.current = null
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)

    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    void fetchBusData()
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void fetchBusData()
    }, AUTO_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [fetchBusData])

  function handleGo() {
    const trimmed = stopCode.trim()
    if (!trimmed) return
    navigate(`/stop/${trimmed}`)
  }

  const ALL_ROUTES = ['M101', 'M102', 'M103']

  const withArrivals = routes
    .filter((r) => r.arrivals.length > 0)
    .sort((a, b) => a.arrivals[0].minutesNum - b.arrivals[0].minutesNum)

  const activeRouteNames = new Set(withArrivals.map((r) => r.route))
  const emptyRoutes = ALL_ROUTES.filter((name) => !activeRouteNames.has(name))
  const refreshCooldownSeconds = Math.max(0, Math.ceil((nextAllowedRefreshAt - nowMs) / 1000))
  const refreshLocked = isRefreshing || refreshCooldownSeconds > 0

  return (
    <div className="app">
      <header className="app-header">
        <h1>BusWatch</h1>
        <p className="stop-name">3 AV / E 23 ST — Southbound</p>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="cards">
        {loading ? (
          <div className="loading">Loading...</div>
        ) : (
          <>
            {withArrivals.map((r) => (
              <BusCard key={r.route} data={r} route={r.route} />
            ))}
            {emptyRoutes.map((name) => (
              <BusCard key={name} data={undefined} route={name} />
            ))}
          </>
        )}
      </div>

      <footer className="app-footer">
        {lastUpdated && (
          <p>Updated {lastUpdated.toLocaleTimeString()}</p>
        )}
        <button
          className="refresh-btn"
          onClick={() => void fetchBusData()}
          disabled={refreshLocked}
        >
          {isRefreshing
            ? 'Refreshing...'
            : refreshCooldownSeconds > 0
              ? `Refresh (${refreshCooldownSeconds}s)`
              : 'Refresh'}
        </button>
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault()
            handleGo()
          }}
        >
          <input
            className="search-input"
            type="text"
            inputMode="numeric"
            placeholder="Input Bus Stop No."
            value={stopCode}
            onChange={(e) => setStopCode(e.target.value)}
          />
          <button className="search-btn" type="submit">
            Go
          </button>
        </form>
      </footer>
    </div>
  )
}
