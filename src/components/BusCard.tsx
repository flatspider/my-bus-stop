import { useLayoutEffect, useRef, useState } from "react";
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

export default function BusCard({
  arrival,
  route,
  showMinSuffix = true,
  showRouteName = true,
  showStopsAway = false,
  hideVehicleStatusDot = false,
}: BusCardProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const routeRef = useRef<HTMLSpanElement | null>(null);
  const minutesRef = useRef<HTMLSpanElement | null>(null);
  const inlineStopsMeasureRef = useRef<HTMLSpanElement | null>(null);
  const [showInlineStopsAway, setShowInlineStopsAway] = useState(false);
  const darkMode =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  const color = getRouteColor(route, darkMode);
  const routeName = route;
  const handleCardClick = () => {
    const mtaUrl = `https://bustime.mta.info/m/index?q=${routeName}`;
    if (window.confirm(`Open MTA page for ${routeName}?`)) {
      window.open(mtaUrl, "_blank");
    }
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

  useLayoutEffect(() => {
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

  return (
    <div className="bus-card" onClick={handleCardClick}>
      <div className="bus-card__accent" style={{ backgroundColor: color }} />
      <div className="bus-card__row">
        <div className="bus-card__primary-row" ref={rowRef}>
          {showRouteName && (
            <span className="bus-card__route" style={{ color }} ref={routeRef}>
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
                  <span className="bus-card__stops-away-label">{stopsAway.label}</span>
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
                <span className="bus-card__stops-away-label">{stopsAway.label}</span>
              </span>
            ) : (
              <span className="bus-card__stops-away bus-card__stops-away--stacked bus-card__stops-away--text-only">
                {stopsAway.label}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
