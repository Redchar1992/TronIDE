import { test, expect, Page } from '@playwright/test'
import { gotoHome } from './helpers'

// TC-GITHUB-002 (v2.3.2 tab-session token): a refresh must keep the GitHub
// connection in the same tab without creating a persistent localStorage/config
// copy. The /user lookup is mocked so no real token or network is needed → @gate.

async function expandAdvancedTools (page: Page) {
  const advToggle = page.locator('[data-id="landingAdvancedToolsToggle"]')
  if ((await advToggle.getAttribute('aria-expanded')) === 'false') await advToggle.click()
  await expect(page.locator('[data-id="landingGithubTokenPanel"]')).toBeVisible({ timeout: 10_000 })
}

test.describe('GitHub token survives refresh in this tab', () => {
  test('TC-GITHUB-002: a reload keeps the tab-session token and connected UI', { tag: '@gate' }, async ({ page }) => {
    await page.route('https://api.github.com/user', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ login: 'tron-tester' }) }))

    await gotoHome(page)
    await expandAdvancedTools(page)
    const panel = page.locator('[data-id="landingGithubTokenPanel"]')

    const connectBtn = page.locator('[data-id="landingGithubTokenConnect"]')
    await expect(connectBtn).toHaveText('Connect token (PAT)')

    // Connect with a (mock-validated) token.
    await connectBtn.click()
    const tokenInput = page.locator('[data-id="modalDialogCustomPromptText"]')
    await tokenInput.waitFor({ state: 'visible', timeout: 10_000 })
    await tokenInput.fill('ghp_faketoken_for_test')
    await page.locator('#modal-footer-ok').click()

    // Connected in the UI and mirrored only to this tab's session storage.
    await expect(page.locator('[data-id="landingGithubTokenDisconnect"]')).toBeVisible({ timeout: 10_000 })
    await expect(panel).toContainText('tron-tester')
    expect(await page.evaluate(() => window.sessionStorage.getItem('tronide.github.token'))).toBe('ghp_faketoken_for_test')
    expect(await page.evaluate(() => window.localStorage.getItem('tronide.github.token'))).toBeNull()

    // Full re-navigation in the same tab rehydrates the token and login.
    await gotoHome(page)
    await expandAdvancedTools(page)
    await expect(page.locator('[data-id="landingGithubTokenConnect"]')).toHaveText('Reconnect token', { timeout: 10_000 })
    await expect(page.locator('[data-id="landingGithubTokenDisconnect"]')).toBeVisible()
    await expect(panel).toContainText('tron-tester')

    // Disconnect clears the session mirror as well as the live state.
    await page.locator('[data-id="landingGithubTokenDisconnect"]').click()
    await expect(page.locator('[data-id="landingGithubTokenConnect"]')).toHaveText('Connect token (PAT)')
    expect(await page.evaluate(() => window.sessionStorage.getItem('tronide.github.token'))).toBeNull()
  })
})
