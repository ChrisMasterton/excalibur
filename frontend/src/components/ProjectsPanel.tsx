import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import { api, errorMessage } from '../lib/tauri'
import type { DiagramKind, ProjectFile, ProjectItem } from '../types'
import { useContextMenu } from '../hooks/useContextMenu'
import { EditableTitle } from './EditableTitle'
import { Icon } from './Icon'
import { IconButton } from './IconButton'
import { buildMoveToProjectItems, kindIcon } from '../lib/menus'

const EXPANDED_STORAGE_KEY = 'excalibur.projects.expanded'

type ProjectFilesState = {
  files: ProjectFile[]
  loading: boolean
  error: string | null
}

type ProjectsPanelProps = {
  projects: ProjectItem[]
  /** Bump to re-scan every expanded project (e.g. after a save or move). */
  refreshToken: number
  activePaths: Record<DiagramKind, string | null>
  onAddProject: () => void
  onRemoveProject: (project: ProjectItem) => void
  onRenameProject: (project: ProjectItem, name: string) => Promise<void>
  onOpenFile: (file: ProjectFile) => void
  onMoveFile: (file: ProjectFile, project: ProjectItem) => void
  onMoveFileToNewProject: (file: ProjectFile) => void
  onError: (message: string) => void
}

function readExpanded(): string[] {
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export function ProjectsPanel({
  projects,
  refreshToken,
  activePaths,
  onAddProject,
  onRemoveProject,
  onRenameProject,
  onOpenFile,
  onMoveFile,
  onMoveFileToNewProject,
  onError,
}: ProjectsPanelProps) {
  const [expanded, setExpanded] = useState<string[]>(readExpanded)
  const [filesByProject, setFilesByProject] = useState<Record<string, ProjectFilesState>>({})
  const [renaming, setRenaming] = useState<string | null>(null)
  const menu = useContextMenu()

  useEffect(() => {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(expanded))
  }, [expanded])

  const loadFiles = useCallback(async (path: string) => {
    setFilesByProject((current) => ({
      ...current,
      [path]: { files: current[path]?.files ?? [], loading: true, error: null },
    }))
    try {
      const files = await api.listProjectFiles(path)
      setFilesByProject((current) => ({ ...current, [path]: { files, loading: false, error: null } }))
    } catch (error) {
      setFilesByProject((current) => ({
        ...current,
        [path]: { files: [], loading: false, error: errorMessage(error, 'Unable to read folder.') },
      }))
    }
  }, [])

  useEffect(() => {
    for (const project of projects) {
      if (expanded.includes(project.path)) {
        void loadFiles(project.path)
      }
    }
    // refreshToken intentionally re-runs the scan.
  }, [expanded, loadFiles, projects, refreshToken])

  const toggle = (path: string) => {
    setExpanded((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    )
  }

  const openProjectMenu = (event: MouseEvent, project: ProjectItem) => {
    menu.open(event, [
      { label: 'Rename project', icon: 'pencil', onSelect: () => setRenaming(project.path) },
      { label: 'Rescan folder', icon: 'refresh', onSelect: () => void loadFiles(project.path) },
      { separator: true },
      {
        label: 'Remove from projects',
        icon: 'x',
        danger: true,
        onSelect: () => onRemoveProject(project),
      },
    ])
  }

  const openFileMenu = (event: MouseEvent, file: ProjectFile, project: ProjectItem) => {
    menu.open(event, [
      { label: 'Open', icon: kindIcon(file.kind), onSelect: () => onOpenFile(file) },
      {
        label: 'Move to project',
        icon: 'folder-input',
        children: buildMoveToProjectItems(
          projects,
          project.path,
          (target) => onMoveFile(file, target),
          () => onMoveFileToNewProject(file),
        ),
      },
    ])
  }

  return (
    <div className="projects-panel">
      <button type="button" className="add-project" onClick={onAddProject}>
        <Icon name="folder-plus" size={16} />
        <span>Add project folder…</span>
      </button>
      {!projects.length ? (
        <div className="empty">
          A project is just a folder. Add one and every .excalidraw, .mmd, or .mermaid file inside it shows up here.
        </div>
      ) : null}
      <div className="project-list">
        {projects.map((project) => {
          const isExpanded = expanded.includes(project.path)
          const state = filesByProject[project.path]
          return (
            <div key={project.path} className={`project${isExpanded ? ' is-expanded' : ''}`}>
              <div className="project-header" onContextMenu={(event) => openProjectMenu(event, project)}>
                <button
                  type="button"
                  className="project-toggle"
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${project.name}`}
                  onClick={() => toggle(project.path)}
                >
                  <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
                  <Icon name="folder" size={16} className="project-icon" />
                </button>
                <EditableTitle
                  value={project.name}
                  label={`Project name for ${project.name}`}
                  className="project-name"
                  autoEdit={renaming === project.path}
                  onEditingChange={(editing) => {
                    if (!editing && renaming === project.path) {
                      setRenaming(null)
                    }
                  }}
                  onCommit={async (name) => {
                    try {
                      await onRenameProject(project, name)
                    } catch (error) {
                      onError(errorMessage(error, 'Unable to rename project.'))
                      throw error
                    }
                  }}
                />
                <IconButton
                  icon="more"
                  label={`More actions for ${project.name}`}
                  size="sm"
                  className="file-row-more"
                  onClick={(event) => openProjectMenu(event, project)}
                />
              </div>
              {isExpanded ? (
                <div className="project-files">
                  {state?.error ? <div className="empty is-error">{state.error}</div> : null}
                  {state && !state.loading && !state.error && !state.files.length ? (
                    <div className="empty">No diagrams in this folder yet. Save one here and it will appear.</div>
                  ) : null}
                  {state?.files.map((file) => {
                    const active = activePaths[file.kind] === file.path
                    return (
                      <div
                        key={file.path}
                        className={`file-row is-nested${active ? ' is-active' : ''}`}
                        onContextMenu={(event) => openFileMenu(event, file, project)}
                      >
                        <button
                          type="button"
                          className="file-row-main"
                          onClick={() => onOpenFile(file)}
                          title={file.path}
                        >
                          <Icon name={kindIcon(file.kind)} size={16} className="file-row-icon" />
                          <span className="file-row-text">
                            <span className="file-row-name">{file.title || file.name}</span>
                            {file.title || file.relative_path !== file.name ? (
                              <span className="file-row-path">{file.relative_path}</span>
                            ) : null}
                          </span>
                        </button>
                        <IconButton
                          icon="more"
                          label={`More actions for ${file.name}`}
                          size="sm"
                          className="file-row-more"
                          onClick={(event) => openFileMenu(event, file, project)}
                        />
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {menu.element}
    </div>
  )
}
