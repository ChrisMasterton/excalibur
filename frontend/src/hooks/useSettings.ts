import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../lib/settings'
import { api, errorMessage } from '../lib/tauri'

/** Only committed settings become active; failures leave the previous values intact. */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const reload = useCallback(async () => {
    try {
      setSettings(normalizeSettings(await api.loadSettings()))
      setReady(true)
      setError('')
    } catch (error) {
      setError(errorMessage(error, 'Unable to load settings.'))
    }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const handleSettingsChange = useCallback(async (next: Settings) => {
    if (!ready || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    const normalized = normalizeSettings(next)
    try {
      await api.saveSettings(normalized)
      setSettings(normalized)
      setError('')
    } catch (error) {
      setError(errorMessage(error, 'Unable to save settings.'))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [ready])
  return { settings, handleSettingsChange, error, ready, saving, reload }
}
