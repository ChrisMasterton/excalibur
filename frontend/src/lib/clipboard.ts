/**
 * Copies text to the clipboard. The async Clipboard API is the real path; the
 * hidden-textarea `execCommand` route is the fallback for the webview contexts
 * that refuse it (no permission, or a non-secure origin).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy route.
  }
  return copyWithTextarea(text)
}

function copyWithTextarea(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '-1000px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  try {
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
