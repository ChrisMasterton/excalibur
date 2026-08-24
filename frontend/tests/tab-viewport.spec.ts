import { expect, test, type Page } from '@playwright/test'
import { installTauriMock, seedBackend, type MockSeed } from './support'

const PROJECT = { path: '/mock/views', name: 'Views', added_at: 1 }

const ONE = `flowchart TD
  A[Alpha] --> B[Beta]
  B --> C[Gamma]
`

const TWO = `flowchart LR
  X[Delta] --> Y[Epsilon]
`

/** A one-element scene, so each drawing has something to look at. */
function drawing(label: string) {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'local',
    elements: [
      {
        id: `${label}-label`,
        type: 'text',
        x: 0,
        y: 0,
        width: 120,
        height: 40,
        angle: 0,
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
        text: label,
        fontSize: 20,
        fontFamily: 1,
        textAlign: 'left',
        verticalAlign: 'top',
        containerId: null,
        originalText: label,
        lineHeight: 1.25,
      },
    ],
    appState: {},
    files: {},
  })
}

const SEED: MockSeed = {
  files: {
    '/mock/views/one.mmd': ONE,
    '/mock/views/two.mmd': TWO,
    '/mock/views/first.excalidraw': drawing('First'),
    '/mock/views/second.excalidraw': drawing('Second'),
  },
  projects: [PROJECT],
  projectFiles: {
    '/mock/views': [
      { kind: 'mermaid', path: '/mock/views/one.mmd', name: 'one.mmd', relative_path: 'one.mmd', updated_at: 1 },
      { kind: 'mermaid', path: '/mock/views/two.mmd', name: 'two.mmd', relative_path: 'two.mmd', updated_at: 2 },
      {
        kind: 'excalidraw',
        path: '/mock/views/first.excalidraw',
        name: 'first.excalidraw',
        relative_path: 'first.excalidraw',
        updated_at: 3,
      },
      {
        kind: 'excalidraw',
        path: '/mock/views/second.excalidraw',
        name: 'second.excalidraw',
        relative_path: 'second.excalidraw',
        updated_at: 4,
      },
    ],
  },
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
})

async function openProjectFile(page: Page, path: string) {
  await page.getByRole('tab', { name: 'Projects' }).click()
  const expand = page.getByRole('button', { name: `Expand ${PROJECT.name}` })
  if (await expand.count()) {
    await expand.click()
  }
  await expect(page.locator(`.file-row-main[title="${path}"]`)).toBeVisible()
  await page.locator(`.file-row-main[title="${path}"]`).click()
}

test('each Mermaid tab keeps its own preview zoom and pan', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')

  await openProjectFile(page, '/mock/views/one.mmd')
  await expect(page.locator('.diagram svg')).toBeVisible()
  const percent = page.locator('.zoom-pan-percent')
  const fitted = await percent.textContent()

  // Zoom tab "one" well away from its fitted scale.
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  const zoomed = await percent.textContent()
  expect(zoomed).not.toBe(fitted)

  // A tab that has never been looked at still auto-fits: no zoom leaks into it.
  await openProjectFile(page, '/mock/views/two.mmd')
  await expect(page.getByRole('tab', { name: 'two' })).toHaveAttribute('aria-selected', 'true')
  await expect(percent).toHaveText(fitted ?? '')

  // Back to "one": the zoom it was left at comes back.
  await page.getByRole('tab', { name: 'one' }).click()
  await expect(percent).toHaveText(zoomed ?? '')

  // And "two" is still where it was, rather than inheriting "one"'s zoom.
  await page.getByRole('tab', { name: 'two' }).click()
  await expect(percent).toHaveText(fitted ?? '')

  // The zoom survives a trip through the other workspace too.
  await page.getByRole('tab', { name: 'one' }).click()
  await expect(percent).toHaveText(zoomed ?? '')
  await page.getByRole('tab', { name: 'Excalidraw' }).click()
  await page.getByRole('tab', { name: 'one' }).click()
  await expect(percent).toHaveText(zoomed ?? '')
})

test('each Excalidraw tab keeps its own canvas zoom and scroll', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')

  await openProjectFile(page, '/mock/views/first.excalidraw')
  const zoom = page.locator('.canvas-frame .reset-zoom-button')
  await expect(zoom).toHaveText('100%')

  // Zoom in, and scroll the drawing out of sight, on the first tab only.
  await page.locator('.canvas-frame').getByRole('button', { name: 'Zoom in' }).click()
  await page.locator('.canvas-frame').getByRole('button', { name: 'Zoom in' }).click()
  const zoomed = await zoom.textContent()
  expect(zoomed).not.toBe('100%')

  const box = await page.locator('.canvas-frame').boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.wheel(0, 2500)
  await expect(page.locator('.canvas-frame .scroll-back-to-content')).toBeVisible()

  // A drawing opened for the first time has no stored viewport, so it keeps the
  // canvas as it stands (unchanged behaviour). Put it somewhere of its own.
  await openProjectFile(page, '/mock/views/second.excalidraw')
  await expect(page.getByRole('tab', { name: 'second' })).toHaveAttribute('aria-selected', 'true')
  await page.locator('.canvas-frame .scroll-back-to-content').click()
  await page.locator('.canvas-frame .reset-zoom-button').click()
  await expect(zoom).toHaveText('100%')
  await expect(page.locator('.canvas-frame .scroll-back-to-content')).toHaveCount(0)

  // Back to the first: both the zoom and the scroll position come back.
  await page.getByRole('tab', { name: 'first' }).click()
  await expect(zoom).toHaveText(zoomed ?? '')
  await expect(page.locator('.canvas-frame .scroll-back-to-content')).toBeVisible()

  // Round-tripping through the Mermaid workspace keeps it too.
  await page.getByRole('tab', { name: 'Mermaid' }).click()
  await page.getByRole('tab', { name: 'first' }).click()
  await expect(zoom).toHaveText(zoomed ?? '')
  await expect(page.locator('.canvas-frame .scroll-back-to-content')).toBeVisible()

  await page.getByRole('tab', { name: 'second' }).click()
  await expect(zoom).toHaveText('100%')
  await expect(page.locator('.canvas-frame .scroll-back-to-content')).toHaveCount(0)
})
