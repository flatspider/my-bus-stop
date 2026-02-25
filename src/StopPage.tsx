import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'

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

const REFRESH_INTERVAL = 30_000

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
  const [error, setError] = useState<string | null>(null)

  const fetchBusData = useCallback(async () => {
    if (!stopCode) return
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
    }
  }, [stopCode])

  useEffect(() => {
    fetchBusData()
    const interval = setInterval(fetchBusData, REFRESH_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchBusData])

  // Sort: routes with arrivals first (by soonest), then routes with no arrivals
  const withArrivals = routes
    .filter((r) => r.arrivals.length > 0)
    .sort((a, b) => a.arrivals[0].minutesNum - b.arrivals[0].minutesNum)

  const noArrivals = routes.filter((r) => r.arrivals.length === 0)

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
        <button className="refresh-btn" onClick={fetchBusData}>
          Refresh
        </button>
        <button className="back-btn" onClick={() => navigate('/')}>
          Search Another Stop
        </button>
      </footer>
    </div>
  )
}
