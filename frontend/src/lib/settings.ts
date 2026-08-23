/**
 * Global Excalibur settings. Stored as `settings.json` in the app data folder
 * (one file per user, shared by every window/instance) via the Rust backend.
 * The backend reads `recentsLimit` and `projectScanDepth`; everything else is frontend-only.
 */

export type WheelAction = 'pan' | 'zoom'

export type Settings = {
  /** How many files the Recent list keeps (1–100). */
  recentsLimit: number
  /** How many folder levels a project scan descends (0–10). */
  projectScanDepth: number
  /** Mermaid source editor font size in px (10–24). */
  mermaidEditorFontSize: number
  /** Multiplier for wheel/pinch zoom and the zoom buttons (0.25–3). */
  previewZoomSpeed: number
  /** What a plain scroll wheel does in the Mermaid preview; the other action needs Ctrl/Cmd. */
  previewWheelAction: WheelAction
  /** Let "Fit to window" enlarge small diagrams beyond 100%. */
  previewFitUpscale: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  recentsLimit: 10,
  projectScanDepth: 4,
  mermaidEditorFontSize: 14,
  previewZoomSpeed: 1,
  previewWheelAction: 'pan',
  previewFitUpscale: false,
}

export const SETTINGS_LIMITS = {
  recentsLimit: { min: 1, max: 100, step: 1 },
  projectScanDepth: { min: 0, max: 10, step: 1 },
  mermaidEditorFontSize: { min: 10, max: 24, step: 1 },
  previewZoomSpeed: { min: 0.25, max: 3, step: 0.25 },
} as const

function clampNumber(value: unknown, fallback: number, limits: { min: number; max: number }) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return Math.min(limits.max, Math.max(limits.min, number))
}

/** Fills in defaults and clamps whatever was on disk, so a hand-edited file can't break the UI. */
export function normalizeSettings(raw: unknown): Settings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>
  return {
    recentsLimit: Math.round(clampNumber(source.recentsLimit, DEFAULT_SETTINGS.recentsLimit, SETTINGS_LIMITS.recentsLimit)),
    projectScanDepth: Math.round(
      clampNumber(source.projectScanDepth, DEFAULT_SETTINGS.projectScanDepth, SETTINGS_LIMITS.projectScanDepth),
    ),
    mermaidEditorFontSize: Math.round(
      clampNumber(source.mermaidEditorFontSize, DEFAULT_SETTINGS.mermaidEditorFontSize, SETTINGS_LIMITS.mermaidEditorFontSize),
    ),
    previewZoomSpeed: clampNumber(source.previewZoomSpeed, DEFAULT_SETTINGS.previewZoomSpeed, SETTINGS_LIMITS.previewZoomSpeed),
    previewWheelAction: source.previewWheelAction === 'zoom' ? 'zoom' : 'pan',
    previewFitUpscale: typeof source.previewFitUpscale === 'boolean' ? source.previewFitUpscale : DEFAULT_SETTINGS.previewFitUpscale,
  }
}
