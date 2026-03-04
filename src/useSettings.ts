import { useState, useEffect } from 'react'

export interface Settings {
  showMinSuffix: boolean
  showRouteName: boolean
  showStopsAway: boolean
  showStopTitle: boolean
  darkMode: boolean
}

const STORAGE_KEY = 'buswatch-settings'

const DEFAULTS: Settings = {
  showMinSuffix: true,
  showRouteName: true,
  showStopsAway: true,
  showStopTitle: true,
  darkMode: false,
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    // corrupt data — fall through to defaults
  }
  return DEFAULTS
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.darkMode)
  }, [settings.darkMode])

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  return { settings, updateSetting } as const
}
