import { expect, test, type Page } from '@playwright/test'
import { enterEditMode, getMockState, installTauriMock, openProjectFile, seedBackend } from './support'

const ROOT = '/mock/ownership'
const SOURCE = 'flowchart TD\n  A[Original] --> B[Result]\n'
const EDITED = 'flowchart TD\n  A[Newer edit] --> B[Result]\n'
const EMPTY_DRAWING = JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} })

declare global {
  interface Window {
    __OWNERSHIP_PENDING__?: boolean
    __OWNERSHIP_RELEASE__?: () => void
  }
}

// Delay the native response, while keeping the real editor, tabs, and save logic.
async function delayCommand(page: Page, command: string) {
  await page.evaluate((wanted) => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
    }).__TAURI_INTERNALS__
    const invoke = internals.invoke
    internals.invoke = async (cmd, args) => {
      if (cmd === wanted) {
        window.__OWNERSHIP_PENDING__ = true
        await new Promise<void>((resolve) => { window.__OWNERSHIP_RELEASE__ = resolve })
      }
      return invoke(cmd, args)
    }
  }, command)
}

async function releaseCommand(page: Page) {
  await page.evaluate(() => window.__OWNERSHIP_RELEASE__?.())
}

for (const kind of ['mermaid', 'excalidraw'] as const) {
  const ext = kind === 'mermaid' ? 'mmd' : 'excalidraw'
  const first = `${ROOT}/first.${ext}`
  const second = `${ROOT}/second.${ext}`

  test.describe(kind, () => {
    test.beforeEach(async ({ page }) => {
      await installTauriMock(page)
      await seedBackend(page, {
        projects: [{ path: ROOT, name: 'Ownership', added_at: 1 }],
        files: { [first]: kind === 'mermaid' ? SOURCE : EMPTY_DRAWING, [second]: kind === 'mermaid' ? SOURCE : EMPTY_DRAWING },
        projectFiles: { [ROOT]: [first, second].map((path) => ({ kind, path, name: path.split('/').pop(), relative_path: path.split('/').pop(), updated_at: 1 })) },
      })
      await page.goto('/')
      await openProjectFile(page, 'Ownership', first)
      await enterEditMode(page)
    })

    test('a delayed save stays attached to its original tab', async ({ page }) => {
      await delayCommand(page, `save_${kind}_file`)
      await page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(() => window.__OWNERSHIP_PENDING__)
      await openProjectFile(page, 'Ownership', second)
      await releaseCommand(page)
      await expect.poll(async () => (await getMockState(page)).savedFiles[first]).toBeTruthy()
      await expect(page.getByTestId(`${kind}-path`)).toHaveAttribute('data-path', second)
      await expect(page.getByRole('tab', { name: /^second(?: Unsaved changes)?$/ })).toHaveAttribute('aria-selected', 'true')
      await page.getByRole('tab', { name: /^first(?: Unsaved changes)?$/ }).click()
      await expect(page.getByTestId(`${kind}-path`)).toHaveAttribute('data-path', first)
    })

    test('edits made while saving remain unsaved', async ({ page }) => {
      await delayCommand(page, `save_${kind}_file`)
      await page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(() => window.__OWNERSHIP_PENDING__)
      if (kind === 'mermaid') {
        await page.getByRole('textbox', { name: 'Mermaid source' }).fill(EDITED)
      } else {
        await page.locator('label').filter({ has: page.getByRole('radio', { name: 'Rectangle', exact: true }) }).click()
        const box = await page.locator('.canvas-frame').boundingBox()
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
        await page.mouse.down()
        await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2 + 60)
        await page.mouse.up()
        await page.keyboard.press('Escape')
      }
      await releaseCommand(page)
      await expect.poll(async () => (await getMockState(page)).savedFiles[first]).toBeTruthy()
      await expect(page.locator('.document-tab.is-active .dirty-dot')).toBeVisible()
      if (kind === 'mermaid') await expect(page.getByRole('textbox', { name: 'Mermaid source' })).toHaveValue(EDITED)
      await page.evaluate(() => window.__PLAYWRIGHT_SET_CONFIRM_RESULT__?.(false))
      await page.getByRole('button', { name: 'Close first', exact: true }).click()
      expect((await getMockState(page)).confirmMessages).toHaveLength(1)
      await expect(page.getByRole('tab', { name: /^first(?: Unsaved changes)?$/ })).toBeVisible()
    })

    test('a delayed rename stays attached to its original tab', async ({ page }) => {
      await delayCommand(page, 'rename_file')
      const label = `${kind === 'mermaid' ? 'Mermaid' : 'Excalidraw'} document name`
      await page.getByRole('button', { name: label }).click()
      await page.getByRole('textbox', { name: label }).fill('renamed')
      await page.getByRole('textbox', { name: label }).press('Enter')
      await page.waitForFunction(() => window.__OWNERSHIP_PENDING__)
      await openProjectFile(page, 'Ownership', second)
      await releaseCommand(page)
      await expect(page.getByRole('tab', { name: /^renamed(?: Unsaved changes)?$/ })).toBeVisible()
      await expect(page.getByTestId(`${kind}-path`)).toHaveAttribute('data-path', second)
      await page.getByRole('tab', { name: /^renamed(?: Unsaved changes)?$/ }).click()
      await expect(page.getByTestId(`${kind}-path`)).toHaveAttribute('data-path', `${ROOT}/renamed.${ext}`)
    })
  })
}

test('project display names survive frontmatter edits and tab switches', async ({ page }) => {
  await installTauriMock(page)
  const path = `${ROOT}/named.mmd`
  await seedBackend(page, {
    projects: [{ path: ROOT, name: 'Ownership', added_at: 1 }],
    files: { [path]: `---\ntitle: Source title\n---\n${SOURCE}` },
    projectFiles: { [ROOT]: [{ kind: 'mermaid', path, name: 'named.mmd', relative_path: 'named.mmd', display_name: 'Chosen label', updated_at: 1 }] },
  })
  await page.goto('/')
  await openProjectFile(page, 'Ownership', path)
  await expect(page.getByRole('tab', { name: /^Chosen label(?: Unsaved changes)?$/ })).toBeVisible()
  await enterEditMode(page)
  await page.getByRole('textbox', { name: 'Mermaid source' }).fill(`---\ntitle: Changed source title\n---\n${SOURCE}`)
  await expect(page.getByTestId('mermaid-subtitle')).toHaveText('Changed source title')
  await page.getByRole('tab', { name: 'Excalidraw', exact: true }).click()
  await expect(page.getByRole('tab', { name: /^Chosen label(?: Unsaved changes)?$/ })).toBeVisible()
  await page.getByRole('tab', { name: /^Chosen label(?: Unsaved changes)?$/ }).click()
  await expect(page.getByTestId('mermaid-subtitle')).toHaveText('Changed source title')
})
