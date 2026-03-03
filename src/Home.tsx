import { useState, useEffect, useCallback, useRef } from 'react'
import { AUTO_REFRESH_INTERVAL_MS, MIN_REQUEST_GAP_MS, STALE_DATA_THRESHOLD_MS } from './refreshPolicy'
import type { BusRoute } from './types'
import BusCard from './components/BusCard'
import StatusDot from './components/StaleDataBanner'
import SettingsPanel from './components/SettingsPanel'
import Tutorial from './components/Tutorial'
import { useSettings } from './useSettings'

const STOP_CODE = '402854'
const ALL_ROUTES = ['M101', 'M102', 'M103']

export default function Home() {
  const [routes, setRoutes] = useState<BusRoute[]>([])
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [nextAllowedRefreshAt, setNextAllowedRefreshAt] = useState(0)
  const [nowMs, setNowMs] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [lastFetchAtMs, setLastFetchAtMs] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showTutorial, setShowTutorial] = useState(
    () => !localStorage.getItem('tutorialComplete')
  )
  const lastRequestAtRef = useRef(0)
  const inFlightRequestRef = useRef<Promise<void> | null>(null)
  const { settings, updateSetting } = useSettings()

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
        setLastFetchAtMs(Date.now())
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
  const isStale = lastFetchAtMs > 0 && (nowMs - lastFetchAtMs > STALE_DATA_THRESHOLD_MS)
  const staleSeconds = lastFetchAtMs > 0 ? Math.floor((nowMs - lastFetchAtMs) / 1000) : 0

  const allCards = [
    ...withArrivals.map((r) => (
      <BusCard
        key={r.route}
        data={r}
        route={r.route}
        showMinSuffix={settings.showMinSuffix}
        showRouteName={settings.showRouteName}
        showStopsAway={settings.showStopsAway}
      />
    )),
    ...emptyRoutes.map((name) => (
      <BusCard
        key={name}
        data={undefined}
        route={name}
        showMinSuffix={settings.showMinSuffix}
        showRouteName={settings.showRouteName}
        showStopsAway={settings.showStopsAway}
      />
    )),
  ]

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__left" data-tutorial="default-stop">
          <StatusDot isStale={isStale} staleSeconds={staleSeconds} />
          {settings.showStopTitle && <span className="stop-name">3 AV / E 23 ST — Southbound</span>}
        </div>
        <button className={`gear-btn${settingsOpen ? " gear-btn--active" : ""}`} onClick={() => setSettingsOpen((prev) => !prev)} aria-label="Settings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="cards">
        {loading ? (
          <div className="loading">Loading...</div>
        ) : (
          <>
            <div data-tutorial="card">
              {allCards[0]}
            </div>
            <div className="cards__lower">
              {allCards.slice(1)}
              {settingsOpen && (
                <SettingsPanel
                  onRefresh={() => void fetchBusData()}
                  refreshLocked={refreshLocked}
                  isRefreshing={isRefreshing}
                  refreshCooldownSeconds={refreshCooldownSeconds}
                  settings={settings}
                  onUpdateSetting={updateSetting}
                />
              )}
            </div>
          </>
        )}
      </div>

      {showTutorial && !loading && (
        <Tutorial
          onClose={() => {
            localStorage.setItem('tutorialComplete', 'true')
            setShowTutorial(false)
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
    </div>
  )
}
