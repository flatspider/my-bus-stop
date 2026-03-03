import { useState } from 'react'

export default function StatusDot({ isStale, staleSeconds }: { isStale: boolean; staleSeconds: number }) {
  const [expanded, setExpanded] = useState(false)
  const minutes = Math.max(1, Math.floor(staleSeconds / 60))

  return (
    <div className="status-dot-wrap" onClick={() => setExpanded(prev => !prev)}>
      <span className={`status-dot ${isStale ? 'status-dot--stale' : ''}`} />
      {expanded && (
        <span className="status-dot__label">
          {isStale ? `Updated ${minutes}m ago` : 'Live'}
        </span>
      )}
    </div>
  )
}
