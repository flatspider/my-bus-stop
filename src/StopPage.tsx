import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
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
import StopSearchHeader from "./components/StopSearchHeader";
import { SETTINGS_CLOSE_HINT_DELAY_MS } from "./settingsHints";
import { fetchStopMiniMap } from "./stopSearchApi";
import { useSettings } from "./useSettings";
import { DEFAULT_STOP_CODE, STOP_CODE_PATTERN } from "./stopConfig";
import type { StopMiniMapResponse } from "./types";
import { isMiniMapUrlEnabled } from "./urlFlags";

type LayoutMode = "singleHero" | "topStack" | "dense";
type ReadyMiniMap = Extract<StopMiniMapResponse, { status: "ready" }>;

function isSupportedMiniMapLayout(layoutVersion: string): layoutVersion is "v2" | "v3" {
  return layoutVersion === "v2" || layoutVersion === "v3";
}

export default function StopPage() {
  const { stopCode } = useParams<{ stopCode: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const normalizedStopCode = stopCode?.trim() ?? "";
  const miniMapUrlEnabled = isMiniMapUrlEnabled(location.search);
  const isValidStopCode = STOP_CODE_PATTERN.test(normalizedStopCode);
  const [stopName, setStopName] = useState("");
  const [routes, setRoutes] = useState<BusRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [nextAllowedRefreshAt, setNextAllowedRefreshAt] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAtMs, setLastFetchAtMs] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showCloseHint, setShowCloseHint] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [miniMapLoading, setMiniMapLoading] = useState(false);
  const [miniMap, setMiniMap] = useState<StopMiniMapResponse | null>(null);
  const [showTutorial, setShowTutorial] = useState(
    () => !localStorage.getItem("tutorialComplete"),
  );
  const [tutorialStep, setTutorialStep] = useState(0);
  const activeStopCodeRef = useRef(normalizedStopCode);
  const lastRequestAtByStopRef = useRef<Record<string, number>>({});
  const readyMiniMapByStopRef = useRef<Record<string, ReadyMiniMap>>({});
  const inFlightRequestRef = useRef<{
    stopCode: string;
    promise: Promise<void>;
  } | null>(null);
  const { settings, updateSetting } = useSettings();

  useEffect(() => {
    activeStopCodeRef.current = normalizedStopCode;
    setLoading(true);
    setError(null);
  }, [normalizedStopCode]);

  const fetchBusData = useCallback(async () => {
    if (!isValidStopCode) return;

    const inFlight = inFlightRequestRef.current;
    if (inFlight && inFlight.stopCode === normalizedStopCode) {
      return inFlight.promise;
    }

    const now = Date.now();
    const lastRequestAt =
      lastRequestAtByStopRef.current[normalizedStopCode] ?? 0;
    if (now - lastRequestAt < MIN_REQUEST_GAP_MS) {
      return;
    }

    lastRequestAtByStopRef.current[normalizedStopCode] = now;
    setNextAllowedRefreshAt(now + MIN_REQUEST_GAP_MS);
    setIsRefreshing(true);

    const requestStopCode = normalizedStopCode;
    const request = (async () => {
      try {
        const res = await fetch(`/api/bustime?q=${requestStopCode}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (activeStopCodeRef.current !== requestStopCode) return;
        setStopName(data.stopName);
        setRoutes(data.routes);
        setLastFetchAtMs(Date.now());
        setError(null);
      } catch (e) {
        if (activeStopCodeRef.current !== requestStopCode) return;
        setError(e instanceof Error ? e.message : "Failed to fetch");
      } finally {
        if (activeStopCodeRef.current === requestStopCode) {
          setLoading(false);
          setIsRefreshing(false);
        }
      }
    })();

    inFlightRequestRef.current = {
      stopCode: requestStopCode,
      promise: request,
    };

    try {
      await request;
    } finally {
      const current = inFlightRequestRef.current;
      if (current && current.stopCode === requestStopCode) {
        inFlightRequestRef.current = null;
      }
    }
  }, [isValidStopCode, normalizedStopCode]);

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

  useEffect(() => {
    if (miniMap?.status === "ready") {
      readyMiniMapByStopRef.current[miniMap.code] = miniMap;
    }
  }, [miniMap]);

  useEffect(() => {
    if (!miniMapUrlEnabled || !settings.miniMapBeta || !isValidStopCode) {
      setMiniMapLoading(false);
      setMiniMap(null);
      return;
    }

    const controller = new AbortController();
    setMiniMapLoading(true);
    setMiniMap((prev) => {
      if (
        prev?.status === "ready" &&
        prev.code === normalizedStopCode &&
        isSupportedMiniMapLayout(prev.layoutVersion)
      ) {
        return prev;
      }
      return null;
    });

    void fetchStopMiniMap(normalizedStopCode, controller.signal)
      .then((payload) => {
        if (!controller.signal.aborted) {
          if (payload.status === "ready") {
            setMiniMap(payload);
            return;
          }

          setMiniMap((prev) => {
            if (
              prev?.status === "ready" &&
              prev.code === normalizedStopCode &&
              isSupportedMiniMapLayout(prev.layoutVersion)
            ) {
              return prev;
            }
            return payload;
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMiniMap((prev) => {
            if (
              prev?.status === "ready" &&
              prev.code === normalizedStopCode &&
              isSupportedMiniMapLayout(prev.layoutVersion)
            ) {
              return prev;
            }
            return {
              status: "unavailable",
              code: normalizedStopCode,
              reason: "error",
            };
          });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setMiniMapLoading(false);
        }
      });

    return () => controller.abort();
  }, [isValidStopCode, miniMapUrlEnabled, normalizedStopCode, settings.miniMapBeta]);

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

  const busCount = arrivalCards.length;
  const layoutMode: LayoutMode =
    busCount === 1 ? "singleHero" : busCount >= 4 ? "dense" : "topStack";
  const noData = !loading && busCount === 0;
  const isErrorEmptyState = noData && Boolean(error);
  const showSettingsPanel = settingsOpen;
  const topCard = displayCards[0];
  const lowerCards = displayCards.slice(1);
  const resolvedMiniMap =
    miniMap?.status === "ready"
      ? miniMap
      : readyMiniMapByStopRef.current[normalizedStopCode] ?? miniMap;

  const cardsClassName = [
    "cards",
    `cards--${layoutMode}`,
    isSlidePhase ? "cards--slide-phase" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const getCardShellClassName = (cardId: string) =>
    [
      "bus-card-shell",
      exitingTopId === cardId ? "bus-card-shell--exiting-top" : "",
    ]
      .filter(Boolean)
      .join(" ");

  if (!isValidStopCode) {
    return <Navigate to={`/stop/${DEFAULT_STOP_CODE}`} replace />;
  }

  function handleStopSelect(nextStopCode: string) {
    const targetPath = `/stop/${nextStopCode}`;
    if (normalizedStopCode === nextStopCode) {
      void fetchBusData();
    } else {
      navigate(targetPath);
    }
    setSettingsOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const noDataMessage = error
    ? "Unable to fetch arrivals right now."
    : "No live arrivals reported for this stop right now.";
  const tutorialHighlightsStopInput = showTutorial && tutorialStep === 2;
  const shouldShowMiniMap =
    miniMapUrlEnabled &&
    settings.miniMapBeta &&
    (miniMapLoading || resolvedMiniMap?.status === "ready");

  return (
    <div className="app">
      <header
        className={`app-header${searchExpanded ? " app-header--search-active" : ""}`}
      >
        <div className="app-header__left">
          <StopSearchHeader
            statusNode={
              <StatusDot
                isStale={isStale && !isErrorEmptyState}
                staleSeconds={staleSeconds}
              />
            }
            stopName={stopName}
            showStopTitle={settings.showStopTitle}
            showMiniMap={shouldShowMiniMap}
            miniMapLoading={miniMapLoading}
            miniMap={resolvedMiniMap}
            onSelectStop={handleStopSelect}
            onExpandedChange={setSearchExpanded}
          />
        </div>
        {!searchExpanded && (
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
              data-tutorial="settings-gear"
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
        )}
      </header>

      {error && !noData && <div className="error">{error}</div>}

      <div className={cardsClassName}>
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
                showMiniMapToggle={miniMapUrlEnabled}
                settings={settings}
                tutorialHighlightsStopInput={tutorialHighlightsStopInput}
                onNavigateToStop={() => setSettingsOpen(false)}
                onUpdateSetting={updateSetting}
              />
            )}
          </>
        ) : noData ? (
          <>
            <div className="loading">{noDataMessage}</div>
            {showSettingsPanel && (
              <SettingsPanel
                inline
                onRefresh={() => void fetchBusData()}
                refreshLocked={refreshLocked}
                isRefreshing={isRefreshing}
                refreshCooldownSeconds={refreshCooldownSeconds}
                showMiniMapToggle={miniMapUrlEnabled}
                settings={settings}
                tutorialHighlightsStopInput={tutorialHighlightsStopInput}
                onNavigateToStop={() => setSettingsOpen(false)}
                onUpdateSetting={updateSetting}
              />
            )}
          </>
        ) : (
          <>
            {topCard && (
              <div className="cards__lead" data-tutorial="card">
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
            <div className="cards__list">
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
              {showSettingsPanel && (
                <>
                  <SettingsPanel
                    inline
                    onRefresh={() => void fetchBusData()}
                    refreshLocked={refreshLocked}
                    isRefreshing={isRefreshing}
                    refreshCooldownSeconds={refreshCooldownSeconds}
                    showMiniMapToggle={miniMapUrlEnabled}
                    settings={settings}
                    tutorialHighlightsStopInput={tutorialHighlightsStopInput}
                    onNavigateToStop={() => setSettingsOpen(false)}
                    onUpdateSetting={updateSetting}
                  />
                  {hasHiddenCards && (
                    <p
                      className="settings-hidden-cue"
                      role="status"
                      aria-live="polite"
                    >
                      Additional buses hidden while settings is open.
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
            setTutorialStep(0);
            setSettingsOpen(false);
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          onStepChange={setTutorialStep}
        />
      )}
    </div>
  );
}
