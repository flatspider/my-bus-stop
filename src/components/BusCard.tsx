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

export default function BusCard({
  arrival,
  route,
  showMinSuffix = true,
  showRouteName = true,
  showStopsAway = false,
  hideVehicleStatusDot = false,
}: BusCardProps) {
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
  const displayMinutes =
    rawMinutes === "now"
      ? "now"
      : showMinSuffix
        ? `${rawMinutes} min`
        : rawMinutes;
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

  return (
    <div className="bus-card" onClick={handleCardClick}>
      <div className="bus-card__accent" style={{ backgroundColor: color }} />
      <div className="bus-card__row">
        {showRouteName && (
          <span className="bus-card__route" style={{ color }}>
            {routeName}
          </span>
        )}
        <span className="bus-card__minutes">{displayMinutes}</span>
        {showStopsAway && arrival.stopsAway && (
          <span className="bus-card__stops-away">{arrival.stopsAway}</span>
        )}
        {!hideVehicleStatusDot && !showStopsAway && (
          <span
            className={vehicleDotClassName}
            aria-label={vehicleDotLabel}
            title={vehicleDotLabel}
          />
        )}
      </div>
    </div>
  );
}
