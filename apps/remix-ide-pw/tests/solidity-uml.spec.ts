import { test, expect, Page } from '@playwright/test'
import {
  gotoHome, treeItem, ensureFilePanel, activateUml,
  setEditorText, saveCurrentFile, blockCompilerSources
} from './helpers'

// TC-UML-001/002: the Solidity UML plugin parses the active .sol into a Mermaid
// classDiagram and renders it (browser-native @solidity-parser + lazy mermaid;
// no sol2uml/graphviz). The plugin is opt-in via the Plugin Manager.

async function openStorageWith (page: Page, source: string) {
  await ensureFilePanel(page)
  const file = page.locator(treeItem('contracts/1_Storage.sol'))
  if (!await file.isVisible().catch(() => false)) await page.locator(treeItem('contracts')).click()
  await file.click()
  await page.locator('#input').waitFor({ timeout: 10_000 })
  await setEditorText(page, source)
  await saveCurrentFile(page, 'contracts/1_Storage.sol', source)
}

test.describe('Solidity UML', () => {
  test.beforeEach(async ({ page }) => {
    await blockCompilerSources(page)
    await gotoHome(page)
  })

  test('TC-UML-001: renders a Mermaid class diagram for the active contract', async ({ page }) => {
    await openStorageWith(page, [
      '// SPDX-License-Identifier: MIT',
      'pragma solidity >=0.8.2 <0.9.0;',
      'contract Base { uint256 internal _x; function ping() public view returns (uint256) { return _x; } }',
      'contract Token is Base {',
      '    address public owner;',
      '    function transfer(address to, uint256 amount) external returns (bool) { return true; }',
      '}'
    ].join('\n'))

    await activateUml(page)
    await page.locator('[data-id="umlGenerate"]').click()

    // mermaid renders an SVG into the diagram host
    await expect(page.locator('[data-id="umlDiagram"] svg').first()).toBeAttached({ timeout: 40_000 })
    await expect(page.locator('[data-id="umlStatus"]')).toContainText(/Diagram for/i)
    // The labels must SURVIVE the DOMPurify svg-profile sanitize: mermaid must
    // emit SVG <text> (htmlLabels:false in the plugin), because <foreignObject>
    // HTML labels are stripped wholesale and leave text-less class boxes. Assert
    // the user-visible contract (names readable in the diagram), then pin the
    // mechanism (real <text> nodes, no foreignObject remnants).
    const svgText = await page.locator('[data-id="umlDiagram"] svg').first().evaluate((el) => el.textContent || '')
    expect(svgText).toContain('Token')
    expect(svgText).toContain('transfer')
    expect(await page.locator('[data-id="umlDiagram"] svg text').count()).toBeGreaterThan(0)
    expect(await page.locator('[data-id="umlDiagram"] foreignObject').count()).toBe(0)
    // the Mermaid source carries the classes + inheritance
    const text = await page.locator('[data-id="umlMermaidText"]').inputValue()
    expect(text).toMatch(/^classDiagram/)
    expect(text).toMatch(/class Token/)
    expect(text).toMatch(/Base <\|-- Token/)
  })

  test('TC-UML-002: a contract-less file reports no contracts and does not crash', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await openStorageWith(page, '// SPDX-License-Identifier: MIT\npragma solidity >=0.8.2 <0.9.0;\n// just a comment, no contract\n')

    await activateUml(page)
    await page.locator('[data-id="umlGenerate"]').click()
    await expect(page.locator('[data-id="umlStatus"]')).toContainText(/No contracts found/i, { timeout: 30_000 })
    expect(errors).toEqual([])
  })
})
