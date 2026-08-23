import { expect, test, type Page } from '@playwright/test'
import { enterEditMode, installTauriMock, seedBackend, setDocumentName, type MockSeed } from './support'

const PROJECT = { path: '/mock/domain', name: 'Domain', added_at: 1 }

const CLASSES = `---
title: Domain classes
---
classDiagram
    class User {
      +String email
    }
    class Order
    User "1" --> "*" Order : places
`

const FLOW = `sequenceDiagram
    participant User
    participant Order
    User->>Order: place(order)
`

/** One stamped text element, so the canvas hit test has something to resolve. */
const DRAWING = JSON.stringify({
    "type": "excalidraw",
    "version": 2,
    "source": "local",
    "elements": [
      {
        "id": "user-label",
        "type": "text",
        "x": 0,
        "y": 0,
        "width": 120,
        "height": 40,
        "angle": 0,
        "strokeColor": "#1e1e1e",
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 1,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "frameId": null,
        "roundness": null,
        "seed": 1,
        "version": 1,
        "versionNonce": 1,
        "isDeleted": false,
        "boundElements": null,
        "updated": 1,
        "link": null,
        "locked": false,
        "text": "User",
        "fontSize": 20,
        "fontFamily": 1,
        "textAlign": "left",
        "verticalAlign": "top",
        "containerId": null,
        "originalText": "User",
        "lineHeight": 1.25,
        "customData": {
          "excalibur": {
            "symbol": "user",
            "display": "User",
            "kind": "node"
          }
        }
      }
    ],
    "appState": {},
    "files": {}
  })

const SEED: MockSeed = {
  files: {
    '/mock/domain/classes.mmd': CLASSES,
    '/mock/domain/flow.mmd': FLOW,
  },
  projects: [PROJECT],
  projectFiles: {
    '/mock/domain': [
      {
        kind: 'mermaid',
        path: '/mock/domain/classes.mmd',
        name: 'classes.mmd',
        relative_path: 'classes.mmd',
        updated_at: 1,
        title: 'Domain classes',
      },
      {
        kind: 'mermaid',
        path: '/mock/domain/flow.mmd',
        name: 'flow.mmd',
        relative_path: 'flow.mmd',
        updated_at: 2,
      },
    ],
  },
}

/** The same project with a drawing in it, for the canvas side of the lookup. */
const DRAWING_SEED: MockSeed = {
  files: { ...SEED.files, '/mock/domain/sketch.excalidraw': DRAWING },
  projects: SEED.projects,
  projectFiles: {
    '/mock/domain': [
      ...(SEED.projectFiles?.['/mock/domain'] ?? []),
      {
        kind: 'excalidraw',
        path: '/mock/domain/sketch.excalidraw',
        name: 'sketch.excalidraw',
        relative_path: 'sketch.excalidraw',
        updated_at: 3,
      },
    ],
  },
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
})

/** Opens one of the seeded project diagrams through the Projects panel. */
async function openProjectFile(page: Page, path: string) {
  await page.getByRole('tab', { name: 'Projects' }).click()
  const expand = page.getByRole('button', { name: `Expand ${PROJECT.name}` })
  if (await expand.count()) {
    await expand.click()
  }
  await page.locator(`.file-row-main[title="${path}"]`).click()
}

const panel = (page: Page) => page.locator('.workspace-panel:not([hidden])')

test('opens a project file in view mode and toggles back to editing per tab', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')
  await openProjectFile(page, '/mock/domain/classes.mmd')

  // Viewing is the default for anything that came off disk.
  await expect(panel(page).getByRole('button', { name: 'Viewing' })).toBeVisible()
  await expect(panel(page).getByRole('button', { name: /^Save$/ })).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: 'Hide code' })).toHaveCount(0)
  await expect(page.locator('.mermaid-editor')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Mermaid document name' })).toBeDisabled()

  // The toggle shows the current mode and brings the editing chrome back.
  await panel(page).getByRole('button', { name: 'Viewing' }).click()
  const editing = panel(page).getByRole('button', { name: 'Editing' })
  await expect(editing).toBeVisible()
  await expect(editing).toHaveAttribute('aria-pressed', 'true')
  await expect(panel(page).getByRole('button', { name: /^Save$/ })).toBeVisible()
  await expect(page.locator('.mermaid-editor')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mermaid document name' })).toBeEnabled()

  // Mode belongs to the tab: the next file still opens in view mode.
  await openProjectFile(page, '/mock/domain/flow.mmd')
  await expect(panel(page).getByRole('button', { name: 'Viewing' })).toBeVisible()

  await page.getByRole('tab', { name: 'Domain classes' }).click()
  await expect(panel(page).getByRole('button', { name: 'Editing' })).toBeVisible()

  // Cmd/Ctrl+Shift+E is the shortcut; plain `E` belongs to Excalidraw's eraser.
  await page.keyboard.press('ControlOrMeta+Shift+E')
  await expect(panel(page).getByRole('button', { name: 'Viewing' })).toBeVisible()
})

