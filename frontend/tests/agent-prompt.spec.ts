import { expect, test, type Page } from '@playwright/test'
import { installTauriMock, seedBackend, type MockSeed } from './support'

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
`

const SEED: MockSeed = {
  files: {
    '/mock/domain/classes.mmd': CLASSES,
    '/mock/domain/sub/schema.mmd': SCHEMA,
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
        path: '/mock/domain/sub/schema.mmd',
        name: 'schema.mmd',
        relative_path: 'sub/schema.mmd',
        updated_at: 2,
      },
    ],
  },
}

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await installTauriMock(page)
})

/** Opens the dialog from the project row's hover button and waits for the index. */
async function openDialog(page: Page) {
  await seedBackend(page, SEED)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: `Coding agent prompt for ${PROJECT.name}` }).click()
  const dialog = page.getByRole('dialog', { name: 'Coding agent prompt' })
  await expect(dialog).toBeVisible()
  // The prompt regenerates once the symbol index finishes; wait for the vocabulary.
  await expect(dialog.getByRole('textbox', { name: 'Prompt preview' })).toHaveValue(/User \(class\)/)
  return dialog
}

const preview = (page: Page) => page.getByRole('textbox', { name: 'Prompt preview' })

test('builds a prompt carrying the project path, its diagrams, and its vocabulary', async ({
  page,
}) => {
  const dialog = await openDialog(page)
  await expect(dialog.locator('.settings-header p')).toContainText('/mock/domain')

  const prompt = await preview(page).inputValue()

  // Project context.
  expect(prompt).toContain('Project folder: /mock/domain')
  expect(prompt).toContain('- classes.mmd — Domain classes')
  expect(prompt).toContain('- sub/schema.mmd')

  // Vocabulary from the index, with the "reuse these names" instruction.
  expect(prompt).toContain('do not invent synonyms')
  expect(prompt).toMatch(/- User \(class\)/)
  expect(prompt).toMatch(/- email \((attribute|member) of/)

  // Output contract.
  expect(prompt).toContain('Use the `.mmd` extension.')
  expect(prompt).toContain('no Markdown code fences')
  expect(prompt).toContain('title: Checkout and payment capture')
  expect(prompt).toContain('kebab-case')
  expect(prompt).toContain('Write each diagram as its own file directly into /mock/domain')
  expect(prompt).toContain('watched by Excalibur')

  // The default preset is the architectural overview.
  expect(prompt).toContain('architectural overview')
})

test('switching preset rewrites the task, and deep-dive needs its feature first', async ({
  page,
}) => {
  await openDialog(page)
  const copyButton = page.getByRole('button', { name: 'Copy prompt' })
  await expect(copyButton).toBeEnabled()

  await page.getByText('ER / data model').click()
  await expect(preview(page)).toHaveValue(/erDiagram/)
  await expect(preview(page)).not.toHaveValue(/architectural overview/)

  await page.getByText('Feature deep-dive').click()
  await expect(copyButton).toBeDisabled()
  await expect(page.getByText('Name the feature to dig into.')).toBeVisible()

  await page.getByRole('textbox', { name: 'Feature' }).fill('Checkout')
  await expect(copyButton).toBeEnabled()
  await expect(preview(page)).toHaveValue(/"Checkout" feature in depth/)
  await expect(preview(page)).toHaveValue(/sequenceDiagram/)

  // The vocabulary and contract travel with every preset.
  await expect(preview(page)).toHaveValue(/User \(class\)/)
  await expect(preview(page)).toHaveValue(/Project folder: \/mock\/domain/)
})

test('copies the prompt with the button and with Cmd/Ctrl+Enter', async ({ page }) => {
  await openDialog(page)
  const prompt = await preview(page).inputValue()

  await page.getByRole('button', { name: 'Copy prompt' }).click()
  await expect(page.getByText('Copied to the clipboard.')).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt)

  // A different preset, copied from the keyboard this time.
  await page.evaluate(() => navigator.clipboard.writeText('cleared'))
  await page.getByText('Sequence for a flow').click()
  await page.getByRole('textbox', { name: 'Flow' }).fill('Sign in')
  const sequencePrompt = await preview(page).inputValue()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByText('Copied to the clipboard.')).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sequencePrompt)
  expect(sequencePrompt).toContain('"Sign in" flow')

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Coding agent prompt' })).toBeHidden()
})

test('opens from the project row context menu too', async ({ page }) => {
  await seedBackend(page, SEED)
  await page.goto('/')
  await page.getByRole('tab', { name: 'Projects' }).click()
  await page.locator('.project-header').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Coding agent prompt…' }).click()
  await expect(page.getByRole('dialog', { name: 'Coding agent prompt' })).toBeVisible()
})

/**
 * `buildAgentPrompt` is pure, so the same request must always produce the same
 * string; the preview and the clipboard would drift apart otherwise. Exercised
 * in the page so there is no second test framework to keep.
 */
test('buildAgentPrompt is deterministic and orders its vocabulary stably', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const module = await import('/src/lib/agentPrompt.ts')
    const request = {
      preset: 'feature' as const,
      inputs: { feature: 'Checkout', flow: '', freeText: '' },
      project: { name: 'Domain', path: '/mock/domain' },
      files: [
        { relativePath: 'classes.mmd', title: 'Domain classes' },
        { relativePath: 'sub/schema.mmd', title: null },
      ],
      symbols: [
        { display: 'User', kind: 'class' as const, documents: 3 },
        { display: 'email', kind: 'member' as const, owner: 'User', documents: 2 },
      ],
    }
    const doc = (path: string) => ({ path, kind: 'mermaid' as const, title: path })
    const entry = (display: string, kind: string, path: string) => ({
      symbol: display.toLowerCase(),
      display,
      kind,
      doc: doc(path),
      diagramType: 'classDiagram',
      locators: [],
    })
    const entries = [
      entry('Order', 'class', '/a.mmd'),
      entry('User', 'class', '/a.mmd'),
      entry('User', 'class', '/b.mmd'),
      entry('User.email', 'member', '/a.mmd'),
    ]
    return {
      first: module.buildAgentPrompt(request),
      second: module.buildAgentPrompt({ ...request }),
      symbols: module.collectPromptSymbols(entries),
      symbolsAgain: module.collectPromptSymbols([...entries].reverse()),
    }
  })

  expect(result.first).toBe(result.second)
  // Busiest symbol first; the qualified `User.email` copy is dropped.
  expect(result.symbols).toEqual([
    { display: 'User', kind: 'class', documents: 2 },
    { display: 'Order', kind: 'class', documents: 1 },
  ])
  expect(result.symbolsAgain).toEqual(result.symbols)
})
