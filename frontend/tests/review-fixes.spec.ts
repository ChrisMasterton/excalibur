import { expect, test } from '@playwright/test'
import { enterEditMode, getMockState, installTauriMock, openProjectFile, seedBackend } from './support'

const root = '/mock/review'
const drawing = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, angle: 0, strokeColor: '#000000', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }], appState: {}, files: {} })

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
  const files = { [`${root}/first.mmd`]: 'flowchart TD\n A --> B', [`${root}/second.mmd`]: 'flowchart TD\n C --> D', [`${root}/drawing.excalidraw`]: drawing, [`${root}/broken.excalidraw`]: '{broken' }
  await seedBackend(page, { files, projects: [{ path: root, name: 'Review', added_at: 1 }], projectFiles: { [root]: Object.keys(files).map(path => ({ path, kind: path.endsWith('.mmd') ? 'mermaid' : 'excalidraw', name: path.split('/').pop(), relative_path: path.split('/').pop(), updated_at: 1 })) } })
  await page.goto('/')
})

test('reload restores unsaved contents of active and inactive tabs', async ({ page }) => {
  for (const name of ['first', 'second']) {
    await openProjectFile(page, 'Review', `${root}/${name}.mmd`)
    await enterEditMode(page)
    await page.getByRole('textbox', { name: 'Mermaid source' }).fill(`flowchart TD\n A[Unsaved ${name}] --> B`)
  }
  await page.reload()
  for (const name of ['first', 'second']) {
    await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click()
    if (await page.getByRole('button', { name: 'Viewing', exact: true }).isVisible()) await enterEditMode(page)
    await expect(page.getByRole('textbox', { name: 'Mermaid source' })).toHaveValue(`flowchart TD\n A[Unsaved ${name}] --> B`)
    await expect(page.locator('.document-tab.is-active .dirty-dot')).toBeVisible()
  }
})

test('invalid drawing is rejected before changing the active document', async ({ page }) => {
  await openProjectFile(page, 'Review', `${root}/drawing.excalidraw`)
  await openProjectFile(page, 'Review', `${root}/broken.excalidraw`)
  await expect(page.getByRole('tab', { name: /^broken/ })).toHaveCount(0)
  await expect(page.getByTestId('excalidraw-path')).toHaveAttribute('data-path', `${root}/drawing.excalidraw`)
})

test('deleting the last element immediately after opening is saved', async ({ page }) => {
  await openProjectFile(page, 'Review', `${root}/drawing.excalidraw`)
  await enterEditMode(page)
  await page.locator('.canvas-frame').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => {
    const contents = (await getMockState(page)).savedFiles[`${root}/drawing.excalidraw`]
    return contents ? JSON.parse(contents).elements.filter((e: { isDeleted: boolean }) => !e.isDeleted).length : -1
  }).toBe(0)
})

test('settings owns keyboard focus and blocks document shortcuts', async ({ page }) => {
  await openProjectFile(page, 'Review', `${root}/first.mmd`)
  await page.keyboard.press('ControlOrMeta+,')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('ControlOrMeta+w')
  await expect(page.locator('.document-tab').filter({ hasText: 'first' })).toHaveCount(1)
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

async function dropImage(page: import('@playwright/test').Page) {
  const transfer = await page.evaluateHandle(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII='), c => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }))
    return data
  })
  await page.locator('.canvas-frame').dispatchEvent('drop', { dataTransfer: transfer, clientX: 700, clientY: 400 })
}

test('view mode refuses custom image drops', async ({ page }) => {
  await openProjectFile(page, 'Review', `${root}/drawing.excalidraw`)
  await dropImage(page)
  await expect(page.getByText('Switch to Editing to import images.')).toBeVisible()
  await enterEditMode(page)
  await page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await getMockState(page)).savedFiles[`${root}/drawing.excalidraw`]).toBeTruthy()
  expect(JSON.parse((await getMockState(page)).savedFiles[`${root}/drawing.excalidraw`]).elements.some((e: { type: string }) => e.type === 'image')).toBe(false)
})

