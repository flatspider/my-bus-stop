import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  AUTO_REFRESH_INTERVAL_MS,
  MIN_REQUEST_GAP_MS,
  STALE_DATA_THRESHOLD_MS,
} from "./refreshPolicy";
import type { BusRoute } from "./types";
import { deriveArrivalCards } from "./arrivalCards";
import { useArrivalCardTransition } from "./useArrivalCardTransition";
import BusCard from "./components/BusCard";
import StatusDot from "./components/StaleDataBanner";
import SettingsPanel from "./components/SettingsPanel";
import Tutorial from "./components/Tutorial";
import { SETTINGS_CLOSE_HINT_DELAY_MS } from "./settingsHints";
import { useSettings } from "./useSettings";

const STOP_CODE = "402854";

export default function Home() {
  const [routes, setRoutes] = useState<BusRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [nextAllowedRefreshAt, setNextAllowedRefreshAt] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAtMs, setLastFetchAtMs] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showCloseHint, setShowCloseHint] = useState(false);
  const [showTutorial, setShowTutorial] = useState(
    () => !localStorage.getItem("tutorialComplete"),
  );
  const lastRequestAtRef = useRef(0);
  const inFlightRequestRef = useRef<Promise<void> | null>(null);
  const { settings, updateSetting } = useSettings();

  const fetchBusData = useCallback(async () => {
    if (inFlightRequestRef.current) {
      return inFlightRequestRef.current;
    }

    const now = Date.now();
    if (now - lastRequestAtRef.current < MIN_REQUEST_GAP_MS) {
      return;
    }

    lastRequestAtRef.current = now;
    setNextAllowedRefreshAt(now + MIN_REQUEST_GAP_MS);
    setIsRefreshing(true);

    const request = (async () => {
      try {
        const res = await fetch(`/api/bustime?q=${STOP_CODE}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setRoutes(data.routes as BusRoute[]);
        setLastFetchAtMs(Date.now());
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to fetch");
      } finally {
        setLoading(false);
        setIsRefreshing(false);
      }
    })();

    inFlightRequestRef.current = request;

    try {
      await request;
    } finally {
      inFlightRequestRef.current = null;
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void fetchBusData();
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchBusData();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [fetchBusData]);

  const arrivalCards = useMemo(() => deriveArrivalCards(routes), [routes]);
  const { displayCards, exitingTopId, isSlidePhase } = useArrivalCardTransition(
    arrivalCards,
    !settingsOpen,
  );
  const hasHiddenCards = settingsOpen && arrivalCards.length > 1;

  useEffect(() => {
    if (!hasHiddenCards) {
      setShowCloseHint(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowCloseHint(true);
    }, SETTINGS_CLOSE_HINT_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [hasHiddenCards]);

  const refreshCooldownSeconds = Math.max(
    0,
    Math.ceil((nextAllowedRefreshAt - nowMs) / 1000),
  );
  const refreshLocked = isRefreshing || refreshCooldownSeconds > 0;
  const isStale =
    lastFetchAtMs > 0 && nowMs - lastFetchAtMs > STALE_DATA_THRESHOLD_MS;
  const staleSeconds =
    lastFetchAtMs > 0 ? Math.floor((nowMs - lastFetchAtMs) / 1000) : 0;

  const noData = !loading && arrivalCards.length === 0;
  const isErrorEmptyState = noData && Boolean(error);
  const topCard = displayCards[0];
  const lowerCards = displayCards.slice(1);
  const noDataMessage = error
    ? "Unable to fetch arrivals right now."
    : "No buses currently en route";

  const cardsClassName = ["cards", isSlidePhase ? "cards--slide-phase" : ""]
    .filter(Boolean)
    .join(" ");

  const getCardShellClassName = (cardId: string) =>
    [
      "bus-card-shell",
      exitingTopId === cardId ? "bus-card-shell--exiting-top" : "",
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__left" data-tutorial="default-stop">
          <StatusDot
            isStale={isStale && !isErrorEmptyState}
            staleSeconds={staleSeconds}
          />
          {settings.showStopTitle && (
            <span className="stop-name">3 AV / E 23 ST — Southbound</span>
          )}
        </div>
        <div className="app-header__right">
          {showCloseHint && (
            <span
              className="settings-close-hint"
              role="status"
              aria-live="polite"
            >
              Click to close
            </span>
          )}
          <button
            className={`gear-btn${settingsOpen ? " gear-btn--active" : ""}`}
            onClick={() => setSettingsOpen((prev) => !prev)}
            aria-label="Settings"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      {error && !noData && <div className="error">{error}</div>}

      <div className={cardsClassName}>
        {loading ? (
          <div className="loading">Loading...</div>
        ) : noData ? (
          <>
            <div className="loading">{noDataMessage}</div>
            {settingsOpen && (
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
          </>
        ) : (
          <>
            {topCard && (
              <div data-tutorial="card">
                <div className={getCardShellClassName(topCard.id)}>
                  <BusCard
                    arrival={topCard.arrival}
                    route={topCard.route}
                    showMinSuffix={settings.showMinSuffix}
                    showRouteName={settings.showRouteName}
                    showStopsAway={settings.showStopsAway}
                    hideVehicleStatusDot={isStale}
                  />
                </div>
              </div>
            )}
            <div className="cards__lower">
              {!settingsOpen &&
                lowerCards.map((card) => (
                  <div key={card.id} className={getCardShellClassName(card.id)}>
                    <BusCard
                      arrival={card.arrival}
                      route={card.route}
                      showMinSuffix={settings.showMinSuffix}
                      showRouteName={settings.showRouteName}
                      showStopsAway={settings.showStopsAway}
                      hideVehicleStatusDot={isStale}
                    />
                  </div>
                ))}
              {settingsOpen && (
                <>
                  <SettingsPanel
                    onRefresh={() => void fetchBusData()}
                    refreshLocked={refreshLocked}
                    isRefreshing={isRefreshing}
                    refreshCooldownSeconds={refreshCooldownSeconds}
                    settings={settings}
                    onNavigateToStop={() => setSettingsOpen(false)}
                    onUpdateSetting={updateSetting}
                  />
                  {hasHiddenCards && (
                    <p
                      className="settings-hidden-cue"
                      role="status"
                      aria-live="polite"
                    >
                      More arrivals hidden while settings is open
                    </p>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {showTutorial && !loading && arrivalCards.length > 0 && (
        <Tutorial
          onClose={() => {
            localStorage.setItem("tutorialComplete", "true");
            setShowTutorial(false);
            setSettingsOpen(false);
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
    </div>
  );
}
