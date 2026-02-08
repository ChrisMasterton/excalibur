import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import mermaid from 'mermaid'
import './App.css'

type ExcalidrawData = {
  elements: unknown[]
  appState: Record<string, unknown>
  files: Record<string, BinaryFileData>
}

type RecentItem = {
  kind: 'excalidraw' | 'mermaid'
  path: string
  name?: string | null
  updated_at: number
}

type OpenFileResponse = {
  path: string
  name?: string | null
  contents: string
}

type SaveFileResponse = {
  path: string
}

function App() {
  const [excalidrawApi, setExcalidrawApiInternal] = useState<ExcalidrawImperativeAPI | null>(null)
  const [tab, setTab] = useState<'excalidraw' | 'mermaid'>('excalidraw')
  const [recents, setRecents] = useState<RecentItem[]>([])

  const setExcalidrawApi = useCallback((api: ExcalidrawImperativeAPI | null) => {
    console.log('[excalibur] setExcalidrawApi called:', api ? 'API instance received' : 'null')
    setExcalidrawApiInternal(api)
  }, [])

  const [excalidrawPath, setExcalidrawPath] = useState<string | null>(null)
  const [excalidrawName, setExcalidrawName] = useState('')
  const [excalidrawMessage, setExcalidrawMessage] = useState('')

  const [mermaidPath, setMermaidPath] = useState<string | null>(null)
  const [mermaidName, setMermaidName] = useState('')
  const [mermaidText, setMermaidText] = useState('flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Ship it]\n  B -->|No| D[Refine]')
  const [mermaidMessage, setMermaidMessage] = useState('')
  const [mermaidSvg, setMermaidSvg] = useState('')
  const [mermaidError, setMermaidError] = useState('')

  const refreshRecents = useCallback(async () => {
    const data = await invoke<RecentItem[]>('list_recents')
    setRecents(data)
  }, [])

  useEffect(() => {
    console.log('[excalibur] App mounted')
    return () => console.log('[excalibur] App unmounted')
  }, [])

  useEffect(() => {
    refreshRecents()
  }, [refreshRecents])

  // Pending file path for the startup race condition (event arrives before excalidrawApi is ready)
  const pendingOpenFile = useRef<string | null>(null)

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      flowchart: { htmlLabels: false },
    })
  }, [])

  useEffect(() => {
    let isActive = true
    const render = async () => {
      try {
        setMermaidError('')
        // Strip BOM and leading/trailing whitespace
        const cleanedText = mermaidText.replace(/^\uFEFF/, '').trim()
        if (!cleanedText) {
          setMermaidSvg('')
          return
        }
        const { svg } = await mermaid.render(`m-${Date.now()}`, cleanedText)
        if (isActive) {
          setMermaidSvg(svg)
        }
      } catch (error) {
        if (isActive) {
          setMermaidError('Unable to render diagram. Check syntax.')
        }
      }
    }
    render()
    return () => {
      isActive = false
    }
  }, [mermaidText])

  const applyExcalidrawFile = useCallback(
    (file: OpenFileResponse) => {
      console.log('[excalibur] applyExcalidrawFile: START', {
        path: file.path,
        name: file.name,
        contentLength: file.contents?.length ?? 0,
      })

      if (!excalidrawApi) {
        console.warn('[excalibur] applyExcalidrawFile: excalidrawApi is null, aborting')
        return
      }
      console.log('[excalibur] applyExcalidrawFile: excalidrawApi is available')

      try {
        console.log('[excalibur] applyExcalidrawFile: parsing JSON...')
        const parsed = JSON.parse(file.contents) as Partial<ExcalidrawData> & {
          data?: Partial<ExcalidrawData>
        }
        console.log('[excalibur] applyExcalidrawFile: JSON parsed successfully', {
          hasData: !!parsed.data,
          hasElements: !!(parsed.elements || parsed.data?.elements),
          topLevelKeys: Object.keys(parsed),
        })

        const raw = parsed.data && parsed.data.elements ? parsed.data : parsed
        console.log('[excalibur] applyExcalidrawFile: extracted raw data', {
          elementCount: raw.elements?.length ?? 0,
          hasAppState: !!raw.appState,
          fileCount: raw.files ? Object.keys(raw.files).length : 0,
        })

        // Sanitize elements to ensure required array properties exist
        const sanitizedElements = (raw.elements ?? []).map((el, index) => {
          const element = el as Record<string, unknown>
          const sanitized = { ...element }
          if (!Array.isArray(sanitized.groupIds)) {
            console.warn(`[excalibur] applyExcalidrawFile: element ${index} missing groupIds, defaulting to []`)
            sanitized.groupIds = []
          }
          if (!Array.isArray(sanitized.boundElements)) {
            sanitized.boundElements = sanitized.boundElements ?? null
          }
          return sanitized
        })

        console.log('[excalibur] applyExcalidrawFile: calling updateScene...')
        excalidrawApi.updateScene({
          elements: sanitizedElements as never[],
          appState: (raw.appState ?? {}) as never,
        })
        console.log('[excalibur] applyExcalidrawFile: updateScene completed')

        const files = raw.files ? Object.values(raw.files) : []
        if (files.length) {
          console.log('[excalibur] applyExcalidrawFile: calling addFiles with', files.length, 'files')
          excalidrawApi.addFiles(files)
          console.log('[excalibur] applyExcalidrawFile: addFiles completed')
        }

        console.log('[excalibur] applyExcalidrawFile: updating React state...')
        setExcalidrawPath(file.path)
        setExcalidrawName(file.name?.replace(/\.[^/.]+$/, '') ?? '')
        setExcalidrawMessage(`Loaded ${file.path}.`)
        setTab('excalidraw')
        console.log('[excalibur] applyExcalidrawFile: refreshing recents...')
        refreshRecents()
        console.log('[excalibur] applyExcalidrawFile: COMPLETE SUCCESS')
      } catch (error) {
        console.error('[excalibur] applyExcalidrawFile: FAILED', error)
        setExcalidrawMessage('Failed to parse .excalidraw file.')
      }
    },
    [excalidrawApi, refreshRecents],
  )

  const handleOpenExcalidraw = useCallback(async () => {
    console.log('[excalibur] handleOpenExcalidraw: invoking open_excalidraw_file...')
    try {
      const response = await invoke<OpenFileResponse | null>('open_excalidraw_file')
      console.log('[excalibur] handleOpenExcalidraw: invoke returned', {
        hasResponse: !!response,
        path: response?.path,
        contentLength: response?.contents?.length ?? 0,
      })
      if (!response) {
        console.log('[excalibur] handleOpenExcalidraw: no response (user cancelled?), returning')
        return
      }
      applyExcalidrawFile(response)
    } catch (error) {
      console.error('[excalibur] handleOpenExcalidraw: invoke FAILED', error)
    }
  }, [applyExcalidrawFile])

  const handleSaveExcalidraw = useCallback(async () => {
    if (!excalidrawApi) {
      return
    }
    const serialized = serializeAsJSON(
      excalidrawApi.getSceneElements(),
      excalidrawApi.getAppState(),
      excalidrawApi.getFiles(),
      'local',
    )
    const response = await invoke<SaveFileResponse>('save_excalidraw_file', {
      request: {
        path: excalidrawPath,
        name: excalidrawName.trim() || undefined,
        contents: serialized,
      },
    })
    setExcalidrawPath(response.path)
    setExcalidrawMessage(`Saved to ${response.path}.`)
    refreshRecents()
  }, [excalidrawApi, excalidrawName, excalidrawPath, refreshRecents])

  const handleNewExcalidraw = useCallback(() => {
    if (!excalidrawApi) {
      return
    }
    excalidrawApi.resetScene()
    setExcalidrawPath(null)
    setExcalidrawName('')
    setExcalidrawMessage('')
  }, [excalidrawApi])

  const loadExcalidrawPath = useCallback(
    async (path: string) => {
      console.log('[excalibur] loadExcalidrawPath: invoking load_excalidraw_path for', path)
      try {
        const response = await invoke<OpenFileResponse>('load_excalidraw_path', { path })
        console.log('[excalibur] loadExcalidrawPath: invoke returned', {
          path: response.path,
          contentLength: response.contents?.length ?? 0,
        })
        applyExcalidrawFile(response)
      } catch (error) {
        console.error('[excalibur] loadExcalidrawPath: invoke FAILED', error)
      }
    },
    [applyExcalidrawFile],
  )

  // Listen for open-file events from the backend (file association / deep-link)
  useEffect(() => {
    const unlisten = listen<string>('open-file', (event) => {
      console.log('[excalibur] open-file event received:', event.payload)
      if (excalidrawApi) {
        loadExcalidrawPath(event.payload)
      } else {
        pendingOpenFile.current = event.payload
      }
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [excalidrawApi, loadExcalidrawPath])

  // When excalidrawApi becomes available, load any pending file
  useEffect(() => {
    if (excalidrawApi && pendingOpenFile.current) {
      const path = pendingOpenFile.current
      pendingOpenFile.current = null
      loadExcalidrawPath(path)
    }
  }, [excalidrawApi, loadExcalidrawPath])

  const handleOpenMermaid = useCallback(async () => {
    const response = await invoke<OpenFileResponse | null>('open_mermaid_file')
    if (!response) {
      return
    }
    setMermaidPath(response.path)
    setMermaidName(response.name?.replace(/\.[^/.]+$/, '') ?? '')
    setMermaidText(response.contents)
    setMermaidMessage(`Loaded ${response.path}.`)
    setTab('mermaid')
    refreshRecents()
  }, [refreshRecents])

  const handleSaveMermaid = useCallback(async () => {
    const response = await invoke<SaveFileResponse>('save_mermaid_file', {
      request: {
        path: mermaidPath,
        name: mermaidName.trim() || undefined,
        contents: mermaidText,
      },
    })
    setMermaidPath(response.path)
    setMermaidMessage(`Saved to ${response.path}.`)
    refreshRecents()
  }, [mermaidName, mermaidPath, mermaidText, refreshRecents])

  const loadMermaidPath = useCallback(async (path: string) => {
    const response = await invoke<OpenFileResponse>('load_mermaid_path', { path })
    setMermaidPath(response.path)
    setMermaidName(response.name?.replace(/\.[^/.]+$/, '') ?? '')
    setMermaidText(response.contents)
    setMermaidMessage(`Loaded ${response.path}.`)
    setTab('mermaid')
    refreshRecents()
  }, [refreshRecents])

  const recentList = useMemo(() => {
    if (!recents.length) {
      return <div className="empty">No recent charts yet.</div>
    }
    return recents.map((item) => (
      <button
        key={`${item.kind}-${item.path}`}
        className="recent-item"
        onClick={() => {
          if (item.kind === 'excalidraw') {
            loadExcalidrawPath(item.path)
          } else {
            loadMermaidPath(item.path)
          }
        }}
      >
        <span className="recent-type">{item.kind}</span>
        <span className="recent-name">{item.name || item.path}</span>
        <span className="recent-path">{item.path}</span>
      </button>
    ))
  }, [recents, loadExcalidrawPath, loadMermaidPath])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">Excalibur</div>
          <div className="brand-sub">Excalidraw + Mermaid workspace</div>
        </div>
        <div className="tab-buttons">
          <button
            className={`tab-button ${tab === 'excalidraw' ? 'active' : ''}`}
            onClick={() => setTab('excalidraw')}
          >
            Excalidraw
          </button>
          <button
            className={`tab-button ${tab === 'mermaid' ? 'active' : ''}`}
            onClick={() => setTab('mermaid')}
          >
            Mermaid
          </button>
        </div>
        <div className="recents">
          <div className="section-title">Recent (last 10)</div>
          <div className="recent-list">{recentList}</div>
        </div>
      </aside>

      <main className="workspace">
        {tab === 'excalidraw' ? (
          <section className="panel">
            <header className="panel-header">
              <div>
                <h1>Excalidraw editor</h1>
                <p>Open, edit, and save .excalidraw files.</p>
              </div>
              <div className="status">{excalidrawMessage}</div>
            </header>
            <div className="control-row">
              <label>
                Name
                <input
                  value={excalidrawName}
                  onChange={(event) => setExcalidrawName(event.target.value)}
                  placeholder="Architecture brainstorm"
                />
              </label>
              <label>
                File
                <input
                  value={excalidrawPath ?? ''}
                  readOnly
                  placeholder="No file loaded"
                />
              </label>
              <div className="actions">
                <button className="primary" onClick={handleSaveExcalidraw}>
                  Save
                </button>
                <button onClick={handleOpenExcalidraw}>Open</button>
                <button onClick={handleNewExcalidraw}>New</button>
              </div>
            </div>
            <div className="canvas-frame">
              <Excalidraw excalidrawAPI={setExcalidrawApi} />
            </div>
          </section>
        ) : (
          <section className="panel">
            <header className="panel-header">
              <div>
                <h1>Mermaid editor</h1>
                <p>Write Mermaid syntax and render instantly.</p>
              </div>
              <div className="status">{mermaidMessage}</div>
            </header>
            <div className="control-row">
              <label>
                Name
                <input
                  value={mermaidName}
                  onChange={(event) => setMermaidName(event.target.value)}
                  placeholder="Auth flow"
                />
              </label>
              <label>
                File
                <input value={mermaidPath ?? ''} readOnly placeholder="No file loaded" />
              </label>
              <div className="actions">
                <button className="primary" onClick={handleSaveMermaid}>
                  Save
                </button>
                <button onClick={handleOpenMermaid}>Open</button>
              </div>
            </div>
            <div className="mermaid-grid">
              <div className="mermaid-editor">
                <textarea
                  value={mermaidText}
                  onChange={(event) => setMermaidText(event.target.value)}
                />
              </div>
              <div className="mermaid-preview">
                {mermaidError ? (
                  <div className="error">{mermaidError}</div>
                ) : (
                  <div
                    className="diagram"
                    dangerouslySetInnerHTML={{ __html: mermaidSvg }}
                  />
                )}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
