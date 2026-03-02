import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

interface SettingsPanelProps {
  onRefresh: () => void
  refreshLocked: boolean
  isRefreshing: boolean
  refreshCooldownSeconds: number
  onClose: () => void
}

export default function SettingsPanel({
  onRefresh,
  refreshLocked,
  isRefreshing,
  refreshCooldownSeconds,
  onClose,
}: SettingsPanelProps) {
  const [stopCode, setStopCode] = useState('')
  const navigate = useNavigate()

  function handleGo() {
    const trimmed = stopCode.trim()
    if (!trimmed) return
    onClose()
    navigate(`/stop/${trimmed}`)
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <button className="settings-panel__close" onClick={onClose}>
          &times;
        </button>

        <form
          className="settings-panel__form"
          onSubmit={(e) => {
            e.preventDefault()
            handleGo()
          }}
        >
          <input
            className="settings-panel__input"
            type="text"
            inputMode="numeric"
            placeholder="Bus stop code"
            value={stopCode}
            onChange={(e) => setStopCode(e.target.value)}
            autoFocus
          />
          <button className="settings-panel__go" type="submit">
            Go
          </button>
        </form>

        <button
          className="settings-panel__refresh"
          onClick={onRefresh}
          disabled={refreshLocked}
        >
          {isRefreshing
            ? 'Refreshing...'
            : refreshCooldownSeconds > 0
              ? `Refresh (${refreshCooldownSeconds}s)`
              : 'Refresh'}
        </button>
      </div>
    </div>
  )
}
