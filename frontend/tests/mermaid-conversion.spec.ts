import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

type MockState = {
  invocations: Array<{ cmd: string }>
  savedFiles: Record<string, string>
}

declare global {
  interface Window {
    __PLAYWRIGHT_TAURI_MOCK__?: MockState
  }
}

const mermaidSource = readFileSync(new URL('./fixtures/mermaid-smoke.mmd', import.meta.url), 'utf8')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const savedFiles = {}
    const invocations = []
    let callbackId = 0
    let listenerId = 0

    const getExcalidrawFileName = (name) => {
      const trimmed = typeof name === 'string' ? name.trim() : ''
      const baseName = trimmed || 'drawing'
      return baseName.endsWith('.excalidraw') || baseName.endsWith('.json')
        ? baseName
        : `${baseName}.excalidraw`
    }

    const fileNameFromPath = (path) => {
      const parts = path.split('/')
      return parts[parts.length - 1] ?? path
    }

    window.confirm = () => true
    window.__PLAYWRIGHT_TAURI_MOCK__ = {
      invocations,
      savedFiles,
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
      transformCallback() {
        callbackId += 1
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
            return listenerId
          case 'plugin:event|unlisten':
            return null
          case 'save_excalidraw_file': {
            const request = args.request ?? {}
            const path = request.path ?? `/mock/${getExcalidrawFileName(request.name)}`
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
