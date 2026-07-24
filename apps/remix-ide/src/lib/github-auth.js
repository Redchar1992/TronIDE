/*
 * Copyright © 2026 TronIDE
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

'use strict'

/**
 * Tab-scoped GitHub credential store.
 *
 * The GitHub access token obtained from the OAuth popup (or a pasted PAT) is
 * mirrored to sessionStorage so a normal refresh keeps the connection. It is
 * deliberately never written to localStorage or the config store: closing the
 * tab still clears it, and another tab does not inherit it.
 *
 * Every reader of the connect token goes through getToken()/getLogin(); the
 * header (and any other live consumer) subscribes via onChange() and/or the
 * existing `tronideGithubConnectionChanged` window event, which setToken/
 * clearToken keep dispatching so nothing else has to change.
 */

const TOKEN_KEY = 'tronide.github.token'
const USER_KEY = 'tronide.github.user'

function readSession (key) {
  try {
    return typeof window !== 'undefined' && window.sessionStorage
      ? String(window.sessionStorage.getItem(key) || '').trim()
      : ''
  } catch (error) {
    console.debug(`[githubAuth] failed to read ${key} from tab session`, error)
    return ''
  }
}

function writeSession (key, value) {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return
    if (value) window.sessionStorage.setItem(key, value)
    else window.sessionStorage.removeItem(key)
  } catch (error) {
    // Privacy modes can deny web storage. The in-memory copy still keeps the
    // current page usable; only refresh continuity is lost in that case.
    console.debug(`[githubAuth] failed to persist ${key} for this tab`, error)
  }
}

// Module-level singleton state is authoritative while the page is running and
// is hydrated from this tab's session after a refresh.
let _token = readSession(TOKEN_KEY)
let _login = _token ? readSession(USER_KEY) : ''
const _listeners = new Set()

function notify () {
  // 1) Local subscribers (e.g. components that imported this module directly).
  for (const cb of Array.from(_listeners)) {
    try {
      cb({ connected: !!_token, login: _login })
    } catch (error) {
      // A broken listener must not break the connect/disconnect flow or starve
      // the other listeners — surface it but keep going (no silent failure).
      console.debug('[githubAuth] onChange listener threw', error)
    }
  }
  // 2) The existing cross-component signal the header already listens for.
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('tronideGithubConnectionChanged'))
    }
  } catch (error) {
    console.debug('[githubAuth] failed to dispatch github-changed event', error)
  }
}

/**
 * @returns {string} the current tab-session token, '' when not connected.
 */
export function getToken () {
  return _token
}

/**
 * @returns {string} the connected GitHub login, '' when unknown/not connected.
 */
export function getLogin () {
  return _login
}

/**
 * Store the connected token (and optional login) for this tab and notify listeners.
 * @param {string} token the GitHub access token
 * @param {string} [login] the GitHub login, if already known
 */
export function setToken (token, login) {
  _token = String(token || '').trim()
  if (login !== undefined) _login = String(login || '').trim()
  writeSession(TOKEN_KEY, _token)
  writeSession(USER_KEY, _token ? _login : '')
  notify()
}

/**
 * Update just the connected login (e.g. once the /user lookup resolves) and
 * notify listeners. No-op effect on the token.
 * @param {string} [login]
 */
export function setLogin (login) {
  _login = String(login || '').trim()
  writeSession(USER_KEY, _token ? _login : '')
  notify()
}

/**
 * Clear the token and login from memory and this tab, then notify listeners.
 */
export function clearToken () {
  _token = ''
  _login = ''
  writeSession(TOKEN_KEY, '')
  writeSession(USER_KEY, '')
  notify()
}

/**
 * Subscribe to connect/disconnect changes.
 * @param {(state: { connected: boolean, login: string }) => void} cb
 */
export function onChange (cb) {
  if (typeof cb === 'function') _listeners.add(cb)
}

/**
 * Unsubscribe a previously-registered listener.
 * @param {Function} cb
 */
export function offChange (cb) {
  _listeners.delete(cb)
}
