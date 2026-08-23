import { useEffect, useState } from 'react'
import type { ProjectSearchGroup, SymbolIndexStatus } from '../hooks/useSymbolIndex'
import type { SymbolDocumentHit } from '../lib/symbolIndex'
import { symbolKindHint } from '../lib/symbols'
import { Icon } from './Icon'
import { IconButton } from './IconButton'
import { SymbolHitList } from './SymbolHitList'

const DEBOUNCE_MS = 150

type SymbolSearchProps = {
  status: SymbolIndexStatus
  /** Called as soon as the field is used, so the index only builds when it is wanted. */
  onEnsureIndex: () => void
  search: (query: string) => ProjectSearchGroup[]
  activePath: string | null
  onSelect: (hit: SymbolDocumentHit) => void
}

/** "Find in project": a symbol, then every document across all projects that names it. */
export function SymbolSearch({ status, onEnsureIndex, search, activePath, onSelect }: SymbolSearchProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const groups = debounced ? search(debounced) : []
  const isSearching = debounced.length > 0

  return (
    <div className="project-search">
      <div className="project-search-field">
        <Icon name="search" size={15} />
        <input
          type="search"
          value={query}
          placeholder="Find in projects…"
          aria-label="Find in projects"
          spellCheck={false}
          onFocus={onEnsureIndex}
          onChange={(event) => {
            onEnsureIndex()
            setQuery(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.stopPropagation()
              setQuery('')
            }
          }}
        />
        {query ? (
          <IconButton
            icon="x"
            label="Clear search"
            size="sm"
            className="project-search-clear"
            onClick={() => setQuery('')}
          />
        ) : null}
      </div>

      {isSearching && status.isIndexing ? (
        <div className="project-search-status" role="status">
          Indexing… {status.indexed}/{status.total}
        </div>
      ) : null}

      {isSearching && !groups.length && !status.isIndexing ? (
        <div className="project-search-status">No matches.</div>
      ) : null}

      {groups.map((group) => (
        <div key={group.project.path} className="symbol-results">
          <div className="symbol-group-title">{group.project.name}</div>
          {group.results.map((result) => (
            <div key={result.symbol} className="symbol-entry">
              <div className="symbol-entry-head">
                <span className="symbol-entry-name">{result.display}</span>
                <span className="symbol-entry-hint">{symbolKindHint(result.kind, result.owner)}</span>
              </div>
              <SymbolHitList hits={result.docs} activePath={activePath} onSelect={onSelect} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
