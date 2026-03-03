import type { BusArrival } from "../types";

const ROUTE_COLORS: Record<string, string> = {
  M101: "#0039A6",
  M102: "#00933C",
  M103: "#B933AD",
};

function getRouteColor(route: string): string {
  return ROUTE_COLORS[route] ?? "#1a1a1a";
}

interface BusCardProps {
  arrival: BusArrival;
  route: string;
  showMinSuffix?: boolean;
  showRouteName?: boolean;
  showStopsAway?: boolean;
}

export default function BusCard({
  arrival,
  route,
  showMinSuffix = true,
  showRouteName = true,
  showStopsAway = false,
}: BusCardProps) {
  const color = getRouteColor(route);
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
        <span
          className={vehicleDotClassName}
          aria-label={vehicleDotLabel}
          title={vehicleDotLabel}
        />
      </div>
    </div>
  );
}
