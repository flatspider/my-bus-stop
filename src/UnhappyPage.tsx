import { useState, useEffect, useCallback } from "react"
import { Link } from "react-router-dom"

interface UnhappyData {
  stopCode: string
  stopName: string
  lat: number
  lon: number
  overdueMinutes: number
  expectedHeadway: number
  relativeOverdue: number
  scheduledArrival: string
  nextScheduledArrival: string
  routes: string[]
  siriVerified: boolean
  computedAt: string
}

type PageState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "data"; data: UnhappyData; fetchedAt: number }

export default function UnhappyPage() {
  const [state, setState] = useState<PageState>({ kind: "loading" })
  const [secondsAgo, setSecondsAgo] = useState(0)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/unhappy")
      if (res.status === 404) {
        setState({ kind: "empty" })
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: UnhappyData = await res.json()
      setState({ kind: "data", data, fetchedAt: Date.now() })
      setSecondsAgo(0)
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Unknown error",
      })
    }
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 60_000)
    return () => clearInterval(id)
  }, [fetchData])

  useEffect(() => {
    const id = setInterval(() => setSecondsAgo((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div style={{
      padding: "24px",
      minHeight: "100dvh",
      display: "flex",
      flexDirection: "column",
    } as React.CSSProperties}>
      <Link to="/" style={{
        color: "var(--text-muted)",
        textDecoration: "none",
        fontSize: "13px",
        letterSpacing: "0.5px",
        textTransform: "uppercase" as const,
        marginBottom: "24px",
        display: "inline-block",
      }}>
        &larr; BusWatch
      </Link>

      <header style={{ marginBottom: "32px" }}>
        <h1 style={{
          fontSize: "15px",
          fontWeight: 700,
          letterSpacing: "2px",
          textTransform: "uppercase" as const,
          color: "var(--text-muted)",
          marginBottom: "4px",
        }}>
          NYC's Unhappiest Bus Stop
        </h1>
        <div style={{
          width: "40px",
          height: "3px",
          background: "var(--bauhaus-red)",
        }} />
      </header>

      {state.kind === "loading" && <LoadingState />}
      {state.kind === "error" && <ErrorState message={state.message} />}
      {state.kind === "empty" && <EmptyState />}
      {state.kind === "data" && (
        <>
          <HeroCard data={state.data} />
          <footer style={{
            marginTop: "auto",
            paddingTop: "24px",
            textAlign: "center",
            fontSize: "12px",
            color: "var(--text-muted)",
            letterSpacing: "0.3px",
          }}>
            Updated {secondsAgo}s ago
          </footer>
        </>
      )}
    </div>
  )
}

function HeroCard({ data }: { data: UnhappyData }) {
  return (
    <div style={{
      background: "var(--card-bg)",
      borderRadius: "12px",
      boxShadow: "var(--shadow)",
      overflow: "hidden",
    }}>
      <div style={{
        padding: "32px 24px 20px",
        textAlign: "center",
        borderBottom: "1px solid var(--border)",
      }}>
        <div style={{
          fontSize: "96px",
          fontWeight: 800,
          lineHeight: 1,
          color: "var(--bauhaus-red)",
          letterSpacing: "-4px",
          fontVariantNumeric: "tabular-nums",
        }}>
          {data.overdueMinutes}
        </div>
        <div style={{
          fontSize: "14px",
          fontWeight: 600,
          textTransform: "uppercase" as const,
          letterSpacing: "3px",
          color: "var(--text-secondary)",
          marginTop: "4px",
        }}>
          minutes overdue
        </div>
      </div>

      <div style={{ padding: "20px 24px" }}>
        <div style={{
          fontSize: "18px",
          fontWeight: 700,
          color: "var(--text)",
          lineHeight: 1.3,
          marginBottom: "12px",
        }}>
          {data.stopName}
        </div>

        <div style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "6px",
          marginBottom: "16px",
        }}>
          {data.routes.map((route) => (
            <span key={route} style={{
              display: "inline-block",
              padding: "3px 10px",
              fontSize: "12px",
              fontWeight: 700,
              letterSpacing: "0.5px",
              background: "var(--bauhaus-ink)",
              color: "var(--bauhaus-paper)",
              borderRadius: "4px",
            }}>
              {route}
            </span>
          ))}
          {data.siriVerified && (
            <span style={{
              display: "inline-block",
              padding: "3px 10px",
              fontSize: "11px",
              fontWeight: 600,
              letterSpacing: "0.5px",
              background: "var(--bauhaus-blue)",
              color: "#fff",
              borderRadius: "4px",
            }}>
              SIRI verified
            </span>
          )}
        </div>

        <div style={{
          fontSize: "13px",
          color: "var(--text-muted)",
          marginBottom: "12px",
          lineHeight: 1.6,
        }}>
          <div>Last scheduled bus: {data.scheduledArrival}</div>
          <div>Next scheduled bus: {data.nextScheduledArrival}</div>
          <div>Normally buses every {Math.round(data.expectedHeadway)} min &mdash; this stop is {data.relativeOverdue.toFixed(1)}x overdue</div>
        </div>

        <div style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          fontSize: "13px",
        }}>
          <Link to={`/stop/${data.stopCode}`} style={{
            color: "var(--bauhaus-blue)",
            textDecoration: "none",
            fontWeight: 600,
            fontSize: "13px",
          }}>
            View stop &rarr;
          </Link>
        </div>
      </div>
    </div>
  )
}

function LoadingState() {
  return (
    <div style={{
      flex: 1,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "var(--text-muted)",
      fontSize: "14px",
      letterSpacing: "0.5px",
    }}>
      Finding the unhappiest stop&hellip;
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div style={{
      background: "var(--error-bg)",
      color: "var(--error-text)",
      padding: "16px 20px",
      borderRadius: "8px",
      fontSize: "14px",
    }}>
      Something went wrong: {message}
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      color: "var(--text-muted)",
      gap: "8px",
    } as React.CSSProperties}>
      <div style={{ fontSize: "32px" }}>&#x1F3D9;</div>
      <div style={{ fontSize: "15px", fontWeight: 600 }}>No active gaps right now</div>
      <div style={{ fontSize: "13px" }}>Build the schedule index to enable this page.</div>
    </div>
  )
}
