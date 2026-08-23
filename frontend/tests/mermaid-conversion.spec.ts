import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  enterEditMode,
  getMockState,
  installTauriMock,
  seedBackend,
  setDocumentName,
  type MockSeed,
} from './support'

const mermaidSource = readFileSync(new URL('./fixtures/mermaid-smoke.mmd', import.meta.url), 'utf8')

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
})

async function emitCloseRequest(page: Page) {
  await page.waitForFunction(() => (window.__PLAYWRIGHT_EMIT_TAURI_EVENT__ ? 1 : 0))
  await page.evaluate(async () => {
    await window.__PLAYWRIGHT_EMIT_TAURI_EVENT__?.('tauri://close-requested')
  })
}

async function convertMermaid(page: Page, name: string) {
  await page.getByRole('tab', { name: 'Mermaid' }).click()
  const title = page.getByRole('button', { name: 'Mermaid document name' })
  if ((await title.textContent())?.trim() !== name) {
    await setDocumentName(page, 'Mermaid', name)
  }
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)
  await page.getByRole('button', { name: 'Convert to Excalidraw' }).click()
  await expect(page.getByRole('tab', { name: 'Excalidraw' })).toHaveClass(/active/)
  await expect(page.getByRole('button', { name: 'Excalidraw document name' })).toHaveText(name)
  await expect(page.getByTestId('excalidraw-path')).toHaveText('Not saved yet')
}

type SceneElement = {
  id: string
  type: string
  isDeleted?: boolean
  containerId?: string | null
  x: number
  y: number
  width: number
  height: number
}

async function readAutosavedScene(page: Page) {
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem('excalibur.excalidraw.autosave.current')
    if (!raw) {
      return 0
    }
    const scene = JSON.parse(JSON.parse(raw).contents)
    return scene.elements.length
  })).toBeGreaterThan(0)
  return await page.evaluate(() => {
    const raw = window.localStorage.getItem('excalibur.excalidraw.autosave.current')
    return JSON.parse(JSON.parse(raw!).contents) as { elements: SceneElement[] }
  })
}

test('converts Mermaid onto the canvas and saves it as an Excalidraw file', async ({ page }) => {
  await page.goto('/')

  await convertMermaid(page, 'smoke-flow')

  const mockStateBeforeSave = await getMockState(page)
  expect(mockStateBeforeSave.invocations.map((call) => call.cmd)).not.toContain('save_excalidraw_file')

  await page.getByRole('button', { name: /^Save$/ }).click()
  await expect(page.getByTestId('excalidraw-path')).toHaveAttribute('data-path', '/mock/smoke-flow.excalidraw')
  await expect(page.getByText('Saved smoke-flow.excalidraw.')).toBeVisible()

  const mockState = await getMockState(page)
  const savedContents = mockState.savedFiles['/mock/smoke-flow.excalidraw']
  const serialized = JSON.parse(savedContents) as {
    type?: string
    elements?: Array<{ isDeleted?: boolean }>
  }

  expect(serialized.type).toBe('excalidraw')
  expect(serialized.elements?.length ?? 0).toBeGreaterThan(0)
  expect(serialized.elements?.some((element) => element.isDeleted !== true)).toBe(true)
})

test('sizes converted labels so they fit inside their containers', async ({ page }) => {
  await page.goto('/')

  await convertMermaid(page, 'fit-check')
  const scene = await readAutosavedScene(page)
  const byId = new Map(scene.elements.map((element) => [element.id, element]))
  const boundLabels = scene.elements.filter(
    (element) => element.type === 'text' && !element.isDeleted && element.containerId,
  )
  expect(boundLabels.length).toBeGreaterThan(4)

  const PADDING = 5
  for (const label of boundLabels) {
    const container = byId.get(label.containerId!)
    expect(container, `container for ${label.id}`).toBeTruthy()
    if (!container || container.type === 'arrow') {
      continue
    }
    let maxWidth = container.width - PADDING * 2
    let maxHeight = container.height - PADDING * 2
    if (container.type === 'ellipse') {
      maxWidth = Math.round((container.width / 2) * Math.SQRT2) - PADDING * 2
      maxHeight = Math.round((container.height / 2) * Math.SQRT2) - PADDING * 2
    } else if (container.type === 'diamond') {
      maxWidth = Math.round(container.width / 2) - PADDING * 2
      maxHeight = Math.round(container.height / 2) - PADDING * 2
    }
    expect(label.width, `label width in ${container.type} ${container.id}`).toBeLessThanOrEqual(maxWidth + 1)
    expect(label.height, `label height in ${container.type} ${container.id}`).toBeLessThanOrEqual(maxHeight + 1)
    // Label stays inside the container's box.
    expect(label.x).toBeGreaterThanOrEqual(container.x - 1)
    expect(label.x + label.width).toBeLessThanOrEqual(container.x + container.width + 1)
  }
})

