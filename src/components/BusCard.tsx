import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BusArrival } from "../types";

const ROUTE_COLORS: Record<string, string> = {
  M101: "#0039A6",
  M102: "#00933C",
  M103: "#B933AD",
};

const ROUTE_COLORS_DARK: Record<string, string> = {
  M101: "#5EA2FF",
  M102: "#4AD97F",
  M103: "#E36BDA",
};

function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = hex.trim();
  const match = normalized.match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;
  const value = match[1];
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function channelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

function contrastRatio(foregroundHex: string, backgroundHex: string): number {
  const fg = hexToRgb(foregroundHex);
  const bg = hexToRgb(backgroundHex);
  if (!fg || !bg) return 1;
  const fgLum = relativeLuminance(fg);
  const bgLum = relativeLuminance(bg);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  return (lighter + 0.05) / (darker + 0.05);
}

function getRouteColor(route: string, darkMode: boolean): string {
  const fallback = darkMode ? "#e5e5e5" : "#1a1a1a";
  const routePalette = darkMode ? ROUTE_COLORS_DARK : ROUTE_COLORS;
  const routeColor = routePalette[route] ?? fallback;
  const background = darkMode ? "#1e1e1e" : "#ffffff";
  const minContrast = darkMode ? 4.5 : 3;
  return contrastRatio(routeColor, background) >= minContrast
    ? routeColor
    : fallback;
}

interface BusCardProps {
  arrival: BusArrival;
  route: string;
  direction?: string;
  expanded?: boolean;
  onToggleExpand?: () => void;
  showMinSuffix?: boolean;
  showRouteName?: boolean;
  showStopsAway?: boolean;
  hideVehicleStatusDot?: boolean;
}

function splitStopsAwayLabel(stopsAway: string): {
  count: string | null;
  label: string;
} {
  const trimmed = stopsAway.trim();
  const match = trimmed.match(/^(\d+)\s+(stop)(s)?(?:\s+away)?$/i);
  if (!match) {
    return {
      count: null,
      label: trimmed,
    };
  }

  return {
    count: match[1],
    label: `${match[2].toLowerCase()}${match[3] ?? ""}`,
  };
}

function buildCardLabel(
  route: string,
  minutes: string,
  stopsAway: string,
  vehicleDotLabel: string,
): string {
  const parts = [`Route ${route}`, `arrives in ${minutes}`];
  if (stopsAway) {
    parts.push(stopsAway);
  } else {
    parts.push(vehicleDotLabel);
  }
  parts.push("Tap for details");
  return parts.join(". ");
}

