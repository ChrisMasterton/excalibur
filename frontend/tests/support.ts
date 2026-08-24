import { expect, type Page } from '@playwright/test'

export type MockState = {
  invocations: Array<{ cmd: string; args: Record<string, unknown> }>
  savedFiles: Record<string, string>
  settings: Record<string, unknown>
  confirmMessages: string[]
  recents: Array<{ kind: string; path: string }>
  savedPngs: Array<{ name: string; path: string; byteLength: number; digest: string }>
  exitCount: number
}

export type MockSeed = {
  files?: Record<string, string>
  projects?: Array<{ path: string; name: string; added_at: number }>
  projectFiles?: Record<string, Array<Record<string, unknown>>>
}

declare global {
  interface Window {
    __PLAYWRIGHT_TAURI_MOCK__?: MockState
    __PLAYWRIGHT_TAURI_SEED__?: MockSeed
    __PLAYWRIGHT_EMIT_TAURI_EVENT__?: (eventName: string, payload?: unknown) => Promise<void>
    __PLAYWRIGHT_SET_CONFIRM_RESULT__?: (result: boolean) => void
  }
}

/** Seeds files/projects the mocked backend should serve. Must run before `page.goto`. */
export async function seedBackend(page: Page, seed: MockSeed) {
  await page.addInitScript((value) => {
    window.__PLAYWRIGHT_TAURI_SEED__ = value
  }, seed)
}

/** Installs the mocked Tauri backend. Must run before `page.goto`. */
export async function installTauriMock(page: Page) {
  await page.addInitScript(() => {
    const savedFiles = {}
    const settings = {}
    const invocations = []
    const confirmMessages = []
    const recents = []
    const savedPngs = []
    const listeners = {}
    const listenerEntries = {}
    const callbacks = {}
    let callbackId = 0
    let listenerId = 0
    let confirmResult = true

    const getExcalidrawFileName = (name) => {
      const trimmed = typeof name === 'string' ? name.trim() : ''
      const baseName = trimmed || 'drawing'
      return baseName.endsWith('.excalidraw') || baseName.endsWith('.json')
        ? baseName
        : `${baseName}.excalidraw`
    }

    const getMermaidFileName = (name) => {
      const trimmed = typeof name === 'string' ? name.trim() : ''
      const baseName = trimmed || 'diagram'
      return baseName.endsWith('.mmd') || baseName.endsWith('.mermaid')
        ? baseName
        : `${baseName}.mmd`
    }

    /** Cheap FNV-1a over the PNG bytes, so a test can say "the same image came out". */
    const digestBytes = (bytes) => {
      let hash = 2166136261
      for (let index = 0; index < bytes.length; index += 1) {
        hash ^= bytes[index]
        hash = Math.imul(hash, 16777619)
      }
      return (hash >>> 0).toString(16)
    }

    const fileNameFromPath = (path) => {
      const parts = path.split('/')
      return parts[parts.length - 1] ?? path
    }

    window.confirm = (message) => {
      confirmMessages.push(String(message))
      return confirmResult
    }
    const seed = () => window.__PLAYWRIGHT_TAURI_SEED__ ?? {}
    const readFile = (path) => {
      const contents = savedFiles[path] ?? (seed().files ?? {})[path]
      if (typeof contents !== 'string') {
        throw new Error(`Missing mock file for ${path}`)
      }
      return contents
    }
    const trackRecent = (kind, path) => {
      const existing = recents.findIndex((item) => item.path === path)
      if (existing !== -1) {
        recents.splice(existing, 1)
      }
      recents.unshift({ kind, path, name: fileNameFromPath(path), updated_at: Date.now() })
    }

    window.__PLAYWRIGHT_TAURI_MOCK__ = {
      invocations,
      savedFiles,
      settings,
      confirmMessages,
      recents,
      savedPngs,
      exitCount: 0,
    }
    window.__PLAYWRIGHT_SET_CONFIRM_RESULT__ = (result) => {
      confirmResult = result
    }
    window.__PLAYWRIGHT_EMIT_TAURI_EVENT__ = async (eventName, payload = null) => {
      const listenerIds = [...(listeners[eventName] ?? [])]
      for (const id of listenerIds) {
        const entry = listenerEntries[id]
        if (!entry) {
          continue
        }
        await callbacks[entry.handler]?.({
          event: eventName,
          id,
          payload,
        })
      }
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener() {},
    }
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: {
          label: 'main',
        },
      },
      transformCallback(callback) {
        callbackId += 1
        callbacks[callbackId] = callback
        return callbackId
      },
      unregisterCallback() {},
      async invoke(cmd, args = {}) {
        const loggedArgs = { ...(args ?? {}) }
        delete loggedArgs.request
        invocations.push({ cmd, args: loggedArgs })

        switch (cmd) {
          case 'list_recents':
            return [...recents]
          case 'remove_recent':
            return []
          case 'list_projects':
            return seed().projects ?? []
          case 'list_project_files':
            return (seed().projectFiles ?? {})[args.path] ?? []
          case 'load_settings':
            return { ...settings }
          case 'save_settings':
            Object.assign(settings, args.settings)
            return null
          case 'plugin:event|listen':
            listenerId += 1
            listenerEntries[listenerId] = {
              event: args.event,
              handler: args.handler,
            }
            if (!listeners[args.event]) {
              listeners[args.event] = []
            }
            listeners[args.event].push(listenerId)
            return listenerId
          case 'plugin:event|unlisten':
            if (listenerEntries[args.eventId]) {
              const eventName = listenerEntries[args.eventId].event
              listeners[eventName] = (listeners[eventName] ?? []).filter((id) => id !== args.eventId)
              delete listenerEntries[args.eventId]
            }
            return null
          case 'exit_app':
            window.__PLAYWRIGHT_TAURI_MOCK__.exitCount += 1
            return null
          case 'save_excalidraw_file': {
            const request = args.request ?? {}
            const path = request.path ?? `/mock/${getExcalidrawFileName(request.name)}`
            savedFiles[path] = request.contents
            return { path }
          }
          case 'save_mermaid_file': {
            const request = args.request ?? {}
            const path = request.path ?? `/mock/${getMermaidFileName(request.name)}`
            savedFiles[path] = request.contents
            return { path }
          }
          case 'save_png_file': {
            const request = args.request ?? {}
            const trimmed = typeof request.name === 'string' ? request.name.trim() : ''
            const base = trimmed || 'drawing'
            const name = base.toLowerCase().endsWith('.png') ? base : `${base}.png`
            const path = `/mock/${name}`
            const bytes = request.contents ?? []
            savedPngs.push({ name, path, byteLength: bytes.length, digest: digestBytes(bytes) })
            return { path }
          }
          case 'load_excalidraw_path':
          case 'load_mermaid_path': {
            const path = args.path
            const contents = readFile(path)
            if (args.trackRecent !== false) {
              trackRecent(cmd === 'load_excalidraw_path' ? 'excalidraw' : 'mermaid', path)
            }
            return {
              path,
              name: fileNameFromPath(path),
              contents,
            }
          }
          case 'take_pending_file':
            return null
          case 'rename_file': {
            const oldPath = args.path
            const directory = oldPath.slice(0, oldPath.lastIndexOf('/'))
            const ext = oldPath.slice(oldPath.lastIndexOf('.'))
            const nextPath = `${directory}/${args.name}${ext}`
            savedFiles[nextPath] = savedFiles[oldPath]
            delete savedFiles[oldPath]
            return nextPath
          }
          default:
            throw new Error(`Unhandled Tauri invoke: ${cmd}`)
        }
      },
    }
  })
}

