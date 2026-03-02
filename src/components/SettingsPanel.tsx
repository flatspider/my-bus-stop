import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Settings } from '../useSettings'

interface SettingsPanelProps {
  onRefresh: () => void
  refreshLocked: boolean
  isRefreshing: boolean
  refreshCooldownSeconds: number
  settings: Settings
  onUpdateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="settings-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="settings-toggle__track" />
    </label>
  )
}

export default function SettingsPanel({
  onRefresh,
  refreshLocked,
  isRefreshing,
  refreshCooldownSeconds,
  settings,
  onUpdateSetting,
}: SettingsPanelProps) {
  const [stopCode, setStopCode] = useState('')
  const navigate = useNavigate()

  function handleGo() {
    const trimmed = stopCode.trim()
    if (!trimmed) return
    navigate(`/stop/${trimmed}`)
  }

  return (
    <div className="bus-card bus-card--settings">
      <div className="bus-card__accent bus-card__accent--gray" />
      <div className="settings-panel__content">
        <div className="settings-toggles">
          <ToggleRow
            label="Show 'min' suffix"
            checked={settings.showMinSuffix}
            onChange={(v) => onUpdateSetting('showMinSuffix', v)}
          />
          <ToggleRow
            label="Show route name"
            checked={settings.showRouteName}
            onChange={(v) => onUpdateSetting('showRouteName', v)}
          />
          <ToggleRow
            label="Show stops away"
            checked={settings.showStopsAway}
            onChange={(v) => onUpdateSetting('showStopsAway', v)}
          />
          <ToggleRow
            label="Dark mode"
            checked={settings.darkMode}
            onChange={(v) => onUpdateSetting('darkMode', v)}
          />
        </div>

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
