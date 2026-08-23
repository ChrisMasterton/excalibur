import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiagramKind } from '../types'

const SAVE_FEEDBACK_HOLD_MS = 100

/**
 * Brief "saved" state for a workspace's Save button. Held for a fixed time so the
 * feedback is visible even when the write itself is instant.
 */
export function useSaveFeedback() {
  const [saveButtonFeedback, setSaveButtonFeedback] = useState<Record<DiagramKind, boolean>>({
    excalidraw: false,
    mermaid: false,
  })
  const saveFeedbackTimersRef = useRef<Record<DiagramKind, number | null>>({
    excalidraw: null,
    mermaid: null,
  })

  useEffect(() => {
    const saveFeedbackTimers = saveFeedbackTimersRef.current
    return () => {
      for (const timer of Object.values(saveFeedbackTimers)) {
        if (timer !== null) {
          window.clearTimeout(timer)
        }
      }
    }
  }, [])

  const showSaveFeedback = useCallback((kind: DiagramKind) => {
    const activeTimer = saveFeedbackTimersRef.current[kind]
    if (activeTimer !== null) {
      window.clearTimeout(activeTimer)
    }
    setSaveButtonFeedback((current) => ({ ...current, [kind]: true }))
    saveFeedbackTimersRef.current[kind] = window.setTimeout(() => {
      setSaveButtonFeedback((current) => ({ ...current, [kind]: false }))
      saveFeedbackTimersRef.current[kind] = null
    }, SAVE_FEEDBACK_HOLD_MS)
  }, [])

  return { saveButtonFeedback, showSaveFeedback }
}
