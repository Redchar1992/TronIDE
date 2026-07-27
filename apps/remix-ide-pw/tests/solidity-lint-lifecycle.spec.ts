import { test, expect, Page } from '@playwright/test'
import { gotoHome, treeItem, ensureFilePanel, setEditorText, lintAnnotations } from './helpers'

// TC-LINT-004/005/006/007 (v2.3.2): the LIFECYCLE of the in-editor lint annotations,
// beyond "do the rules fire" (solidity-lint.spec.ts covers firing). The linter
// runs debounced (~600ms) on editor 'change' and keeps its own
// 'solidityLint'-tagged annotations PER FILE (editor.js _runLint), preserving
// other plugins' annotations. All deterministic (browser parser only) → @gate.

// missing SPDX, no visibility on login(), state var `secret`, tx.origin, require w/o reason
const DIRTY = [
  'pragma solidity ^0.8.0;',
  'contract Risky {',
  '    uint256 secret;',
  '    function login() { require(tx.origin == msg.sender); }',
  '}'
].join('\n')

const CLEAN = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity ^0.8.0;',
  'contract Clean {',
  '    uint256 private value;',
  '    function get() public view returns (uint256) { return value; }',
  '}'
].join('\n')

async function openFileWith (page: Page, path: string, source: string) {
  await ensureFilePanel(page)
  const file = page.locator(treeItem(path))
  if (!await file.isVisible().catch(() => false)) await page.locator(treeItem('contracts')).click()
  await file.click()
  await page.locator('#input').waitFor({ timeout: 10_000 })
  await setEditorText(page, source)
}

async function lintText (page: Page): Promise<string> {
  return (await lintAnnotations(page)).map((a) => a.text).join(' | ')
}

test.describe('Solidity lint lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHome(page)
  })

  test('TC-LINT-004: fixing one flagged issue clears only that annotation', { tag: '@gate' }, async ({ page }) => {
    await openFileWith(page, 'contracts/1_Storage.sol', DIRTY)

    // the dirty contract raises several rules, including avoid-tx-origin
    await expect.poll(() => lintText(page), { timeout: 30_000 }).toMatch(/\[avoid-tx-origin\]/)

    // remove ONLY the tx.origin usage; the other findings must stay
    await setEditorText(page, DIRTY.replace('tx.origin', 'msg.sender'))

    // the tx-origin annotation drains after the re-lint…
    await expect.poll(() => lintText(page), { timeout: 30_000 }).not.toMatch(/\[avoid-tx-origin\]/)
    // …but unrelated findings (missing SPDX) remain — a targeted clear, not a wipe
    expect(await lintText(page)).toMatch(/\[spdx\]/)
  })

  test('TC-LINT-005: annotations track the active file, not a stale buffer', { tag: '@gate' }, async ({ page }) => {
    // File A is dirty → annotations present
    await openFileWith(page, 'contracts/1_Storage.sol', DIRTY)
    await expect.poll(() => lintAnnotations(page), { timeout: 30_000 }).not.toHaveLength(0)

    // Switch to file B, make it clean → B shows NO lint annotations
    await openFileWith(page, 'contracts/3_Ballot.sol', CLEAN)
    await expect.poll(() => lintAnnotations(page), { timeout: 30_000 }).toHaveLength(0)

    // Back to A → its findings are still there (kept per-session, not lost)
    await page.locator(treeItem('contracts/1_Storage.sol')).click()
    await expect.poll(() => lintAnnotations(page), { timeout: 30_000 }).not.toHaveLength(0)
  })

  test('TC-LINT-006: rapid edits stay responsive and settle after typing stops', { tag: '@gate' }, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await openFileWith(page, 'contracts/1_Storage.sol', CLEAN)
    await expect.poll(() => lintAnnotations(page), { timeout: 30_000 }).toHaveLength(0)

    // Several quick edits, each faster than the ~600ms lint debounce. The editor
    // must stay alive and, once edits stop, annotations reflect the FINAL content.
    for (let i = 0; i < 5; i++) {
      await setEditorText(page, CLEAN + `\n// edit ${i}\n`)
      await page.waitForTimeout(120)
    }
    // final content is still clean → settles to zero, no thrash / no crash
    await expect.poll(() => lintAnnotations(page), { timeout: 30_000 }).toHaveLength(0)

    // a final dirty edit still lints (the debounce never wedged)
    await setEditorText(page, DIRTY)
    await expect.poll(() => lintAnnotations(page), { timeout: 30_000 }).not.toHaveLength(0)
    expect(pageErrors).toEqual([])
  })

  test('TC-LINT-007: annotations survive a side panel focus change', { tag: '@gate' }, async ({ page }) => {
    await openFileWith(page, 'contracts/1_Storage.sol', DIRTY)
    await expect.poll(() => lintAnnotations(page), { timeout: 30_000 }).not.toHaveLength(0)
    const before = (await lintAnnotations(page)).length

    // Focus a DIFFERENT side panel plugin (file explorer → compiler). sidePanel
    // 'focusChanged' → editor.keepAnnotationsFor(name) hides foreign plugins'
    // annotations, but the editor-owned lint ones must stay visible. (Clicking
    // the already-active icon would toggle the panel closed instead.)
    await page.locator('#icon-panel div[plugin="solidity"]').click()
    await page.locator('[data-id="compilerContainerCompileBtn"]').waitFor({ timeout: 10_000 })
    await page.waitForTimeout(1_000)
    expect((await lintAnnotations(page)).length).toBe(before)

    // …and back to the file explorer: still intact, no edit needed to restore
    await page.locator('#icon-panel div[plugin="filePanel"]').click()
    await page.locator('[data-id="filePanelFileExplorerTree"]').waitFor({ timeout: 10_000 })
    await page.waitForTimeout(1_000)
    expect((await lintAnnotations(page)).length).toBe(before)
  })
})
