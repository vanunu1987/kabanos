/**
 * Milestone 5: routines — add from workspace, captures, templating, polling, assertions,
 * dry run and step-through, against the docker ES 9 cluster.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { CLUSTERS, connect, launch, pasteInto } from './helpers'

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const AUTH = { authorization: `Basic ${Buffer.from('elastic:sift-dev-pass').toString('base64')}` }

test.beforeAll(async () => {
  await fetch('http://localhost:9202/kabanos-e2e-copy', { method: 'DELETE', headers: AUTH })
  ;({ app, page } = await launch())
  await connect(page, CLUSTERS.es9)
})
test.afterAll(async () => {
  await app?.close()
  await fetch('http://localhost:9202/kabanos-e2e-copy', { method: 'DELETE', headers: AUTH })
})

const steps = () => page.locator('.step-card')
const stepEditor = (i: number) => page.locator('.step-card').nth(i)

test('workspace blocks become a routine that runs in order', async () => {
  await page.getByRole('button', { name: 'Query workspace' }).click()
  await page.getByRole('button', { name: 'Import…' }).click()
  await page.getByLabel('Console text').fill('# Cluster is healthy\nGET _cluster/health\n\n# Count listings\nPOST listings-v6/_count\n')
  await page.getByRole('button', { name: 'Import 2 requests' }).click()
  for (const i of [0, 1]) await page.locator('.block').nth(i).getByLabel('Select for sequential run').check()
  await page.getByRole('button', { name: 'Add to routine' }).click()
  await page.getByRole('dialog').getByLabel('Routine name').fill('Reindex listings & verify')
  await page.getByRole('button', { name: 'Add steps' }).click()

  await expect(page.getByLabel('Routine name')).toHaveValue('Reindex listings & verify')
  await expect(steps()).toHaveCount(2)
  await page.getByRole('button', { name: '▶ Run all' }).click()
  await expect(page.locator('.run-badge.lg')).toContainText('ok')
  await expect(page.locator('.step-status.s-done')).toHaveCount(2)
  await expect(page.locator('.log-lines')).toContainText('✓ Cluster is healthy')
})

test('build the reindex routine: variables, capture, poll, assert', async () => {
  // Variables
  for (const v of ['source=listings-v6', 'target=kabanos-e2e-copy']) {
    await page.getByRole('button', { name: '+ variable' }).click()
    await page.getByLabel('New variable').fill(v)
    await page.getByLabel('New variable').press('Enter')
  }
  await expect(page.locator('.var-chip')).toHaveCount(2)

  // Step 1: health gets an assertion.
  await stepEditor(0).locator('.step-summary').click()
  await stepEditor(0).getByLabel('Assert').fill("status != 'red'")
  await stepEditor(0).locator('.step-summary').click()

  // Step 2: count the source via the variable and capture it (inline copy, not the scratch block).
  await stepEditor(1).locator('.step-summary').click()
  await stepEditor(1).getByLabel('Step path').fill('{{source}}/_count')
  await stepEditor(1).getByLabel('Capture').fill('value = count')
  await stepEditor(1).getByLabel('Capture').blur()
  await stepEditor(1).locator('.step-summary').click()

  // Step 3: start an async reindex and capture the task id.
  await page.getByRole('button', { name: /Add step/ }).click()
  await page.getByRole('button', { name: 'New inline request' }).click()
  await stepEditor(2).locator('.step-summary').click()
  await stepEditor(2).getByLabel('Step name').fill('Start reindex')
  await stepEditor(2).getByLabel('Step method').selectOption('POST')
  await stepEditor(2).getByLabel('Step path').fill('_reindex?wait_for_completion=false&refresh=true')
  await pasteInto(app, page, stepEditor(2).locator('.monaco-editor'), '{"source":{"index":"{{source}}"},"dest":{"index":"{{target}}"}}')
  await stepEditor(2).getByLabel('Capture').fill('task = task')
  await stepEditor(2).getByLabel('Capture').blur()
  await stepEditor(2).locator('.step-summary').click()

  // Step 4: poll the task until it completes.
  await page.getByRole('button', { name: /Add step/ }).click()
  await page.getByRole('button', { name: 'New inline request' }).click()
  await stepEditor(3).locator('.step-summary').click()
  await stepEditor(3).getByLabel('Step name').fill('Wait for task')
  await stepEditor(3).getByLabel('Step path').fill('_tasks/{{steps.start_reindex.task}}')
  await stepEditor(3).getByRole('checkbox', { name: 'Repeat until' }).check()
  await stepEditor(3).getByLabel('Every seconds').fill('1')
  await stepEditor(3).locator('.step-summary').click()

  // Step 5: verify the copy has the same number of documents.
  await page.getByRole('button', { name: /Add step/ }).click()
  await page.getByRole('button', { name: 'New inline request' }).click()
  await stepEditor(4).locator('.step-summary').click()
  await stepEditor(4).getByLabel('Step name').fill('Verify doc count')
  await stepEditor(4).getByLabel('Step method').selectOption('POST')
  await stepEditor(4).getByLabel('Step path').fill('{{target}}/_count')
  await stepEditor(4).getByLabel('Assert').fill('count == steps.count_listings.value')
  await stepEditor(4).locator('.step-summary').click()
  await expect(steps()).toHaveCount(5)
})

test('dry run only reads and lists what writes would do', async () => {
  await page.getByLabel('Dry run (reads only)').check()
  await page.getByRole('button', { name: '▶ Run all' }).click()
  await expect(page.locator('.run-badge.lg')).toContainText('dry run')
  await expect(stepEditor(2)).toContainText('would run POST _reindex?wait_for_completion=false&refresh=true')
  await expect(stepEditor(3)).toContainText('needs {{steps.start_reindex.task}}')
  const exists = await fetch('http://localhost:9202/kabanos-e2e-copy', { method: 'HEAD', headers: AUTH })
  expect(exists.status).toBe(404)
  await page.getByLabel('Dry run (reads only)').uncheck()
})

test('full run: captures values, polls the task, asserts the copy', async () => {
  await page.getByRole('button', { name: '▶ Run all' }).click()
  await expect(page.locator('.run-badge.lg')).not.toContainText('Running', { timeout: 30_000 })
  await expect(page.locator('.run-badge.lg')).toContainText('ok', { timeout: 30_000 })
  await expect(page.locator('.step-status.s-done')).toHaveCount(5)
  await expect(page.locator('.captured')).toContainText('steps.count_listings.value = 150')
  await expect(page.locator('.captured')).toContainText('steps.start_reindex.task')
  await expect(page.locator('.log-lines')).toContainText('✓ Verify doc count')
  await page.screenshot({ path: 'e2e/screens/30-routines.png' })
})

test('a failing assertion stops the routine', async () => {
  await stepEditor(0).locator('.step-summary').click()
  await stepEditor(0).getByLabel('Assert').fill("status = 'purple'")
  await stepEditor(0).locator('.step-summary').click()
  await page.getByRole('button', { name: '▶ Run all' }).click()
  await expect(page.locator('.run-badge.lg')).toContainText('failed')
  await expect(stepEditor(0)).toContainText("assertion failed: status = 'purple'")
  await expect(page.locator('.step-status.s-done')).toHaveCount(0)
  await expect(page.locator('.log-lines')).toContainText('Stopped after failed step')
})

test('step through pauses before each step; stop ends the run', async () => {
  await stepEditor(0).locator('.step-summary').click()
  await stepEditor(0).getByLabel('Assert').fill('')
  await stepEditor(0).locator('.step-summary').click()
  await page.getByRole('button', { name: 'Step through' }).click()
  await expect(page.locator('.run-badge.lg')).toContainText('Paused · before step 1')
  await page.getByRole('button', { name: 'Run next step' }).click()
  await expect(page.locator('.run-badge.lg')).toContainText('Paused · before step 2')
  await expect(page.locator('.step-status.s-done')).toHaveCount(1)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.locator('.run-badge.lg')).toContainText('stopped')
  await page.getByLabel('Previous runs').selectOption({ index: 2 })
  await expect(page.locator('.log-lines')).toContainText('assertion failed')
})
