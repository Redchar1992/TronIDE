/*
 * TronIDE — GitHub OAuth code→token exchange (Deno Deploy).
 *
 * The IDE is a static site on GitHub Pages, so it cannot hold the OAuth client
 * secret or call GitHub's token endpoint (no CORS) itself. This single-file
 * Deno function is the only server-side piece: it receives the `code` from the
 * GitHub authorization popup, exchanges it (with the secret) for an access
 * token, resolves the login, and hands both back to the opener via postMessage.
 *
 * Deploy:  deployctl deploy --project=tronide-gh-oauth main.ts
 * Callback (register in the GitHub OAuth App):
 *          https://tronide-gh-oauth.redchar1992.deno.net/callback
 *
 * Env vars (Deno Deploy → Settings → Environment Variables):
 *   GITHUB_CLIENT_ID       the OAuth App client id
 *   GITHUB_CLIENT_SECRET   the OAuth App client secret   (never shipped to the browser)
 *   REDIRECT_URI           https://tronide-gh-oauth.redchar1992.deno.net/callback
 *   ALLOWED_ORIGINS        comma-separated site origins allowed to receive the token,
 *                          e.g. "https://tronide.io,https://<user>.github.io"
 *   OAUTH_RATE_LIMIT       callback attempts per client/minute (default 10)
 *   GIT_PUBLIC_RATE_LIMIT  unauthenticated git requests per client/minute (default 30)
 *   GIT_AUTH_RATE_LIMIT    authenticated git requests per client/minute (default 120)
 */

const CLIENT_ID = Deno.env.get('GITHUB_CLIENT_ID') ?? ''
const CLIENT_SECRET = Deno.env.get('GITHUB_CLIENT_SECRET') ?? ''
const REDIRECT_URI = Deno.env.get('REDIRECT_URI') ?? 'https://tronide-gh-oauth.redchar1992.deno.net/callback'
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://tronide.io')
  .split(',').map((s) => s.trim()).filter(Boolean)
const OAUTH_RATE_LIMIT = positiveInt(Deno.env.get('OAUTH_RATE_LIMIT'), 10)
const GIT_PUBLIC_RATE_LIMIT = positiveInt(Deno.env.get('GIT_PUBLIC_RATE_LIMIT'), 30)
const GIT_AUTH_RATE_LIMIT = positiveInt(Deno.env.get('GIT_AUTH_RATE_LIMIT'), 120)
const RATE_WINDOW_MS = 60_000

type RateRecord = { count: number; resetAt: number }
type RateResult = { allowed: boolean; limit: number; remaining: number; resetAt: number }
type RateCheck = (req: Request, bucket: string, limit: number, windowMs: number, info?: unknown) => RateResult | Promise<RateResult>

