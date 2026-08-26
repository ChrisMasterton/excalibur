import { diagramIcon } from '../lib/menus'
import type { SymbolDocumentHit } from '../lib/symbolIndex'
import { Icon } from './Icon'

type SymbolHitListProps = {
  hits: readonly SymbolDocumentHit[]
  /** Path of the document on screen, so the row for it reads as "you are here". */
  activePath: string | null
  onSelect: (hit: SymbolDocumentHit) => void
}

/** The documents that mention a symbol. Shared by "Find in project" and the references panel. */
export function SymbolHitList({ hits, activePath, onSelect }: SymbolHitListProps) {
  return (
    <>
      {hits.map((hit) => (
        <button
          key={hit.doc.path}
          type="button"
          className={`symbol-hit${activePath === hit.doc.path ? ' is-active' : ''}`}
          title={hit.doc.path}
          onClick={() => onSelect(hit)}
        >
          <Icon name={diagramIcon(hit.doc.kind, hit.doc.diagramType)} size={15} className="symbol-hit-icon" />
          <span className="symbol-hit-name">{hit.doc.title}</span>
          <span className="symbol-hit-count">{hit.count}</span>
        </button>
      ))}
    </>
  )
}
