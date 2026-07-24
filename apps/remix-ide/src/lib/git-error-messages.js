/*
 * Copyright © 2026 TronIDE
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

/**
 * True only for REAL browser-storage quota failures (IndexedDB/BrowserFS).
 *
 * The clone error path rewrites a quota failure into "Browser storage is
 * full — delete unused workspaces…", which is DESTRUCTIVE advice if wrong: a
 * bare /quota/i on the raw text also matched server-side errors (the git
 * CORS proxy's own usage quotas, GitHub/HTTP bodies mentioning quota) and
 * told users to delete local work over a network failure. Accept only the
 * DOMException itself — by name, by the legacy code 22, or by the exact
 * exception NAME wrapped into a provider error string — never arbitrary
 * prose containing the word "quota".
 *
 * Pure + dependency-free so it is unit-testable directly in Node.
 */
function isStorageQuotaError (error, raw) {
  if (error && (error.name === 'QuotaExceededError' || error.code === 22)) return true
  return /\bQuotaExceededError\b/.test(String(raw == null ? '' : raw))
}

module.exports = { isStorageQuotaError }