test('image decoding completion is cancelled after changing tabs', async ({ page }) => {
  await openProjectFile(page, 'Review', `${root}/drawing.excalidraw`)
  await enterEditMode(page)
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = async function () {
      window.__OWNERSHIP_PENDING__ = true
      await new Promise<void>(resolve => { window.__OWNERSHIP_RELEASE__ = resolve })
      return read.call(this)
    }
  })
  await dropImage(page)
  await page.waitForFunction(() => window.__OWNERSHIP_PENDING__)
  await openProjectFile(page, 'Review', `${root}/first.mmd`)
  await page.evaluate(() => window.__OWNERSHIP_RELEASE__?.())
  await expect(page.getByText('Image import cancelled because the document changed.')).toBeAttached()
  await expect(page.getByTestId('mermaid-path')).toBeVisible()
  await page.getByRole('tab', { name: /^drawing/ }).click()
  await page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await getMockState(page)).savedFiles[`${root}/drawing.excalidraw`]).toBeTruthy()
  expect(JSON.parse((await getMockState(page)).savedFiles[`${root}/drawing.excalidraw`]).elements.some((e: { type: string }) => e.type === 'image')).toBe(false)
})

test('refit completion is cancelled after switching documents', async ({ page }) => {
  await openProjectFile(page, 'Review', `${root}/drawing.excalidraw`)
  await enterEditMode(page)
  await page.evaluate(() => {
    document.fonts.load = async () => {
      window.__OWNERSHIP_PENDING__ = true
      await new Promise<void>(resolve => { window.__OWNERSHIP_RELEASE__ = resolve })
      return []
    }
  })
  await page.getByRole('button', { name: 'Refit text' }).click()
  await page.waitForFunction(() => window.__OWNERSHIP_PENDING__)
  await openProjectFile(page, 'Review', `${root}/first.mmd`)
  await page.evaluate(() => window.__OWNERSHIP_RELEASE__?.())
  await expect(page.getByText('Text refit cancelled because the document changed.')).toBeAttached()
})

test('failed settings writes stay visible and do not apply unsaved values', async ({ page }) => {
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
    const invoke = internals.invoke
    internals.invoke = (cmd, args) => cmd === 'save_settings' ? Promise.reject('Disk is full') : invoke(cmd, args)
  })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const select = page.getByRole('combobox', { name: 'Scroll wheel action' })
  const original = await select.inputValue()
  await select.selectOption(original === 'pan' ? 'zoom' : 'pan')
  await expect(page.getByRole('alert')).toContainText('Disk is full')
  await expect(select).toHaveValue(original)
})

test('rescan refreshes saved symbol contents even with the same timestamp', async ({ page }) => {
  await page.getByRole('tab', { name: 'Projects', exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Find in projects' })
  await search.fill('FreshSymbol')
  await expect(page.getByText('No matches.', { exact: true })).toBeVisible()
  await page.evaluate(({ path }) => { window.__PLAYWRIGHT_TAURI_SEED__!.files![path] = 'flowchart TD\n A[FreshSymbol] --> B' }, { path: `${root}/first.mmd` })
  await search.fill('')
  await page.getByRole('button', { name: 'More actions for Review', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rescan folder' }).click()
  await search.fill('FreshSymbol')
  await expect(page.getByText('FreshSymbol', { exact: true }).first()).toBeVisible()
})

test('an unsaved empty drawing survives tab switching and reload', async ({ page }) => {
  await openProjectFile(page, 'Review', `${root}/drawing.excalidraw`)
  await enterEditMode(page)
  await page.locator('.canvas-frame').click()
  // Desktop Chrome's emulated Windows platform uses Control for Excalidraw shortcuts.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await expect(page.locator('.document-tab.is-active .dirty-dot')).toBeVisible()
  await openProjectFile(page, 'Review', `${root}/first.mmd`)
  await page.reload()
  await page.getByRole('tab', { name: /^drawing/ }).click()
  await page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => {
    const contents = (await getMockState(page)).savedFiles[`${root}/drawing.excalidraw`]
    return contents ? JSON.parse(contents).elements.length : -1
  }).toBe(0)
})

test('closing with discard removes Mermaid recovery', async ({ page }) => {
  await openProjectFile(page, 'Review', `${root}/first.mmd`)
  await enterEditMode(page)
  await page.getByRole('textbox', { name: 'Mermaid source' }).fill('flowchart TD\n A[Discard me] --> B')
  await page.getByRole('button', { name: 'Close first', exact: true }).click()
  expect((await getMockState(page)).confirmMessages).toHaveLength(1)
  await page.reload()
  await openProjectFile(page, 'Review', `${root}/first.mmd`)
  await enterEditMode(page)
  await expect(page.getByRole('textbox', { name: 'Mermaid source' })).toHaveValue('flowchart TD\n A --> B')
})

test('recovery storage failures are visible and do not block editing', async ({ page }) => {
  await openProjectFile(page, 'Review', `${root}/first.mmd`)
  await enterEditMode(page)
  await page.evaluate(() => {
    const write = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'excalibur.recoveryDocuments') throw new DOMException('Quota exceeded', 'QuotaExceededError')
      return write.call(this, key, value)
    }
  })
  await page.getByRole('textbox', { name: 'Mermaid source' }).fill('flowchart TD\n A[Keep editing] --> B')
  await expect(page.getByRole('alert')).toContainText('Recovery could not be updated')
  await expect(page.getByRole('textbox', { name: 'Mermaid source' })).toHaveValue('flowchart TD\n A[Keep editing] --> B')
})

test('all native startup paths are opened', async ({ page }) => {
  await page.addInitScript(({ root }) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
    const invoke = internals.invoke
    internals.invoke = (cmd, args) => cmd === 'take_pending_file' ? Promise.resolve([`${root}/first.mmd`, `${root}/second.mmd`]) : invoke(cmd, args)
  }, { root })
  await page.reload()
  await expect(page.getByRole('tab', { name: 'first', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'second', exact: true })).toBeVisible()
})

