import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

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
const REFRESH_INTERVAL = 30_000

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
  const [error, setError] = useState<string | null>(null)
  const [stopCode, setStopCode] = useState('')
  const navigate = useNavigate()

  const fetchBusData = useCallback(async () => {
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
    }
  }, [])

  useEffect(() => {
    fetchBusData()
    const interval = setInterval(fetchBusData, REFRESH_INTERVAL)
    return () => clearInterval(interval)
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
        <button className="refresh-btn" onClick={fetchBusData}>
          Refresh
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
