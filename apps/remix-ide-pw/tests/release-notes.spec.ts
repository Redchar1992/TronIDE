import { test, expect, Page } from '@playwright/test'
import { dismissWelcomeModal } from './helpers'

// TC-RN-001/002 (v2.3.2): in-app Release Notes page. Entry points: the header
// version badge and the Home hero "Release Notes" link. The page lists the
// v2.3.x releases newest-first and states the running version.

async function openHome (page: Page) {
  await page.goto('/')
  await dismissWelcomeModal(page)
  await page.locator('[data-id="landingWorkspaceStatus"]').waitFor({ timeout: 30_000 })
}

test.describe('Release notes', () => {
  test('TC-RN-001: the header version badge opens the Release Notes tab', { tag: '@gate' }, async ({ page }) => {
    await openHome(page)
    await page.locator('[data-id="headerVersionBadge"]').click()
    await expect(page.locator('[data-id="releaseNotesView"]')).toBeVisible({ timeout: 15_000 })
    // every 2.3.x release is present, and the running version is stated
    await expect(page.locator('[data-id="releaseNotesV232"]')).toBeVisible()
    await expect(page.locator('[data-id="releaseNotesV231"]')).toBeVisible()
    await expect(page.locator('[data-id="releaseNotesV230"]')).toBeVisible()
    await expect(page.locator('[data-id="releaseNotesView"]')).toContainText('You are running TRON IDE v')
  })

  test('TC-RN-002: the Home hero link opens Release Notes and Home still works after', { tag: '@gate' }, async ({ page }) => {
    await openHome(page)
    await page.locator('[data-id="landingReleaseNotesLink"]').click()
    await expect(page.locator('[data-id="releaseNotesView"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-id="releaseNotesV230"]')).toContainText('TronLink')
    // back to Home via the logo; the landing page is still alive
    await page.locator('.homeIcon').click()
    await expect(page.locator('[data-id="landingRemix220Hero"]')).toBeVisible({ timeout: 15_000 })
  })

  // TC-RN-003: the "Report an issue" feedback entry — on the Home hero and at
  // the bottom of the Release Notes page — links straight to the project's
  // GitHub issues.
  test('TC-RN-003: the feedback entry links to GitHub issues', { tag: '@gate' }, async ({ page }) => {
    const ISSUES = 'https://github.com/tronweb3/TronIDE/issues'
    await openHome(page)
    // Home hero: a "Report an issue" link opening the issues page in a new tab
    const homeLink = page.locator('[data-id="landingReportIssueLink"]')
    await expect(homeLink).toBeVisible({ timeout: 15_000 })
    await expect(homeLink).toHaveAttribute('href', ISSUES)
    await expect(homeLink).toHaveAttribute('target', '_blank')
    // Release Notes page footer: same issues link
    await page.locator('[data-id="landingReleaseNotesLink"]').click()
    await expect(page.locator('[data-id="releaseNotesView"]')).toBeVisible({ timeout: 15_000 })
    const notesLink = page.locator('[data-id="releaseNotesReportIssue"]')
    await expect(notesLink).toHaveAttribute('href', ISSUES)
    await expect(page.locator('[data-id="releaseNotesView"]')).toContainText('Help & Feedback')
  })

  // TC-RN-004: global header entries — Release Notes (opens the page) and a
  // Feedback button (opens the GitHub issues page in a new tab), reachable from
  // anywhere in the IDE, not just the Home page.
  test('TC-RN-004: the header exposes Release Notes and a Feedback entry', { tag: '@gate' }, async ({ page }) => {
    await openHome(page)
    // header Release Notes button opens the notes page
    await page.locator('[data-id="headerReleaseNotes"]').click()
    await expect(page.locator('[data-id="releaseNotesView"]')).toBeVisible({ timeout: 15_000 })
    // header Feedback button opens the GitHub issues page in a new tab. The
    // button calls window.open(..., 'noopener'), so the popup starts as
    // about:blank and its cross-origin navigation may not have committed when
    // Playwright's popup event fires (and never commits on a runner without
    // external network) — capture the window.open argument instead of racing
    // the popup's URL.
    await page.evaluate(() => {
      const w = window as any
      w.__openedUrls = []
      w.open = (url?: unknown) => { w.__openedUrls.push(String(url)); return null }
    })
    await page.locator('[data-id="headerReportIssue"]').click()
    const openedUrls = await page.evaluate(() => (window as any).__openedUrls as string[])
    expect(openedUrls).toHaveLength(1)
    expect(openedUrls[0]).toContain('github.com/tronweb3/TronIDE/issues')
  })
})
