import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { AUTO_REFRESH_INTERVAL_MS, MIN_REQUEST_GAP_MS } from './refreshPolicy'
import type { BusRoute } from './types'
import BusCard from './components/BusCard'
import SettingsPanel from './components/SettingsPanel'

export default function StopPage() {
  const { stopCode } = useParams<{ stopCode: string }>()
  const navigate = useNavigate()
  const [stopName, setStopName] = useState('')
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
        const data = await res.json()
        setStopName(data.stopName)
        setRoutes(data.routes)
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

  const withArrivals = routes
    .filter((r) => r.arrivals.length > 0)
    .sort((a, b) => a.arrivals[0].minutesNum - b.arrivals[0].minutesNum)

  const noArrivals = routes.filter((r) => r.arrivals.length === 0)
  const refreshCooldownSeconds = Math.max(0, Math.ceil((nextAllowedRefreshAt - nowMs) / 1000))
  const refreshLocked = isRefreshing || refreshCooldownSeconds > 0

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__left">
          <button className="back-arrow" onClick={() => navigate('/')} aria-label="Back">
            &larr;
          </button>
          <span className="stop-name">{stopName || `Stop ${stopCode}`}</span>
        </div>
        <button className="gear-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings">
          &#9881;
        </button>
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
              <BusCard key={`${r.route}-${r.direction}`} data={r} route={r.route} />
            ))}
            {noArrivals.map((r) => (
              <BusCard key={`${r.route}-${r.direction}`} data={r} route={r.route} />
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
