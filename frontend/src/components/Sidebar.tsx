import type { ReactNode } from 'react'
import type { DiagramKind } from '../types'
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
  children,
}: SidebarProps) {
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
      </aside>
    </>
  )
}
