import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

type MockState = {
  invocations: Array<{ cmd: string }>
  savedFiles: Record<string, string>
  confirmMessages: string[]
  exitCount: number
}

declare global {
  interface Window {
    __PLAYWRIGHT_TAURI_MOCK__?: MockState
    __PLAYWRIGHT_EMIT_TAURI_EVENT__?: (eventName: string, payload?: unknown) => Promise<void>
    __PLAYWRIGHT_SET_CONFIRM_RESULT__?: (result: boolean) => void
  }
}

const mermaidSource = readFileSync(new URL('./fixtures/mermaid-smoke.mmd', import.meta.url), 'utf8')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const savedFiles = {}
    const invocations = []
    const confirmMessages = []
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

    const fileNameFromPath = (path) => {
      const parts = path.split('/')
      return parts[parts.length - 1] ?? path
    }

    window.confirm = (message) => {
      confirmMessages.push(String(message))
      return confirmResult
    }
    window.__PLAYWRIGHT_TAURI_MOCK__ = {
      invocations,
      savedFiles,
      confirmMessages,
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
        invocations.push({ cmd })

        switch (cmd) {
          case 'list_recents':
            return []
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
          case 'load_excalidraw_path': {
            const path = args.path
            const contents = savedFiles[path]
            if (typeof contents !== 'string') {
              throw new Error(`Missing mock file for ${path}`)
            }
            return {
              path,
              name: fileNameFromPath(path),
              contents,
            }
          }
          case 'take_pending_file':
            return null
          default:
            throw new Error(`Unhandled Tauri invoke: ${cmd}`)
        }
      },
    }
  })
})

async function emitCloseRequest(page: Page) {
  await page.waitForFunction(() => (window.__PLAYWRIGHT_EMIT_TAURI_EVENT__ ? 1 : 0))
  await page.evaluate(async () => {
    await window.__PLAYWRIGHT_EMIT_TAURI_EVENT__?.('tauri://close-requested')
  })
}

async function getMockState(page: Page) {
  return await page.evaluate(() => window.__PLAYWRIGHT_TAURI_MOCK__) as MockState
}

test('converts Mermaid into a saved Excalidraw file', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: 'Mermaid' }).click()
  await page.getByLabel('Name').fill('smoke-flow')
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)

  await page.getByRole('button', { name: 'Convert & Save Excalidraw' }).click()

  await expect(page.getByRole('button', { name: 'Excalidraw' })).toHaveClass(/active/)
  await expect(page.getByLabel('File')).toHaveValue('/mock/smoke-flow.excalidraw')

  const mockState = await page.evaluate(() => window.__PLAYWRIGHT_TAURI_MOCK__) as MockState
  const savedContents = mockState.savedFiles['/mock/smoke-flow.excalidraw']
  const serialized = JSON.parse(savedContents) as {
    type?: string
    elements?: Array<{ isDeleted?: boolean }>
  }

  expect(serialized.type).toBe('excalidraw')
  expect(serialized.elements?.length ?? 0).toBeGreaterThan(0)
  expect(serialized.elements?.some((element) => element.isDeleted !== true)).toBe(true)
  expect(mockState.invocations.map((call) => call.cmd)).toEqual(
    expect.arrayContaining(['save_excalidraw_file', 'load_excalidraw_path']),
  )
})

test('exits the Tauri app from a native close request when clean', async ({ page }) => {
  await page.goto('/')

  await emitCloseRequest(page)

  const mockState = await getMockState(page)
  expect(mockState.confirmMessages).toEqual([])
  expect(mockState.exitCount).toBe(1)
  expect(mockState.invocations.map((call) => call.cmd)).toContain('exit_app')
  expect(mockState.invocations.map((call) => call.cmd)).not.toContain('plugin:window|destroy')
})

test('warns before exiting from a native close request with unsaved Excalidraw changes', async ({ page }) => {
  await page.goto('/')

  await page.getByLabel('Name').fill('close-warning')
  await page.waitForTimeout(50)
  await page.evaluate(() => window.__PLAYWRIGHT_SET_CONFIRM_RESULT__?.(false))
  await emitCloseRequest(page)

  let mockState = await getMockState(page)
  expect(mockState.confirmMessages).toHaveLength(1)
  expect(mockState.confirmMessages[0]).toContain('unsaved Excalidraw changes')
  expect(mockState.exitCount).toBe(0)

  await page.evaluate(() => window.__PLAYWRIGHT_SET_CONFIRM_RESULT__?.(true))
  await emitCloseRequest(page)

  mockState = await getMockState(page)
  expect(mockState.confirmMessages).toHaveLength(2)
  expect(mockState.exitCount).toBe(1)
})

test('shows compositor-safe Save feedback after saving Mermaid text', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: 'Mermaid' }).click()
  await page.getByLabel('Name').fill('pulse-flow')
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)

  const saveButton = page.getByRole('button', { name: /^Save$/ })
  await saveButton.click()

  await expect(page.getByText('Saved to /mock/pulse-flow.mmd.')).toBeVisible()
  await expect(saveButton).toHaveClass(/save-feedback/)
  await expect(saveButton).toHaveCSS('animation-name', 'none')
  await expect(saveButton).toHaveCSS('transition-property', 'transform')

  const mockState = await page.evaluate(() => window.__PLAYWRIGHT_TAURI_MOCK__) as MockState
  expect(mockState.savedFiles['/mock/pulse-flow.mmd']).toBe(mermaidSource)
})

