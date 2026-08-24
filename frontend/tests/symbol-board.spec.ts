import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  hasCanvasSelection,
  installTauriMock,
  openProjectFile as openFile,
  seedBackend,
  type MockSeed,
} from './support'

const PROJECT = { path: '/mock/board', name: 'Board', added_at: 1 }

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

/** Names `User` twice (spelt two ways), so this document is the busiest and sorts first. */
const SIGNUP = `---
title: Signup flow
---
flowchart TD
    User[User] --> Session[Session]
    Signin[USER] --> Audit[Audit]
`

/** Lives outside every registered project, so a symbol picked here lists nothing. */
const LOOSE = `classDiagram
    class Ledger
`

const SKETCH = readFileSync(new URL('./fixtures/symbol-walk-sketch.excalidraw', import.meta.url), 'utf8')

const SEED: MockSeed = {
  files: {
    '/mock/board/classes.mmd': CLASSES,
    '/mock/board/signup.mmd': SIGNUP,
    '/mock/board/sketch.excalidraw': SKETCH,
    '/mock/loose/ledger.mmd': LOOSE,
  },
  projects: [PROJECT],
  projectFiles: {
    '/mock/board': [
      {
        kind: 'mermaid',
        path: '/mock/board/classes.mmd',
        name: 'classes.mmd',
        relative_path: 'classes.mmd',
        updated_at: 1,
        title: 'Domain classes',
      },
      {
        kind: 'mermaid',
        path: '/mock/board/signup.mmd',
        name: 'signup.mmd',
        relative_path: 'signup.mmd',
        updated_at: 2,
        title: 'Signup flow',
      },
      {
        kind: 'excalidraw',
        path: '/mock/board/sketch.excalidraw',
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

const openProjectFile = (page: Page, path: string) => openFile(page, PROJECT.name, path)

const references = (page: Page) => page.getByRole('complementary', { name: 'References' })
const board = (page: Page) => page.getByRole('dialog')

/** Picks `User` in the class diagram, which is what every board here is opened for. */
async function pickUser(page: Page) {
  await openProjectFile(page, '/mock/board/classes.mmd')
  await expect(page.locator('.diagram svg')).toBeVisible()
  await page.locator('.diagram [id^="classId-User-"]').first().click()
  await expect(references(page).locator('.references-name')).toHaveText('User')
}

test('the board button is dead until the symbol has documents to show', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')

  // A file outside every registered project: nothing can be listed for it.
  await page.evaluate(() =>
    window.__PLAYWRIGHT_EMIT_TAURI_EVENT__?.('open-file', '/mock/loose/ledger.mmd'),
  )
  await expect(page.locator('.diagram svg')).toBeVisible()
  await page.locator('.diagram [id^="classId-Ledger-"]').first().click()
  await expect(references(page).locator('.references-name')).toHaveText('Ledger')
  await expect(references(page).getByRole('button', { name: 'Board' })).toBeDisabled()

  // The same symbol inside a project has somewhere to go.
  await pickUser(page)
  await expect(references(page).getByRole('button', { name: 'Board' })).toBeEnabled()
})

test('the board shows every mentioning document, busiest first, marked where you are', async ({
  page,
}) => {
  await seedBackend(page, SEED)
  await page.goto('/')
  await pickUser(page)

  await references(page).getByRole('button', { name: 'Board' }).click()
  await expect(board(page)).toBeVisible()
  const cards = board(page).locator('.board-card')
  await expect(cards).toHaveCount(3)

  // Two `User` nodes in the flowchart put it first; the rest tie on one and sort by title.
  await expect(cards.locator('.board-card-name')).toHaveText([
    'Signup flow',
    'Domain classes',
    'sketch',
  ])
  await expect(cards.nth(0).locator('.board-card-count')).toHaveText('2')
  // Exactly one card says "you are here", and it is the document that was clicked in.
  await expect(board(page).locator('.board-card.is-active')).toHaveCount(1)
  await expect(cards.nth(1)).toHaveClass(/is-active/)
  await expect(cards.nth(1)).toHaveAttribute('aria-current', 'true')

  // Every card ends up with a thumbnail of its own diagram.
  await expect(board(page).locator('.board-card-svg svg')).toHaveCount(3)

  // The Mermaid thumbnails carry the same marks the live preview would show...
  const mermaidCard = cards.nth(1)
  await expect(mermaidCard.locator('.board-card-svg .symbol-highlight').first()).toBeVisible()
  // ...and the drawing, which cannot be highlighted during export, gets a box drawn on it.
  const drawingCard = cards.nth(2)
  await expect(drawingCard.locator('.board-card-svg rect.symbol-highlight')).toHaveCount(1)
})

test('a card hands the document over to the references panel, and Escape puts the board back', async ({
  page,
}) => {
  await seedBackend(page, SEED)
  await page.goto('/')
  await pickUser(page)
  await expect(page.locator('.diagram .symbol-highlight').first()).toBeVisible()

  // Escape closes the board before it touches the highlight or the panel.
  await references(page).getByRole('button', { name: 'Board' }).click()
  await expect(board(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(board(page)).toHaveCount(0)
  await expect(references(page)).toBeVisible()
  await expect(page.locator('.diagram .symbol-highlight').first()).toBeVisible()

  // A card is a way in: the board steps aside and that document is revealed.
  await references(page).getByRole('button', { name: 'Board' }).click()
  await board(page).locator('.board-card', { hasText: 'sketch' }).click()
  await expect(board(page)).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'sketch' })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => hasCanvasSelection(page)).toBe(true)
  // The walk carries on: the panel is still open, now pointing at the drawing.
  await expect(references(page).locator('.symbol-hit.is-active')).toHaveText(/sketch/)
})

test('a document that will not load keeps its card and says nothing', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')
  await pickUser(page)

  // The drawing goes missing after the index has already read it.
  await page.evaluate(() => {
    const files = window.__PLAYWRIGHT_TAURI_SEED__?.files
    if (files) {
      delete files['/mock/board/sketch.excalidraw']
    }
  })

  await references(page).getByRole('button', { name: 'Board' }).click()
  const card = board(page).locator('.board-card', { hasText: 'sketch' })
  await expect(card.locator('.board-card-blank:not(.is-loading)')).toBeVisible()
  await expect(card.locator('.board-card-svg')).toHaveCount(0)
  // The other cards are unaffected, and nothing was reported at the user.
  await expect(board(page).locator('.board-card-svg svg')).toHaveCount(2)
  await expect(page.locator('.workspace-panel:not([hidden]) .status')).not.toContainText('Unable')
})