export default function BusCard({
  arrival,
  route,
  direction,
  expanded = false,
  onToggleExpand,
  showMinSuffix = true,
  showRouteName = true,
  showStopsAway = false,
  hideVehicleStatusDot = false,
}: BusCardProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const routeRef = useRef<HTMLSpanElement | null>(null);
  const minutesRef = useRef<HTMLSpanElement | null>(null);
  const inlineStopsMeasureRef = useRef<HTMLSpanElement | null>(null);
  const detailRouteRef = useRef<HTMLSpanElement | null>(null);
  const detailMeasureRef = useRef<HTMLSpanElement | null>(null);
  const [showInlineStopsAway, setShowInlineStopsAway] = useState(false);
  const [showRouteInDetail, setShowRouteInDetail] = useState(false);
  const [slideFrom, setSlideFrom] = useState<number | null>(null);
  const prevExpanded = useRef(expanded);
  const darkMode =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  const color = getRouteColor(route, darkMode);
  const routeName = route;
  const handleCardClick = () => {
    onToggleExpand?.();
  };

  const rawMinutes = arrival.minutes
    .replace(/\s*minutes?/, "")
    .replace(/approaching/i, "now");
  const showNowLabel = rawMinutes === "now";
  const stopsAway = splitStopsAwayLabel(arrival.stopsAway);
  const isApproaching =
    arrival.minutesNum === 0 || /approaching/i.test(arrival.minutes);
  const hasLiveVehicle = arrival.vehicleId.trim().length > 0;
  const vehicleDotClassName = [
    "bus-card__vehicle-dot",
    isApproaching
      ? "bus-card__vehicle-dot--approaching"
      : hasLiveVehicle
        ? "bus-card__vehicle-dot--live"
        : "bus-card__vehicle-dot--fallback",
  ].join(" ");
  const vehicleDotLabel = isApproaching
    ? "Approaching"
    : hasLiveVehicle
      ? "Live vehicle"
      : "Schedule fallback";
  const cardLabel = buildCardLabel(
    routeName,
    showNowLabel ? "now" : `${rawMinutes} minutes`,
    arrival.stopsAway,
    vehicleDotLabel,
  );

  useEffect(() => {
    if (!showStopsAway || !arrival.stopsAway) {
      return;
    }

    const measureInlineFit = () => {
      const row = rowRef.current;
      const minutes = minutesRef.current;
      const inlineStopsMeasure = inlineStopsMeasureRef.current;
      if (!row || !minutes || !inlineStopsMeasure) return;

      const routeWidth = showRouteName ? (routeRef.current?.scrollWidth ?? 0) : 0;
      const minutesChildren = Array.from(minutes.children) as HTMLElement[];
      const minutesWidth = minutesChildren.reduce((sum, child) => sum + child.scrollWidth, 0)
        + Math.max(0, minutesChildren.length - 1) * (Number.parseFloat(getComputedStyle(minutes).gap || "0") || 0);
      const stopsWidth = inlineStopsMeasure.scrollWidth;
      const gapStyle = getComputedStyle(row);
      const gap =
        Number.parseFloat(gapStyle.columnGap || gapStyle.gap || "0") || 0;
      const visibleItems = (showRouteName ? 1 : 0) + 1 + 1;
      const totalNeededWidth =
        routeWidth + minutesWidth + stopsWidth + gap * (visibleItems - 1);

      setShowInlineStopsAway(totalNeededWidth <= row.clientWidth);
    };

    measureInlineFit();

    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measureInlineFit);
      return () => window.removeEventListener("resize", measureInlineFit);
    }

    const observer = new ResizeObserver(measureInlineFit);
    observer.observe(row);
    return () => observer.disconnect();
  }, [
    arrival.minutes,
    arrival.stopsAway,
    showMinSuffix,
    showRouteName,
    showStopsAway,
  ]);

  // Measure whether "M101 → direction" fits on one line in the detail row
  useEffect(() => {
    if (!direction || !showRouteName) {
      setShowRouteInDetail(false);
      return;
    }

    const measure = () => {
      const el = detailMeasureRef.current;
      if (!el) return;
      const parent = el.closest(".bus-card__detail-inner") as HTMLElement | null;
      if (!parent) return;
      const availableWidth = parent.clientWidth;
      setShowRouteInDetail(el.scrollWidth <= availableWidth);
    };

    measure();

    const parent = detailMeasureRef.current?.closest(".bus-card__detail-inner") as HTMLElement | null;
    if (!parent || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [direction, showRouteName, route]);

  // FLIP: calculate vertical delta when expanding
  useLayoutEffect(() => {
    const justExpanded = expanded && !prevExpanded.current;
    const justCollapsed = !expanded && prevExpanded.current;
    prevExpanded.current = expanded;

    if (justExpanded && showRouteInDetail) {
      const primaryRect = routeRef.current?.getBoundingClientRect();
      const detailRect = detailRouteRef.current?.getBoundingClientRect();
      if (primaryRect && detailRect) {
        setSlideFrom(primaryRect.top - detailRect.top);
      }
    }

    if (justCollapsed) {
      setSlideFrom(null);
    }
  }, [expanded, showRouteInDetail]);

  // After slideFrom is set, clear it in the next frame to trigger the transition
  useEffect(() => {
    if (slideFrom === null) return;
    const raf = requestAnimationFrame(() => {
      setSlideFrom(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [slideFrom]);

  return (
    <button
      type="button"
      className="bus-card bus-card--action"
      onClick={handleCardClick}
      aria-label={cardLabel}
      aria-expanded={direction ? expanded : undefined}
    >
      <div className="bus-card__accent" style={{ backgroundColor: color }} />
      <div className="bus-card__row">
        <div className="bus-card__primary-row" ref={rowRef}>
          {showRouteName && (
            <span
              className={`bus-card__route${expanded && showRouteInDetail ? " bus-card__route--hidden" : ""}`}
              style={{ color }}
              ref={routeRef}
            >
              {routeName}
            </span>
          )}
          <span
            className={`bus-card__minutes${showNowLabel ? " bus-card__minutes--now" : ""}`}
            ref={minutesRef}
          >
            <span className="bus-card__minutes-value">{rawMinutes}</span>
            {!showNowLabel && showMinSuffix && (
              <span className="bus-card__minutes-suffix">min</span>
            )}
          </span>
          {showStopsAway && arrival.stopsAway && showInlineStopsAway && (
            <span className="bus-card__stops-away bus-card__stops-away--inline" aria-label={arrival.stopsAway}>
              {stopsAway.count ? (
                <>
                  <span className="bus-card__stops-away-count">{stopsAway.count}</span>
                  <span className="bus-card__stops-away-label">
                    {stopsAway.label}
                    <span className={`bus-card__stops-away-suffix${expanded ? " bus-card__stops-away-suffix--show" : ""}`}> away</span>
                  </span>
                </>
              ) : (
                <span className="bus-card__stops-away-label">{stopsAway.label}</span>
              )}
            </span>
          )}
          {!hideVehicleStatusDot && !showStopsAway && (
            <span
              className={vehicleDotClassName}
              aria-label={vehicleDotLabel}
              title={vehicleDotLabel}
            />
          )}
          {showStopsAway && arrival.stopsAway && (
            <span
              aria-hidden="true"
              className="bus-card__stops-away bus-card__stops-away--inline bus-card__stops-away--measure"
              ref={inlineStopsMeasureRef}
            >
              {stopsAway.count ? (
                <>
                  <span className="bus-card__stops-away-count">{stopsAway.count}</span>
                  <span className="bus-card__stops-away-label">{stopsAway.label}</span>
                </>
              ) : (
                <span className="bus-card__stops-away-label">{stopsAway.label}</span>
              )}
            </span>
          )}
        </div>
        {showStopsAway && arrival.stopsAway && !showInlineStopsAway && (
          <div
            className={`bus-card__meta-row${showRouteName ? "" : " bus-card__meta-row--no-route"}`}
          >
            {stopsAway.count ? (
              <span className="bus-card__stops-away bus-card__stops-away--stacked" aria-label={arrival.stopsAway}>
                <span className="bus-card__stops-away-count">{stopsAway.count}</span>
                <span className="bus-card__stops-away-label">
                  {stopsAway.label}
                  <span className={`bus-card__stops-away-suffix${expanded ? " bus-card__stops-away-suffix--show" : ""}`}> away</span>
                </span>
              </span>
            ) : (
              <span className="bus-card__stops-away bus-card__stops-away--stacked bus-card__stops-away--text-only">
                {stopsAway.label}
              </span>
            )}
          </div>
        )}
      </div>
      {direction && (
        <div
          className={`bus-card__detail-row${expanded ? " bus-card__detail-row--open" : ""}`}
          aria-hidden={!expanded}
        >
          <div className="bus-card__detail-inner">
            {showRouteInDetail && (
              <span
                className="bus-card__detail-route"
                style={{
                  color,
                  transform: slideFrom !== null ? `translateY(${slideFrom}px)` : undefined,
                }}
                ref={detailRouteRef}
                aria-hidden="true"
              >
                {routeName}
              </span>
            )}
            <span className="bus-card__direction">
              {!showRouteInDetail && "→ "}{direction}
            </span>
            {/* Hidden measurement span */}
            <span
              className="bus-card__detail-measure"
              aria-hidden="true"
              ref={detailMeasureRef}
            >
              {routeName} → {direction}
            </span>
          </div>
        </div>
      )}
    </button>
  );
}