test('collapses the sidebar and opens Excalidraw image export', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/)
  await expect(page.locator('.app-shell')).toHaveCSS('transition-property', 'all')
  await expect(page.locator('.app-shell')).toHaveCSS('transition-duration', '0s')

  const sidebarReturn = page.getByRole('button', { name: 'Show sidebar' })
  await expect(sidebarReturn).toHaveCSS('background-color', 'rgb(247, 195, 111)')
  await expect.poll(async () => page.evaluate(() => {
    const button = document.querySelector('.sidebar-return')
    const title = document.querySelector('.panel-header h1')
    if (!button || !title) {
      return Number.POSITIVE_INFINITY
    }
    const buttonRect = button.getBoundingClientRect()
    const titleRect = title.getBoundingClientRect()
    return Math.abs(buttonRect.right - titleRect.left)
  })).toBeLessThanOrEqual(1)

  const tabCenter = await page.evaluate(() => {
    const button = document.querySelector('.sidebar-return')
    if (!button) {
      throw new Error('Missing sidebar return button')
    }
    const buttonRect = button.getBoundingClientRect()
    return {
      x: Math.max(1, buttonRect.right - 8),
      y: buttonRect.top + buttonRect.height / 2,
    }
  })
  await page.mouse.move(tabCenter.x, tabCenter.y)
  await expect.poll(async () => page.evaluate(() => {
    const button = document.querySelector('.sidebar-return')
    if (!button) {
      return Number.NEGATIVE_INFINITY
    }
    return button.getBoundingClientRect().left
  })).toBeGreaterThanOrEqual(-1)

  await sidebarReturn.click()
  await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/)

  await page.getByRole('button', { name: 'Mermaid' }).click()
  await page.getByLabel('Name').fill('smoke-flow')
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)
  await page.getByRole('button', { name: 'Convert & Save Excalidraw' }).click()

  await expect(page.getByRole('button', { name: 'Excalidraw' })).toHaveClass(/active/)
  await expect(page.getByLabel('File')).toHaveValue('/mock/smoke-flow.excalidraw')

  await expect(page.getByLabel('Transparent background')).toHaveCount(0)
  await page.getByRole('button', { name: 'Export PNG' }).click()
  await expect(page.getByRole('heading', { name: 'Export image' }).first()).toBeVisible()
  await expect(page.getByText('Background')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export to PNG' })).toBeVisible()

  const mockState = await page.evaluate(() => window.__PLAYWRIGHT_TAURI_MOCK__) as MockState

  expect(mockState.invocations.map((call) => call.cmd)).not.toContain('save_png_file')
})

test('uses explicit motion properties and honors reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  const tabButton = page.getByRole('button', { name: 'Mermaid' })
  await expect(tabButton).not.toHaveCSS('transition-property', 'all')
  await expect(tabButton).toHaveCSS('transition-duration', '0.001s')
  await tabButton.click()

  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(page.locator('.sidebar')).toHaveCSS('transition-duration', '0.001s')

  await page.getByLabel('Name').fill('accessible-flow')
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)
  await page.getByRole('button', { name: /^Save$/ }).click()

  const status = page.getByRole('status')
  await expect(status).toHaveAttribute('aria-live', 'polite')
  await expect(status.locator('.status-message')).toHaveCSS('animation-duration', '0.001s')
})

test('imports dropped image files into the Excalidraw canvas', async ({ page }) => {
  await page.goto('/')

  const frame = page.locator('.canvas-frame')
  const box = await frame.boundingBox()
  expect(box).not.toBeNull()

  const dataTransfer = await page.evaluateHandle(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 80
    canvas.height = 48
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Unable to create canvas context')
    }
    context.fillStyle = '#2f80ed'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#ffffff'
    context.fillRect(20, 12, 40, 24)

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((nextBlob) => {
        if (nextBlob) {
          resolve(nextBlob)
        } else {
          reject(new Error('Unable to create PNG blob'))
        }
      }, 'image/png')
    })
    const file = new File([blob], 'badge.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    return transfer
  })

  await frame.dispatchEvent('dragover', {
    dataTransfer,
    clientX: box!.x + box!.width / 2,
    clientY: box!.y + box!.height / 2,
  })
  await frame.dispatchEvent('drop', {
    dataTransfer,
    clientX: box!.x + box!.width / 2,
    clientY: box!.y + box!.height / 2,
  })

  await expect(page.getByText('Imported badge.png.')).toBeVisible()

  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem('excalibur.excalidraw.autosave.current')
    if (!raw) {
      return 0
    }
    const autosave = JSON.parse(raw)
    const scene = JSON.parse(autosave.contents)
    return scene.elements.filter((element) => element.type === 'image' && element.isDeleted !== true).length
  })).toBe(1)

  const imported = await page.evaluate(() => {
    const raw = window.localStorage.getItem('excalibur.excalidraw.autosave.current')
    if (!raw) {
      throw new Error('Missing autosave')
    }
    const autosave = JSON.parse(raw)
    const scene = JSON.parse(autosave.contents)
    const imageElement = scene.elements.find((element) => element.type === 'image')
    const file = imageElement ? scene.files[imageElement.fileId] : null
    return { imageElement, file }
  })

  expect(imported.imageElement.width).toBe(80)
  expect(imported.imageElement.height).toBe(48)
  expect(imported.file.mimeType).toBe('image/png')
  expect(imported.file.dataURL).toContain('data:image/png;base64,')
})
