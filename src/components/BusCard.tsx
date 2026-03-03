import type { BusRoute } from "../types";

const ROUTE_COLORS: Record<string, string> = {
  M101: "#0039A6",
  M102: "#00933C",
  M103: "#B933AD",
};

function getRouteColor(route: string): string {
  return ROUTE_COLORS[route] ?? "#1a1a1a";
}

interface BusCardProps {
  data: BusRoute | undefined;
  route: string;
  showMinSuffix?: boolean;
  showRouteName?: boolean;
  showStopsAway?: boolean;
}

export default function BusCard({
  data,
  route,
  showMinSuffix = true,
  showRouteName = true,
  showStopsAway = false,
}: BusCardProps) {
  const color = getRouteColor(route);
  const routeName = data?.route ?? route;

  const handleCardClick = () => {
    const mtaUrl = `https://bustime.mta.info/m/index?q=${routeName}`;
    if (window.confirm(`Open MTA page for ${routeName}?`)) {
      window.open(mtaUrl, "_blank");
    }
  };

  const closest = data?.arrivals[0];
  const next = data?.arrivals[1];
  const gapMinutes =
    closest && next ? next.minutesNum - closest.minutesNum : null;

  if (!data || !closest) {
    return (
      <div className="bus-card bus-card--empty" onClick={handleCardClick}>
        <div className="bus-card__accent" style={{ backgroundColor: color }} />
        <div className="bus-card__row">
          {showRouteName && (
            <span className="bus-card__route" style={{ color }}>
              {routeName}
            </span>
          )}
          <span className="bus-card__no-data">No buses en route</span>
        </div>
      </div>
    );
  }

  const rawMinutes = closest.minutes
    .replace(/\s*minutes?/, "")
    .replace(/approaching/i, "now");
  const displayMinutes =
    rawMinutes === "now"
      ? "now"
      : showMinSuffix
        ? `${rawMinutes} min`
        : rawMinutes;
  const nextGapValue = gapMinutes != null && gapMinutes > 0 ? `+${gapMinutes} min` : null;

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
        {showStopsAway && closest.stopsAway && (
          <span className="bus-card__stops-away">{closest.stopsAway}</span>
        )}
        {nextGapValue && (
          <span className="bus-card__next-gap">
            <span className="bus-card__next-gap-label">next bus</span>
            <span className="bus-card__next-gap-value">{nextGapValue}</span>
          </span>
        )}
      </div>
    </div>
  );
}