function positiveInt (value: string | null | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function peerHostname (info?: unknown): string {
  if (!info || typeof info !== 'object' || !('remoteAddr' in info)) return ''
  const remoteAddr = (info as { remoteAddr?: unknown }).remoteAddr
  if (!remoteAddr || typeof remoteAddr !== 'object' || !('hostname' in remoteAddr)) return ''
  const hostname = (remoteAddr as { hostname?: unknown }).hostname
  return typeof hostname === 'string' ? hostname : ''
}

function clientAddress (req: Request, info?: unknown): string {
  // Prefer the server-provided peer address, which request authors cannot
  // spoof. Deno Deploy also sets these edge headers; use them as the fallback
  // when the runtime does not expose remoteAddr to the handler.
  const remote = peerHostname(info)
  const forwarded = req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-real-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
  return remote || forwarded || 'unknown'
}

async function hashClientAddress (address: string): Promise<string> {
  const bytes = new TextEncoder().encode(address)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Deno KV makes counters consistent across edge isolates. If no database is
// attached (local development or a temporary deployment), the bounded local
// map still provides a per-isolate safety net rather than failing OAuth/Git.
export function createRateLimiter (options: {
  now?: () => number;
  kvFactory?: () => Deno.Kv | null | Promise<Deno.Kv | null>;
} = {}): RateCheck {
  const now = options.now || Date.now
  const local = new Map<string, RateRecord>()
  let kvPromise: Promise<Deno.Kv | null> | null = null
  const getKv = () => {
    if (!kvPromise) {
      // Invoke the factory inside the async boundary. `Deno.openKv()` can throw
      // synchronously when the deployment has no KV database attached (or the
      // runtime does not expose the unstable API), which Promise.resolve(value)
      // cannot catch because `value` is evaluated first.
      kvPromise = (async () => {
        try {
          if (options.kvFactory) return await options.kvFactory()
          if (typeof Deno.openKv !== 'function') return null
          return await Deno.openKv()
        } catch (error) {
          console.warn('[rate-limit] Deno KV unavailable; using per-isolate counters', error)
          return null
        }
      })()
    }
    return kvPromise
  }

  return async (req, bucket, limit, windowMs, info) => {
    const client = await hashClientAddress(clientAddress(req, info))
    const localKey = bucket + ':' + client
    const key: Deno.KvKey = ['rate-limit-v1', bucket, client]
    const timestamp = now()
    const kv = await getKv()

    if (kv) {
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const entry = await kv.get<RateRecord>(key)
          const current = entry.value && entry.value.resetAt > timestamp
            ? entry.value
            : { count: 0, resetAt: timestamp + windowMs }
          if (current.count >= limit) {
            return { allowed: false, limit, remaining: 0, resetAt: current.resetAt }
          }
          const next = { count: current.count + 1, resetAt: current.resetAt }
          const committed = await kv.atomic().check(entry).set(key, next).commit()
          if (committed.ok) {
            return { allowed: true, limit, remaining: Math.max(0, limit - next.count), resetAt: next.resetAt }
          }
        }
      } catch (error) {
        console.warn('[rate-limit] Deno KV transaction failed; using per-isolate counters', error)
      }
    }

    const current = local.get(localKey)
    const active = current && current.resetAt > timestamp ? current : { count: 0, resetAt: timestamp + windowMs }
    if (active.count >= limit) return { allowed: false, limit, remaining: 0, resetAt: active.resetAt }
    const next = { count: active.count + 1, resetAt: active.resetAt }
    local.set(localKey, next)
    if (local.size > 10_000) {
      for (const [entryKey, record] of local) {
        if (record.resetAt <= timestamp) local.delete(entryKey)
      }
      // Keep the fallback truly bounded even during a burst of unique client
      // addresses within one rate window. Map iteration order is insertion
      // order, so evict the oldest counters first.
      while (local.size > 10_000) {
        const oldestKey = local.keys().next().value
        if (oldestKey === undefined) break
        local.delete(oldestKey)
      }
    }
    return { allowed: true, limit, remaining: Math.max(0, limit - next.count), resetAt: next.resetAt }
  }
}

const defaultRateCheck = createRateLimiter()

const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
}

function setSecurityHeaders (headers: Headers): Headers {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
  return headers
}

function rateHeaders (result: RateResult): Record<string, string> {
  return {
    'x-ratelimit-limit': String(result.limit),
    'x-ratelimit-remaining': String(result.remaining),
    'x-ratelimit-reset': String(Math.ceil(result.resetAt / 1000))
  }
}

function rateLimitedResponse (result: RateResult, headers: Record<string, string> = {}): Response {
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
  return new Response('Too many requests', {
    status: 429,
    headers: setSecurityHeaders(new Headers({ ...headers, ...rateHeaders(result), 'retry-after': String(retryAfter), 'cache-control': 'no-store' }))
  })
}

