import { test, expect, Page } from '@playwright/test'
import { gotoHome, createFile } from './helpers'

// TC-ED-010 (v2.3.2): syntax highlighting follows the file extension. Web
// artifacts (html/css) rendered as plain text because their Ace modes were
// never registered — an unregistered extension silently falls back to
// ace/mode/text with no error anywhere. Deterministic (no compile, no network)
// → @gate.

async function openByName (page: Page, name: string) {
  await page.locator(`[data-id^="treeViewLitreeViewItem"][data-id$="${name}"]`).click()
  await page.locator('#input').waitFor({ timeout: 10_000 })
}

async function editorModeId (page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.getElementById('input') as any
    return el && el.editor ? String(el.editor.session.getMode().$id || '') : ''
  })
}

test.describe('Editor syntax modes', () => {
  test('TC-ED-010: html/js/css files open with their syntax mode, not plain text', { tag: '@gate' }, async ({ page }) => {
    await gotoHome(page)

    await createFile(page, 'index.html')
    await openByName(page, 'index.html')
    await expect.poll(() => editorModeId(page), { timeout: 10_000 }).toBe('ace/mode/html')

    await createFile(page, 'app.js')
    await openByName(page, 'app.js')
    await expect.poll(() => editorModeId(page), { timeout: 10_000 }).toBe('ace/mode/javascript')

    await createFile(page, 'style.css')
    await openByName(page, 'style.css')
    await expect.poll(() => editorModeId(page), { timeout: 10_000 }).toBe('ace/mode/css')
  })
})
