import { test, expect, Page } from '@playwright/test'
import { dismissWelcomeModal } from './helpers'

// TRON Cookbook recipe cards (v2.3.2): each card click must give visible
// feedback and must not double-fire toasts. These run in a fresh browser with
// NO TronLink injected, which is the case the user hit ("no reaction" /
// "two toasts").

async function openHomeCookbook (page: Page) {
  await page.goto('/')
  await dismissWelcomeModal(page)
  await page.locator('[data-id="landingWorkspaceStatus"]').waitFor({ timeout: 30_000 })
  // The Cookbook lives in the Advanced Tools section — expand it if collapsed.
  const advToggle = page.locator('[data-id="landingAdvancedToolsToggle"]')
  if ((await advToggle.getAttribute('aria-expanded')) === 'false') await advToggle.click()
  await page.locator('[data-id="landingRecipeTronLink"]').waitFor({ state: 'visible', timeout: 10_000 })
}

const toast = (page: Page) => page.locator('[data-shared="tooltipPopup"]')

test.describe('Home TRON Cookbook recipes', () => {
  // TC-CB-001: TronLink readiness gives visible feedback (a toast), not just a
  // silent bell notification — the locked/uninjected case looked like a no-op.
  test('TC-CB-001: TronLink readiness shows a visible toast', { tag: '@gate' }, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await openHomeCookbook(page)
    await page.locator('[data-id="landingRecipeTronLink"]').click()
    // a toast appears mentioning TronLink (installed-or-not / locked guidance)
    await expect(toast(page).filter({ hasText: /TronLink/i }).first()).toBeVisible({ timeout: 10_000 })
    expect(errors).toEqual([])
  })

  // TC-CB-002: Nile deploy checklist must show a SINGLE toast, not two. The
  // udapp connect flow already surfaces the outcome; the Home handler used to
  // also tooltip the same error, producing a duplicate.
  test('TC-CB-002: Nile deploy checklist shows a single toast, not a duplicate', { tag: '@gate' }, async ({ page }) => {
    await openHomeCookbook(page)
    await page.locator('[data-id="landingRecipeNileDeploy"]').click()
    // wait for the connect outcome toast to appear…
    await expect(toast(page).first()).toBeVisible({ timeout: 15_000 })
    // …then there must be exactly one toast (no duplicate from the Home handler).
    // Poll briefly to let any second toast surface before asserting the count.
    await page.waitForTimeout(1_000)
    await expect(toast(page)).toHaveCount(1)
  })

  // TC-CB-003: keep the implementation available while its entry point is temporarily hidden.
  test('TC-CB-003: GitHub token safety recipe is hidden', { tag: '@gate' }, async ({ page }) => {
    await openHomeCookbook(page)
    await expect(page.locator('[data-id="landingRecipeGithubToken"]')).toHaveCount(0)
  })
})
