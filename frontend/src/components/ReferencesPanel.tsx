import type { SymbolDocumentHit } from '../lib/symbolIndex'
import { symbolKindHint } from '../lib/symbols'
import type { PickedSymbol } from '../lib/symbolPick'
import { IconButton } from './IconButton'
import { SymbolHitList } from './SymbolHitList'

type ReferencesPanelProps = {
  /** The symbol a click resolved to; null keeps the panel closed. */
  symbol: PickedSymbol | null
  /** Project the lookup is scoped to, or null when the document is in none. */
  projectName: string | null
  inProject: boolean
  isIndexing: boolean
  documents: readonly SymbolDocumentHit[]
  activePath: string | null
  onSelect: (hit: SymbolDocumentHit) => void
  onClose: () => void
}

/**
 * Everywhere in the project one symbol turns up. Clicking a row activates that
 * document and marks the matches; the panel stays put so the whole list can be
 * flipped through. Escape clears the marks first, then closes the panel.
 */
export function ReferencesPanel({
  symbol,
  projectName,
  inProject,
  isIndexing,
  documents,
  activePath,
  onSelect,
  onClose,
}: ReferencesPanelProps) {
  if (!symbol) {
    return null
  }

  return (
    <aside className="references-panel" aria-label="References">
      <header className="references-head">
        <div className="references-titles">
          <span className="references-name">{symbol.display}</span>
          <span className="references-hint">
            {symbolKindHint(symbol.kind, symbol.owner)}
            {projectName ? ` · ${projectName}` : ''}
          </span>
        </div>
        <IconButton icon="x" label="Close references" size="sm" onClick={onClose} />
      </header>

      <div className="references-body">
        {!inProject ? (
          <p className="references-note">
            This document is not in a registered project, so there is nothing to search. Add its folder
            under <strong>Projects</strong> to see everywhere {symbol.display} is used.
          </p>
        ) : isIndexing && !documents.length ? (
          <p className="references-note" role="status">
            Indexing the project…
          </p>
        ) : documents.length ? (
          <>
            <p className="references-count">
              {documents.length} {documents.length === 1 ? 'document' : 'documents'}
            </p>
            <SymbolHitList hits={documents} activePath={activePath} onSelect={onSelect} />
          </>
        ) : (
          <p className="references-note">No other diagram in this project mentions {symbol.display}.</p>
        )}
      </div>
    </aside>
  )
}
