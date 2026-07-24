/*
 * Copyright © 2026 TronIDE
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

/**
 * The restore-on-boot workspace marker, in ONE place. It used to be a magic
 * string copy-pasted across workspaceFileProvider / file-panel / the Git
 * panel, and the copies were already drifting (the clone repair pointed at a
 * key the boot path could have stopped reading).
 *
 * Storage is two-level:
 * - sessionStorage is the per-TAB truth: a reload restores THIS tab's own
 *   workspace even when another tab switched elsewhere meanwhile (a single
 *   localStorage key made tabs silently overwrite each other's marker).
 * - localStorage is the cross-session fallback that a fresh tab or browser
 *   restart boots from.
 *
 * Two writer rules keep the marker trustworthy:
 * - Transient link-landing workspaces (gist-sample / code-sample) never
 *   stamp: following a shared #gist= link once must not hijack every future
 *   boot — especially when the remote fetch then fails and leaves the sample
 *   workspace empty.
 * - suspendWhile(fn) mutes stamping for workspaces whose success is not yet
 *   known (a clone target may only become the boot target AFTER the clone
 *   succeeds; a tab closed mid-clone must not resurrect the half-created
 *   workspace on the next boot).
 */

const KEY = 'tronide.lastWorkspace'
const TRANSIENT = ['gist-sample', 'code-sample']

let suspended = false

function set (workspace) {
  if (suspended || !workspace || TRANSIENT.includes(workspace)) return
  try { window.sessionStorage.setItem(KEY, workspace) } catch (e) { /* storage may be unavailable */ }
  try { window.localStorage.setItem(KEY, workspace) } catch (e) { /* storage may be unavailable */ }
}

function get () {
  let session = null
  try { session = window.sessionStorage.getItem(KEY) } catch (e) { /* storage may be unavailable */ }
  if (session) return session
  try { return window.localStorage.getItem(KEY) } catch (e) { return null }
}

async function suspendWhile (fn) {
  suspended = true
  try { return await fn() } finally { suspended = false }
}

module.exports = { set, get, suspendWhile, KEY, TRANSIENT }
