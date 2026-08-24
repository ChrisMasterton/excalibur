import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AGENT_PROMPT_PRESETS,
  agentPromptInputError,
  agentPromptPreset,
  buildAgentPrompt,
  collectPromptSymbols,
  EMPTY_AGENT_PROMPT_INPUTS,
  isAgentPromptPreset,
  type AgentPromptFile,
  type AgentPromptInputs,
  type AgentPromptPreset,
} from '../lib/agentPrompt'
import { copyText } from '../lib/clipboard'
import { api, errorMessage } from '../lib/tauri'
import type { SymbolIndexApi } from '../hooks/useSymbolIndex'
import type { ProjectItem } from '../types'
import { IconButton } from './IconButton'

const PRESET_STORAGE_KEY = 'excalibur.agentPrompt.preset'
const COPY_FEEDBACK_MS = 1400

type AgentPromptDialogProps = {
  /** The project the prompt is for; `null` keeps the dialog closed. */
  project: ProjectItem | null
  symbolIndex: SymbolIndexApi
  onClose: () => void
}

function readStoredPreset(): AgentPromptPreset {
  const raw = window.localStorage.getItem(PRESET_STORAGE_KEY)
  return raw && isAgentPromptPreset(raw) ? raw : 'overview'
}

/**
 * Composes the prompt a user pastes into a coding agent so the Mermaid files it
 * writes drop straight into this project folder, named the way the diagrams
 * already there are named.
 *
 * Keyed on the project path, so every open starts from a clean sheet — only the
 * chosen preset is remembered, in localStorage.
 */
export function AgentPromptDialog({ project, symbolIndex, onClose }: AgentPromptDialogProps) {
  if (!project) {
    return null
  }
  return (
    <AgentPromptPanel
      key={project.path}
      project={project}
      symbolIndex={symbolIndex}
      onClose={onClose}
    />
  )
}

function AgentPromptPanel({
  project,
  symbolIndex,
  onClose,
}: {
  project: ProjectItem
  symbolIndex: SymbolIndexApi
  onClose: () => void
}) {
  const titleId = useId()
  const presetName = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const copyTimerRef = useRef<number | null>(null)

  const [preset, setPreset] = useState<AgentPromptPreset>(readStoredPreset)
  const [inputs, setInputs] = useState<AgentPromptInputs>(EMPTY_AGENT_PROMPT_INPUTS)
  const [files, setFiles] = useState<AgentPromptFile[]>([])
  const [filesError, setFilesError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const { ensureIndex, entriesFor, status } = symbolIndex
  const projectPath = project.path

  useEffect(() => {
    window.localStorage.setItem(PRESET_STORAGE_KEY, preset)
  }, [preset])

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    },
    [],
  )

  // Opening the dialog is the ask that starts (or refreshes) the symbol index.
  useEffect(() => {
    ensureIndex()
    let cancelled = false
    api
      .listProjectFiles(projectPath)
      .then((listing) => {
        if (cancelled) {
          return
        }
        setFiles(
          [...listing]
            .sort((a, b) => a.relative_path.localeCompare(b.relative_path))
            .map((file) => ({ relativePath: file.relative_path, title: file.title ?? null })),
        )
      })
      .catch((error) => {
        if (!cancelled) {
          setFilesError(errorMessage(error, 'Unable to read the project folder.'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [ensureIndex, projectPath])

  const symbols = useMemo(
    () => collectPromptSymbols(entriesFor(projectPath)),
    [entriesFor, projectPath],
  )

  const definition = agentPromptPreset(preset)
  const inputError = agentPromptInputError(preset, inputs)

  const prompt = useMemo(
    () =>
      buildAgentPrompt({
        preset,
        inputs,
        project: { name: project.name, path: project.path },
        files,
        symbols,
      }),
    [files, inputs, preset, project.name, project.path, symbols],
  )

  const copy = useCallback(() => {
    if (inputError) {
      return
    }
    void copyText(prompt).then((ok) => {
      setCopyState(ok ? 'copied' : 'failed')
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopyState('idle')
        copyTimerRef.current = null
      }, COPY_FEEDBACK_MS)
    })
  }, [inputError, prompt])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        copy()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    panelRef.current?.querySelector<HTMLElement>('input, textarea, button')?.focus()
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [copy, onClose])

  const field = definition.field
  const setField = (key: keyof AgentPromptInputs, value: string) => {
    setInputs((current) => ({ ...current, [key]: value }))
  }

  const statusText = () => {
    if (copyState === 'copied') {
      return 'Copied to the clipboard.'
    }
    if (copyState === 'failed') {
      return 'Unable to copy — select the text above and copy it manually.'
    }
    if (inputError) {
      return inputError
    }
    if (filesError) {
      return filesError
    }
    if (status.isIndexing) {
      return `Indexing project… ${status.indexed}/${status.total}`
    }
    return `${symbols.length} project names included · ⌘/Ctrl+Enter copies`
  }

  return createPortal(
    <div
      className="settings-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        className="settings-dialog agent-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="settings-header">
          <div>
            <h2 id={titleId}>Coding agent prompt</h2>
            <p>
              {project.name} · {project.path}
            </p>
          </div>
          <IconButton icon="x" label="Close coding agent prompt" onClick={onClose} />
        </header>

        <div className="settings-body agent-prompt-body">
          <fieldset className="agent-prompt-presets">
            <legend>What should the agent diagram?</legend>
            <div className="agent-prompt-preset-row">
              {AGENT_PROMPT_PRESETS.map((option) => (
                <label
                  key={option.id}
                  className={`agent-prompt-preset${option.id === preset ? ' is-selected' : ''}`}
                >
                  <input
                    type="radio"
                    name={presetName}
                    value={option.id}
                    checked={option.id === preset}
                    onChange={() => setPreset(option.id)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {field ? (
            <label className="agent-prompt-field">
              <span className="agent-prompt-field-label">{definition.fieldLabel}</span>
              {definition.multiline ? (
                <textarea
                  aria-label={definition.fieldLabel}
                  rows={3}
                  placeholder={definition.fieldPlaceholder}
                  value={inputs[field]}
                  onChange={(event) => setField(field, event.target.value)}
                />
              ) : (
                <input
                  type="text"
                  aria-label={definition.fieldLabel}
                  placeholder={definition.fieldPlaceholder}
                  value={inputs[field]}
                  onChange={(event) => setField(field, event.target.value)}
                />
              )}
            </label>
          ) : null}

          <label className="agent-prompt-field agent-prompt-preview-field">
            <span className="agent-prompt-field-label">Prompt</span>
            <textarea
              className="agent-prompt-preview"
              aria-label="Prompt preview"
              readOnly
              spellCheck={false}
              value={prompt}
            />
          </label>
        </div>

        <footer className="settings-footer agent-prompt-footer">
          <p className="agent-prompt-status" role="status">
            {statusText()}
          </p>
          <IconButton
            icon="copy"
            label="Copy prompt"
            showLabel
            primary
            feedback={copyState === 'copied'}
            disabled={Boolean(inputError)}
            onClick={copy}
          />
        </footer>
      </div>
    </div>,
    document.body,
  )
}
