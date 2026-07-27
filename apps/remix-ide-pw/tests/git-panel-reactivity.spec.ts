import { test, expect, Page } from '@playwright/test'
import {
  gotoHome, treeItem, ensureFilePanel, ensureSidePanel, createFile,
  setEditorText, getEditorText, saveCurrentFile, blockCompilerSources
} from './helpers'

// TC-GIT-005/006/007 (v2.3.2): local Git panel interactions beyond the
// init→stage→commit path (git-panel.spec.ts). Covers unstage (wired via
// dGitProvider rm, error NOT swallowed), the A/M status badges, and the
// reactive 500ms-debounced refresh (git-panel-tab.js onActivation) that makes
// an in-editor save surface WITHOUT re-opening the panel. Local git only,
// no network, compiler sources blocked → @gate.

const STORAGE = 'contracts/1_Storage.sol'

function openGitPanel (page: Page) {
  return ensureSidePanel(page, 'gitPanel', '[data-id="gitPanel"]')
}

async function initIfNeeded (page: Page) {
  const initBtn = page.locator('[data-id="gitInit"]')
  if (await initBtn.isVisible().catch(() => false)) await initBtn.click()
  // Initialized (whether just now or before) once the staging UI is up.
  await page.locator('[data-id="gitStageAll"]').waitFor({ state: 'visible', timeout: 15_000 })
}

async function openStorage (page: Page) {
  await ensureFilePanel(page)
  const f = page.locator(treeItem(STORAGE))
  if (!await f.isVisible().catch(() => false)) await page.locator(treeItem('contracts')).click()
  await f.click()
  await page.locator('#input').waitFor({ timeout: 10_000 })
}

// Edit the file already open in the editor WITHOUT touching the side panel, so a
// reactive refresh (not a manual re-open) is what surfaces the change. Waits for
// the save to actually land in the workspace FS before returning.
async function editCurrent (page: Page, marker: string) {
  await setEditorText(page, (await getEditorText(page)) + `\n// ${marker}\n`)
  await saveCurrentFile(page, STORAGE, marker)
}

// Stage everything, then wait for the staged rows to render before touching the
// commit message: the panel re-renders when the stage op finishes, and that
// re-render resets the (yo-yo template) textarea — filling it after a blind
// sleep loses the message on a slow runner.
async function stageAll (page: Page) {
  await page.locator('[data-id="gitStageAll"]').click()
  await expect(page.locator('[data-id="gitUnstageFile"]').first()).toBeVisible({ timeout: 15_000 })
}

async function commitBaseline (page: Page) {
  await stageAll(page)
  await page.locator('[data-id="gitCommitMessage"]').fill('baseline')
  await page.locator('[data-id="gitCommit"]').click()
  await expect(page.locator('[data-id="gitLogEntry"]').filter({ hasText: 'baseline' })).toBeVisible({ timeout: 15_000 })
}

async function deleteFromExplorer (page: Page, path: string) {
  await ensureFilePanel(page)
  const row = page.locator(treeItem(path))
  await row.click({ button: 'right' })
  await page.locator('#menuitemdelete').click()
  const dialog = page.locator('[data-id$="ModalDialogContainer-react"]')
    .filter({ hasText: 'Are you sure you want to delete this item?' })
  await expect(dialog).toBeVisible()
  const ok = dialog.locator('.modal-ok')
  await expect(ok).toBeVisible()
  await ok.click()
  // The file-explorer modal can replace its first rendered footer while the
  // opening transition settles. If that swallowed the click, retry the still-
  // visible control instead of sleeping or accepting a flaky false failure.
  if (await dialog.isVisible().catch(() => false)) await ok.click()
  await expect(dialog).toBeHidden()
  await expect(row).toHaveCount(0)
}

function gitRow (page: Page, filename: string) {
  return page.locator('[data-id="gitFileRow"]', { hasText: filename })
}

