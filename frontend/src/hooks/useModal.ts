import { useEffect, useRef } from 'react'

/** Native modal scope supplies focus containment, inert background, and focus restoration. */
export function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement | null>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    dialog.showModal()
    const cancel = (event: Event) => { event.preventDefault(); onClose() }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length)
      const index = controls.indexOf(document.activeElement as HTMLElement)
      if (!controls.length) { event.preventDefault(); dialog.focus(); return }
      if (event.shiftKey ? index <= 0 : index === controls.length - 1 || index < 0) {
        event.preventDefault()
        controls[event.shiftKey ? controls.length - 1 : 0].focus()
      }
    }
    dialog.addEventListener('keydown', keydown)
    dialog.addEventListener('cancel', cancel)
    return () => { dialog.removeEventListener('keydown', keydown); dialog.removeEventListener('cancel', cancel); dialog.close() }
  }, [open, onClose])
  return ref
}