// Neutralize sequences that can break out of a <script> context. JSON.stringify
// does NOT escape `</script>`, `-->`, or the JS line terminators U+2028/U+2029,
// so a reflected value (state / GitHub error) could otherwise inject markup.
function escapeForScript (json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

// `state` is generated by the browser as hex and only echoed back; reject
// anything else so a crafted value can never be reflected into the page.
function safeState (raw: string | null): string {
  return raw && /^[A-Za-z0-9]{8,64}$/.test(raw) ? raw : ''
}

// Render a tiny page that posts the result to the opener and closes itself.
// We post to EACH allowed origin: the browser only delivers a message when the
// opener's origin matches the targetOrigin, so looping never leaks the token to
// an unintended origin.
function resultPage (payload: Record<string, unknown>, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const data = escapeForScript(JSON.stringify({ source: 'tronide-github-oauth', ...payload }))
  const origins = escapeForScript(JSON.stringify(ALLOWED_ORIGINS))
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>GitHub</title></head>
<body style="font:14px system-ui;padding:24px;color:#333">
<script>
(function () {
  var data = ${data};
  var origins = ${origins};
  try {
    if (window.opener) origins.forEach(function (o) { try { window.opener.postMessage(data, o) } catch (e) {} });
  } catch (e) {}
  document.body.textContent = data.error
    ? ('GitHub connect failed: ' + data.error + '. You can close this window.')
    : 'GitHub connected. You can close this window.';
  setTimeout(function () { try { window.close() } catch (e) {} }, 300);
})();
</script>
<noscript>Enable JavaScript to finish connecting to GitHub.</noscript>
</body></html>`
  return new Response(body, {
    status,
    headers: setSecurityHeaders(new Headers({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      ...extraHeaders
    }))
  })
}

// CORS allow-origin for a given request: echo it only when it is allow-listed.
// Never use '*' because git requests can carry an Authorization header.
function corsOrigin (req: Request): string {
  const origin = req.headers.get('origin') ?? ''
  return ALLOWED_ORIGINS.includes(origin) ? origin : ''
}

// Headers git's smart-HTTP client may send and needs us to forward/allow. Kept
// lower-case for case-insensitive comparison against the incoming request.
const GIT_ALLOW_HEADERS = [
  'accept', 'authorization', 'content-type', 'content-length',
  'git-protocol', 'user-agent', 'pragma', 'cache-control', 'x-requested-with'
]
// Response headers git needs to read back from the proxied response.
const GIT_EXPOSE_HEADERS = [
  'content-type', 'content-length', 'content-encoding', 'transfer-encoding',
  'cache-control', 'expires', 'pragma', 'www-authenticate',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'
]

function gitCorsHeaders (req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': GIT_ALLOW_HEADERS.join(', '),
    'access-control-expose-headers': GIT_EXPOSE_HEADERS.join(', '),
    'access-control-allow-credentials': 'true',
    'access-control-max-age': '600',
    vary: 'Origin'
  }
  const origin = corsOrigin(req)
  if (origin) headers['access-control-allow-origin'] = origin
  return headers
}

function hasAllowedBrowserOrigin (req: Request): boolean {
  const origin = req.headers.get('origin')
  return !origin || ALLOWED_ORIGINS.includes(origin)
}

// Stateless CORS proxy for isomorphic-git smart-HTTP. The IDE is a static site
// on GitHub Pages; the browser cannot talk to github.com's git endpoints
// directly (no CORS). isomorphic-git is configured with corsProxy='<this>/git'
// and rewrites a request to e.g. `<this>/git/<owner>/<repo>.git/info/refs?...`.
// We strip the `/git/` prefix, forward the rest verbatim to
// `https://github.com/<rest>`, stream both bodies through, and re-attach CORS
// headers. We forward only git-relevant request headers (incl. Authorization,
// which carries the token-as-basic-auth) and NEVER log them.
//
// NOTE: this function runs on Deno Deploy. Source changes take effect only
// after `deployctl deploy --project=tronide-gh-oauth main.ts`.
async function handleGitProxy (req: Request, url: URL, fetchFn: typeof fetch): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: setSecurityHeaders(new Headers(gitCorsHeaders(req))) })
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: setSecurityHeaders(new Headers(gitCorsHeaders(req))) })
  }

  // isomorphic-git's corsProxy sends `/git/<host>/<owner>/<repo>[.git]/<endpoint>`
  // (the target host is part of the path, protocol stripped). SSRF guard: pin the
  // host to github.com, allow only the exact git smart-HTTP shape, never
  // `..`/`@`/`//`/backslash, and assert the constructed URL still points at
  // github.com. Combined with redirect:'manual' below, the proxy cannot be
  // steered to another host (which would leak the forwarded Authorization token).
  const rest = url.pathname.slice('/git/'.length).replace(/^https?:\/\//i, '')
  const GIT_PATH_RE = /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/
  const GIT_QUERY_RE = /^(?:\?service=git-(?:upload|receive)-pack)?$/
  if (!rest || rest.includes('..') || rest.includes('@') || rest.includes('//') || rest.includes('\\') ||
      !GIT_PATH_RE.test(rest) || !GIT_QUERY_RE.test(url.search)) {
    return new Response('Bad git proxy request', { status: 400, headers: setSecurityHeaders(new Headers(gitCorsHeaders(req))) })
  }
  let target: URL
  try {
    target = new URL('https://' + rest + url.search)
  } catch (_e) {
    return new Response('Bad git proxy request', { status: 400, headers: setSecurityHeaders(new Headers(gitCorsHeaders(req))) })
  }
  if (target.protocol !== 'https:' || target.hostname !== 'github.com') {
    return new Response('Bad git proxy request', { status: 400, headers: setSecurityHeaders(new Headers(gitCorsHeaders(req))) })
  }

  // Forward only the git-relevant request headers.
  const fwdHeaders = new Headers()
  for (const name of GIT_ALLOW_HEADERS) {
    const v = req.headers.get(name)
    if (v !== null) fwdHeaders.set(name, v)
  }

  let upstream: Response
  try {
    upstream = await fetchFn(target.toString(), {
      method: req.method,
      headers: fwdHeaders,
      body: req.method === 'POST' ? req.body : undefined,
      // Do NOT follow redirects: a redirect off github.com would otherwise make
      // the proxy re-send the Authorization token to an attacker-controlled host.
      redirect: 'manual'
    })
  } catch (_e) {
    return new Response('Upstream git request failed', { status: 502, headers: setSecurityHeaders(new Headers(gitCorsHeaders(req))) })
  }

  // Re-attach CORS headers, preserving git-relevant upstream response headers.
  const respHeaders = new Headers(gitCorsHeaders(req))
  for (const name of [...GIT_EXPOSE_HEADERS]) {
    const v = upstream.headers.get(name)
    if (v !== null) respHeaders.set(name, v)
  }
  return new Response(upstream.body, { status: upstream.status, headers: setSecurityHeaders(respHeaders) })
}

