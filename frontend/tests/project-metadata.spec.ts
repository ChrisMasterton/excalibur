import { expect, test } from '@playwright/test'
import { getMockState, installTauriMock, seedBackend } from './support'

const DIAGRAMS_PATH = '/mock/fsm-nextjs/docs/diagrams'

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
})

test('shows project paths and edits project and diagram display names without moving files', async ({ page }) => {
  await seedBackend(page, {
    files: {
      [`${DIAGRAMS_PATH}/auth.mmd`]: 'flowchart TD\n  Signup --> Routing\n',
    },
    projects: [
      { path: DIAGRAMS_PATH, name: 'diagrams', added_at: 1 },
      { path: '/mock/example-project/docs/diagrams', name: 'diagrams', added_at: 2 },
    ],
    projectFiles: {
      [DIAGRAMS_PATH]: [
        {
          kind: 'mermaid',
          path: `${DIAGRAMS_PATH}/auth.mmd`,
          name: 'auth.mmd',
          relative_path: 'auth.mmd',
          updated_at: 1,
          title: 'Auth flow',
        },
      ],
    },
  })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Projects' }).click()

  await expect(page.getByText(DIAGRAMS_PATH, { exact: true })).toBeVisible()
  await expect(page.getByText('/mock/example-project/docs/diagrams', { exact: true })).toBeVisible()

  const project = page.locator('.project').filter({ hasText: DIAGRAMS_PATH })
  await project.getByRole('button', { name: 'Project display name for diagrams' }).click()
  const projectName = project.getByRole('textbox', { name: 'Project display name for diagrams' })
  await projectName.fill('Example architecture')
  await projectName.press('Enter')
  await expect(project.getByRole('button', { name: 'Project display name for Example architecture' })).toBeVisible()
  await expect(project).toContainText(DIAGRAMS_PATH)

  await project.getByRole('button', { name: 'Expand Example architecture' }).click()
  const fileRow = project.locator('.file-row').filter({ hasText: 'Auth flow' })
  await fileRow.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename diagram display name' }).click()
  const diagramName = page.getByRole('textbox', { name: 'Diagram display name for Auth flow' })
  await diagramName.fill('Account flow')
  await diagramName.press('Enter')

  const renamedFileRow = project.locator('.file-row').filter({ hasText: 'Account flow' })
  await expect(renamedFileRow).toContainText('auth.mmd')
  await renamedFileRow.locator('.file-row-main').click()
  await expect(page.getByRole('tab', { name: 'Account flow' })).toBeVisible()
  const state = await getMockState(page)
  expect(state.invocations).toContainEqual({
    cmd: 'rename_project',
    args: { path: DIAGRAMS_PATH, name: 'Example architecture' },
  })
  expect(state.invocations).toContainEqual({
    cmd: 'rename_project_file_display_name',
    args: {
      projectPath: DIAGRAMS_PATH,
      path: `${DIAGRAMS_PATH}/auth.mmd`,
      name: 'Account flow',
    },
  })
})

test('renders diagrams beneath their project-relative subfolders', async ({ page }) => {
  await seedBackend(page, {
    projects: [{ path: DIAGRAMS_PATH, name: 'diagrams', added_at: 1 }],
    projectFiles: {
      [DIAGRAMS_PATH]: [
        {
          kind: 'mermaid',
          path: `${DIAGRAMS_PATH}/identity/access/roles.mmd`,
          name: 'roles.mmd',
          relative_path: 'identity/access/roles.mmd',
          updated_at: 1,
          title: 'Account roles',
        },
        {
          kind: 'excalidraw',
          path: `${DIAGRAMS_PATH}/overview.excalidraw`,
          name: 'overview.excalidraw',
          relative_path: 'overview.excalidraw',
          updated_at: 2,
        },
      ],
    },
  })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: 'Expand diagrams' }).click()

  const identity = page.locator('[data-folder-path="identity"]')
  const access = identity.locator('[data-folder-path="identity/access"]')
  await expect(identity.locator('.project-subfolder', { hasText: 'identity' })).toBeVisible()
  await expect(access.locator('.project-subfolder', { hasText: 'access' })).toBeVisible()
  await expect(access.locator('.file-row-main[title$="/identity/access/roles.mmd"]')).toContainText('Account roles')
  await expect(page.locator('.project-tree > .file-row .file-row-name')).toHaveText('overview.excalidraw')
})

test('closes only tabs belonging to the selected project, including subfolders', async ({ page }) => {
  const otherProject = '/mock/other/diagrams'
  const nestedPath = `${DIAGRAMS_PATH}/identity/auth.mmd`
  const otherPath = `${otherProject}/town.mmd`
  await seedBackend(page, {
    files: {
      [nestedPath]: 'flowchart TD\n  Signup --> Home\n',
      [otherPath]: 'flowchart TD\n  Town --> Shop\n',
    },
    projects: [
      { path: DIAGRAMS_PATH, name: 'Example architecture', added_at: 1 },
      { path: otherProject, name: 'Town diagrams', added_at: 2 },
    ],
    projectFiles: {
      [DIAGRAMS_PATH]: [
        {
          kind: 'mermaid',
          path: nestedPath,
          name: 'auth.mmd',
          relative_path: 'identity/auth.mmd',
          updated_at: 1,
          display_name: 'Authentication',
        },
      ],
      [otherProject]: [
        {
          kind: 'mermaid',
          path: otherPath,
          name: 'town.mmd',
          relative_path: 'town.mmd',
          updated_at: 1,
          display_name: 'Town map',
        },
      ],
    },
  })
  await page.goto('/')
  await page.getByRole('tab', { name: 'Projects' }).click()
  await page.getByRole('button', { name: 'Expand Example architecture' }).click()
  await page.getByRole('button', { name: 'Expand Town diagrams' }).click()
  await page.locator(`.file-row-main[title="${nestedPath}"]`).click()
  await page.locator(`.file-row-main[title="${otherPath}"]`).click()
  await expect(page.getByRole('tab', { name: 'Authentication' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Town map' })).toBeVisible()

  await page.getByRole('button', { name: 'More actions for Example architecture' }).click()
  await page.getByRole('menuitem', { name: 'Close all tabs' }).click()

  await expect(page.getByRole('tab', { name: 'Authentication' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Town map' })).toBeVisible()
  await page.getByRole('button', { name: 'More actions for Example architecture' }).click()
  await expect(page.getByRole('menuitem', { name: 'Close all tabs' })).toBeDisabled()
})
