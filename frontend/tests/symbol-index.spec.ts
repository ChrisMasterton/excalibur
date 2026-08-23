import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  getMockState,
  installTauriMock,
  seedBackend,
  setDocumentName,
  type MockSeed,
} from './support'

const mermaidSource = readFileSync(new URL('./fixtures/mermaid-smoke.mmd', import.meta.url), 'utf8')

const PROJECT = { path: '/mock/domain', name: 'Domain', added_at: 1 }

const CLASSES = `---
title: Domain classes
---
classDiagram
    class User {
      +String email
      +login(pass) bool
    }
    class Order
    User "1" --> "*" Order : places
`

const SCHEMA = `erDiagram
    USER ||--o{ ORDER : places
    USER {
      string email PK
    }
    ORDER {
      int id
    }
`

const FLOW = `sequenceDiagram
    participant User
    participant Order
    User->>Order: place(order)
`

const SEED: MockSeed = {
  files: {
    '/mock/domain/classes.mmd': CLASSES,
    '/mock/domain/schema.mmd': SCHEMA,
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
        path: '/mock/domain/schema.mmd',
        name: 'schema.mmd',
        relative_path: 'schema.mmd',
        updated_at: 2,
      },
      {
        kind: 'mermaid',
        path: '/mock/domain/flow.mmd',
        name: 'flow.mmd',
        relative_path: 'flow.mmd',
        updated_at: 3,
      },
    ],
  },
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
})

async function search(page: Page, query: string) {
  await page.getByRole('tab', { name: 'Projects' }).click()
  const field = page.getByRole('searchbox', { name: 'Find in projects' })
  await field.fill(query)
  return field
}

test('indexes classes, members, entities, and participants across a project', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')
  await search(page, 'user')

  // `User`, `USER` and the sequence participant all group under one symbol.
  const result = page.locator('.symbol-entry', { has: page.locator('.symbol-entry-name', { hasText: /^User$/i }) })
  await expect(result.first().locator('.symbol-hit')).toHaveCount(3)
  await expect(result.first().getByRole('button', { name: /Domain classes/ })).toBeVisible()
  await expect(result.first().getByRole('button', { name: /schema/ })).toBeVisible()
  await expect(result.first().getByRole('button', { name: /flow/ })).toBeVisible()

  // A class member and an ER attribute are the same symbol in two documents.
  await search(page, 'email')
  const email = page.locator('.symbol-entry', { has: page.locator('.symbol-entry-name', { hasText: /^email$/ }) })
  await expect(email.first().locator('.symbol-hit')).toHaveCount(2)
  await expect(email.first().locator('.symbol-entry-hint')).toContainText('of')

  // Members are reachable by their qualified name too.
  await search(page, 'User.email')
  await expect(page.locator('.symbol-entry-name', { hasText: 'User.email' }).first()).toBeVisible()

  await search(page, 'zzzz')
  await expect(page.getByText('No matches.')).toBeVisible()
})

test('opens the document behind a search hit and highlights the matched node', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')
  await search(page, 'user')

  const result = page.locator('.symbol-entry', { has: page.locator('.symbol-entry-name', { hasText: /^User$/i }) })
  await result.first().getByRole('button', { name: /schema/ }).click()

  await expect(page.getByRole('tab', { name: 'schema' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.workspace-panel:not([hidden])')).toHaveAttribute('aria-label', 'Mermaid editor')
  // The entity node mermaid rendered for USER carries the highlight.
  const highlighted = page.locator('.diagram .symbol-highlight')
  await expect(highlighted).toHaveCount(1)
  await expect(highlighted).toHaveAttribute('id', /^entity-USER-/)

  // Escape drops the marks.
  await page.keyboard.press('Escape')
  await expect(page.locator('.diagram .symbol-highlight')).toHaveCount(0)

  // A hit in another document activates that tab instead.
  await search(page, 'order')
  const order = page.locator('.symbol-entry', { has: page.locator('.symbol-entry-name', { hasText: /^Order$/i }) })
  await order.first().getByRole('button', { name: /Domain classes/ }).click()
  await expect(page.getByRole('tab', { name: 'Domain classes' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.diagram .symbol-highlight')).toHaveAttribute('id', /^classId-Order-/)

  const mockState = await getMockState(page)
  // Opening from search must not push the file into Recent.
  expect(mockState.recents).toEqual([])
})

test('stamps converted Excalidraw elements with the symbol they came from', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('tab', { name: 'Mermaid' }).click()
  await setDocumentName(page, 'Mermaid', 'stamped')
  await page.locator('.mermaid-editor textarea').fill('flowchart TD\n  A[User] --> B[Order Service]')
  await page.getByRole('button', { name: 'Convert to Excalidraw' }).click()
  await expect(page.getByRole('button', { name: 'Excalidraw document name' })).toHaveText('stamped')

  const stamps = await page.evaluate(async () => {
    const read = () => {
      const raw = window.localStorage.getItem('excalibur.excalidraw.autosave.current')
      if (!raw) {
        return []
      }
      const scene = JSON.parse(JSON.parse(raw).contents) as {
        elements: Array<{ type: string; customData?: { excalibur?: { display: string; kind: string } } }>
      }
      return scene.elements
        .map((element) => element.customData?.excalibur)
        .filter((stamp): stamp is { display: string; kind: string } => Boolean(stamp))
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const found = read()
      if (found.length) {
        return found
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return read()
  })

  expect(stamps.map((stamp) => stamp.display)).toEqual(
    expect.arrayContaining(['User', 'Order Service']),
  )
  expect(stamps.every((stamp) => stamp.kind === 'node')).toBe(true)
})

test('exports the Mermaid preview as a PNG through save_png_file', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('tab', { name: 'Mermaid' }).click()
  await setDocumentName(page, 'Mermaid', 'exported-flow')
  await page.locator('.mermaid-editor textarea').fill(mermaidSource)
  await expect(page.locator('.diagram svg')).toBeVisible()

  await page.locator('.workspace-panel:not([hidden])').getByRole('button', { name: 'Export PNG' }).click()
  await expect(page.getByText('Exported exported-flow.png.')).toBeVisible()

  const mockState = await getMockState(page)
  expect(mockState.savedPngs).toHaveLength(1)
  expect(mockState.savedPngs[0].name).toBe('exported-flow.png')
  expect(mockState.savedPngs[0].byteLength).toBeGreaterThan(1000)
  expect(mockState.invocations.map((call) => call.cmd)).toContain('save_png_file')
})
