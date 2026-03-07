import { useState } from 'react'

export default function StatusDot({ isStale, staleSeconds }: { isStale: boolean; staleSeconds: number }) {
  const [expanded, setExpanded] = useState(false)
  const minutes = Math.max(1, Math.floor(staleSeconds / 60))

  if (!isStale) return null

  return (
    <button
      type="button"
      className="status-dot-wrap"
      onClick={() => setExpanded(prev => !prev)}
      aria-expanded={expanded}
      aria-label={`Data is stale. Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago.`}
    >
      <span className="status-dot status-dot--stale" />
      {expanded && (
        <span className="status-dot__label">
          Updated {minutes}m ago
        </span>
      )}
    </button>
  )
}
