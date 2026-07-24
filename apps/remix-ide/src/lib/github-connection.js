/*
 * Copyright © 2026 TronIDE
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

'use strict'

import * as githubAuth from './github-auth'

const globalRegistry = require('../global/registry')

/**
 * Fully disconnect GitHub from this browser session. Shared by BOTH the Home
 * panel "Disconnect" and the header GitHub menu so the two can never drift into
 * a half-cleanup (a disconnect that leaves a usable token copy behind):
 *
 *  - drop the authoritative tab-session token+login (githubAuth notifies every
 *    live subscriber — the header re-reads "not connected" immediately);
 *  - scrub the legacy web-storage copies older versions may have persisted;
 *  - scrub the legacy config-backed Settings gist token: that PAT channel is
 *    retired (nothing writes or reads it anymore) but older versions persisted
 *    it, so wipe any leftover copy here too (app boot also purges it).
 *
 * Never throws — each cleanup is best-effort and logged.
 */
export function disconnectGithub () {
  githubAuth.clearToken()
  try { window.localStorage.removeItem('tronide.github.token') } catch (e) { console.debug('[githubConnection] clear ls token', e) }
  try { window.localStorage.removeItem('tronide.github.user') } catch (e) { console.debug('[githubConnection] clear ls user', e) }
  // clearToken owns the current session entries. Repeat the removals only as a
  // defensive cleanup if an older/broken store implementation left a copy.
  try { window.sessionStorage.removeItem('tronide.github.token') } catch (e) { console.debug('[githubConnection] clear ss token', e) }
  try { window.sessionStorage.removeItem('tronide.github.user') } catch (e) { console.debug('[githubConnection] clear ss user', e) }
  try { globalRegistry.get('config').api.set('settings/gist-access-token', '') } catch (e) { console.debug('[githubConnection] clear settings gist token', e) }
}
