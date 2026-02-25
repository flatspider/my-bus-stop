import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { AUTO_REFRESH_INTERVAL_MS, MIN_REQUEST_GAP_MS } from './refreshPolicy'

interface BusArrival {
  minutes: string
  minutesNum: number
  stopsAway: string
  vehicleId: string
}

interface BusRoute {
  route: string
  direction: string
  arrivals: BusArrival[]
}

const ROUTE_COLORS: Record<string, string> = {
  M101: '#0039A6',
  M102: '#00933C',
  M103: '#B933AD',
}

function getRouteColor(route: string): string {
  return ROUTE_COLORS[route] ?? '#1a1a1a'
}

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

function parseStopName(doc: Document): string {
  // The stop name appears after an <h3>Bus Stop:</h3> tag
  const h3s = doc.querySelectorAll('h3')
  for (const h3 of h3s) {
    if (h3.textContent?.includes('Bus Stop:')) {
      // The stop name is the next text sibling
      let node = h3.nextSibling
      while (node) {
        const text = node.textContent?.trim()
        if (text) return text
        node = node.nextSibling
      }
    }
  }
  return ''
}

function parseBusData(html: string): { stopName: string; routes: BusRoute[] } {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')

  const stopName = parseStopName(doc)
  const directions = doc.querySelectorAll('.directionAtStop')
  const routes: BusRoute[] = []

  directions.forEach((dir) => {
    const headerEl = dir.querySelector('p strong')
    if (!headerEl) return

    const headerText = headerEl.textContent?.trim() ?? ''
    // Match any route name (M101, SIM6, B63, Bx12, Q44, etc.)
    const match = headerText.match(/^(\S+)\s+(.+)/)
    if (!match) return

    const route = match[1]
    const direction = match[2]

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

    routes.push({ route, direction, arrivals })
  })

  return { stopName, routes }
}

function BusCard({ data }: { data: BusRoute }) {
  const color = getRouteColor(data.route)
  const closest = data.arrivals[0]
  const next = data.arrivals[1]

  return (
    <div className={`bus-card${data.arrivals.length === 0 ? ' bus-card--empty' : ''}`}>
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

export default function StopPage() {
  const { stopCode } = useParams<{ stopCode: string }>()
  const navigate = useNavigate()
  const [stopName, setStopName] = useState('')
  const [routes, setRoutes] = useState<BusRoute[]>([])
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [nextAllowedRefreshAt, setNextAllowedRefreshAt] = useState(0)
  const [nowMs, setNowMs] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const lastRequestAtRef = useRef(0)
  const inFlightRequestRef = useRef<Promise<void> | null>(null)

  const fetchBusData = useCallback(async () => {
    if (!stopCode) return

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
        const res = await fetch(`/api/bustime?q=${stopCode}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const html = await res.text()
        const parsed = parseBusData(html)
        setStopName(parsed.stopName)
        setRoutes(parsed.routes)
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
  }, [stopCode])

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

  // Sort: routes with arrivals first (by soonest), then routes with no arrivals
  const withArrivals = routes
    .filter((r) => r.arrivals.length > 0)
    .sort((a, b) => a.arrivals[0].minutesNum - b.arrivals[0].minutesNum)

  const noArrivals = routes.filter((r) => r.arrivals.length === 0)
  const refreshCooldownSeconds = Math.max(0, Math.ceil((nextAllowedRefreshAt - nowMs) / 1000))
  const refreshLocked = isRefreshing || refreshCooldownSeconds > 0

  return (
    <div className="app">
      <header className="app-header">
        <h1>BusWatch</h1>
        <p className="stop-name">{stopName || `Stop ${stopCode}`}</p>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="cards">
        {loading ? (
          <div className="loading">Loading...</div>
        ) : withArrivals.length === 0 && noArrivals.length === 0 ? (
          <div className="loading">No bus data found for this stop</div>
        ) : (
          <>
            {withArrivals.map((r) => (
              <BusCard key={`${r.route}-${r.direction}`} data={r} />
            ))}
            {noArrivals.map((r) => (
              <BusCard key={`${r.route}-${r.direction}`} data={r} />
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
        <button className="back-btn" onClick={() => navigate('/')}>
          Search Another Stop
        </button>
      </footer>
    </div>
  )
}
