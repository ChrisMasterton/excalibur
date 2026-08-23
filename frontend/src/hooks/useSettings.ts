import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../lib/settings'
import { api } from '../lib/tauri'

/** Global settings, loaded from (and written back to) the backend's settings.json. */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)

  useEffect(() => {
    api
      .loadSettings()
      .then((raw) => setSettings(normalizeSettings(raw)))
      .catch((error) => console.error('[excalibur] load_settings failed', error))
  }, [])

  const handleSettingsChange = useCallback((next: Settings) => {
    const normalized = normalizeSettings(next)
    setSettings(normalized)
    api.saveSettings(normalized).catch((error) => console.error('[excalibur] save_settings failed', error))
  }, [])

  return { settings, handleSettingsChange }
}
