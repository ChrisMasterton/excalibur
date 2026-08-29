import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { DiagramKind } from '../types'
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from '../hooks/useAppLayout'
import { Icon } from './Icon'
import { IconButton } from './IconButton'

export type SidebarPanel = 'recent' | 'projects'

type SidebarProps = {
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  workspace: DiagramKind
  onWorkspaceChange: (workspace: DiagramKind) => void
  panel: SidebarPanel
  onPanelChange: (panel: SidebarPanel) => void
  dirty: Record<DiagramKind, boolean>
  onOpenSettings: () => void
  width: number
  onWidthChange: (width: number) => void
  children: ReactNode
}

const WORKSPACES: Array<{ kind: DiagramKind; label: string; icon: 'pen' | 'branch' }> = [
  { kind: 'excalidraw', label: 'Excalidraw', icon: 'pen' },
  { kind: 'mermaid', label: 'Mermaid', icon: 'branch' },
]

const PANELS: Array<{ id: SidebarPanel; label: string }> = [
  { id: 'recent', label: 'Recent' },
  { id: 'projects', label: 'Projects' },
]

export function Sidebar({
  collapsed,
  onCollapsedChange,
  workspace,
  onWorkspaceChange,
  panel,
  onPanelChange,
  dirty,
  onOpenSettings,
  width,
  onWidthChange,
  children,
}: SidebarProps) {
  const dragOffsetRef = useRef(0)

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      dragOffsetRef.current = width - event.clientX
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    [width],
  )

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
      onWidthChange(event.clientX + dragOffsetRef.current)
    },
    [onWidthChange],
  )

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        onWidthChange(width - 16)
        event.preventDefault()
      } else if (event.key === 'ArrowRight') {
        onWidthChange(width + 16)
        event.preventDefault()
      }
    },
    [onWidthChange, width],
  )

  return (
    <>
      <button
        className="sidebar-return"
        type="button"
        aria-expanded={!collapsed}
        aria-label="Show sidebar"
        onClick={() => onCollapsedChange(false)}
      >
        Show sidebar
      </button>
      <aside className="sidebar" aria-hidden={collapsed}>
        <div className="brand-row">
          <div className="brand">
            <div className="brand-title">Excalibur</div>
            <div className="brand-sub">Excalidraw + Mermaid</div>
          </div>
          <div className="brand-actions">
            <IconButton icon="settings" label="Settings" className="sidebar-hide" onClick={onOpenSettings} />
            <IconButton
              icon="panel-left"
              label="Hide sidebar"
              className="sidebar-hide"
              aria-expanded={!collapsed}
              onClick={() => onCollapsedChange(true)}
            />
          </div>
        </div>

        <div className="tab-buttons" role="tablist" aria-label="Workspace">
          {WORKSPACES.map((item) => (
            <button
              key={item.kind}
              type="button"
              role="tab"
              aria-selected={workspace === item.kind}
              className={`tab-button${workspace === item.kind ? ' active' : ''}`}
              onClick={() => onWorkspaceChange(item.kind)}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
              {dirty[item.kind] ? <span className="dirty-dot" title="Unsaved changes" /> : null}
            </button>
          ))}
        </div>

        <div className="sidebar-panels">
          <div className="panel-tabs" role="tablist" aria-label="Files">
            {PANELS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={panel === item.id}
                className={`panel-tab${panel === item.id ? ' active' : ''}`}
                onClick={() => onPanelChange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="panel-body" role="tabpanel">
            {children}
          </div>
        </div>
        <div
          className="sidebar-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={collapsed ? -1 : 0}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onKeyDown={handleResizeKeyDown}
          onDoubleClick={() => onWidthChange(SIDEBAR_DEFAULT_WIDTH)}
        />
      </aside>
    </>
  )
}
