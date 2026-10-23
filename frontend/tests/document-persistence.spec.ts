import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { enterEditMode, getMockState, installTauriMock, openProjectFile, seedBackend } from './support'

const drawing = readFileSync(new URL('./fixtures/symbol-walk-sketch.excalidraw', import.meta.url), 'utf8')
const source = 'flowchart TD\n  A[Original] --> B[Saved]'
const edited = 'flowchart LR\n  X[Newer] --> Y[Unsaved]'
const project = { path: '/mock/saves', name: 'Saves', added_at: 1 }

async function holdCommand(page: Page, cmd: string) {
  await page.evaluate((command) => window.__PLAYWRIGHT_HOLD_COMMAND__?.(command), cmd)
  return {
    started: () => expect.poll(async () => (await getMockState(page)).invocations.filter((call) => call.cmd === cmd).length).toBeGreaterThan(0),
    release: (error?: string) => page.evaluate((message) => window.__PLAYWRIGHT_RELEASE_COMMAND__?.(message), error),
  }
}

async function editContents(page: Page, kind: 'mermaid' | 'excalidraw') {
  if (kind === 'mermaid') {
    await page.getByRole('textbox', { name: 'Mermaid source' }).fill(edited)
  } else {
    await page.locator('.canvas-frame canvas.interactive').click({ position: { x: 10, y: 10 } })
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
  }
  await expect(page.getByRole('tab', { name: /^one(?: Unsaved changes)?$/ }).locator('.dirty-dot')).toHaveCount(1)
}

for (const kind of ['mermaid', 'excalidraw'] as const) {
  const ext = kind === 'mermaid' ? 'mmd' : 'excalidraw'
  const one = `/mock/saves/one.${ext}`
  const two = `/mock/saves/two.${ext}`
  const contents = kind === 'mermaid' ? source : drawing
  const pathView = (page: Page) => page.getByTestId(`${kind}-path`)
  const save = (page: Page) => page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: 'Save', exact: true })

  test.describe(`${kind} file operations`, () => {
    test.beforeEach(async ({ page }) => {
      await installTauriMock(page)
      await seedBackend(page, {
        files: { [one]: contents, [two]: contents },
        projects: [project],
        projectFiles: { [project.path]: [one, two].map((path, index) => ({
          kind, path, name: path.split('/').at(-1), relative_path: path.split('/').at(-1), updated_at: index + 1,
        })) },
      })
      await page.goto('/')
      await openProjectFile(page, project.name, one)
      await enterEditMode(page)
    })

    test('a delayed save stays with its original tab', async ({ page }) => {
      await editContents(page, kind)
      const held = await holdCommand(page, `save_${kind}_file`)
      await save(page).click()
      await held.started()
      await openProjectFile(page, project.name, two)
      await held.release()
      await expect.poll(async () => (await getMockState(page)).savedFiles[one]).toBeTruthy()
      await expect(pathView(page)).toHaveAttribute('data-path', two)
      await expect(page.getByRole('tab', { name: 'two', exact: true })).toHaveAttribute('title', two)
      await page.getByRole('tab', { name: /^one(?: Unsaved changes)?$/ }).click()
      await expect(pathView(page)).toHaveAttribute('data-path', one)
      await expect(page.getByRole('tab', { name: /^one(?: Unsaved changes)?$/ }).locator('.dirty-dot')).toHaveCount(0)
      await page.getByRole('button', { name: 'Close one', exact: true }).click()
      await openProjectFile(page, project.name, one)
      if (kind === 'mermaid') {
        await enterEditMode(page)
        await expect(page.getByRole('textbox', { name: 'Mermaid source' })).toHaveValue(edited)
      } else {
        const saved = JSON.parse((await getMockState(page)).savedFiles[one])
        expect(saved.elements.filter((element: { isDeleted?: boolean }) => !element.isDeleted)).toHaveLength(0)
      }
      expect((await getMockState(page)).savedFiles[two]).toBeUndefined()
    })

    test('edits made during a save remain unsaved until the next save', async ({ page }) => {
      const held = await holdCommand(page, `save_${kind}_file`)
      await save(page).click()
      await held.started()
      await editContents(page, kind)
      await held.release()
      await expect(page.getByText(`Saved one.${ext}. Newer changes remain unsaved.`, { exact: true })).toBeVisible()
      await expect(page.getByRole('tab', { name: /^one(?: Unsaved changes)?$/ }).locator('.dirty-dot')).toHaveCount(1)
      await save(page).click()
      await expect(page.getByRole('tab', { name: /^one(?: Unsaved changes)?$/ }).locator('.dirty-dot')).toHaveCount(0)
      const saved = (await getMockState(page)).savedFiles[one]
      if (kind === 'mermaid') expect(saved).toBe(edited)
      else expect(JSON.parse(saved).elements.filter((element: { isDeleted?: boolean }) => !element.isDeleted)).toHaveLength(0)
    })

    test('a delayed rename stays with its original tab', async ({ page }) => {
      const held = await holdCommand(page, 'rename_file')
      const label = `${kind === 'mermaid' ? 'Mermaid' : 'Excalidraw'} document name`
      await page.getByRole('button', { name: label }).click()
      const input = page.getByRole('textbox', { name: label })
      await input.fill('renamed')
      await input.press('Enter')
      await held.started()
      await openProjectFile(page, project.name, two)
      await held.release()
      const renamed = `/mock/saves/renamed.${ext}`
      await expect.poll(async () => (await getMockState(page)).savedFiles[renamed]).toBe(contents)
      await expect(pathView(page)).toHaveAttribute('data-path', two)
      await expect(page.getByRole('tab', { name: 'renamed', exact: true })).toHaveAttribute('title', renamed)
      await page.getByRole('tab', { name: 'renamed', exact: true }).click()
      await expect(pathView(page)).toHaveAttribute('data-path', renamed)
    })

    test('a failed save preserves the edited contents for retry', async ({ page }) => {
      await editContents(page, kind)
      const held = await holdCommand(page, `save_${kind}_file`)
      await save(page).click()
      await held.started()
      await held.release('Disk is full')
      await expect(page.getByText('Disk is full', { exact: true })).toBeVisible()
      await expect(page.getByRole('tab', { name: /^one(?: Unsaved changes)?$/ }).locator('.dirty-dot')).toHaveCount(1)
      expect((await getMockState(page)).savedFiles[one]).toBeUndefined()
      await save(page).click()
      await expect(page.getByRole('tab', { name: 'one', exact: true }).locator('.dirty-dot')).toHaveCount(0)
      const saved = (await getMockState(page)).savedFiles[one]
      if (kind === 'mermaid') expect(saved).toBe(edited)
      else expect(JSON.parse(saved).elements).toHaveLength(0)
    })

    if (kind === 'excalidraw') {
      test('deleting every shape immediately after opening survives tab switches', async ({ page }) => {
        await editContents(page, kind)
        await openProjectFile(page, project.name, two)
        await page.getByRole('tab', { name: /^one(?: Unsaved changes)?$/ }).click()
        await save(page).click()
        await expect.poll(async () => (await getMockState(page)).savedFiles[one]).toBeTruthy()
        expect(JSON.parse((await getMockState(page)).savedFiles[one]).elements).toHaveLength(0)
      })
    }
  })
}
