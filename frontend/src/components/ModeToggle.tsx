import type { DocumentMode } from '../types'
import { IconButton } from './IconButton'

type ModeToggleProps = {
  mode: DocumentMode
  onToggle: () => void
}

/**
 * The edit/view switch both workspaces carry. It always says which mode the
 * document is in, rather than which one the click would move to.
 */
export function ModeToggle({ mode, onToggle }: ModeToggleProps) {
  const isEditing = mode === 'edit'
  return (
    <IconButton
      icon={isEditing ? 'pencil' : 'eye'}
      label={isEditing ? 'Editing' : 'Viewing'}
      title={`${isEditing ? 'Editing' : 'Viewing'} — switch to ${isEditing ? 'viewing' : 'editing'}`}
      showLabel
      active={isEditing}
      className="mode-toggle"
      onClick={onToggle}
    />
  )
}