test('shows the Mermaid frontmatter title and uses it to name the conversion', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('tab', { name: 'Mermaid' }).click()
  await expect(page.getByTestId('mermaid-subtitle')).toHaveCount(0)

  await page.locator('.mermaid-editor textarea').fill(`---\ntitle: "Smoke: flow"\n---\n${mermaidSource}`)
  await expect(page.getByTestId('mermaid-subtitle')).toHaveText('Smoke: flow')

  // Zoom in, then the toolbar fit button should bring the diagram back to a fitted scale.
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  const zoomedLabel = await page.locator('.zoom-pan-percent').textContent()
  await page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: 'Fit to window' }).click()
  await expect(page.locator('.zoom-pan-percent')).not.toHaveText(zoomedLabel ?? '')

  await page.getByRole('button', { name: 'Convert to Excalidraw' }).click()
  await expect(page.getByRole('tab', { name: 'Excalidraw' })).toHaveClass(/active/)
  await expect(page.getByRole('button', { name: 'Excalidraw document name' })).toHaveText('Smoke flow')

  await page.getByRole('button', { name: 'Fit to window' }).click()
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem('excalibur.excalidraw.autosave.current')
    return raw ? JSON.parse(JSON.parse(raw).contents).elements.length : 0
  })).toBeGreaterThan(0)
  await expect(page.getByText('Nothing on the canvas to fit yet.')).toHaveCount(0)
})

test('edits global settings and applies zoom speed to the Mermaid preview', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('tab', { name: 'Mermaid' }).click()
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)
  await expect(page.locator('.zoom-pan-percent')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Zoom speed').fill('2')
  await dialog.getByLabel('Scroll wheel action').selectOption('zoom')
  await dialog.getByLabel('Editor font size').fill('18')

  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toHaveCount(0)

  const mockState = await getMockState(page)
  expect(mockState.settings).toMatchObject({ previewZoomSpeed: 2, previewWheelAction: 'zoom', mermaidEditorFontSize: 18 })
  await expect(page.locator('.mermaid-editor textarea')).toHaveCSS('font-size', '18px')

  // Zoom buttons step by 1 + 0.25 * speed = 1.5× instead of 1.25×.
  await page.locator('.zoom-pan-percent').click()
  await expect(page.locator('.zoom-pan-percent')).toHaveText('100%')
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(page.locator('.zoom-pan-percent')).toHaveText('150%')

  await page.keyboard.press('ControlOrMeta+,')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
})

