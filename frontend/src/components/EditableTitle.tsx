import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

type EditableTitleProps = {
  value: string
  placeholder?: string
  /** Accessible name for both the display button and the input. */
  label: string
  className?: string
  disabled?: boolean
  /** Return a rejection to keep the editor open (e.g. rename failed). */
  onCommit: (next: string) => void | Promise<void>
  /** Start in edit mode; used when a row is created with the intent to name it. */
  autoEdit?: boolean
  onEditingChange?: (editing: boolean) => void
}

/**
 * A heading that turns into a text input on click. Shared by document titles
 * (rename on disk) and project display names (stored as metadata).
 */
export function EditableTitle({
  value,
  placeholder = 'Untitled',
  label,
  className,
  disabled = false,
  onCommit,
  autoEdit = false,
  onEditingChange,
}: EditableTitleProps) {
  const [editing, setEditing] = useState(autoEdit)
  const [draft, setDraft] = useState(value)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!editing) {
      setDraft(value)
    }
  }, [value, editing])

  useEffect(() => {
    onEditingChange?.(editing)
  }, [editing, onEditingChange])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const finish = async () => {
    if (cancelledRef.current) {
      cancelledRef.current = false
      setDraft(value)
      setEditing(false)
      return
    }
    const next = draft.trim()
    if (next === value.trim()) {
      setEditing(false)
      return
    }
    setPending(true)
    try {
      await onCommit(next)
      setEditing(false)
    } catch {
      // Keep the editor open so the user can fix the name; the caller surfaces the error.
      inputRef.current?.focus()
    } finally {
      setPending(false)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      inputRef.current?.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelledRef.current = true
      inputRef.current?.blur()
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`editable-title is-editing${className ? ` ${className}` : ''}`}
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        disabled={pending}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void finish()}
        onKeyDown={handleKeyDown}
        spellCheck={false}
      />
    )
  }

  return (
    <button
      type="button"
      className={`editable-title${value ? '' : ' is-placeholder'}${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={disabled ? undefined : `Rename (${value || placeholder})`}
      disabled={disabled}
      onClick={() => setEditing(true)}
    >
      {value || placeholder}
    </button>
  )
}
