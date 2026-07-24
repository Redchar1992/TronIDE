import { test, expect, Page } from '@playwright/test'
import {
  gotoHome, treeItem, ensureFilePanel, ensureSidePanel, activateUml,
  setEditorText, saveCurrentFile, blockCompilerSources
} from './helpers'

// TC-IX-UML-* / TC-UML-004 (v2.3.2): interaction-level coverage for the Solidity
// UML plugin BEYOND the initial render (solidity-uml.spec.ts already covers
// TC-UML-001/002). These target the reactive-redraw path behind the
// `fix(uml): replay dropped redraw` commit (solidity-uml-tab.js
// generate()/pendingGenerate), the side-panel toggle-close gotcha, and the
// Copy-Mermaid affordance. All deterministic (browser-native parser + mermaid;
// compiler sources blocked so the Ctrl+S saves never start a solc run), hence
// @gate.

const ALPHA = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity >=0.8.2 <0.9.0;',
  'contract Alpha { uint256 public a; function fa() external {} }'
].join('\n')
const BETA = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity >=0.8.2 <0.9.0;',
  'contract Beta { address public b; function fb() external {} }'
].join('\n')

async function openFile (page: Page, path: string) {
  await ensureFilePanel(page)
  const file = page.locator(treeItem(path))
  if (!await file.isVisible().catch(() => false)) await page.locator(treeItem('contracts')).click()
  await file.click()
  await page.locator('#input').waitFor({ timeout: 10_000 })
}

async function seedFile (page: Page, path: string, source: string) {
  await openFile(page, path)
  await setEditorText(page, source)
  await saveCurrentFile(page, path, source)
}

function showUml (page: Page) {
  return ensureSidePanel(page, 'solidityUml', '[data-id="solidityUmlPanel"]')
}

test.describe('Solidity UML interactions', () => {
  test.beforeEach(async ({ page }) => {
    await blockCompilerSources(page)
    await gotoHome(page)
  })

  test('TC-IX-UML-001: the diagram redraws when the active .sol changes', { tag: '@gate' }, async ({ page }) => {
    await seedFile(page, 'contracts/1_Storage.sol', ALPHA)
    await seedFile(page, 'contracts/3_Ballot.sol', BETA)

    // Open UML on Storage(Alpha) and render it.
    await openFile(page, 'contracts/1_Storage.sol')
    await activateUml(page)
    await page.locator('[data-id="umlGenerate"]').click()
    await expect(page.locator('[data-id="umlStatus"]')).toContainText('1_Storage.sol', { timeout: 40_000 })
    await expect(page.locator('[data-id="umlMermaidText"]')).toHaveValue(/class Alpha/, { timeout: 20_000 })

    // Switch the active file. onActivation subscribes to fileManager
    // 'currentFileChanged' → redraw(), so the diagram must follow WITHOUT a
    // second Generate click.
    await openFile(page, 'contracts/3_Ballot.sol')
    await showUml(page)
    await expect(page.locator('[data-id="umlStatus"]')).toContainText('3_Ballot.sol', { timeout: 40_000 })
    await expect(page.locator('[data-id="umlMermaidText"]')).toHaveValue(/class Beta/, { timeout: 20_000 })
    expect(await page.locator('[data-id="umlMermaidText"]').inputValue()).not.toMatch(/class Alpha/)
  })

  test('TC-IX-UML-002: rapid file switches settle on the latest file (dropped-redraw replay)', { tag: '@gate' }, async ({ page }) => {
    await seedFile(page, 'contracts/1_Storage.sol', ALPHA)
    await seedFile(page, 'contracts/3_Ballot.sol', BETA)

    await openFile(page, 'contracts/1_Storage.sol')
    await activateUml(page)
    await page.locator('[data-id="umlGenerate"]').click()
    await expect(page.locator('[data-id="umlMermaidText"]')).toHaveValue(/class Alpha/, { timeout: 40_000 })

    // Fire several file switches back-to-back so a switch lands while a mermaid
    // render is still in flight. generate()'s pendingGenerate guard must replay
    // once more in its finally so the panel ends on the LAST file (Ballot/Beta),
    // never stuck on a stale earlier render.
    await ensureFilePanel(page)
    await page.locator(treeItem('contracts/3_Ballot.sol')).click()
    await page.locator(treeItem('contracts/1_Storage.sol')).click()
    await page.locator(treeItem('contracts/3_Ballot.sol')).click()

    await showUml(page)
    await expect(page.locator('[data-id="umlStatus"]')).toContainText('3_Ballot.sol', { timeout: 40_000 })
    await expect(page.locator('[data-id="umlMermaidText"]')).toHaveValue(/class Beta/, { timeout: 20_000 })
    expect(await page.locator('[data-id="umlMermaidText"]').inputValue()).not.toMatch(/class Alpha/)
  })

  test('TC-IX-UML-003: toggling the panel closed and reopening keeps the diagram', { tag: '@gate' }, async ({ page }) => {
    await seedFile(page, 'contracts/1_Storage.sol', ALPHA)
    await openFile(page, 'contracts/1_Storage.sol')
    await activateUml(page)
    await page.locator('[data-id="umlGenerate"]').click()
    await expect(page.locator('[data-id="umlDiagram"] svg').first()).toBeAttached({ timeout: 40_000 })

    // Clicking the icon of the plugin that is CURRENTLY shown toggles the side
    // panel closed (known IDE gotcha) — the panel content hides…
    await page.locator('#icon-panel div[plugin="solidityUml"]').click()
    await expect(page.locator('[data-id="solidityUmlPanel"]')).toBeHidden({ timeout: 10_000 })

    // …and clicking again reopens it with the diagram still present (no blank
    // panel / lost render on reopen).
    await page.locator('#icon-panel div[plugin="solidityUml"]').click()
    await expect(page.locator('[data-id="solidityUmlPanel"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-id="umlDiagram"] svg').first()).toBeAttached({ timeout: 10_000 })
    await expect(page.locator('[data-id="umlStatus"]')).toContainText('1_Storage.sol')
  })

  test('TC-UML-004: Copy Mermaid writes the diagram source to the clipboard', { tag: '@gate' }, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await seedFile(page, 'contracts/1_Storage.sol', ALPHA)
    await openFile(page, 'contracts/1_Storage.sol')
    await activateUml(page)
    await page.locator('[data-id="umlGenerate"]').click()
    await expect(page.locator('[data-id="umlMermaidText"]')).toHaveValue(/class Alpha/, { timeout: 40_000 })

    await page.locator('[data-id="umlCopy"]').click()
    await expect(page.locator('[data-id="umlStatus"]')).toContainText(/copied to clipboard/i, { timeout: 10_000 })
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip).toMatch(/^classDiagram/)
    expect(clip).toMatch(/class Alpha/)
  })
})