export async function getMockState(page: Page) {
  return (await page.evaluate(() => window.__PLAYWRIGHT_TAURI_MOCK__)) as MockState
}

/** Existing files open in view mode, so tests that edit one have to ask for the editor. */
export async function enterEditMode(page: Page) {
  const panel = page.locator('.workspace-panel:not([hidden])')
  await panel.getByRole('button', { name: 'Viewing' }).click()
  await expect(panel.getByRole('button', { name: 'Editing' })).toBeVisible()
}

/** The toolbar title is an inline editor: click it, type, press Enter. */
export async function setDocumentName(page: Page, kind: 'Excalidraw' | 'Mermaid', name: string) {
  await page.getByRole('button', { name: `${kind} document name` }).click()
  const input = page.getByRole('textbox', { name: `${kind} document name` })
  await input.fill(name)
  await input.press('Enter')
  await expect(page.getByRole('button', { name: `${kind} document name` })).toHaveText(name)
}

/** Whether the Excalidraw interactive layer has anything painted on it (a selection border). */
export function hasCanvasSelection(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.canvas-frame canvas.interactive')
    const context = canvas?.getContext('2d')
    // A hidden workspace measures 0x0 until the canvas has re-measured itself.
    if (!canvas || !context || !canvas.width || !canvas.height) {
      return false
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) {
        return true
      }
    }
    return false
  })
}

/** Opens a file from the Projects panel, expanding the project first if it is collapsed. */
export async function openProjectFile(page: Page, projectName: string, path: string) {
  await page.getByRole('tab', { name: 'Projects' }).click()
  const expand = page.getByRole('button', { name: `Expand ${projectName}` })
  if (await expand.count()) {
    await expand.click()
  }
  const row = page.locator(`.file-row-main[title="${path}"]`)
  await expect(row).toBeVisible()
  await row.click()
}
