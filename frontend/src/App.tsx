import { useCallback } from 'react'
import './App.css'
import { DocumentTabs } from './components/DocumentTabs'
import { ExcalidrawWorkspace } from './components/ExcalidrawWorkspace'
import { MermaidWorkspace } from './components/MermaidWorkspace'
import { ProjectsPanel } from './components/ProjectsPanel'
import { RecentList } from './components/RecentList'
import { ReferencesPanel } from './components/ReferencesPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { SymbolBoard } from './components/SymbolBoard'
import { useAppLayout } from './hooks/useAppLayout'
import { useDocumentActions } from './hooks/useDocumentActions'
import { useDocumentTabs } from './hooks/useDocumentTabs'
import { useExcalidrawDocument } from './hooks/useExcalidrawDocument'
import { useImageImport } from './hooks/useImageImport'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useMermaidDocument } from './hooks/useMermaidDocument'
import { useNativeEvents } from './hooks/useNativeEvents'
import { useOpenDocuments } from './hooks/useOpenDocuments'
import { useProjectActions } from './hooks/useProjectActions'
import { useSaveFeedback } from './hooks/useSaveFeedback'
import { useSettings } from './hooks/useSettings'
import { useSidebarData } from './hooks/useSidebarData'
import { useSymbolBoard } from './hooks/useSymbolBoard'
import { useSymbolIndex } from './hooks/useSymbolIndex'
import { useSymbolReferences } from './hooks/useSymbolReferences'
import type { ProjectFile } from './types'

