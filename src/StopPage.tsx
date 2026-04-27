import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import StopSearchHeader from "./components/StopSearchHeader";
import { useSettings } from "./useSettings";
import { DEFAULT_STOP_CODE, STOP_CODE_PATTERN } from "./stopConfig";
import { loadRecents, saveRecents } from "./recentStopsStore";
import { shouldForceLeadCardNow } from "./urlFlags";
import type { InitialStopData } from "./initialStopData";
import { formatStopName } from "./formatStopName";

type LayoutMode = "singleHero" | "topStack" | "dense";

interface StopPageProps {
  initialData?: InitialStopData | null;
}

const SettingsPanel = lazy(() => import("./components/SettingsPanel"));
const Tutorial = lazy(() => import("./components/Tutorial"));

export default function StopPage({ initialData = null }: StopPageProps) {
  const { stopCode } = useParams<{ stopCode: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const normalizedStopCode = stopCode?.trim() ?? "";
  const forceLeadCardNow = shouldForceLeadCardNow(location.search);
  const isValidStopCode = STOP_CODE_PATTERN.test(normalizedStopCode);
  const matchedInitialData =
    initialData?.stopCode === normalizedStopCode ? initialData : null;
  const hasPartialInitialData = matchedInitialData?.isPartial ?? false;
  const [stopName, setStopName] = useState(() => matchedInitialData?.stopName ?? "");
  const [routes, setRoutes] = useState<BusRoute[]>(() => matchedInitialData?.routes ?? []);
  const [loading, setLoading] = useState(
    () => matchedInitialData === null || hasPartialInitialData,
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [nextAllowedRefreshAt, setNextAllowedRefreshAt] = useState(() =>
    matchedInitialData && !matchedInitialData.isPartial
      ? matchedInitialData.fetchedAt + MIN_REQUEST_GAP_MS
      : 0,
  );
  const [nowMs, setNowMs] = useState(Date.now());
  const [error, setError] = useState<string | null>(() => matchedInitialData?.error ?? null);
  const [lastFetchAtMs, setLastFetchAtMs] = useState(
    () => (matchedInitialData && !matchedInitialData.isPartial ? matchedInitialData.fetchedAt : 0),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const activeStopCodeRef = useRef(normalizedStopCode);
  const lastRequestAtByStopRef = useRef<Record<string, number>>({});
  const inFlightRequestRef = useRef<{
    stopCode: string;
    promise: Promise<void>;
  } | null>(null);
  const isFirstRouteRenderRef = useRef(true);
  const { settings, updateSetting } = useSettings();

  if (matchedInitialData && !matchedInitialData.isPartial) {
    lastRequestAtByStopRef.current[normalizedStopCode] = matchedInitialData.fetchedAt;
  }

  useEffect(() => {
    if (!isValidStopCode || !stopName) return;
    const recents = loadRecents();
    if (recents[0]?.code === normalizedStopCode) return;
    saveRecents([
      { code: normalizedStopCode, name: stopName },
      ...recents.filter((r) => r.code !== normalizedStopCode),
    ]);
  }, [normalizedStopCode, stopName, isValidStopCode]);

  useEffect(() => {
    activeStopCodeRef.current = normalizedStopCode;
    if (isFirstRouteRenderRef.current) {
      isFirstRouteRenderRef.current = false;
      return;
    }
    setLoading(true);
    setError(null);
  }, [normalizedStopCode]);

  const fetchBusData = useCallback(async (options?: { force?: boolean }) => {
    if (!isValidStopCode) return;

    const inFlight = inFlightRequestRef.current;
    if (inFlight && inFlight.stopCode === normalizedStopCode) {
      return inFlight.promise;
    }

    const now = Date.now();
    const lastRequestAt =
      lastRequestAtByStopRef.current[normalizedStopCode] ?? 0;
    if (!options?.force && now - lastRequestAt < MIN_REQUEST_GAP_MS) {
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
        setExpandedCardId(null);
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
    setIsHydrated(true);
    setShowTutorial(!localStorage.getItem("tutorialComplete"));
  }, []);

  useEffect(() => {
    if (!matchedInitialData || matchedInitialData.isPartial) {
      void fetchBusData();
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchBusData();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [fetchBusData, matchedInitialData]);

  const arrivalCards = useMemo(() => deriveArrivalCards(routes), [routes]);
  const { displayCards, exitingTopId, isSlidePhase } = useArrivalCardTransition(
    arrivalCards,
    true,
  );

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
  const topCardArrival =
    topCard && forceLeadCardNow
      ? { ...topCard.arrival, minutes: "now", minutesNum: 0 }
      : topCard?.arrival;

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
      void fetchBusData({ force: true });
    } else {
      navigate(targetPath);
    }
    setSettingsOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const noDataMessage = error
    ? "Unable to fetch arrivals right now."
    : "No live arrivals reported for this stop right now.";
  const formattedStopName = stopName ? formatStopName(stopName) : `Stop ${normalizedStopCode}`;

  return (
    <div className="app">
      <h1 className="sr-only">{formattedStopName} bus arrivals</h1>
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
            onSelectStop={handleStopSelect}
            onExpandedChange={setSearchExpanded}
          />
        </div>
        {!searchExpanded && (
          <div className="app-header__right">
            <button
              className={`gear-btn${settingsOpen ? " gear-btn--active" : ""}`}
              onClick={() => setSettingsOpen((prev) => !prev)}
              aria-label={settingsOpen ? "Close settings" : "Open settings"}
              aria-expanded={settingsOpen}
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

      <main className={cardsClassName}>
        {loading ? (
          <div className="loading">Loading...</div>
        ) : noData ? (
          <div className="loading">{noDataMessage}</div>
        ) : (
          <>
            {topCard && (
              <div className="cards__lead" data-tutorial="card">
                <div className={getCardShellClassName(topCard.id)}>
                  <BusCard
                    arrival={topCardArrival ?? topCard.arrival}
                    route={topCard.route}
                    direction={topCard.direction}
                    expanded={expandedCardId === topCard.id}
                    onToggleExpand={() =>
                      setExpandedCardId((prev) =>
                        prev === topCard.id ? null : topCard.id,
                      )
                    }
                    showMinSuffix={settings.showMinSuffix}
                    showRouteName={settings.showRouteName}
                    showStopsAway={settings.showStopsAway}
                    hideVehicleStatusDot={isStale}
                  />
                </div>
              </div>
            )}
            <div className="cards__list">
              {lowerCards.map((card) => (
                <div key={card.id} className={getCardShellClassName(card.id)}>
                  <BusCard
                    arrival={card.arrival}
                    route={card.route}
                    direction={card.direction}
                    expanded={expandedCardId === card.id}
                    onToggleExpand={() =>
                      setExpandedCardId((prev) =>
                        prev === card.id ? null : card.id,
                      )
                    }
                    showMinSuffix={settings.showMinSuffix}
                    showRouteName={settings.showRouteName}
                    showStopsAway={settings.showStopsAway}
                    hideVehicleStatusDot={isStale}
                  />
                </div>
              ))}
            </div>
          </>
        )}
        {showSettingsPanel && (
          <Suspense fallback={null}>
            <div className="settings-sheet-layer">
              <SettingsPanel
                onClose={() => setSettingsOpen(false)}
                onRefresh={() => void fetchBusData({ force: true })}
                refreshLocked={refreshLocked}
                isRefreshing={isRefreshing}
                refreshCooldownSeconds={refreshCooldownSeconds}
                settings={settings}
                onNavigateToStop={() => setSettingsOpen(false)}
                onUpdateSetting={updateSetting}
              />
            </div>
          </Suspense>
        )}
      </main>

      {isHydrated && showTutorial && !loading && arrivalCards.length > 0 && (
        <Suspense fallback={null}>
          <Tutorial
            onClose={() => {
              localStorage.setItem("tutorialComplete", "true");
              setShowTutorial(false);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
