import { useEffect, useId, useRef } from 'react'
import { diagramIcon } from '../lib/menus'
import type { SymbolDocumentHit } from '../lib/symbolIndex'
import { symbolKindHint } from '../lib/symbols'
import type { PickedSymbol } from '../lib/symbolPick'
import type { BoardCard, BoardThumbnail } from '../hooks/useSymbolBoard'
import { Icon } from './Icon'
import { IconButton } from './IconButton'

type SymbolBoardProps = {
  open: boolean
  /** The active symbol; the board shows nothing else. */
  symbol: PickedSymbol | null
  projectName: string | null
  cards: readonly BoardCard[]
  thumbnailFor: (hit: SymbolDocumentHit) => BoardThumbnail | null
  requestThumbnail: (hit: SymbolDocumentHit) => void
  onSelect: (hit: SymbolDocumentHit) => void
  onClose: () => void
}

type BoardCardViewProps = {
  card: BoardCard
  thumbnail: BoardThumbnail | null
  onRequest: (hit: SymbolDocumentHit) => void
  onSelect: (hit: SymbolDocumentHit) => void
}

/**
 * One document's appearance of the symbol. The thumbnail is asked for once the
 * card is mounted, so a large project fills in progressively instead of stalling.
 */
function BoardCardView({ card, thumbnail, onRequest, onSelect }: BoardCardViewProps) {
  const { hit, isActive } = card

  useEffect(() => {
    onRequest(hit)
  }, [hit, onRequest])

  return (
    <button
      type="button"
      className={`board-card${isActive ? ' is-active' : ''}`}
      title={hit.doc.path}
      aria-current={isActive || undefined}
      onClick={() => onSelect(hit)}
    >
      <span className="board-card-head">
        <Icon name={diagramIcon(hit.doc.kind, hit.doc.diagramType)} size={15} className="board-card-icon" />
        <span className="board-card-name">{hit.doc.title}</span>
        <span className="board-card-count">{hit.count}</span>
      </span>
      <span className="board-card-thumb">
        {thumbnail?.status === 'ready' ? (
          // Markup this app just rendered; inlined rather than rasterised so it stays crisp.
          <span
            className="board-card-svg"
            dangerouslySetInnerHTML={{ __html: thumbnail.thumbnail.markup }}
          />
        ) : (
          <span className={`board-card-blank${thumbnail?.status === 'loading' ? ' is-loading' : ''}`}>
            <Icon name={diagramIcon(hit.doc.kind, hit.doc.diagramType)} size={24} />
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * Every diagram in the project that mentions the active symbol, at once.
 *
 * The overlay covers the workspace and leaves the sidebar alone, and closing it
 * puts back exactly what was underneath: the same tab, the same panel, the same
 * marks. Choosing a card is the one thing that moves the app on.
 */
export function SymbolBoard({
  open,
  symbol,
  projectName,
  cards,
  thumbnailFor,
  requestThumbnail,
  onSelect,
  onClose,
}: SymbolBoardProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (open) {
      panelRef.current?.querySelector<HTMLElement>('button')?.focus()
    }
  }, [open])

  if (!open || !symbol) {
    return null
  }

  return (
    <div
      className="board-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div ref={panelRef} className="board" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="board-header">
          <div className="board-titles">
            <h2 id={titleId}>{symbol.display}</h2>
            <p>
              {symbolKindHint(symbol.kind, symbol.owner)}
              {projectName ? ` · ${projectName}` : ''} · {cards.length}{' '}
              {cards.length === 1 ? 'document' : 'documents'}
            </p>
          </div>
          <IconButton icon="x" label="Close board" onClick={onClose} />
        </header>
        <div className="board-grid">
          {cards.map((card) => (
            <BoardCardView
              key={card.hit.doc.path}
              card={card}
              thumbnail={thumbnailFor(card.hit)}
              onRequest={requestThumbnail}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
