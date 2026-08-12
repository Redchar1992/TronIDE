/*
 * Copyright © 2026 TronIDE
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

'use strict'

import * as githubAuth from './github-auth.js'

export const GITHUB_BFF = {
  origin: String(process.env.TRONIDE_GITHUB_BFF_ORIGIN || 'https://tronide-gh-oauth.redchar1992.deno.net').replace(/\/$/, ''),
  sessionHeader: 'X-TronIDE-Session'
}

function bffUrl (path) {
  const normalized = String(path || '')
  if (!normalized.startsWith('/')) throw new Error('GitHub BFF path must be absolute.')
  return GITHUB_BFF.origin + normalized
}

function sessionHeaders (session, headers) {
  const result = new Headers(headers || {})
  const handle = String(session || '').trim()
  if (handle) result.set(GITHUB_BFF.sessionHeader, handle)
  return result
}

/**
 * Make a request to the TronIDE BFF with the current opaque session handle.
 * @param {string} path
 * @param {RequestInit & { session?: string }} [options]
 */
export async function request (path, options = {}) {
  const session = options.session === undefined ? githubAuth.getSession() : options.session
  const init = Object.assign({}, options, {
    headers: sessionHeaders(session, options.headers),
    redirect: 'error'
  })
  delete init.session
  const response = await window.fetch(bffUrl(path), init)
  // Do not leave an expired/revoked handle advertised as connected. An
  // explicit request may target an old handle during reconnect/disconnect; in
  // that case, never clear the newer current session.
  if (response.status === 401 && session && githubAuth.getSession() === session) {
    githubAuth.clearSession()
  }
  return response
}

/** Fail closed when the independently deployed OAuth service is still legacy. */
export async function assertBffReady () {
  let response
  try {
    response = await window.fetch(bffUrl('/capabilities'), {
      headers: { Accept: 'application/json' },
      redirect: 'error'
    })
  } catch (_error) {
    throw new Error('GitHub connection is temporarily unavailable while its secure backend is being upgraded.')
  }
  if (!response.ok) {
    throw new Error('GitHub connection is temporarily unavailable while its secure backend is being upgraded.')
  }
  const capabilities = await response.json().catch(() => null)
  if (!capabilities || capabilities.authMode !== 'bff-v1' || capabilities.githubTokenInBrowser !== false) {
    throw new Error('GitHub connection is temporarily unavailable while its secure backend is being upgraded.')
  }
  return capabilities
}

/** Route an allow-listed GitHub REST path through the BFF. */
export function githubRequest (path, options = {}) {
  if (!githubAuth.getSession()) return Promise.reject(new Error('Connect GitHub first.'))
  const normalized = String(path || '')
  if (!normalized.startsWith('/')) return Promise.reject(new Error('Invalid GitHub API path.'))
  return request('/api' + normalized, options)
}

/** Validate and hydrate the current BFF session. */
export async function validateSession () {
  if (!githubAuth.getSession()) return null
  const response = await request('/session', { method: 'GET' })
  if (!response.ok) {
    if (response.status === 401) githubAuth.clearSession()
    return null
  }
  const state = await response.json()
  githubAuth.setLogin(state.login || '')
  return state
}

/** Revoke a BFF session. The caller clears local state even when this fails. */
export function revokeSession (session) {
  const handle = String(session || '').trim()
  if (!handle) return Promise.resolve()
  return request('/session', { method: 'DELETE', session: handle }).then(() => undefined)
}