test('renames the open document through the toolbar title', async ({ page }) => {
  await page.goto('/')

  await convertMermaid(page, 'before-rename')
  await page.getByRole('button', { name: /^Save$/ }).click()
  await expect(page.getByTestId('excalidraw-path')).toHaveAttribute('data-path', '/mock/before-rename.excalidraw')

  await setDocumentName(page, 'Excalidraw', 'after-rename')
  await expect(page.getByTestId('excalidraw-path')).toHaveAttribute('data-path', '/mock/after-rename.excalidraw')

  const mockState = await getMockState(page)
  expect(mockState.invocations.map((call) => call.cmd)).toContain('rename_file')
  expect(Object.keys(mockState.savedFiles)).toEqual(['/mock/after-rename.excalidraw'])
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

  // Save the Mermaid source first so only the converted drawing is dirty.
  await page.getByRole('tab', { name: 'Mermaid' }).click()
  await setDocumentName(page, 'Mermaid', 'close-warning')
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)
  await page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: /^Save$/ }).click()
  await expect(page.getByText('Saved close-warning.mmd.')).toBeVisible()
  await convertMermaid(page, 'close-warning')
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

  await page.getByRole('tab', { name: 'Mermaid' }).click()
  await setDocumentName(page, 'Mermaid', 'pulse-flow')
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)

  const saveButton = page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: /^Save$/ })
  await saveButton.click()

  await expect(page.getByText('Saved pulse-flow.mmd.')).toBeVisible()
  await expect(page.getByTestId('mermaid-path')).toHaveAttribute('data-path', '/mock/pulse-flow.mmd')
  await expect(saveButton).toHaveClass(/save-feedback/)
  await expect(saveButton).toHaveCSS('animation-name', 'none')
  await expect(saveButton).toHaveCSS('transition-property', /transform/)

  const mockState = await getMockState(page)
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
  // The return tab must not cover the toolbar once the sidebar is gone.
  await expect.poll(async () => page.evaluate(() => {
    const button = document.querySelector('.sidebar-return')
    const toolbar = document.querySelector('.workspace-panel:not([hidden]) .toolbar-document')
    if (!button || !toolbar) {
      return Number.POSITIVE_INFINITY
    }
    return button.getBoundingClientRect().right - toolbar.getBoundingClientRect().left
  })).toBeLessThanOrEqual(0)

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

  await convertMermaid(page, 'smoke-flow')

  await expect(page.getByLabel('Transparent background')).toHaveCount(0)
  await page.getByRole('button', { name: 'Export PNG' }).click()
  await expect(page.getByRole('heading', { name: 'Export image' }).first()).toBeVisible()
  await expect(page.getByText('Background', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export to PNG' })).toBeVisible()

  const mockState = await getMockState(page)

  expect(mockState.invocations.map((call) => call.cmd)).not.toContain('save_png_file')
})

test('uses explicit motion properties and honors reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  const tabButton = page.getByRole('tab', { name: 'Mermaid' })
  await expect(tabButton).not.toHaveCSS('transition-property', 'all')
  await expect(tabButton).toHaveCSS('transition-duration', '0.001s')
  await tabButton.click()

  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(page.locator('.sidebar')).toHaveCSS('transition-duration', '0.001s')

  await setDocumentName(page, 'Mermaid', 'accessible-flow')
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)
  await page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: /^Save$/ }).click()

  const status = page.locator('.workspace-panel:not([hidden])').getByRole('status')
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

// ---------------------------------------------------------------------------
// Open documents as tabs
// ---------------------------------------------------------------------------

const PROJECT = { path: '/mock/project', name: 'Diagrams', added_at: 1 }

const PROJECT_SEED: MockSeed = {
  files: {
    '/mock/project/one.mmd': 'flowchart TD\n  A[One] --> B[Done]',
    '/mock/project/two.mmd': 'flowchart TD\n  C[Two] --> D[Done]',
    '/mock/project/three.excalidraw': JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'local',
      elements: [],
      appState: {},
      files: {},
    }),
  },
  projects: [PROJECT],
  projectFiles: {
    '/mock/project': [
      { kind: 'mermaid', path: '/mock/project/one.mmd', name: 'one.mmd', relative_path: 'one.mmd', updated_at: 1 },
      { kind: 'mermaid', path: '/mock/project/two.mmd', name: 'two.mmd', relative_path: 'two.mmd', updated_at: 2 },
      {
        kind: 'excalidraw',
        path: '/mock/project/three.excalidraw',
        name: 'three.excalidraw',
        relative_path: 'three.excalidraw',
        updated_at: 3,
      },
    ],
  },
}

async function openProjectsPanel(page: Page) {
  await page.getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: `Expand ${PROJECT.name}` }).click()
}