export function createRequestHandler (options: {
  fetchFn?: typeof fetch;
  rateCheck?: RateCheck;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
} = {}) {
  const fetchFn = options.fetchFn || fetch
  const rateCheck = options.rateCheck || defaultRateCheck
  const clientId = options.clientId === undefined ? CLIENT_ID : options.clientId
  const clientSecret = options.clientSecret === undefined ? CLIENT_SECRET : options.clientSecret
  const redirectUri = options.redirectUri || REDIRECT_URI

  return async (req: Request, info?: unknown): Promise<Response> => {
    const url = new URL(req.url)

    if (url.pathname === '/git' || url.pathname.startsWith('/git/')) {
      if (!hasAllowedBrowserOrigin(req)) {
        return new Response('Origin not allowed', {
          status: 403,
          headers: setSecurityHeaders(new Headers({ ...gitCorsHeaders(req), 'cache-control': 'no-store' }))
        })
      }
      // Preflight does not reach GitHub and must remain cheap/reliable.
      if (req.method !== 'OPTIONS') {
        const authenticated = !!req.headers.get('authorization')
        const limit = authenticated ? GIT_AUTH_RATE_LIMIT : GIT_PUBLIC_RATE_LIMIT
        const rate = await rateCheck(req, authenticated ? 'git-auth' : 'git-public', limit, RATE_WINDOW_MS, info)
        if (!rate.allowed) return rateLimitedResponse(rate, gitCorsHeaders(req))
      }
      return await handleGitProxy(req, url, fetchFn)
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('tronide-gh-oauth: ok', {
        headers: setSecurityHeaders(new Headers({ 'cache-control': 'no-store' }))
      })
    }
    if (url.pathname !== '/callback') {
      return new Response('Not found', { status: 404, headers: setSecurityHeaders(new Headers()) })
    }

    const state = safeState(url.searchParams.get('state'))
    // The frontend generates exactly 16 random bytes as 32 hexadecimal chars.
    // Reject junk before it can consume a GitHub token-exchange request.
    if (!/^[A-Fa-f0-9]{32}$/.test(state)) return resultPage({ state: '', error: 'invalid_state' }, 400)

    const oauthError = url.searchParams.get('error')
    if (oauthError) return resultPage({ state, error: oauthError }, 400)

    const code = url.searchParams.get('code')
    if (!code) return resultPage({ state, error: 'missing_code' }, 400)
    if (!/^[A-Za-z0-9_-]{10,128}$/.test(code)) return resultPage({ state, error: 'invalid_code' }, 400)
    if (!clientId || !clientSecret) return resultPage({ state, error: 'server_misconfigured' }, 503)

    const rate = await rateCheck(req, 'oauth-callback', OAUTH_RATE_LIMIT, RATE_WINDOW_MS, info)
    if (!rate.allowed) {
      return resultPage(
        { state, error: 'rate_limited' },
        429,
        { ...rateHeaders(rate), 'retry-after': String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))) }
      )
    }

    // Exchange the code for an access token (secret stays here).
    let token = ''
    try {
      const res = await fetchFn('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri })
      })
      const data = await res.json()
      token = data.access_token ?? ''
      if (!token) return resultPage({ state, error: data.error_description || data.error || 'exchange_failed' }, 400, rateHeaders(rate))
    } catch (_e) {
      return resultPage({ state, error: 'exchange_request_failed' }, 502, rateHeaders(rate))
    }

    // Resolve the login server-side (no browser CORS to api.github.com needed).
    let login = ''
    try {
      const ures = await fetchFn('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tronide-gh-oauth' }
      })
      if (ures.ok) login = (await ures.json()).login ?? ''
    } catch (_e) { /* login is best-effort; the token still works */ }

    return resultPage({ state, token, login }, 200, rateHeaders(rate))
  }
}

if (import.meta.main) Deno.serve(createRequestHandler())
