import { Page, expect } from '@playwright/test'

/**
 * Hide the webpack dev-server overlay and dismiss the first-load "I Understand"
 * welcome dialog if it appears. Safe to call on every page that may show it.
 */
export async function dismissWelcomeModal(page: Page) {
  try {
    await page.addStyleTag({ content: '#webpack-dev-server-client-overlay { display: none !important; }' })
  } catch (e) {}
  const welcomeDialogBtn = page.locator('button:has-text("I Understand")')
  try {
    await welcomeDialogBtn.waitFor({ state: 'visible', timeout: 5000 })
    await welcomeDialogBtn.click()
  } catch (e) {
    // Ignore if dialog does not appear
  }
}

/** Load the IDE and wait until the landing page is interactive. */
export async function gotoHome (page: Page) {
  await page.goto('/')
  await dismissWelcomeModal(page)
  await page.locator('[data-id="landingWorkspaceStatus"]').waitFor({ timeout: 30_000 })
}

/** data-id selector for a row of the File Explorer tree. */
export function treeItem (path: string) {
  return `[data-id="treeViewLitreeViewItem${path}"]`
}

/**
 * Show plugin `name` in the side panel WITHOUT toggle-closing it: clicking the
 * icon of the plugin that is already shown collapses the panel. The check must
 * key off the VISIBILITY of the plugin's own panel content (`readySelector`) —
 * not the swap-it header text, which keeps its last value while the panel is
 * collapsed to zero width. Safe whether the panel currently shows this plugin,
 * another plugin, or is collapsed.
 */
export async function ensureSidePanel (page: Page, name: string, readySelector: string) {
  const ready = page.locator(readySelector)
  if (!await ready.isVisible().catch(() => false)) {
    await page.locator(`#icon-panel div[plugin="${name}"]`).click()
    await ready.waitFor({ state: 'visible', timeout: 10_000 })
  }
}

/** Make the File Explorer the shown side panel (see ensureSidePanel). */
export async function ensureFilePanel (page: Page) {
  await ensureSidePanel(page, 'filePanel', '[data-id="filePanelFileExplorerTree"]')
}

/**
 * Activate the Solidity UML plugin via the Plugin Manager if needed, then show
 * its panel without toggle-closing it.
 */
export async function activateUml (page: Page) {
  if (await page.locator('#icon-panel div[plugin="solidityUml"]').count() === 0) {
    await page.locator('#icon-panel div[plugin="pluginManager"]').click()
    await page.locator('[data-id="pluginManagerComponentActivateButtonsolidityUml"]').click()
    await page.locator('#icon-panel div[plugin="solidityUml"]').waitFor({ timeout: 10_000 })
  }
  await ensureSidePanel(page, 'solidityUml', '[data-id="solidityUmlPanel"]')
}

/**
 * Abort every Solidity compiler source — the remote version list/binaries AND
 * the bundled same-origin fallback (assets/js/soljson.js) — so the specs never
 * spend CPU on solc. Ctrl+S still saves (compile-tab's global handler runs
 * fileManager.saveCurrentFile() before compiling) but the compile attempt now
 * fails instantly instead of loading a compiler and saturating the runner: the
 * compile-saturation flake must stay out of the @gate subset. Call BEFORE
 * page.goto.
 */
export async function blockCompilerSources (page: Page) {
  await page.route(
    /binaries\.soliditylang\.org|tronprotocol\.github\.io|\/assets\/js\/soljson\.js/,
    (route) => route.abort()
  )
}

/** Replace the whole Ace editor buffer. */
export async function setEditorText (page: Page, source: string) {
  await page.evaluate((s) => {
    const el = document.getElementById('input') as any
    el.editor.session.setValue(s)
  }, source)
}

/** Current Ace editor buffer ('' when the editor isn't up yet). */
export async function getEditorText (page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.getElementById('input') as any
    return el && el.editor ? el.editor.session.getValue() : ''
  })
}

/**
 * Read a workspace file straight from the in-browser filesystem ('' if
 * missing). This is the saved (provider) content, not the editor buffer.
 */
export async function readSavedFile (page: Page, path: string): Promise<string> {
  return page.evaluate((p) => {
    try {
      const select = document.querySelector('#workspacesSelect') as HTMLSelectElement | null
      const ws = (select && select.value) || 'default_workspace'
      return (window as any).remixFileSystem.readFileSync(`.workspaces/${ws}/${p}`, 'utf8')
    } catch (e) {
      return ''
    }
  }, path)
}

/**
 * Ctrl+S the active file, then wait until the provider actually holds
 * `mustContain` — the deterministic replacement for sleeping after a save.
 */
export async function saveCurrentFile (page: Page, path: string, mustContain: string) {
  await page.keyboard.press('Control+S')
  await expect.poll(() => readSavedFile(page, path), { timeout: 15_000 }).toContain(mustContain)
}

/**
 * Create a file through the File Explorer's inline-edit flow. The explorer adds
 * a blank tree row in edit mode under the currently FOCUSED folder — not the
 * workspace root — and focuses its contenteditable label on a ~150ms delay:
 * wait for that focus before typing. Waits for the new row (matched by data-id
 * suffix, since the full path depends on the focused folder) to appear.
 */
export async function createFile (page: Page, name: string) {
  await ensureFilePanel(page)
  await page.locator('[data-id="fileExplorerNewFilecreateNewFile"]').click()
  const blank = page.locator('[data-id$="/blank"]').first()
  await blank.waitFor({ state: 'visible', timeout: 10_000 })
  await expect(blank.locator('.remixui_items[contenteditable="true"]')).toBeFocused({ timeout: 10_000 })
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await page.locator(`[data-id^="treeViewLitreeViewItem"][data-id$="${name}"]`).waitFor({ timeout: 20_000 })
}

// Ace annotations carry { row, column, text, type }. Lint-owned annotations are
// tagged with their rule in the message text — the single source of truth for
// which rules exist; specs must not copy this list.
export const LINT_RULE_TAG = /\[(spdx|pragma|func-visibility|state-visibility|avoid-tx-origin|no-selfdestruct|avoid-throw|avoid-sha3|reason-string|contract-name-capwords)\]/

/** Only the lint plugin's annotations, read straight off the Ace session. */
export async function lintAnnotations (page: Page): Promise<Array<{ type: string, text: string, row: number }>> {
  const all = await page.evaluate(() => {
    const el = document.getElementById('input') as any
    return ((el && el.editor && el.editor.session.getAnnotations()) || [])
      .map((a: any) => ({ type: a.type, text: a.text, row: a.row }))
  })
  return all.filter((a) => LINT_RULE_TAG.test(a.text))
}