test('opens two files as separate tabs and keeps each one\'s unsaved edits', async ({ page }) => {
  await seedBackend(page, PROJECT_SEED)
  await page.goto('/')
  await openProjectsPanel(page)

  await page.locator('.file-row-main[title="/mock/project/one.mmd"]').click()
  await expect(page.getByRole('tab', { name: 'one' })).toHaveAttribute('aria-selected', 'true')
  await enterEditMode(page)
  await page.locator('.mermaid-editor textarea').fill('flowchart TD\n  A[Edited one] --> B[Done]')

  await page.locator('.file-row-main[title="/mock/project/two.mmd"]').click()
  await expect(page.getByRole('tab', { name: 'two' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.mermaid-editor textarea')).toHaveValue('flowchart TD\n  C[Two] --> D[Done]')
  await enterEditMode(page)
  await page.locator('.mermaid-editor textarea').fill('flowchart TD\n  C[Edited two] --> D[Done]')

  // The first file took over the blank startup tab, so it is one tab per file.
  await expect(page.locator('.document-tab')).toHaveCount(2)

  // Switching back must not prompt, and must bring the unsaved edits with it.
  await page.getByRole('tab', { name: 'one' }).click()
  await expect(page.locator('.mermaid-editor textarea')).toHaveValue('flowchart TD\n  A[Edited one] --> B[Done]')
  await page.getByRole('tab', { name: 'two' }).click()
  await expect(page.locator('.mermaid-editor textarea')).toHaveValue('flowchart TD\n  C[Edited two] --> D[Done]')

  const mockState = await getMockState(page)
  expect(mockState.confirmMessages).toEqual([])
  // Both tabs are marked open in the sidebar; only the active one is highlighted.
  await expect(page.locator('.file-row.is-open')).toHaveCount(2)
  await expect(page.locator('.file-row.is-active')).toHaveCount(1)
})

test('opens every diagram in a project as tabs without filling the recent list', async ({ page }) => {
  await seedBackend(page, PROJECT_SEED)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Projects' }).click()

  await page.getByRole('button', { name: `Open all diagrams in ${PROJECT.name}` }).click()

  await expect(page.locator('.document-tab')).toHaveCount(3)
  await expect(page.getByRole('tab', { name: 'one' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Opened 3 diagrams from Diagrams.')).toBeVisible()

  const mockState = await getMockState(page)
  expect(mockState.recents).toEqual([])
  const loads = mockState.invocations.filter((call) => call.cmd.endsWith('_path'))
  expect(loads).toHaveLength(3)
  expect(loads.every((call) => call.args.trackRecent === false)).toBe(true)

  // Re-running it is a no-op rather than a duplicate set of tabs.
  await page.getByRole('button', { name: `Open all diagrams in ${PROJECT.name}` }).click()
  await expect(page.getByText('Every diagram in Diagrams is already open.')).toBeVisible()
  await expect(page.locator('.document-tab')).toHaveCount(3)
})

test('prompts before closing a tab with unsaved changes', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('tab', { name: 'Mermaid' }).click()
  await setDocumentName(page, 'Mermaid', 'closing-flow')
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)
  const tab = page.locator('.document-tab', { hasText: 'closing-flow' })
  await expect(tab.locator('.dirty-dot')).toBeVisible()

  await page.evaluate(() => window.__PLAYWRIGHT_SET_CONFIRM_RESULT__?.(false))
  await page.getByRole('button', { name: 'Close closing-flow' }).click()
  await expect(tab).toHaveCount(1)

  let mockState = await getMockState(page)
  expect(mockState.confirmMessages).toHaveLength(1)
  expect(mockState.confirmMessages[0]).toContain('unsaved Mermaid (closing-flow) changes')

  await page.evaluate(() => window.__PLAYWRIGHT_SET_CONFIRM_RESULT__?.(true))
  await page.getByRole('button', { name: 'Close closing-flow' }).click()
  await expect(tab).toHaveCount(0)

  mockState = await getMockState(page)
  expect(mockState.confirmMessages).toHaveLength(2)

  // Closing a clean tab never asks.
  await page.getByRole('button', { name: 'Close Untitled' }).click()
  mockState = await getMockState(page)
  expect(mockState.confirmMessages).toHaveLength(2)
  // The workspace is never left without a document.
  await expect(page.locator('.document-tab')).toHaveCount(1)
})

test('restores the open tabs after a reload', async ({ page }) => {
  await seedBackend(page, PROJECT_SEED)
  await page.goto('/')
  await openProjectsPanel(page)

  await page.locator('.file-row-main[title="/mock/project/one.mmd"]').click()
  await page.locator('.file-row-main[title="/mock/project/two.mmd"]').click()
  await expect(page.getByRole('tab', { name: 'two' })).toHaveAttribute('aria-selected', 'true')
  await expect
    .poll(async () => page.evaluate(() => window.localStorage.getItem('excalibur.openDocuments')))
    .toContain('/mock/project/two.mmd')

  await page.reload()

  await expect(page.locator('.document-tab')).toHaveCount(2)
  await expect(page.getByRole('tab', { name: 'one' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'two' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.mermaid-editor textarea')).toHaveValue('flowchart TD\n  C[Two] --> D[Done]')

  const mockState = await getMockState(page)
  expect(mockState.recents).toEqual([])
})

test('switches and closes tabs from the keyboard', async ({ page }) => {
  await seedBackend(page, PROJECT_SEED)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: `Open all diagrams in ${PROJECT.name}` }).click()
  await expect(page.locator('.document-tab')).toHaveCount(3)

  // Cmd/Ctrl+1..9 jumps straight to a tab.
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByRole('tab', { name: 'one' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ControlOrMeta+2')
  await expect(page.getByRole('tab', { name: 'two' })).toHaveAttribute('aria-selected', 'true')

  // Ctrl+Tab cycles forward, Ctrl+Shift+Tab back.
  await page.keyboard.press('Control+Tab')
  await expect(page.getByRole('tab', { name: 'three' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+Shift+Tab')
  await expect(page.getByRole('tab', { name: 'two' })).toHaveAttribute('aria-selected', 'true')

  // Cmd/Ctrl+W closes the active tab; a clean one never prompts.
  await page.keyboard.press('ControlOrMeta+w')
  await expect(page.locator('.document-tab')).toHaveCount(2)
  await expect(page.getByRole('tab', { name: 'two' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'three' })).toHaveAttribute('aria-selected', 'true')

  const mockState = await getMockState(page)
  expect(mockState.confirmMessages).toEqual([])
})

test('keeps each Excalidraw tab on its own scene when switching', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('tab', { name: 'Mermaid' }).click()
  await setDocumentName(page, 'Mermaid', 'alpha')
  await page.locator('.mermaid-editor textarea').fill('flowchart TD\n  A[One] --> B[Two]')
  await page.getByRole('button', { name: 'Convert to Excalidraw' }).click()
  await expect(page.getByRole('button', { name: 'Excalidraw document name' })).toHaveText('alpha')
  const alphaScene = await readAutosavedScene(page)

  await page.getByRole('tab', { name: 'Mermaid' }).click()
  await setDocumentName(page, 'Mermaid', 'beta')
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)
  await page.getByRole('button', { name: 'Convert to Excalidraw' }).click()
  await expect(page.getByRole('button', { name: 'Excalidraw document name' })).toHaveText('beta')
  const betaScene = await readAutosavedScene(page)
  expect(betaScene.elements.length).not.toBe(alphaScene.elements.length)

  // Two converted drawings plus the Mermaid source; the first took over the blank tab.
  await expect(page.locator('.document-tab')).toHaveCount(3)

  // `.icon-pen` picks the converted drawing rather than the Mermaid source tab.
  await page.locator('.document-tab:has(.icon-pen)', { hasText: 'alpha' }).getByRole('tab').click()
  await expect(page.getByRole('button', { name: 'Excalidraw document name' })).toHaveText('alpha')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('excalibur.excalidraw.autosave.current')
        return raw ? JSON.parse(JSON.parse(raw).contents).elements.length : 0
      }),
    )
    .toBe(alphaScene.elements.length)

  await page.locator('.document-tab:has(.icon-pen)', { hasText: 'beta' }).getByRole('tab').click()
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('excalibur.excalidraw.autosave.current')
        return raw ? JSON.parse(JSON.parse(raw).contents).elements.length : 0
      }),
    )
    .toBe(betaScene.elements.length)
})

test('closes other tabs and all tabs from the tab context menu', async ({ page }) => {
  await seedBackend(page, PROJECT_SEED)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: `Open all diagrams in ${PROJECT.name}` }).click()
  await expect(page.locator('.document-tab')).toHaveCount(3)

  await page.locator('.document-tab', { hasText: 'two' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close others' }).click()
  await expect(page.locator('.document-tab')).toHaveCount(1)
  await expect(page.getByRole('tab', { name: 'two' })).toHaveAttribute('aria-selected', 'true')

  await page.locator('.document-tab', { hasText: 'two' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close all' }).click()
  // Closing everything leaves one empty document of the same kind behind.
  await expect(page.locator('.document-tab')).toHaveCount(1)
  await expect(page.getByRole('tab', { name: 'Untitled' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.workspace-panel:not([hidden])')).toHaveAttribute('aria-label', 'Mermaid editor')

  const mockState = await getMockState(page)
  expect(mockState.confirmMessages).toEqual([])
})

test('takes over the blank startup tab when a file is opened', async ({ page }) => {
  await seedBackend(page, PROJECT_SEED)
  await page.goto('/')
  await expect(page.getByRole('tab', { name: 'Untitled' })).toHaveAttribute('aria-selected', 'true')

  await openProjectsPanel(page)
  await page.locator('.file-row-main[title="/mock/project/one.mmd"]').click()

  await expect(page.locator('.document-tab')).toHaveCount(1)
  await expect(page.getByRole('tab', { name: 'one' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Untitled' })).toHaveCount(0)

  // A tab with content is never recycled.
  await enterEditMode(page)
  await page.locator('.mermaid-editor textarea').fill('flowchart TD\n  A[Edited] --> B[Done]')
  await page.locator('.file-row-main[title="/mock/project/two.mmd"]').click()
  await expect(page.locator('.document-tab')).toHaveCount(2)
})

test('recovers an autosave backup into the tab that already has that file', async ({ page }) => {
  await page.goto('/')
  await convertMermaid(page, 'recover')
  await page.getByRole('button', { name: /^Save$/ }).click()
  await expect(page.getByTestId('excalidraw-path')).toHaveAttribute('data-path', '/mock/recover.excalidraw')

  const saved = (await getMockState(page)).savedFiles['/mock/recover.excalidraw']
  const scene = JSON.parse(saved) as { appState: Record<string, unknown> }
  const backup = JSON.stringify({ ...scene, appState: { ...scene.appState, viewBackgroundColor: '#fff5e6' } })

  // Relaunch with the file on disk and a newer backup for it waiting to be recovered.
  await page.addInitScript(
    ({ path, contents, backupContents }) => {
      window.__PLAYWRIGHT_TAURI_SEED__ = { files: { [path]: contents } }
      window.localStorage.setItem(
        'excalibur.excalidraw.autosave.recovery',
        JSON.stringify({ contents: backupContents, path, name: 'recover', updatedAt: 1 }),
      )
    },
    { path: '/mock/recover.excalidraw', contents: saved, backupContents: backup },
  )
  await page.reload()

  await expect(page.locator('.document-tab')).toHaveCount(1)
  await expect(page.getByTestId('excalidraw-path')).toHaveAttribute('data-path', '/mock/recover.excalidraw')

  await page.getByRole('button', { name: 'Recover backup' }).click()

  await expect(page.getByText('Recovered autosave backup for recover.excalidraw.')).toBeVisible()
  // Same tab, same file, now carrying unsaved changes.
  await expect(page.locator('.document-tab')).toHaveCount(1)
  await expect(page.getByTestId('excalidraw-path')).toHaveAttribute('data-path', '/mock/recover.excalidraw')
  await expect(page.locator('.document-tab .dirty-dot')).toBeVisible()
})
