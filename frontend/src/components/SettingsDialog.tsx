import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_SETTINGS, SETTINGS_LIMITS, type Settings } from '../lib/settings'
import { IconButton } from './IconButton'

type SettingsDialogProps = {
  open: boolean
  settings: Settings
  settingsPath?: string | null
  onChange: (next: Settings) => void
  onClose: () => void
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="settings-field">
      <span className="settings-field-text">
        <span className="settings-field-label">{label}</span>
        {hint ? <span className="settings-field-hint">{hint}</span> : null}
      </span>
      <span className="settings-field-control">{children}</span>
    </label>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

/** Modal editor for the global settings; every change applies and saves immediately. */
export function SettingsDialog({ open, settings, settingsPath, onChange, onClose }: SettingsDialogProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    panelRef.current?.querySelector<HTMLElement>('input, select, button')?.focus()
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  if (!open) {
    return null
  }

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    onChange({ ...settings, [key]: value })
  }

  return createPortal(
    <div className="settings-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panelRef} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="settings-header">
          <div>
            <h2 id={titleId}>Settings</h2>
            <p>Shared by every Excalibur window{settingsPath ? ` · ${settingsPath}` : ''}</p>
          </div>
          <IconButton icon="x" label="Close settings" onClick={onClose} />
        </header>

        <div className="settings-body">
          <Section title="Mermaid preview">
            <Field label="Zoom speed" hint="Wheel, pinch, and the +/− buttons">
              <input
                type="range"
                aria-label="Zoom speed"
                min={SETTINGS_LIMITS.previewZoomSpeed.min}
                max={SETTINGS_LIMITS.previewZoomSpeed.max}
                step={SETTINGS_LIMITS.previewZoomSpeed.step}
                value={settings.previewZoomSpeed}
                onChange={(event) => update('previewZoomSpeed', Number(event.target.value))}
              />
              <output className="settings-value">{settings.previewZoomSpeed.toFixed(2)}×</output>
            </Field>
            <Field label="Scroll wheel" hint="The other action is available with Ctrl / Cmd held">
              <select
                aria-label="Scroll wheel action"
                value={settings.previewWheelAction}
                onChange={(event) => update('previewWheelAction', event.target.value as Settings['previewWheelAction'])}
              >
                <option value="pan">Pans the diagram</option>
                <option value="zoom">Zooms the diagram</option>
              </select>
            </Field>
            <Field label="Fit can enlarge" hint="Let Fit to window scale small diagrams above 100%">
              <input
                type="checkbox"
                aria-label="Fit can enlarge small diagrams"
                checked={settings.previewFitUpscale}
                onChange={(event) => update('previewFitUpscale', event.target.checked)}
              />
            </Field>
          </Section>

          <Section title="Mermaid editor">
            <Field label="Font size">
              <input
                type="number"
                aria-label="Editor font size"
                min={SETTINGS_LIMITS.mermaidEditorFontSize.min}
                max={SETTINGS_LIMITS.mermaidEditorFontSize.max}
                value={settings.mermaidEditorFontSize}
                onChange={(event) => update('mermaidEditorFontSize', Number(event.target.value))}
              />
              <span className="settings-value">px</span>
            </Field>
          </Section>

          <Section title="Files">
            <Field label="Recent files to keep">
              <input
                type="number"
                aria-label="Recent files to keep"
                min={SETTINGS_LIMITS.recentsLimit.min}
                max={SETTINGS_LIMITS.recentsLimit.max}
                value={settings.recentsLimit}
                onChange={(event) => update('recentsLimit', Number(event.target.value))}
              />
            </Field>
            <Field label="Project folder depth" hint="How many levels of subfolders a project scans">
              <input
                type="number"
                aria-label="Project folder depth"
                min={SETTINGS_LIMITS.projectScanDepth.min}
                max={SETTINGS_LIMITS.projectScanDepth.max}
                value={settings.projectScanDepth}
                onChange={(event) => update('projectScanDepth', Number(event.target.value))}
              />
            </Field>
          </Section>
        </div>

        <footer className="settings-footer">
          <button type="button" className="settings-reset" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>
            Reset to defaults
          </button>
          <button type="button" className="settings-done" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
