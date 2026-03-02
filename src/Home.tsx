import { useState, useEffect, useCallback, useRef } from 'react'
import { AUTO_REFRESH_INTERVAL_MS, MIN_REQUEST_GAP_MS } from './refreshPolicy'
import type { BusRoute } from './types'
import BusCard from './components/BusCard'
import SettingsPanel from './components/SettingsPanel'

const STOP_CODE = '402854'
const ALL_ROUTES = ['M101', 'M102', 'M103']

export default function Home() {
  const [routes, setRoutes] = useState<BusRoute[]>([])
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [nextAllowedRefreshAt, setNextAllowedRefreshAt] = useState(0)
  const [nowMs, setNowMs] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const lastRequestAtRef = useRef(0)
  const inFlightRequestRef = useRef<Promise<void> | null>(null)

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
        const data = await res.json()
        setRoutes(data.routes as BusRoute[])
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
        <div className="app-header__left">
          <span className="stop-name">3 AV / E 23 ST — Southbound</span>
        </div>
        <button className="gear-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings">
          &#9881;
        </button>
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

      {settingsOpen && (
        <SettingsPanel
          onRefresh={() => void fetchBusData()}
          refreshLocked={refreshLocked}
          isRefreshing={isRefreshing}
          refreshCooldownSeconds={refreshCooldownSeconds}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