test('failed symbol reads retry after rescan without a timestamp change', async ({ page }) => {
  await page.evaluate(({ root }) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: { path?: string }) => Promise<unknown> } }).__TAURI_INTERNALS__
    const invoke = internals.invoke
    let failed = false
    internals.invoke = (cmd, args) => {
      if (cmd === 'load_mermaid_path' && args.path === `${root}/first.mmd` && !failed) {
        failed = true
        return Promise.reject('Temporary read failure')
      }
      return invoke(cmd, args)
    }
    window.__PLAYWRIGHT_TAURI_SEED__!.files![`${root}/first.mmd`] = 'flowchart TD\n A[RetrySymbol] --> B'
  }, { root })
  await page.getByRole('tab', { name: 'Projects', exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Find in projects' })
  await search.fill('RetrySymbol')
  await expect(page.getByRole('alert')).toContainText('could not be indexed')
  await expect(page.getByText('No matches.', { exact: true })).toBeVisible()
  await search.fill('')
  await page.getByRole('button', { name: 'More actions for Review', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rescan folder' }).click()
  await search.fill('RetrySymbol')
  await expect(page.getByText('RetrySymbol', { exact: true }).first()).toBeVisible()
})

test('native exit with discard clears recovery and cancelled exit retains it', async ({ page }) => {
  await openProjectFile(page, 'Review', `${root}/first.mmd`)
  await enterEditMode(page)
  await page.getByRole('textbox', { name: 'Mermaid source' }).fill('flowchart TD\n A[Exit edit] --> B')
  await page.evaluate(() => window.__PLAYWRIGHT_SET_CONFIRM_RESULT__?.(false))
  await page.evaluate(() => window.__PLAYWRIGHT_EMIT_TAURI_EVENT__?.('tauri://close-requested'))
  expect((await getMockState(page)).exitCount).toBe(0)
  expect(await page.evaluate(() => localStorage.getItem('excalibur.recoveryDocuments'))).toContain('Exit edit')
  await page.evaluate(() => window.__PLAYWRIGHT_SET_CONFIRM_RESULT__?.(true))
  await page.evaluate(() => window.__PLAYWRIGHT_EMIT_TAURI_EVENT__?.('tauri://close-requested'))
  await expect.poll(async () => (await getMockState(page)).exitCount).toBe(1)
  expect(await page.evaluate(() => localStorage.getItem('excalibur.recoveryDocuments'))).toBeNull()
})

test('a dotted native folder drop and multiple diagram drops are all handled', async ({ page }) => {
  await page.evaluate(({ root }) => {
    window.__PLAYWRIGHT_TAURI_SEED__!.projects!.push({ path: '/mock/project.with.dots', name: 'Dotted', added_at: 1 })
    return window.__PLAYWRIGHT_EMIT_TAURI_EVENT__?.('tauri://drag-drop', {
      paths: ['/mock/project.with.dots', `${root}/first.mmd`, `${root}/second.mmd`], position: { x: 50, y: 50 },
    })
  }, { root })
  await expect(page.getByRole('tab', { name: 'first', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'second', exact: true })).toBeVisible()
  expect((await getMockState(page)).invocations.some(call => call.cmd === 'add_project_path' && call.args.path === '/mock/project.with.dots')).toBe(true)
})
