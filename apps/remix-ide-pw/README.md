# TronIDE Playwright smoke

Minimal Playwright harness for the post-2026-05-27 audit surface. The
existing Nightwatch suite at `apps/remix-ide-e2e/` still owns the full
deploy/debug/MetaMask flows; this harness exists to add cheap,
fast-feedback smoke tests for new Home / GitHub-token / Contract
Verification work where Playwright's auto-waiting and trace viewer are
worth the extra dep.

## Layout

- `playwright.config.ts` — single-browser (Chromium) config; auto-starts
  `pnpm nx serve remix-ide --configuration=development` on port 18080
  unless `TRONIDE_PW_REUSE_SERVER=1` is set. Use
  `TRONIDE_PW_BASE_URL=http://localhost:<port>` when iterating against a
  different external server.
- `tests/*.spec.ts` — smoke specs. Today: home loads, GitHub token modal
  storage regression.

## Running

```bash
# First-time browser install (Chromium + system deps)
pnpm test:pw:install

# Headless run — boots its own dev server, runs, tears down
pnpm test:pw

# Iterate against an already-running server
TRONIDE_PW_REUSE_SERVER=1 TRONIDE_PW_BASE_URL=http://localhost:18080 pnpm test:pw

# Headed / debug
pnpm test:pw:headed
pnpm test:pw:debug
```

Reports land in `playwright-report/` (gitignored under `reports/*`).

## What's covered

| Spec | What it asserts |
|---|---|
| `home.spec.ts` | Landing page renders, primary Home actions are present, Advanced tools remain collapsed until expanded, the expanded advanced sections render, the state is persisted, the tabbar compile shortcut starts disabled without an active Solidity tab, and no console errors occur during initial load |
| `github-token-modal.spec.ts` | "Connect token" opens the modal **without** the legacy "Remember in this browser" checkbox; the tab-only storage notice is present (regression guard for the token-persistence security fix) |
| `solidity-uml-interactions.spec.ts` | UML diagram redraws on file switch, replays after rapid switches (dropped-redraw guard), survives a panel toggle-close/reopen, and Copy-Mermaid writes the source to the clipboard |
| `solidity-lint-lifecycle.spec.ts` | Lint annotations clear when a finding is fixed, track the active file (no stale buffer), and stay responsive under rapid edits |
| `git-panel-reactivity.spec.ts` | Unstage returns a file to Changes, A/M status badges render, and an in-editor save surfaces in the panel via the 500 ms reactive refresh (no re-open) |
| `github-token-memory.spec.ts` | A reload drops the in-memory GitHub token and the UI re-reads disconnected; web storage is never written (memory-only token regression guard) |
| `autosave-reactivity.spec.ts` | An idle edit autosaves (no Ctrl+S) and survives a full reload |

## Deterministic gate subset (`@gate`)

The v2.3.2 interaction-regression specs are tagged `@gate` and run
deterministically — VM/local only, no network, wallet, or live clone. Specs
that press Ctrl+S first abort every compiler source (remote binaries and the
bundled same-origin fallback) via the `blockCompilerSources` helper: the save
still happens (it runs before the compile), but no solc run ever starts, so the
compile-saturation flake stays out of this subset by construction. Saves are
then confirmed by polling the in-browser workspace FS (`readSavedFile`) instead
of sleeping. Run just the gate subset with:

```bash
pnpm test:pw:gate      # playwright test --grep @gate
```

Unlike the full suite, this subset is meant to be **release-blocking**. The
Playwright suite is `continue-on-error` / `allow_failure: true` in CI today
because the full set carries network + compile-saturation flake; the `@gate`
subset does not, so it can be promoted to a required check. Proposed CI change
(Ops-owned — not wired here):

- GitHub `ci.yml`: add a job running `pnpm test:pw:gate` **without**
  `continue-on-error` (leave the existing `e2e-smoke` job informational).
- Any other CI provider: the equivalent is a required (no allow-failure) job in
  the test stage running `pnpm test:pw:gate`, keeping the full suite as a
  separate informational job.

To extend the gate, add `{ tag: '@gate' }` to any other deterministic spec.
`autosave-reactivity.spec.ts` is intentionally **not** tagged — its idle-debounce
+ reload timing suits the smoke run, not a required gate.

## What it's NOT for

- MetaMask / TronLink wallet flows — keep those in the Nightwatch suite
  for now (CRX install via Selenium chromedriver is already tuned there).
- Full compile/deploy round-trips — the Nightwatch suite already covers
  `ballot.test.ts`, `libraryDeployment.test.ts`, etc.
- Anything that needs a real TronGrid / TronScan call — mock at the
  fetch boundary if you reach for that.