test.describe('Git panel reactivity & staging', () => {
  test.beforeEach(async ({ page }) => {
    await blockCompilerSources(page)
    await gotoHome(page)
    await openStorage(page)
    await openGitPanel(page)
    await initIfNeeded(page)
  })

  test('TC-GIT-005: unstaging a staged file returns it to Changes', { tag: '@gate' }, async ({ page }) => {
    // Create a known change so the test does not depend on the sample files'
    // initial tracked/untracked state.
    await editCurrent(page, 'GIT-005-CHANGE')
    await expect(gitRow(page, '1_Storage.sol')).toBeVisible({ timeout: 15_000 })

    // Stage just this file, then unstage it.
    await gitRow(page, '1_Storage.sol').locator('[data-id="gitStageFile"]').click()
    await expect(gitRow(page, '1_Storage.sol').locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })
    await gitRow(page, '1_Storage.sol').locator('[data-id="gitUnstageFile"]').click()

    // It returns to Changes (a Stage button reappears) and the rm error was NOT
    // silently swallowed into a fake success.
    await expect(gitRow(page, '1_Storage.sol').locator('[data-id="gitStageFile"]')).toBeVisible({ timeout: 15_000 })
    // gitStatus renders only when there IS a message, so a clean unstage may
    // leave no status node at all — assert no "unstage failed" status exists
    // (count 0 passes whether the node is absent or present-but-clean).
    await expect(page.locator('[data-id="gitStatus"]', { hasText: /unstage failed/i })).toHaveCount(0)
  })

  test('TC-GIT-006: rows show A for a new file and M for a modified tracked file', { tag: '@gate' }, async ({ page }) => {
    // Commit a baseline so the sample files are tracked & clean.
    await commitBaseline(page)

    // Modify a tracked file → status code M (panel updates via reactive refresh).
    await editCurrent(page, 'GIT-006-MODIFY')
    await expect(gitRow(page, '1_Storage.sol').locator('.badge').first()).toHaveText('M', { timeout: 15_000 })

    // Create a brand-new file → status code A (also exercises fileAdded reactivity).
    await createFile(page, 'NewlyAdded.sol')
    await openGitPanel(page) // createFile switched to the file explorer; re-show git
    await expect(gitRow(page, 'NewlyAdded.sol').locator('.badge').first()).toHaveText('A', { timeout: 15_000 })
  })

  test('TC-GIT-007: an in-editor save surfaces in the panel without re-opening it', { tag: '@gate' }, async ({ page }) => {
    // Commit a baseline so Storage is tracked and the panel is clean for it.
    await commitBaseline(page)
    await expect(gitRow(page, '1_Storage.sol')).toHaveCount(0)

    // Edit + save the open file WITHOUT re-opening the panel. The fileManager
    // 'fileSaved' → 500ms debounced refresh must surface the modified file on
    // its own (the reactivity the v2.3.2 fix added).
    await editCurrent(page, 'GIT-007-REACTIVE')
    await expect(gitRow(page, '1_Storage.sol')).toBeVisible({ timeout: 15_000 })
  })

  test('TC-GIT-008: unstage keeps the file tracked — a later commit does not record a deletion', { tag: '@gate' }, async ({ page }) => {
    // Baseline so 1_Storage.sol is TRACKED (the data-loss case: rm-based
    // unstage deleted a tracked file's index entry, so the next commit
    // recorded the file as deleted and a push would remove it remotely).
    await commitBaseline(page)

    // Modify → stage → unstage (must reset the index entry to HEAD, not drop it).
    await editCurrent(page, 'GIT-008-KEEP')
    await expect(gitRow(page, '1_Storage.sol')).toBeVisible({ timeout: 15_000 })
    await gitRow(page, '1_Storage.sol').locator('[data-id="gitStageFile"]').click()
    await expect(gitRow(page, '1_Storage.sol').locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })
    await gitRow(page, '1_Storage.sol').locator('[data-id="gitUnstageFile"]').click()
    await expect(gitRow(page, '1_Storage.sol').locator('[data-id="gitStageFile"]')).toBeVisible({ timeout: 15_000 })

    // Commit a DIFFERENT change only (never re-staging Storage).
    await createFile(page, 'Companion.sol')
    await openGitPanel(page)
    await expect(gitRow(page, 'Companion.sol')).toBeVisible({ timeout: 15_000 })
    await gitRow(page, 'Companion.sol').locator('[data-id="gitStageFile"]').click()
    await expect(gitRow(page, 'Companion.sol').locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })
    await page.locator('[data-id="gitCommitMessage"]').fill('companion only')
    await page.locator('[data-id="gitCommit"]').click()
    await expect(page.locator('[data-id="gitLogEntry"]').filter({ hasText: 'companion only' })).toBeVisible({ timeout: 15_000 })

    // The unstaged file survived that commit as a tracked MODIFIED file. Under
    // the old rm-based unstage its index entry was gone, the commit recorded a
    // deletion, and this row would re-read 'A' (as if untracked) instead of 'M'.
    await expect(gitRow(page, '1_Storage.sol').locator('.badge').first()).toHaveText('M', { timeout: 15_000 })
  })

  test('TC-GIT-009: the commit message survives the reactive panel refresh', { tag: '@gate' }, async ({ page }) => {
    // Stage a change, then type the commit message BEFORE another save lands.
    await editCurrent(page, 'GIT-009-EDIT')
    await expect(gitRow(page, '1_Storage.sol')).toBeVisible({ timeout: 15_000 })
    await gitRow(page, '1_Storage.sol').locator('[data-id="gitStageFile"]').click()
    await expect(gitRow(page, '1_Storage.sol').locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })
    await page.locator('[data-id="gitCommitMessage"]').fill('survives refresh')

    // A save elsewhere triggers fileSaved → the panel's 500ms debounced
    // refresh re-renders it. The (yo-yo) re-render used to reset the textarea
    // to empty, wiping the half-typed message.
    await editCurrent(page, 'GIT-009-SECOND')
    await expect(gitRow(page, '1_Storage.sol').locator('[data-id="gitStageFile"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-id="gitCommitMessage"]')).toHaveValue('survives refresh')
    await page.locator('[data-id="gitCommit"]').click()
    await expect(page.locator('[data-id="gitLogEntry"]').filter({ hasText: 'survives refresh' })).toBeVisible({ timeout: 15_000 })
  })

  test('TC-GIT-010: a file staged then edited again shows in BOTH lists and stays committable', { tag: '@gate' }, async ({ page }) => {
    await editCurrent(page, 'GIT-010-FIRST')
    await expect(gitRow(page, '1_Storage.sol')).toBeVisible({ timeout: 15_000 })
    await gitRow(page, '1_Storage.sol').locator('[data-id="gitStageFile"]').click()
    await expect(gitRow(page, '1_Storage.sol').locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })

    // Edit again AFTER staging: like real `git status`, the staged snapshot
    // must stay listed (and committable) alongside the new unstaged edit —
    // the old classification dropped it from Staged, and the commit guard
    // then refused with "Stage at least one change" despite a staged snapshot.
    await editCurrent(page, 'GIT-010-AGAIN')
    await expect(gitRow(page, '1_Storage.sol').locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })
    await expect(gitRow(page, '1_Storage.sol').locator('[data-id="gitStageFile"]')).toBeVisible({ timeout: 15_000 })

    await page.locator('[data-id="gitCommitMessage"]').fill('staged snapshot')
    await page.locator('[data-id="gitCommit"]').click()
    await expect(page.locator('[data-id="gitLogEntry"]').filter({ hasText: 'staged snapshot' })).toBeVisible({ timeout: 15_000 })
  })

  test('TC-GIT-012: deleting a tracked file surfaces, stages, and commits the deletion', { tag: '@gate' }, async ({ page }) => {
    await commitBaseline(page)
    await deleteFromExplorer(page, STORAGE)
    await openGitPanel(page)

    const deleted = gitRow(page, '1_Storage.sol')
    await expect(deleted.locator('.badge').first()).toHaveText('D', { timeout: 15_000 })
    await deleted.locator('[data-id="gitStageFile"]').click()
    await expect(deleted.locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })

    await page.locator('[data-id="gitCommitMessage"]').fill('delete storage')
    await page.locator('[data-id="gitCommit"]').click()
    await expect(page.locator('[data-id="gitLogEntry"]').filter({ hasText: 'delete storage' })).toBeVisible({ timeout: 15_000 })
    await expect(deleted).toHaveCount(0)
  })

  test('TC-GIT-013: Stage all handles deleted and added files together', { tag: '@gate' }, async ({ page }) => {
    await commitBaseline(page)
    await deleteFromExplorer(page, STORAGE)
    await createFile(page, 'AfterDelete.sol')
    await openGitPanel(page)

    const deleted = gitRow(page, '1_Storage.sol')
    const added = gitRow(page, 'AfterDelete.sol')
    await expect(deleted.locator('.badge').first()).toHaveText('D', { timeout: 15_000 })
    await expect(added.locator('.badge').first()).toHaveText('A', { timeout: 15_000 })
    await page.locator('[data-id="gitStageAll"]').click()
    await expect(deleted.locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })
    await expect(added.locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })
  })

  test('TC-GIT-016: mixed staged and unstaged badges describe their own deltas', { tag: '@gate' }, async ({ page }) => {
    await commitBaseline(page)
    await editCurrent(page, 'GIT-016-STAGED-MODIFICATION')
    await expect(gitRow(page, '1_Storage.sol')).toBeVisible({ timeout: 15_000 })
    await gitRow(page, '1_Storage.sol').locator('[data-id="gitStageFile"]').click()
    await expect(gitRow(page, '1_Storage.sol').locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })

    // Index contains a modification, then the worktree file is deleted:
    // statusMatrix [1,0,2]. The next commit is M, while the unstaged delta is
    // D. Reusing one HEAD↔WORKDIR badge used to label BOTH rows as D.
    await deleteFromExplorer(page, STORAGE)
    await openGitPanel(page)
    const rows = gitRow(page, '1_Storage.sol')
    const staged = rows.filter({ has: page.locator('[data-id="gitUnstageFile"]') })
    const unstaged = rows.filter({ has: page.locator('[data-id="gitStageFile"]') })
    await expect(rows).toHaveCount(2, { timeout: 15_000 })
    await expect(staged.locator('.badge').first()).toHaveText('M')
    await expect(unstaged.locator('.badge').first()).toHaveText('D')
  })

  test('TC-GIT-017: Stage all flushes an immediate unsaved editor change', { tag: '@gate' }, async ({ page }) => {
    await commitBaseline(page)
    await setEditorText(page, (await getEditorText(page)) + '\n// GIT-017-IMMEDIATE\n')

    // Click before Ace's normal autosave debounce fires. Stage all must save
    // the active buffer itself, then put that exact saved version in the index.
    await page.locator('[data-id="gitStageAll"]').click()
    const storage = gitRow(page, '1_Storage.sol')
    await expect(storage.locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })
    await expect(storage.locator('[data-id="gitStageFile"]')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => {
      const workspace = (document.querySelector('#workspacesSelect') as HTMLSelectElement).value
      return (window as any).remixFileSystem.readFileSync(`.workspaces/${workspace}/contracts/1_Storage.sol`, 'utf8')
    }), { timeout: 15_000 }).toContain('GIT-017-IMMEDIATE')
  })

  test('TC-GIT-019: same-size same-stat edits remain visible and stageable', { tag: '@gate' }, async ({ page }) => {
    await commitBaseline(page)
    await page.evaluate(() => {
      const fs = (window as any).remixFileSystem
      const workspace = (document.querySelector('#workspacesSelect') as HTMLSelectElement).value
      const path = `.workspaces/${workspace}/contracts/1_Storage.sol`
      const before = String(fs.readFileSync(path, 'utf8'))
      const after = before.replace('contract Storage', 'contract StoragE')
      if (after.length !== before.length || after === before) throw new Error('same-size test fixture failed')

      // Forge the exact stat tuple cached in the index while changing bytes.
      // Raw isomorphic-git statusMatrix trusts this tuple and reports clean;
      // dGitProvider must independently hash the tracked worktree content.
      const cachedStat = fs.lstatSync(path)
      fs.writeFileSync(path, after)
      const originalLstat = fs.lstat
      ;(window as any).__git019Lstat = originalLstat
      fs.lstat = function (candidate: string, ...args: any[]) {
        const callback = args[args.length - 1]
        if (String(candidate) === path && typeof callback === 'function') {
          queueMicrotask(() => callback(null, cachedStat))
          return
        }
        return originalLstat.call(this, candidate, ...args)
      }
      const input = document.getElementById('input') as any
      input.editor.session.setValue(after)
    })

    await ensureFilePanel(page)
    await openGitPanel(page)
    const storage = gitRow(page, '1_Storage.sol')
    await expect(storage.locator('.badge').first()).toHaveText('M', { timeout: 15_000 })
    await storage.locator('[data-id="gitStageFile"]').click()
    await expect(storage.locator('[data-id="gitUnstageFile"]')).toBeVisible({ timeout: 15_000 })

    await page.evaluate(() => {
      const fs = (window as any).remixFileSystem
      fs.lstat = (window as any).__git019Lstat
      delete (window as any).__git019Lstat
    })
  })
})
