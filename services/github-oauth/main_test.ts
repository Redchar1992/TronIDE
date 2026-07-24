import { createRateLimiter, createRequestHandler } from './main.ts'

function assert (condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const allowRate = (_req: Request, _bucket: string, limit: number) => ({
  allowed: true,
  limit,
  remaining: limit - 1,
  resetAt: Date.now() + 60_000
})

Deno.test('rate limiter rejects requests after the configured per-client allowance', async () => {
  let now = 1_000
  const check = createRateLimiter({ now: () => now, kvFactory: () => null })
  const req = new Request('https://proxy.example/callback', { headers: { 'x-forwarded-for': '203.0.113.4' } })
  assert((await check(req, 'test', 2, 60_000)).allowed, 'first request should pass')
  assert((await check(req, 'test', 2, 60_000)).allowed, 'second request should pass')
  const denied = await check(req, 'test', 2, 60_000)
  assert(!denied.allowed && denied.remaining === 0, 'third request should be denied')
  now += 60_001
  assert((await check(req, 'test', 2, 60_000)).allowed, 'request should pass after reset')
})

Deno.test('rate limiter falls back when KV initialization throws synchronously', async () => {
  const check = createRateLimiter({
    kvFactory: () => { throw new Error('KV is not attached') }
  })
  const req = new Request('https://proxy.example/callback', { headers: { 'x-forwarded-for': '203.0.113.5' } })

  const first = await check(req, 'test', 2, 60_000)
  const second = await check(req, 'test', 2, 60_000)
  const denied = await check(req, 'test', 2, 60_000)

  assert(first.allowed && second.allowed, 'local fallback should preserve the configured allowance')
  assert(!denied.allowed && denied.remaining === 0, 'local fallback should still enforce the limit')
})

Deno.test('git proxy rejects a disallowed browser origin without contacting GitHub', async () => {
  let fetches = 0
  const handler = createRequestHandler({
    rateCheck: allowRate,
    fetchFn: () => { fetches++; return Promise.resolve(new Response('unexpected')) }
  })
  const response = await handler(new Request(
    'https://proxy.example/git/github.com/tronprotocol/tronbox/info/refs?service=git-upload-pack',
    { headers: { origin: 'https://evil.example' } }
  ))
  assert(response.status === 403, 'disallowed origin should receive HTTP 403')
  assert(fetches === 0, 'disallowed origin must not reach the upstream fetch')
})

Deno.test('git proxy returns HTTP 429 before contacting GitHub when quota is exhausted', async () => {
  let fetches = 0
  const handler = createRequestHandler({
    rateCheck: (_req, _bucket, limit) => ({ allowed: false, limit, remaining: 0, resetAt: Date.now() + 30_000 }),
    fetchFn: () => { fetches++; return Promise.resolve(new Response('unexpected')) }
  })
  const response = await handler(new Request(
    'https://proxy.example/git/github.com/tronprotocol/tronbox/info/refs?service=git-upload-pack'
  ))
  assert(response.status === 429, 'exhausted client should receive HTTP 429')
  assert(response.headers.has('retry-after'), '429 response should advertise Retry-After')
  assert(fetches === 0, 'rate-limited request must not reach GitHub')
})

Deno.test('OAuth callback rejects malformed state before contacting GitHub', async () => {
  let fetches = 0
  const handler = createRequestHandler({
    clientId: 'client',
    clientSecret: 'secret',
    rateCheck: allowRate,
    fetchFn: () => { fetches++; return Promise.resolve(new Response('unexpected')) }
  })
  const response = await handler(new Request('https://proxy.example/callback?code=VALID_CODE_123&state=AAAAAAAAAA'))
  assert(response.status === 400, 'malformed state should receive HTTP 400')
  assert(fetches === 0, 'malformed state must not reach GitHub')
})

Deno.test('OAuth callback preserves the successful exchange flow with security headers', async () => {
  const calls: string[] = []
  const handler = createRequestHandler({
    clientId: 'client',
    clientSecret: 'secret',
    rateCheck: allowRate,
    fetchFn: (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/login/oauth/access_token')) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: 'github-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }))
      }
      return Promise.resolve(new Response(JSON.stringify({ login: 'tron-user' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }))
    }
  })
  const state = '0123456789abcdef0123456789abcdef'
  const response = await handler(new Request(`https://proxy.example/callback?code=VALID_CODE_123&state=${state}`))
  const body = await response.text()
  assert(response.status === 200, 'valid callback should still succeed')
  assert(calls.length === 2, 'successful callback should exchange the code and resolve the user')
  assert(body.includes('github-token') && body.includes('tron-user'), 'result page should return token and login to the opener')
  assert(response.headers.get('strict-transport-security') === 'max-age=31536000', 'callback should send HSTS')
  assert(response.headers.get('x-ratelimit-remaining') !== null, 'callback should expose quota state')
})