test('a Mermaid conversion still starts in edit mode', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('tab', { name: 'Mermaid' }).click()
  await setDocumentName(page, 'Mermaid', 'converted')
  await page.locator('.mermaid-editor textarea').fill('flowchart TD\n  A[User] --> B[Order]')
  await page.getByRole('button', { name: 'Convert to Excalidraw' }).click()

  await expect(page.getByRole('button', { name: 'Excalidraw document name' })).toHaveText('converted')
  await expect(panel(page).getByRole('button', { name: 'Editing' })).toBeVisible()
  await expect(panel(page).getByRole('button', { name: /^Save$/ })).toBeVisible()
})

test('clicking a Mermaid node lists every document in the project that mentions it', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')
  await openProjectFile(page, '/mock/domain/classes.mmd')
  await expect(page.locator('.diagram svg')).toBeVisible()

  await page.locator('.diagram [id^="classId-User-"]').first().click()

  const references = page.getByRole('complementary', { name: 'References' })
  await expect(references).toBeVisible()
  await expect(references.locator('.references-name')).toHaveText('User')
  await expect(references.locator('.references-hint')).toContainText('class')
  await expect(references.locator('.references-hint')).toContainText(PROJECT.name)
  // The class diagram and the sequence diagram both name `User`.
  await expect(references.locator('.symbol-hit')).toHaveCount(2)
  await expect(references.getByRole('button', { name: /Domain classes/ })).toBeVisible()
  await expect(references.getByRole('button', { name: /flow/ })).toBeVisible()

  // Clicking a reference activates that document and marks the matches, panel still open.
  await references.getByRole('button', { name: /flow/ }).click()
  await expect(page.getByRole('tab', { name: 'flow' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.diagram .symbol-highlight').first()).toBeVisible()
  await expect(references).toBeVisible()
  // The other document opened for reading, not editing.
  await expect(panel(page).getByRole('button', { name: 'Viewing' })).toBeVisible()

  // Escape peels one layer at a time: the marks first, the panel second.
  await page.keyboard.press('Escape')
  await expect(page.locator('.diagram .symbol-highlight')).toHaveCount(0)
  await expect(references).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(references).toHaveCount(0)

  // Empty space resolves to nothing, and says nothing.
  await page.locator('.mermaid-preview').click({ position: { x: 8, y: 8 } })
  await expect(page.getByRole('complementary', { name: 'References' })).toHaveCount(0)
})

test('the references panel closes from its own button and works while editing', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')
  await openProjectFile(page, '/mock/domain/classes.mmd')
  await expect(page.locator('.diagram svg')).toBeVisible()
  await enterEditMode(page)

  // Clicking the preview resolves symbols in edit mode too.
  await page.locator('.diagram [id^="classId-Order-"]').first().click()
  const references = page.getByRole('complementary', { name: 'References' })
  await expect(references.locator('.references-name')).toHaveText('Order')

  await references.getByRole('button', { name: 'Close references' }).click()
  await expect(references).toHaveCount(0)
})

test('clicking a labelled Excalidraw element in view mode opens its references', async ({ page }) => {
  await seedBackend(page, DRAWING_SEED)
  await page.goto('/')
  await openProjectFile(page, '/mock/domain/sketch.excalidraw')

  await expect(panel(page).getByRole('button', { name: 'Viewing' })).toBeVisible()
  // View mode hands the canvas to Excalidraw read-only, so a click is a question.
  await expect(page.locator('.canvas-frame .excalidraw')).toHaveClass(/excalidraw--view-mode/)

  // The scene loads unscrolled at 100%, so the label sits at the canvas origin.
  const box = await page.locator('.canvas-frame').boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.click(box!.x + 61, box!.y + 21)

  const references = page.getByRole('complementary', { name: 'References' })
  await expect(references.locator('.references-name')).toHaveText('User')
  // The drawing, the class diagram, and the sequence diagram all name `User`.
  await expect(references.locator('.symbol-hit')).toHaveCount(3)
})

