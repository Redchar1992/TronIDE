import { test, expect, Page } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { blockCompilerSources, dismissWelcomeModal } from './helpers'

// Extra compiler coverage:
//   TC-CMP-003 — a syntax error is reported with a location, no crash.
//   TC-CMP-004 — local relative / multi-level imports resolve.
//   TC-CMP-006 — a non-allowlisted custom compiler URL is blocked (the
//                malicious script is never injected).

const tmpDir = path.join(os.tmpdir(), 'tronide-pw-cmp')

async function openDefaultWorkspace (page: Page) {
  await page.goto('/')
  await dismissWelcomeModal(page)
  await page.locator('[data-id="landingWorkspaceStatus"]').waitFor({ timeout: 30_000 })
  const storage = page.locator('[data-id="treeViewLitreeViewItemcontracts/1_Storage.sol"]')
  if (!await storage.isVisible()) {
    await page.locator('[data-id="treeViewLitreeViewItemcontracts"]').click()
  }
  await storage.click()
}

async function setEditorContent (page: Page, src: string) {
  await page.locator('#input').waitFor({ timeout: 10_000 })
  await page.evaluate((s) => {
    const el = document.getElementById('input') as any
    el.editor.session.setValue(s)
  }, src)
}

async function createWorkspace (page: Page, name: string) {
  await page.goto('/')
  await dismissWelcomeModal(page)
  await page.locator('[data-id="landingWorkspaceStatus"]').waitFor({ timeout: 30_000 })
  await page.locator('[data-id="workspaceCreate"]').click()
  const input = page.locator('input[data-id="modalDialogCustomPromptTextCreate"]')
  await input.waitFor({ state: 'visible', timeout: 5000 })
  await input.fill(name)
  await page.locator('[data-id="workspacesModalDialog-modal-footer-ok-react"]').click()
  await expect(page.locator('select[data-id="workspacesSelect"]')).toHaveValue(name, { timeout: 15_000 })
}

async function uploadFiles (page: Page, filePaths: string[]) {
  await page.locator('[data-id="fileExplorerFileUpload"]').setInputFiles(filePaths)
  const ok = page.locator('#modal-footer-ok')
  if (await ok.isVisible().catch(() => false)) await ok.click()
}

test.beforeAll(() => fs.mkdirSync(tmpDir, { recursive: true }))

