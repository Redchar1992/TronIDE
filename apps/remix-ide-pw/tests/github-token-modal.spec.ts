import { test, expect } from '@playwright/test'
import { dismissWelcomeModal } from './helpers'

test.describe('GitHub token modal (tab-session storage)', () => {
  test('Connect token modal explains refresh-safe tab-only storage', async ({ page }) => {
    await page.goto('/')
    await dismissWelcomeModal(page)

    // Toggle Advanced Tools open to make GitHub Token panel visible
    await page.locator('[data-id="landingAdvancedToolsToggle"]').click()

    await page.locator('[data-id="landingGithubTokenPanel"]').waitFor({ timeout: 30_000 })

    // Sanity-check the pre-modal state: sessionStorage is empty and no legacy
    // localStorage tokens survive a fresh load.
    const storageBefore = await page.evaluate(() => ({
      session: window.sessionStorage.getItem('tronide.github.token'),
      local: window.localStorage.getItem('tronide.github.token')
    }))
    expect(storageBefore.session).toBeNull()
    expect(storageBefore.local).toBeNull()

    await page.locator('[data-id="landingGithubTokenConnect"]').click()

    // The connection is automatic for this tab; there is no persistent-storage
    // checkbox that could accidentally promote it to localStorage.
    await expect(page.locator('text=Tokens stay in this browser tab')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('text=survive a refresh')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('#githubTokenRemember')).toHaveCount(0)
    await expect(page.locator('text=Remember in this browser')).toHaveCount(0)
  })
})
