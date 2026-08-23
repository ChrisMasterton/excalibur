import { useCallback, useEffect, useRef, useState } from 'react'
import type { SidebarPanel } from '../components/Sidebar'
import type { DiagramKind } from '../types'

const SIDEBAR_PANEL_KEY = 'excalibur.sidebar.panel'
const MERMAID_EDITOR_COLLAPSED_KEY = 'excalibur.mermaid.editorCollapsed'

function readStoredFlag(key: string, fallback: boolean) {
  const raw = window.localStorage.getItem(key)
  return raw === null ? fallback : raw === 'true'
}

/** Which workspace is on screen plus the shell's remembered chrome state. */
export function useAppLayout() {
  const [workspace, setWorkspace] = useState<DiagramKind>('excalidraw')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>(() =>
    window.localStorage.getItem(SIDEBAR_PANEL_KEY) === 'projects' ? 'projects' : 'recent',
  )
  const [isMermaidEditorCollapsed, setIsMermaidEditorCollapsed] = useState(() =>
    readStoredFlag(MERMAID_EDITOR_COLLAPSED_KEY, false),
  )
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const workspaceRef = useRef(workspace)

  useEffect(() => {
    workspaceRef.current = workspace
  }, [workspace])

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_PANEL_KEY, sidebarPanel)
  }, [sidebarPanel])

  useEffect(() => {
    window.localStorage.setItem(MERMAID_EDITOR_COLLAPSED_KEY, String(isMermaidEditorCollapsed))
  }, [isMermaidEditorCollapsed])

  /** The workspace as of right now, for callbacks that must not close over stale state. */
  const getWorkspace = useCallback(() => workspaceRef.current, [])

  const toggleMermaidEditor = useCallback(() => setIsMermaidEditorCollapsed((current) => !current), [])
  const openSettings = useCallback(() => setIsSettingsOpen(true), [])
  const closeSettings = useCallback(() => setIsSettingsOpen(false), [])

  return {
    workspace,
    setWorkspace,
    getWorkspace,
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    sidebarPanel,
    setSidebarPanel,
    isMermaidEditorCollapsed,
    toggleMermaidEditor,
    isSettingsOpen,
    openSettings,
    closeSettings,
  }
}
