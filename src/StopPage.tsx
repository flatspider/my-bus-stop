import { useState, useEffect, useCallback, useRef } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { AUTO_REFRESH_INTERVAL_MS, MIN_REQUEST_GAP_MS, STALE_DATA_THRESHOLD_MS } from './refreshPolicy'
import type { BusRoute } from './types'
import BusCard from './components/BusCard'
import StatusDot from './components/StaleDataBanner'
import SettingsPanel from './components/SettingsPanel'
import { useSettings } from './useSettings'
import { DEFAULT_STOP_CODE, STOP_CODE_PATTERN } from './stopConfig'

export default function StopPage() {
  const { stopCode } = useParams<{ stopCode: string }>()
  const normalizedStopCode = stopCode?.trim() ?? ''
  const isValidStopCode = STOP_CODE_PATTERN.test(normalizedStopCode)
  const [stopName, setStopName] = useState('')
  const [routes, setRoutes] = useState<BusRoute[]>([])
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [nextAllowedRefreshAt, setNextAllowedRefreshAt] = useState(0)
  const [nowMs, setNowMs] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [lastFetchAtMs, setLastFetchAtMs] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const lastRequestAtRef = useRef(0)
  const inFlightRequestRef = useRef<Promise<void> | null>(null)
  const { settings, updateSetting } = useSettings()

  const fetchBusData = useCallback(async () => {
    if (!isValidStopCode) return

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
        const res = await fetch(`/api/bustime?q=${normalizedStopCode}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        setStopName(data.stopName)
        setRoutes(data.routes)
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
  }, [isValidStopCode, normalizedStopCode])

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
  const isStale = lastFetchAtMs > 0 && (nowMs - lastFetchAtMs > STALE_DATA_THRESHOLD_MS)
  const staleSeconds = lastFetchAtMs > 0 ? Math.floor((nowMs - lastFetchAtMs) / 1000) : 0

  const allCards = [
    ...withArrivals.map((r) => (
      <BusCard
        key={`${r.route}-${r.direction}`}
        data={r}
        route={r.route}
        showMinSuffix={settings.showMinSuffix}
        showRouteName={settings.showRouteName}
        showStopsAway={settings.showStopsAway}
      />
    )),
    ...noArrivals.map((r) => (
      <BusCard
        key={`${r.route}-${r.direction}`}
        data={r}
        route={r.route}
        showMinSuffix={settings.showMinSuffix}
        showRouteName={settings.showRouteName}
        showStopsAway={settings.showStopsAway}
      />
    )),
  ]
  const noData = !loading && allCards.length === 0
  const showSettingsPanel = settingsOpen || noData

  if (!isValidStopCode) {
    return <Navigate to={`/stop/${DEFAULT_STOP_CODE}`} replace />
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__left">
          <StatusDot isStale={isStale} staleSeconds={staleSeconds} />
          {settings.showStopTitle && <span className="stop-name">{stopName || `Stop ${normalizedStopCode}`}</span>}
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
          <>
            <div className="loading">Loading...</div>
            {showSettingsPanel && (
              <SettingsPanel
                inline
                onRefresh={() => void fetchBusData()}
                refreshLocked={refreshLocked}
                isRefreshing={isRefreshing}
                refreshCooldownSeconds={refreshCooldownSeconds}
                settings={settings}
                onNavigateToStop={() => setSettingsOpen(false)}
                onUpdateSetting={updateSetting}
              />
            )}
          </>
        ) : noData ? (
          <>
            <div className="loading">No bus data found for this stop</div>
            {showSettingsPanel && (
              <SettingsPanel
                inline
                onRefresh={() => void fetchBusData()}
                refreshLocked={refreshLocked}
                isRefreshing={isRefreshing}
                refreshCooldownSeconds={refreshCooldownSeconds}
                settings={settings}
                onNavigateToStop={() => setSettingsOpen(false)}
                onUpdateSetting={updateSetting}
              />
            )}
          </>
        ) : (
          <>
            {allCards[0]}
            <div className="cards__lower">
              {!settingsOpen && allCards.slice(1)}
              {showSettingsPanel && (
                <SettingsPanel
                  onRefresh={() => void fetchBusData()}
                  refreshLocked={refreshLocked}
                  isRefreshing={isRefreshing}
                  refreshCooldownSeconds={refreshCooldownSeconds}
                  settings={settings}
                  onNavigateToStop={() => setSettingsOpen(false)}
                  onUpdateSetting={updateSetting}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
