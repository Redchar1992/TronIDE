import { test, expect, Page } from '@playwright/test'
import { gotoHome, treeItem, ensureFilePanel, setEditorText, lintAnnotations } from './helpers'

// TC-LINT-001/002 (v2.3.2 T2): the in-editor Solidity linter surfaces a focused
// set of high-value rules as live annotations, lazily loading the parser and
// never disrupting editing.

async function openStorageWith (page: Page, source: string) {
  await gotoHome(page)
  await ensureFilePanel(page)
  const file = page.locator(treeItem('contracts/1_Storage.sol'))
  if (!await file.isVisible().catch(() => false)) await page.locator(treeItem('contracts')).click()
  await file.click()
  await page.locator('#input').waitFor({ timeout: 10_000 })
  await setEditorText(page, source)
}

test.describe('Solidity lint (in-editor)', () => {
  test('TC-LINT-001: flags missing visibility, tx.origin and selfdestruct as annotations', async ({ page }) => {
    await openStorageWith(page, [
      'pragma solidity ^0.8.0;',
      'contract Risky {',
      '    uint256 secret;',
      '    function login() { require(tx.origin == msg.sender); }',
      '    function boom() public { selfdestruct(payable(msg.sender)); }',
      '}'
    ].join('\n'))

    // lint is debounced; poll until the parser chunk loads and annotations land
    await expect.poll(() => lintAnnotations(page), { timeout: 30_000 }).not.toHaveLength(0)
    const ann = await lintAnnotations(page)
    const texts = ann.map((a) => a.text).join(' | ')

    expect(texts).toMatch(/\[spdx\]/)               // no SPDX header
    expect(texts).toMatch(/\[func-visibility\]/)    // login() has no visibility
    expect(texts).toMatch(/\[state-visibility\]/)   // secret has no visibility
    expect(texts).toMatch(/\[avoid-tx-origin\]/)    // tx.origin auth
    expect(texts).toMatch(/\[no-selfdestruct\]/)    // selfdestruct
    // visibility/tx-origin are warnings, state-visibility is info
    expect(ann.find((a) => /func-visibility/.test(a.text))!.type).toBe('warning')
    expect(ann.find((a) => /state-visibility/.test(a.text))!.type).toBe('info')
  })

  test('TC-LINT-003: flags the Solhint-style rules (throw, sha3, require reason, CapWords)', async ({ page }) => {
    await openStorageWith(page, [
      '// SPDX-License-Identifier: MIT',
      'pragma solidity ^0.8.0;',
      'contract lowercase {',
      '    function go() public {',
      '        require(msg.sender != address(0));',
      '        if (msg.sender == address(0)) throw;',
      '        bytes32 h = sha3("x");',
      '    }',
      '}'
    ].join('\n'))

    await expect.poll(() => lintAnnotations(page), { timeout: 30_000 }).not.toHaveLength(0)
    const texts = (await lintAnnotations(page)).map((a) => a.text).join(' | ')
    expect(texts).toMatch(/\[contract-name-capwords\]/) // contract "lowercase"
    expect(texts).toMatch(/\[reason-string\]/)          // require without a message
    expect(texts).toMatch(/\[avoid-throw\]/)            // throw
    expect(texts).toMatch(/\[avoid-sha3\]/)             // sha3
  })

  // TC-LINT-008 (J-011): FILE-LEVEL (free) functions cannot carry a
  // visibility — flagging them was a false positive found linting a types
  // file with free functions + a global using-for. Contract members without
  // visibility must still flag (control).
  test('TC-LINT-008: file-level free functions are not flagged for visibility', { tag: '@gate' }, async ({ page }) => {
    await openStorageWith(page, [
      '// SPDX-License-Identifier: MIT',
      'pragma solidity ^0.8.20;',
      'struct Pair { uint256 a; uint256 b; }',
      'function sum(Pair memory p) pure returns (uint256) { return p.a + p.b; }',
      'using { sum } for Pair global;',
      'contract Holder {',
      '    function bad() { }', // control: this one must still flag
      '}'
    ].join('\n'))

    await expect.poll(() => lintAnnotations(page), { timeout: 30_000 }).not.toHaveLength(0)
    const texts = (await lintAnnotations(page)).map((a) => a.text)
    // the contract member flags…
    expect(texts.some((t) => t.includes('"bad"') && t.includes('[func-visibility]'))).toBe(true)
    // …the free function does not
    expect(texts.some((t) => t.includes('"sum"'))).toBe(false)
  })

  test('TC-LINT-002: clean code lints clean, and a syntax error does not crash the editor', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    // a well-formed contract: SPDX, pragma, explicit visibility everywhere
    await openStorageWith(page, [
      '// SPDX-License-Identifier: MIT',
      'pragma solidity ^0.8.0;',
      'contract Clean {',
      '    uint256 private value;',
      '    function set(uint256 v) public { value = v; }',
      '    function get() public view returns (uint256) { return value; }',
      '}'
    ].join('\n'))
    await page.waitForTimeout(3_000)
    expect(await lintAnnotations(page)).toHaveLength(0)

    // now break the syntax — AST rules must stay silent (the compiler owns
    // syntax errors) and the editor must remain alive. File-level checks
    // (SPDX/pragma) are kept satisfied so only AST findings could appear.
    await setEditorText(page, '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Broken {{{ uint256 ')
    await page.waitForTimeout(3_000)
    expect(await lintAnnotations(page)).toHaveLength(0)
    expect(pageErrors).toEqual([])
    // editor still editable
    await setEditorText(page, '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Ok { function f() public {} }')
    await page.waitForTimeout(2_000)
    expect(pageErrors).toEqual([])
  })
})
