import type { BusRoute } from '../types'

const ROUTE_COLORS: Record<string, string> = {
  M101: '#0039A6',
  M102: '#00933C',
  M103: '#B933AD',
}

function getRouteColor(route: string): string {
  return ROUTE_COLORS[route] ?? '#1a1a1a'
}

export default function BusCard({ data, route }: { data: BusRoute | undefined; route: string }) {
  const color = getRouteColor(route)
  const routeName = data?.route ?? route

  const handleCardClick = () => {
    const mtaUrl = `https://bustime.mta.info/m/index?q=${routeName}`
    if (window.confirm(`Open MTA page for ${routeName}?`)) {
      window.open(mtaUrl, '_blank')
    }
  }

  const closest = data?.arrivals[0]
  const next = data?.arrivals[1]
  const gapMinutes = (closest && next) ? next.minutesNum - closest.minutesNum : null

  if (!data || !closest) {
    return (
      <div className="bus-card bus-card--empty" onClick={handleCardClick}>
        <div className="bus-card__accent" style={{ backgroundColor: color }} />
        <div className="bus-card__row">
          <span className="bus-card__route" style={{ color }}>{routeName}</span>
          <span className="bus-card__no-data">No buses en route</span>
        </div>
      </div>
    )
  }

  return (
    <div className="bus-card" onClick={handleCardClick}>
      <div className="bus-card__accent" style={{ backgroundColor: color }} />
      <div className="bus-card__row">
        <span className="bus-card__route" style={{ color }}>{routeName}</span>
        <span className="bus-card__minutes">{closest.minutes.replace(/\s*minutes?/, '')}</span>
        {gapMinutes != null && gapMinutes > 0 && (
          <span className="bus-card__next-gap">+{gapMinutes} min</span>
        )}
      </div>
    </div>
  )
}
