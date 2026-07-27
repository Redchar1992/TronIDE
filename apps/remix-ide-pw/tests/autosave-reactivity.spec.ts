import { test, expect, Page } from '@playwright/test'
import { gotoHome, treeItem, ensureFilePanel, setEditorText, getEditorText } from './helpers'

// TC-IX-SAVE-001 (v2.3.2): the editor autosaves on an idle debounce (no Ctrl+S).
// This guards that an edit is persisted (survives a full reload) — the shared
// timing contract behind the reactive fileSaved consumers (UML redraw, lint,
// git-panel refresh).
//
// NOT tagged @gate: the idle-debounce + reload makes it timing-sensitive and
// slower than the deterministic gate subset; it belongs in the smoke run.

async function openStorage (page: Page) {
  await ensureFilePanel(page)
  const f = page.locator(treeItem('contracts/1_Storage.sol'))
  if (!await f.isVisible().catch(() => false)) await page.locator(treeItem('contracts')).click()
  await f.click()
  await page.locator('#input').waitFor({ timeout: 10_000 })
}

test.describe('Editor autosave', () => {
  test('TC-IX-SAVE-001: an idle edit autosaves and survives a reload (no Ctrl+S)', async ({ page }) => {
    await gotoHome(page)
    await openStorage(page)

    const marker = 'AUTOSAVE_MARKER_001'
    // Append a unique marker via the editor and DO NOT press Ctrl+S.
    await setEditorText(page, (await getEditorText(page)) + `\n// ${marker}\n`)

    // Wait past the autosave idle debounce (~5s) without any manual save.
    await page.waitForTimeout(7_000)

    // Full re-navigation: only an autosaved change survives it.
    await gotoHome(page)
    await openStorage(page)
    await expect.poll(() => getEditorText(page), { timeout: 15_000 }).toContain(marker)
  })
})
