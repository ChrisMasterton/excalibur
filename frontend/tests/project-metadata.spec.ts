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
      { path: '/mock/ossan-yokai/docs/diagrams', name: 'diagrams', added_at: 2 },
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
  await expect(page.getByText('/mock/ossan-yokai/docs/diagrams', { exact: true })).toBeVisible()

  const project = page.locator('.project').filter({ hasText: DIAGRAMS_PATH })
  await project.getByRole('button', { name: 'Project display name for diagrams' }).click()
  const projectName = project.getByRole('textbox', { name: 'Project display name for diagrams' })
  await projectName.fill('FSML architecture')
  await projectName.press('Enter')
  await expect(project.getByRole('button', { name: 'Project display name for FSML architecture' })).toBeVisible()
  await expect(project).toContainText(DIAGRAMS_PATH)

  await project.getByRole('button', { name: 'Expand FSML architecture' }).click()
  const fileRow = project.locator('.file-row').filter({ hasText: 'Auth flow' })
  await fileRow.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename diagram display name' }).click()
  const diagramName = page.getByRole('textbox', { name: 'Diagram display name for Auth flow' })
  await diagramName.fill('Teacher signup and routing')
  await diagramName.press('Enter')

  const renamedFileRow = project.locator('.file-row').filter({ hasText: 'Teacher signup and routing' })
  await expect(renamedFileRow).toContainText('auth.mmd')
  await renamedFileRow.locator('.file-row-main').click()
  await expect(page.getByRole('tab', { name: 'Teacher signup and routing' })).toBeVisible()
  const state = await getMockState(page)
  expect(state.invocations).toContainEqual({
    cmd: 'rename_project',
    args: { path: DIAGRAMS_PATH, name: 'FSML architecture' },
  })
  expect(state.invocations).toContainEqual({
    cmd: 'rename_project_file_display_name',
    args: {
      projectPath: DIAGRAMS_PATH,
      path: `${DIAGRAMS_PATH}/auth.mmd`,
      name: 'Teacher signup and routing',
    },
  })
})
