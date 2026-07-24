import { test, expect, Page } from '@playwright/test'
import { gotoHome } from './helpers'

async function createWorkspace (page: Page, name: string) {
  await page.locator('[data-id="workspaceCreate"]').click()
  const nameInput = page.locator('input[data-id="modalDialogCustomPromptTextCreate"]')
  await nameInput.waitFor({ state: 'visible', timeout: 5_000 })
  await nameInput.fill(name)
  await page.locator('[data-id="workspacesModalDialog-modal-footer-ok-react"]').click()
  await expect(page.locator('select[data-id="workspacesSelect"]')).toHaveValue(name, { timeout: 15_000 })
}

async function activateSolidityUnitTesting (page: Page) {
  await page.locator('#icon-panel div[plugin="pluginManager"]').click()
  await page.locator('[data-id="pluginManagerComponentActivateButtonsolidityUnitTesting"]').click()
  await page.locator('#icon-panel div[plugin="solidityUnitTesting"]').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('#icon-panel div[plugin="solidityUnitTesting"]').click()
  await expect(page.locator('[data-id="uiPathInput"]')).toHaveValue('tests', { timeout: 10_000 })
}

test.describe('Solidity Unit Testing workspace lifecycle', () => {
  test('queues a workspace change during activation and refreshes changes after activation', { tag: '@gate' }, async ({ page }) => {
    const pageErrors: Error[] = []
    page.on('pageerror', error => pageErrors.push(error))

    await gotoHome(page)

    // A workspace selected before activation must be reflected when the plugin
    // first renders. Activation subscribes to filePanel before its view exists,
    // so a synchronous setWorkspace notification exercises the lifecycle race.
    await createWorkspace(page, 'unit-before-activation')
    await activateSolidityUnitTesting(page)

    // Once the view is ready, later workspace changes must still reset both the
    // visible path and the backing test directory instead of being dropped.
    await page.locator('[data-id="uiPathInput"]').fill('custom-tests')
    await page.locator('#icon-panel div[plugin="filePanel"]').click()
    await createWorkspace(page, 'unit-after-activation')
    await page.locator('#icon-panel div[plugin="solidityUnitTesting"]').click()
    await expect(page.locator('[data-id="uiPathInput"]')).toHaveValue('tests', { timeout: 10_000 })

    // Deactivate/reactivate the plugin and switch once more. The file event
    // handlers must be removed by identity; otherwise every activation stacks
    // another refresh callback against the new view.
    await page.locator('#icon-panel div[plugin="pluginManager"]').click()
    const deactivate = page.locator('[data-id="pluginManagerComponentDeactivateButtonsolidityUnitTesting"]')
    await deactivate.waitFor({ state: 'visible', timeout: 10_000 })
    await deactivate.click()
    const activate = page.locator('[data-id="pluginManagerComponentActivateButtonsolidityUnitTesting"]')
    await activate.waitFor({ state: 'visible', timeout: 10_000 })
    await activate.click()
    await page.locator('#icon-panel div[plugin="solidityUnitTesting"]').waitFor({ state: 'visible', timeout: 10_000 })
    await page.locator('#icon-panel div[plugin="filePanel"]').click()
    await createWorkspace(page, 'unit-after-reactivation')
    await page.locator('#icon-panel div[plugin="solidityUnitTesting"]').click()
    await expect(page.locator('[data-id="uiPathInput"]')).toHaveValue('tests', { timeout: 10_000 })

    expect(pageErrors.map(error => error.message)).not.toContainEqual(
      expect.stringMatching(/Cannot set properties of undefined.*value/)
    )
  })
})