test.describe('Solidity compiler (extra)', () => {
  test('TC-CMP-003: a syntax error is reported with a location and does not crash the IDE', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))
    await openDefaultWorkspace(page)

    // Missing semicolon + unterminated function — a clear parser error.
    await setEditorContent(page, [
      '// SPDX-License-Identifier: GPL-3.0',
      'pragma solidity >=0.8.2 <0.9.0;',
      'contract Broken {',
      '  uint256 public x',
      '  function set(uint256 v) public { x = v }',
      '}'
    ].join('\n'))
    await page.locator('#icon-panel div[plugin="solidity"]').click()
    await page.locator('*[data-id="compilerContainerCompileBtn"]').click()

    // The error renderer shows a danger alert that references a line:col.
    const errorAlert = page.locator('#compileTabView .alert-danger, [data-id="compiledErrors"] .alert-danger').first()
    await expect(errorAlert).toBeVisible({ timeout: 30_000 })
    await expect(errorAlert).toContainText(/ParserError|Expected|;/, { timeout: 10_000 })
    await expect(errorAlert).toContainText(/\d+:\d+|\.sol:\d+/)

    // The IDE survives: still editable, recompiling clean code clears the error.
    expect(pageErrors).toEqual([])
    await setEditorContent(page, [
      '// SPDX-License-Identifier: GPL-3.0',
      'pragma solidity >=0.8.2 <0.9.0;',
      'contract Fixed { uint256 public x; function set(uint256 v) public { x = v; } }'
    ].join('\n'))
    await page.locator('*[data-id="compilerContainerCompileBtn"]').click()
    await expect(page.locator('*[data-id="compiledContracts"]')).toContainText('Fixed', { timeout: 30_000 })
  })

  test('TC-CMP-004: local relative and multi-level imports resolve', async ({ page }) => {
    // libs/Math.sol (deep) ← contracts/Token.sol imports it ← Main.sol imports Token.
    const mathPath = path.join(tmpDir, 'Math.sol')
    const tokenPath = path.join(tmpDir, 'Token.sol')
    const mainPath = path.join(tmpDir, 'Main.sol')
    fs.writeFileSync(mathPath, [
      '// SPDX-License-Identifier: GPL-3.0',
      'pragma solidity >=0.8.2 <0.9.0;',
      'library Math { function add(uint256 a, uint256 b) internal pure returns (uint256) { return a + b; } }'
    ].join('\n'))
    fs.writeFileSync(tokenPath, [
      '// SPDX-License-Identifier: GPL-3.0',
      'pragma solidity >=0.8.2 <0.9.0;',
      'import "./Math.sol";',
      'contract Token { using Math for uint256; uint256 public total; function mint(uint256 v) public { total = total.add(v); } }'
    ].join('\n'))
    fs.writeFileSync(mainPath, [
      '// SPDX-License-Identifier: GPL-3.0',
      'pragma solidity >=0.8.2 <0.9.0;',
      'import "./Token.sol";',
      'contract Main is Token {}'
    ].join('\n'))

    await createWorkspace(page, 'cmp-imports')
    await uploadFiles(page, [mathPath, tokenPath, mainPath])
    await expect(page.locator('[data-id="treeViewLitreeViewItemMain.sol"]')).toBeVisible({ timeout: 15_000 })

    await page.locator('[data-id="treeViewLitreeViewItemMain.sol"]').click()
    await page.locator('#icon-panel div[plugin="solidity"]').click()
    await page.locator('*[data-id="compilerContainerCompileBtn"]').click()

    // Both the importer and the transitively-imported contracts compile, and
    // no "File not found"/"not found" import resolution error appears.
    await expect(page.locator('*[data-id="compiledContracts"]')).toContainText('Main', { timeout: 30_000 })
    const options = (await page.locator('*[data-id="compiledContracts"] option').allInnerTexts()).join(' ')
    expect(options).toContain('Token')
    await expect(page.locator('#compileTabView')).not.toContainText(/not found|Source .* not found|File import callback/i)
  })

  test('TC-CMP-006: a non-allowlisted custom compiler URL is blocked, the script is never injected', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))
    await openDefaultWorkspace(page)
    await page.locator('#icon-panel div[plugin="solidity"]').click()

    const evilUrl = 'https://evil.example.com/soljson.js'
    // Drive the "Add a custom compiler" prompt (the + next to the version
    // select). It's an icon-font button; click it directly via the DOM to
    // avoid icon-glyph sizing/stability flakiness.
    await page.locator('button[data-title="Add a custom compiler with URL"]').evaluate((el: HTMLElement) => el.click())
    const urlInput = page.locator('[data-id="modalDialogCustomPromptCompiler"]')
    await urlInput.waitFor({ state: 'visible', timeout: 10_000 })
    await urlInput.fill(evilUrl)
    await page.locator('[data-id="workspacesModalDialog-modal-footer-ok-react"]').click()

    // After the CMP-CUSTOMURL-1 fix the rejection surfaces as a clear message
    // ("Custom compiler URL not allowed: …") instead of an uncaught throw.
    await expect(page.getByText(/Custom compiler URL not allowed/i)).toHaveCount(1, { timeout: 10_000 })

    // The blocked URL must never be injected as a <script> (the security
    // property: the malicious compiler source is never fetched/executed).
    await page.waitForTimeout(2_000)
    const loadedEvilModule = await page.evaluate((u) => {
      return [...document.querySelectorAll('script')].some((s) => (s as HTMLScriptElement).src === u)
    }, evilUrl)
    expect(loadedEvilModule).toBe(false)

    // After the CMP-CUSTOMURL-1 fix: the rejected URL is NOT shown as the
    // active version (the switch is aborted before any state mutation) and a
    // clear "not allowed" message is shown instead of an uncaught throw.
    const activeVersion = await page.locator('#versionSelector').inputValue().catch(() => '')
    expect(activeVersion).not.toContain('evil.example.com')
    expect(pageErrors.filter((e) => /evil\.example\.com|not allowed/i.test(e))).toEqual([])

    // The compile button is still operable (IDE not wedged).
    await expect(page.locator('*[data-id="compilerContainerCompileBtn"]')).toBeEnabled()
  })

  test('TC-CMP-VER-001: recommended TVM compiler versions are offered and selectable', async ({ page }) => {
    await openDefaultWorkspace(page)
    await page.locator('#icon-panel div[plugin="solidity"]').click()

    // The recommended row renders once the Tron solc list has loaded, with at
    // least the latest 0.8.x line as a quick-pick.
    const row = page.locator('[data-id="compilerRecommendedVersions"]')
    await expect(row).toBeVisible({ timeout: 30_000 })
    const picks = row.locator('button[data-id^="compilerRecommendedVersion-"]')
    await expect.poll(() => picks.count(), { timeout: 15_000 }).toBeGreaterThan(0)
    const labels = await picks.allInnerTexts()
    expect(labels.some((t) => /^0\.8\./.test(t.trim()))).toBeTruthy()

    // Clicking a recommended version sets the compiler selector to that build
    // (state updates synchronously; the soljson download proceeds in the
    // background — the UX contract under test is the one-click selection).
    const target = picks.filter({ hasText: /^0\.8\./ }).first()
    const version = (await target.innerText()).trim()
    await target.click()
    await expect.poll(async () => await page.locator('#versionSelector').inputValue(), { timeout: 10_000 })
      .toContain(version)
  })

  // TC-CMP-VER-002 (v2.3.2): the compilation event carries the REAL solc
  // version, not the literal 'soljson' the upstream code hardcoded.
  test('TC-CMP-VER-002: __last.languageversion holds the real solc version after compiling', async ({ page }) => {
    await openDefaultWorkspace(page)
    await page.locator('#icon-panel div[plugin="solidity"]').click()
    await page.locator('*[data-id="compilerContainerCompileBtn"]').click()
    await expect(page.locator('*[data-id="compiledContracts"]')).toContainText('Storage', { timeout: 30_000 })

    const langVersion = await page.evaluate(() => {
      const art = (window as any).__compilersArtefacts
      return (art && art.__last && art.__last.languageversion) || ''
    })
    // the real solc version, e.g. "0.8.20+commit.…", not the literal 'soljson'
    expect(langVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(langVersion).not.toBe('soljson')
  })

  // TC-CMP-VER-003 (v2.3.2 Q2-b): the version list being unreachable must not
  // throw uncaught; the panel degrades to the bundled builtin compiler.
  test('TC-CMP-VER-003: version list unreachable degrades to builtin with no uncaught error', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.route('**/list.json*', (route) => route.abort())
    await openDefaultWorkspace(page)
    await page.locator('#icon-panel div[plugin="solidity"]').click()
    await expect(page.locator('*[data-id="compilerContainerCompileBtn"]')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(3_000)

    // the degrade-gracefully fix: the same-origin builtin compiler is no longer rejected as
    // a disallowed origin, so the version-load path does not throw uncaught
    expect(pageErrors.filter((e) => /origin is not allowed|not allowed/i.test(e))).toEqual([])
    expect(pageErrors).toEqual([])

    // the panel degraded to the builtin compiler and stays operable
    const version = await page.locator('#versionSelector').inputValue().catch(() => '')
    expect(version === '' || /builtin/i.test(version) || /0\.8/.test(version)).toBeTruthy()
    await expect(page.locator('*[data-id="compilerContainerCompileBtn"]')).toBeEnabled()
  })

  // TC-CMP-VER-005 (v2.3.2): when the version list cannot be fetched (offline /
  // blocked / timed out) the panel must INFORM the user it is falling back to
  // the bundled builtin compiler, not degrade silently (silent-failure M4).
  // VER-003 only asserted no-crash; this closes the "user is informed" gap.
  test('TC-CMP-VER-005: version-list fetch failure informs the user it is using the builtin compiler', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    // make the list.json fetch fail (the offline / blocked scenario)
    await page.route('**/list.json*', (route) => route.abort())
    await openDefaultWorkspace(page)
    await page.locator('#icon-panel div[plugin="solidity"]').click()

    // the fetch-failure path surfaces a toast telling the user it could not
    // fetch the version list and is using the built-in compiler
    await expect(
      page.locator('[data-shared="tooltipPopup"]')
        .filter({ hasText: /could not fetch the compiler version list|using the built-in compiler/i })
        .first()
    ).toBeVisible({ timeout: 30_000 })

    // and it still degrades gracefully — no uncaught error, button operable
    expect(pageErrors).toEqual([])
    await expect(page.locator('*[data-id="compilerContainerCompileBtn"]')).toBeEnabled()
  })

  // TC-CMP-VER-004 (v2.3.2 Q2-c): selecting a 0.4.x build in the full dropdown
  // warns up front on Chromium (the asm.js build crashes the compiler), but
  // does not block the selection.
  test('TC-CMP-VER-004: selecting 0.4.x warns on Chromium without blocking', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the warning targets Chromium-based engines')
    await openDefaultWorkspace(page)
    await page.locator('#icon-panel div[plugin="solidity"]').click()
    const selector = page.locator('#versionSelector')
    await expect.poll(async () => (await selector.locator('option').count()), { timeout: 30_000 }).toBeGreaterThan(5)

    // find a real 0.4.x option value from the live list
    const v04 = await selector.locator('option').evaluateAll((opts) => {
      const m = (opts as HTMLOptionElement[]).find((o) => /^soljson-v0\.4\./.test(o.value))
      return m ? m.value : ''
    })
    test.skip(!v04, 'no 0.4.x build offered by the live list')

    await selector.selectOption(v04)
    // the warning toast names 0.4.x and Chromium
    await expect(page.locator('[data-shared="tooltipPopup"]').filter({ hasText: /0\.4\.x.*Chromium|Chromium.*crashes/i }).first())
      .toBeVisible({ timeout: 10_000 })
    // selection is NOT blocked — the selector now shows the 0.4 version
    await expect.poll(async () => await selector.inputValue(), { timeout: 5_000 }).toContain('0.4.')
  })

  // TC-CMP-VER-006 (v2.3.2): the version list loads but the compiler BINARY
  // download fails (slow/blocked CDN — the mainland-China github.io case).
  // The panel must inform the user and auto-fall back to the bundled builtin
  // compiler, and the builtin must actually COMPILE through the worker: the
  // worker-side URL re-validation used to reject the same-origin builtin
  // (`window` does not exist in a worker), so the fallback target itself was
  // broken — asserting a real compile pins the fix.
  test('TC-CMP-VER-006: compiler binary download failure falls back to builtin and still compiles', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    // deterministic version list (no live-network dependency)…
    await page.route('**/list.json*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ builds: [{ path: 'soljson-v0.8.6+commit.0e36fba0.js', version: '0.8.6', build: 'commit.0e36fba0', longVersion: '0.8.6+commit.0e36fba0' }] })
    }))
    // …then kill the remote binary download itself (builtin stays reachable)
    await page.route(/tronprotocol\.github\.io\/solc-bin\/wasm\/soljson-/, (route) => route.abort())
    await openDefaultWorkspace(page)
    await page.locator('#icon-panel div[plugin="solidity"]').click()

    // the fallback informs the user…
    await expect(
      page.locator('[data-shared="tooltipPopup"]').filter({ hasText: /switched to the built-in compiler/i }).first()
    ).toBeVisible({ timeout: 30_000 })
    // …and selects the builtin build
    await expect.poll(async () => await page.locator('#versionSelector').inputValue(), { timeout: 10_000 }).toBe('builtin')

    // the builtin compiler really works end-to-end through the worker
    await expect(page.locator('*[data-id="compilerContainerCompileBtn"]')).toBeEnabled({ timeout: 30_000 })
    await page.locator('*[data-id="compilerContainerCompileBtn"]').click()
    await expect(page.locator('*[data-id="compiledContracts"]')).toContainText('Storage', { timeout: 30_000 })
    expect(pageErrors).toEqual([])
  })

  // TC-CMP-VER-008 (v2.3.2): the builtin dropdown label must state the version
  // the BUNDLED binary actually reports. The asset was swapped (0.8.6 → 0.8.20)
  // while every label stayed "0.8.6" — banner, toast and pragma matching all
  // described a compiler that wasn't there. Comparing label and binary at
  // runtime makes any future asset swap fail HERE instead of going stale.
  test('TC-CMP-VER-008: builtin label matches the version the bundled compiler reports', { tag: '@gate' }, async ({ page }) => {
    await page.route(/tronprotocol\.github\.io\/solc-bin\/wasm\/soljson-/, (route) => route.abort())
    await openDefaultWorkspace(page)
    await page.locator('#icon-panel div[plugin="solidity"]').click()

    // the blocked binary download lands the panel on the builtin compiler
    const selector = page.locator('#versionSelector')
    await expect.poll(async () => await selector.inputValue(), { timeout: 45_000 }).toBe('builtin')
    const label = await selector.locator('option[value="builtin"]').innerText()
    const labelVersion = (label.match(/(\d+\.\d+\.\d+)/) || [])[1] || ''
    expect(labelVersion, `builtin label "${label}" must carry a version`).not.toBe('')

    // compile with the builtin and compare what the binary itself reports
    await expect(page.locator('*[data-id="compilerContainerCompileBtn"]')).toBeEnabled({ timeout: 30_000 })
    await page.locator('*[data-id="compilerContainerCompileBtn"]').click()
    await expect(page.locator('*[data-id="compiledContracts"]')).toContainText('Storage', { timeout: 60_000 })
    const reported = await page.evaluate(() => {
      const a = (window as any).__compilersArtefacts
      return (a && a.__last && a.__last.languageversion) || ''
    })
    expect(
      reported.startsWith(labelVersion + '+') || reported === labelVersion,
      `label says ${labelVersion} but the bundled binary reports ${reported}`
    ).toBeTruthy()
  })

  // TC-CMP-VER-007 (v2.3.2): when the BUILTIN compiler itself cannot load
  // (fully offline: version list, remote binaries and the bundled soljson all
  // unreachable) the failure must surface once — the auto-fallback must not
  // advertise switching to the compiler that just failed, nor retry-loop.
  test('TC-CMP-VER-007: builtin compiler load failure does not fall back in a loop', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await blockCompilerSources(page)
    await openDefaultWorkspace(page)
    await page.locator('#icon-panel div[plugin="solidity"]').click()

    // the builtin load failure is surfaced in the panel…
    await expect(page.locator('#compileTabView'))
      .toContainText(/Worker error|Failed to load compiler|timed out/i, { timeout: 45_000 })
    // …without the fallback toast (builtin IS the fallback — switching to it
    // again would loop) and without uncaught errors
    await expect(page.locator('[data-shared="tooltipPopup"]').filter({ hasText: /switched to the built-in compiler/i })).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })
})
