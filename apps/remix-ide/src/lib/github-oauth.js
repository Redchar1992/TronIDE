/*
 * Copyright © 2026 TronIDE
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

/**
 * Connect to GitHub via the OAuth authorization popup instead of pasting a PAT.
 *
 * Flow (the IDE is static on GitHub Pages, so a tiny Deno proxy does the secret
 * exchange — see services/github-oauth):
 *   1. open a popup to GitHub's authorize URL (public client_id + state)
 *   2. user approves; GitHub redirects the popup to the proxy /callback
 *   3. the proxy exchanges code->token and postMessages { token, login, state }
 *      back to this window
 *   4. we verify origin + state and resolve { token, login }
 *
 * This module is pure: it only obtains the token. Apply it through the existing
 * connect path so the gist-token mirror and the header stay consistent, e.g.
 *
 *   import { connectWithGithubOAuth } from '../../lib/github-oauth'
 *   const { token, login } = await connectWithGithubOAuth()
 *   saveGithubToken(token)        // existing: stores for this tab (lib/github-auth)
 *   persistGithubUser(login)      // existing: header sync + 'tronideGithubConnectionChanged'
 */

export const GITHUB_OAUTH = {
  // Public — the OAuth App client id (safe to ship; the secret lives in the Deno proxy).
  clientId: 'Ov23liQFiVI9mMjBfAVK',
  // The Deno proxy origin and its /callback (must equal the OAuth App callback URL).
  proxyOrigin: 'https://tronide-gh-oauth.redchar1992.deno.net',
  get redirectUri () { return this.proxyOrigin + '/callback' },
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  // gist = read/write gists; repo = the local Git panel commit/push.
  // KEEP `repo` (do not narrow to `public_repo`): the just-shipped remote-git
  // feature (dgitProvider clone/push/pull, gitOnAuth) supports PRIVATE repos, and
  // `public_repo` cannot push to them. The tab-scoped token store avoids
  // persistent localStorage/config rather than narrowing the OAuth scope;
  // tightening scope to fine-grained/auto-expiring tokens is Stage 2
  // (GitHub App installation tokens), not this change.
  scope: 'gist repo'
}

function randomState () {
  const a = new Uint8Array(16)
  ;(window.crypto || window.msCrypto).getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * @param {object} [opts]
 * @param {string} [opts.scope] override the requested scopes
 * @returns {Promise<{ token: string, login: string }>}
 */
export function connectWithGithubOAuth (opts = {}) {
  return new Promise((resolve, reject) => {
    if (!GITHUB_OAUTH.clientId || GITHUB_OAUTH.clientId.startsWith('<')) {
      return reject(new Error('GitHub OAuth is not configured (missing client id).'))
    }

    const state = randomState()
    const authorize = `${GITHUB_OAUTH.authorizeUrl}?` + new URLSearchParams({
      client_id: GITHUB_OAUTH.clientId,
      redirect_uri: GITHUB_OAUTH.redirectUri,
      scope: opts.scope || GITHUB_OAUTH.scope,
      state,
      allow_signup: 'false'
    }).toString()

    const w = 720
    const h = 720
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2)
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2)
    // A per-attempt name prevents an unrelated pre-existing named window from
    // being reused as the OAuth browsing context.
    const popup = window.open(authorize, 'tronide-github-oauth-' + state,
      `width=${w},height=${h},left=${left},top=${top},resizable,scrollbars`)
    if (!popup) return reject(new Error('Popup blocked — allow popups for this site, then try again.'))

    let settled = false
    const cleanup = () => {
      window.removeEventListener('message', onMessage)
      clearInterval(closedTimer)
      clearTimeout(hardTimeout)
    }
    const finish = (fn, arg) => { if (!settled) { settled = true; cleanup(); try { popup.close() } catch (e) {} fn(arg) } }

    const onMessage = (event) => {
      if (event.origin !== GITHUB_OAUTH.proxyOrigin) return
      if (event.source !== popup) return
      const d = event.data
      if (!d || d.source !== 'tronide-github-oauth') return
      if (d.state !== state) return finish(reject, new Error('GitHub OAuth state mismatch — aborted.'))
      if (d.error) return finish(reject, new Error('GitHub authorization failed: ' + d.error))
      if (!d.token) return finish(reject, new Error('GitHub authorization returned no token.'))
      finish(resolve, { token: d.token, login: d.login || '' })
    }
    window.addEventListener('message', onMessage)

    // The user closed the popup without finishing.
    const closedTimer = setInterval(() => {
      if (popup.closed) finish(reject, new Error('GitHub connection cancelled.'))
    }, 500)

    // Safety net so we never hang forever.
    const hardTimeout = setTimeout(() => finish(reject, new Error('GitHub connection timed out.')), 120000)
  })
}