function App() {
  const layout = useAppLayout()
  const sidebar = useSidebarData()
  const symbolIndex = useSymbolIndex({
    projects: sidebar.projects,
    refreshToken: sidebar.projectsRefreshToken,
  })
  const { settings, handleSettingsChange } = useSettings()
  const { saveButtonFeedback, showSaveFeedback } = useSaveFeedback()

  const {
    documents,
    activeId,
    activeDocument,
    openPaths,
    getDocuments,
    getDocument,
    findByPath,
    openDocument,
    replaceDocument,
    findPristineDocument,
    patchDocument,
    closeDocuments,
    readExcalidrawCache,
    writeExcalidrawCache,
    readMermaidCache,
    writeMermaidCache,
    setActiveId,
  } = useOpenDocuments()

  const excalidraw = useExcalidrawDocument({
    isVisible: layout.workspace === 'excalidraw',
    isSidebarCollapsed: layout.isSidebarCollapsed,
    setWorkspace: layout.setWorkspace,
    patchDocument,
    readCache: readExcalidrawCache,
    writeCache: writeExcalidrawCache,
    refreshRecents: sidebar.refreshRecents,
    refreshProjectFiles: sidebar.refreshProjectFiles,
    showSaveFeedback,
  })

  const mermaid = useMermaidDocument({
    patchDocument,
    readCache: readMermaidCache,
    writeCache: writeMermaidCache,
    refreshRecents: sidebar.refreshRecents,
    refreshProjectFiles: sidebar.refreshProjectFiles,
    showSaveFeedback,
  })

  const imageImport = useImageImport({
    excalidrawApi: excalidraw.api,
    setWorkspace: layout.setWorkspace,
    setMessage: excalidraw.setMessage,
  })

  const { getWorkspace } = layout
  const { setMessage: setExcalidrawMessage } = excalidraw
  const { setMessage: setMermaidMessage } = mermaid
  const { clearHighlight: clearExcalidrawHighlight } = excalidraw
  const { clearHighlight: clearMermaidHighlight } = mermaid

  /** Drops the symbol marks in both workspaces, whichever one is holding them. */
  const clearHighlight = useCallback(() => {
    clearExcalidrawHighlight()
    clearMermaidHighlight()
  }, [clearExcalidrawHighlight, clearMermaidHighlight])

  /** Status message for whichever workspace the user is looking at. */
  const notify = useCallback(
    (message: string) => {
      if (getWorkspace() === 'excalidraw') {
        setExcalidrawMessage(message)
      } else {
        setMermaidMessage(message)
      }
    },
    [getWorkspace, setExcalidrawMessage, setMermaidMessage],
  )

  const tabs = useDocumentTabs({
    excalidraw,
    mermaid,
    setWorkspace: layout.setWorkspace,
    notify,
    refreshRecents: sidebar.refreshRecents,
    documents,
    activeId,
    getDocuments,
    getDocument,
    findByPath,
    openDocument,
    replaceDocument,
    findPristineDocument,
    patchDocument,
    closeDocuments,
    setActiveId,
  })

  const actions = useDocumentActions({
    excalidraw,
    mermaid,
    tabs,
    refreshRecents: sidebar.refreshRecents,
    setDocumentMode: tabs.setDocumentMode,
    findByPath,
    readExcalidrawCache,
    writeExcalidrawCache,
  })

  const references = useSymbolReferences({
    excalidraw,
    mermaid,
    symbolIndex,
    activeDocument,
    openSymbolDocument: actions.openSymbolDocument,
    highlightSymbolHit: actions.highlightSymbolHit,
    revealSymbol: actions.revealSymbol,
    clearHighlight,
  })

  const board = useSymbolBoard({
    symbol: references.symbol,
    documents: references.documents,
    activePath: references.activePath,
    select: references.select,
    // Escape peels the board first, then the panel's own layers (highlight, panel).
    onEscape: references.handleEscape,
    snapshotLiveDocuments: tabs.snapshotLiveDocuments,
    findByPath,
    readExcalidrawCache,
    readMermaidCache,
  })

  const projectActions = useProjectActions({
    excalidraw,
    mermaid,
    tabs,
    notify,
    setSidebarPanel: layout.setSidebarPanel,
    refreshRecents: sidebar.refreshRecents,
    refreshProjects: sidebar.refreshProjects,
    refreshProjectFiles: sidebar.refreshProjectFiles,
    getDocuments,
    patchDocument,
    findByPath,
  })

  useNativeEvents({
    hasUnsavedDocuments: tabs.hasUnsavedDocuments,
    confirmExit: tabs.confirmExit,
    openDiagram: tabs.openDiagram,
    openFileFromEvent: tabs.openFileFromEvent,
    importNativeImagePath: imageImport.importNativeImagePath,
    isClientPointInCanvasFrame: imageImport.isClientPointInCanvasFrame,
    refreshProjects: sidebar.refreshProjects,
    setSidebarPanel: layout.setSidebarPanel,
  })

  useKeyboardShortcuts({
    workspace: layout.workspace,
    activateDocument: tabs.activateDocument,
    closeActiveDocument: tabs.closeActiveDocument,
    getCycleTargetId: tabs.getCycleTargetId,
    getDocumentIdAt: tabs.getDocumentIdAt,
    openSettings: layout.openSettings,
    onClearHighlight: board.handleEscape,
    onToggleMode: tabs.toggleActiveMode,
    onSaveExcalidraw: excalidraw.handleSave,
    onOpenExcalidraw: actions.handleOpenExcalidraw,
    onSaveMermaid: mermaid.handleSave,
    onOpenMermaid: actions.handleOpenMermaid,
  })

  const activePath = activeDocument?.path ?? null

  return (
    <div className={`app-shell ${layout.isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        collapsed={layout.isSidebarCollapsed}
        onCollapsedChange={layout.setIsSidebarCollapsed}
        workspace={layout.workspace}
        onWorkspaceChange={tabs.handleWorkspaceChange}
        panel={layout.sidebarPanel}
        onPanelChange={layout.setSidebarPanel}
        dirty={{ excalidraw: excalidraw.dirty, mermaid: mermaid.dirty }}
        onOpenSettings={layout.openSettings}
      >
        {layout.sidebarPanel === 'recent' ? (
          <RecentList
            recents={sidebar.recents}
            projects={sidebar.projects}
            openPaths={openPaths}
            activePath={activePath}
            onOpen={(item) => tabs.openDiagram(item.kind, item.path)}
            onMoveToProject={(item, project) => void projectActions.moveFileToProject(item.path, project)}
            onMoveToNewProject={(item) => void projectActions.moveFileToNewProject(item.path)}
            onRemove={(item) => void sidebar.removeRecent(item)}
          />
        ) : (
          <ProjectsPanel
            projects={sidebar.projects}
            refreshToken={sidebar.projectsRefreshToken}
            openPaths={openPaths}
            activePath={activePath}
            symbolIndex={symbolIndex}
            onOpenSymbol={references.revealSearchHit}
            onAddProject={() => void projectActions.handleAddProject()}
            onRemoveProject={(project) => void sidebar.removeProject(project)}
            onRenameProject={projectActions.handleRenameProject}
            onOpenFile={(file: ProjectFile) => tabs.openDiagram(file.kind, file.path)}
            onOpenAllFiles={(project) => void projectActions.handleOpenAllProjectFiles(project)}
            onMoveFile={(file, project) => void projectActions.moveFileToProject(file.path, project)}
            onMoveFileToNewProject={(file) => void projectActions.moveFileToNewProject(file.path)}
            onError={notify}
          />
        )}
      </Sidebar>

      <main className="workspace">
        <DocumentTabs
          documents={documents}
          activeId={activeId}
          onActivate={tabs.activateDocument}
          onClose={(id) => tabs.closeDocumentIds([id])}
          onCloseOthers={tabs.closeOtherDocuments}
          onCloseAll={tabs.closeAllDocuments}
        />
        <div className="workspace-body">
          <ExcalidrawWorkspace
            hidden={layout.workspace !== 'excalidraw'}
            title={excalidraw.name}
            path={excalidraw.path}
            dirty={excalidraw.dirty}
            message={excalidraw.message}
            hasRecovery={Boolean(excalidraw.recoverableAutosave)}
            mode={tabs.activeMode}
            saveFeedback={saveButtonFeedback.excalidraw}
            isRefitting={excalidraw.isRefittingText}
            apiReady={Boolean(excalidraw.api)}
            canvasFrameRef={imageImport.canvasFrameRef}
            onRename={excalidraw.handleRename}
            onToggleMode={tabs.toggleActiveMode}
            onCanvasClick={references.handleExcalidrawClick}
            onNew={actions.handleNewExcalidraw}
            onOpen={() => void actions.handleOpenExcalidraw()}
            onSave={() => void excalidraw.handleSave()}
            onExportPng={excalidraw.handleExportPng}
            onFitToWindow={excalidraw.handleFitToWindow}
            onRefitText={() => void excalidraw.handleRefitText()}
            onRecover={actions.handleRecoverExcalidraw}
            onDragOver={imageImport.handleDragOver}
            onDrop={(event) => void imageImport.handleDrop(event)}
            onApi={excalidraw.setApi}
            onChange={excalidraw.handleChange}
          />
          <MermaidWorkspace
            hidden={layout.workspace !== 'mermaid'}
            title={mermaid.name}
            path={mermaid.path}
            dirty={mermaid.dirty}
            message={mermaid.message}
            subtitle={mermaid.title}
            settings={settings}
            saveFeedback={saveButtonFeedback.mermaid}
            isConverting={mermaid.isConverting}
            mode={tabs.activeMode}
            editorCollapsed={tabs.activeMode === 'view' || layout.isMermaidEditorCollapsed}
            text={mermaid.text}
            diagram={mermaid.diagram}
            error={mermaid.error}
            previewRef={mermaid.previewRef}
            viewportRef={mermaid.viewportRef}
            onRename={mermaid.handleRename}
            onToggleMode={tabs.toggleActiveMode}
            onNodeClick={references.handleMermaidClick}
            onOpen={() => void actions.handleOpenMermaid()}
            onSave={() => void mermaid.handleSave()}
            onExportPng={() => void mermaid.handleExportPng()}
            onPreviewPointerDown={references.handlePreviewPointerDown}
            onConvert={() => void actions.handleConvertMermaidToExcalidraw()}
            onToggleEditor={layout.toggleMermaidEditor}
            onTextChange={mermaid.handleTextChange}
            onKeyDown={mermaid.handleKeyDown}
          />
          <ReferencesPanel
            symbol={references.symbol}
            projectName={references.projectName}
            inProject={references.inProject}
            isIndexing={references.isIndexing}
            documents={references.documents}
            activePath={references.activePath}
            onSelect={references.select}
            onOpenBoard={board.open}
            onClose={references.close}
          />
        </div>
        <SymbolBoard
          open={board.isOpen}
          symbol={references.symbol}
          projectName={references.projectName}
          cards={board.cards}
          thumbnailFor={board.thumbnailFor}
          requestThumbnail={board.requestThumbnail}
          onSelect={board.selectCard}
          onClose={board.close}
        />
      </main>
      <SettingsDialog
        open={layout.isSettingsOpen}
        settings={settings}
        onChange={handleSettingsChange}
        onClose={layout.closeSettings}
      />
    </div>
  )
}

export default App
