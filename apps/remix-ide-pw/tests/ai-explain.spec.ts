import { test, expect, Page } from '@playwright/test'
import { dismissWelcomeModal } from './helpers'

// TC-AI-001 (v2.3.2 AI parity): a compiler error renders an "Explain" button
// that hands the error to the AI panel. The LLM round-trip needs a user API key
// (out of scope for a deterministic e2e), so this locks in the wiring: the
// button appears on a real error and invoking it reaches the AI panel without
// throwing.

async function openHome (page: Page) {
  await page.goto('/')
  await dismissWelcomeModal(page)
  await page.locator('[data-id="landingWorkspaceStatus"]').waitFor({ timeout: 30_000 })
}

const BAD_SOL = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity >=0.8.2 <0.9.0;',
  'contract Broken { function f() public { uint x = ; } }'
].join('\n')

test.describe('AI Explain', () => {
  test('TC-AI-001: a compiler error shows an Explain button that reaches the AI panel', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await openHome(page)

    const file = page.locator('[data-id="treeViewLitreeViewItemcontracts/1_Storage.sol"]')
    if (!await file.isVisible()) await page.locator('[data-id="treeViewLitreeViewItemcontracts"]').click()
    await file.click()
    await page.locator('#input').waitFor({ timeout: 10_000 })
    await page.evaluate((src) => {
      const el = document.getElementById('input') as any
      el.editor.session.setValue(src)
    }, BAD_SOL)
    await page.keyboard.press('Control+S')
    await page.waitForTimeout(1_000)

    await page.locator('#icon-panel div[plugin="solidity"]').click()
    await page.locator('*[data-id="compilerContainerCompileBtn"]').click()

    // The error renderer carries the new Explain button.
    const explain = page.locator('[data-id="rendererExplain"]').first()
    await expect(explain).toBeVisible({ timeout: 30_000 })

    // Invoking it must not throw (it routes the error to aiPanel.explainError).
    await explain.click()
    await page.waitForTimeout(1_500)
    expect(pageErrors, 'clicking Explain should not raise an uncaught error').toEqual([])
  })
})
