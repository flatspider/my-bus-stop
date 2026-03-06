import { useEffect, useSyncExternalStore } from 'react'

export interface Settings {
  showMinSuffix: boolean
  showRouteName: boolean
  showStopsAway: boolean
  showStopTitle: boolean
  darkMode: boolean
}

const STORAGE_KEY = 'buswatch-settings'
const SETTINGS_EVENT = 'buswatch-settings-change'

const DEFAULTS: Settings = {
  showMinSuffix: true,
  showRouteName: true,
  showStopsAway: true,
  showStopTitle: true,
  darkMode: false,
}

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULTS

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    // corrupt data — fall through to defaults
  }
  return DEFAULTS
}

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {}

  const handleStorage = (event: StorageEvent) => {
    if (event.key && event.key !== STORAGE_KEY) return
    onStoreChange()
  }
  const handleCustomEvent = () => onStoreChange()

  window.addEventListener('storage', handleStorage)
  window.addEventListener(SETTINGS_EVENT, handleCustomEvent)
  return () => {
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener(SETTINGS_EVENT, handleCustomEvent)
  }
}

export function useSettings() {
  const settings = useSyncExternalStore(subscribe, loadSettings, () => DEFAULTS)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.darkMode)
  }, [settings.darkMode])

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    if (typeof window === "undefined") return
    const nextSettings = { ...settings, [key]: value }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSettings))
    window.dispatchEvent(new Event(SETTINGS_EVENT))
  }

  return { settings, updateSetting } as const
}
