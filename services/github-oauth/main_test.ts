import {
  type AuthStore,
  createMemoryAuthStore,
  createRateLimiter,
  createRequestHandler,
  createTokenCipher,
  type TokenCipher,
} from "./main.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

const ORIGIN = "https://tronide.io";
const CHANNEL = "channel_0123456789abcdef";
const STATE = "s".repeat(43);
const VERIFIER = "v".repeat(43);
const SESSION = "h".repeat(43);

const allowRate = (_req: Request, _bucket: string, limit: number) => ({
  allowed: true,
  limit,
  remaining: limit - 1,
  resetAt: Date.now() + 60_000,
});

function testKey(): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
}

async function createTestDependencies(): Promise<{
  store: AuthStore;
  cipher: TokenCipher;
}> {
  return {
    store: createMemoryAuthStore(),
    cipher: await createTokenCipher(testKey()),
  };
}

async function beginOAuth(
  handler: ReturnType<typeof createRequestHandler>,
): Promise<{ response: Response; authorize: URL; state: string }> {
  const response = await handler(
    new Request(
      `https://proxy.example/oauth/start?origin=${
        encodeURIComponent(ORIGIN)
      }&channel=${CHANNEL}`,
    ),
  );
  const authorize = new URL(response.headers.get("location") || "");
  return {
    response,
    authorize,
    state: authorize.searchParams.get("state") || "",
  };
}

Deno.test("rate limiter rejects requests after the configured per-client allowance", async () => {
  let now = 1_000;
  const check = createRateLimiter({ now: () => now, kvFactory: () => null });
  const req = new Request("https://proxy.example/callback", {
    headers: { "x-forwarded-for": "203.0.113.4" },
  });
  assert(
    (await check(req, "test", 2, 60_000)).allowed,
    "first request should pass",
  );
  assert(
    (await check(req, "test", 2, 60_000)).allowed,
    "second request should pass",
  );
  const denied = await check(req, "test", 2, 60_000);
  assert(
    !denied.allowed && denied.remaining === 0,
    "third request should be denied",
  );
  now += 60_001;
  assert(
    (await check(req, "test", 2, 60_000)).allowed,
    "request should pass after reset",
  );
});

Deno.test("rate limiter falls back when KV initialization throws synchronously", async () => {
  const check = createRateLimiter({
    kvFactory: () => {
      throw new Error("KV is not attached");
    },
  });
  const req = new Request("https://proxy.example/callback", {
    headers: { "x-forwarded-for": "203.0.113.5" },
  });

  const first = await check(req, "test", 2, 60_000);
  const second = await check(req, "test", 2, 60_000);
  const denied = await check(req, "test", 2, 60_000);

  assert(
    first.allowed && second.allowed,
    "local fallback should preserve the configured allowance",
  );
  assert(
    !denied.allowed && denied.remaining === 0,
    "local fallback should still enforce the limit",
  );
});

Deno.test("capabilities advertises the tokenless BFF only to allowed browser origins", async () => {
  const handler = createRequestHandler({
    allowedOrigins: [ORIGIN],
    rateCheck: allowRate,
  });
  const allowed = await handler(
    new Request("https://proxy.example/capabilities", {
      headers: { origin: ORIGIN },
    }),
  );
  assertEquals(allowed.status, 200, "allowed origin should read capabilities");
  assertEquals(
    allowed.headers.get("access-control-allow-origin"),
    ORIGIN,
    "capabilities response should be readable cross-origin",
  );
  const payload = await allowed.json();
  assertEquals(payload.authMode, "bff-v1", "BFF mode should be explicit");
  assertEquals(
    payload.githubTokenInBrowser,
    false,
    "capabilities must promise that GitHub tokens stay server-side",
  );

  const disallowed = await handler(
    new Request("https://proxy.example/capabilities", {
      headers: { origin: "https://evil.example" },
    }),
  );
  assertEquals(disallowed.status, 403, "disallowed origin should be rejected");
});

Deno.test("OAuth start owns state and PKCE and always selects an account", async () => {
  const { store, cipher } = await createTestDependencies();
  const values = [STATE, VERIFIER];
  const handler = createRequestHandler({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://proxy.example/callback",
    allowedOrigins: [ORIGIN],
    authStore: store,
    tokenCipher: cipher,
    rateCheck: allowRate,
    randomTokenFn: () => values.shift() || SESSION,
  });

  const { response, authorize, state } = await beginOAuth(handler);
  assertEquals(response.status, 302, "OAuth start should redirect");
  assertEquals(
    authorize.origin,
    "https://github.com",
    "authorization must be pinned to GitHub",
  );
  assertEquals(
    authorize.pathname,
    "/login/oauth/authorize",
    "authorization path should be GitHub OAuth",
  );
  assertEquals(
    authorize.searchParams.get("client_id"),
    "client",
    "server should add the client id",
  );
  assertEquals(
    authorize.searchParams.get("state"),
    STATE,
    "server should generate OAuth state",
  );
  assertEquals(
    authorize.searchParams.get("code_challenge_method"),
    "S256",
    "PKCE should use S256",
  );
  assert(
    (authorize.searchParams.get("code_challenge") || "").length === 43,
    "PKCE challenge should be present",
  );
  assertEquals(
    authorize.searchParams.get("prompt"),
    "select_account",
    "account picker must always be requested",
  );
  assertEquals(state, STATE, "test should capture server state");
});

Deno.test("OAuth callback keeps the GitHub token server-side and rejects state replay", async () => {
  const { store, cipher } = await createTestDependencies();
  const values = [STATE, VERIFIER, SESSION];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const handler = createRequestHandler({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://proxy.example/callback",
    allowedOrigins: [ORIGIN],
    authStore: store,
    tokenCipher: cipher,
    rateCheck: allowRate,
    randomTokenFn: () => values.shift() || "x".repeat(43),
    fetchFn: (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/login/oauth/access_token")) {
        return Promise.resolve(
          Response.json({ access_token: "github-secret-token" }),
        );
      }
      if (url.endsWith("/user")) {
        return Promise.resolve(Response.json({ login: "tron-user", id: 42 }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    },
  });

  const { state } = await beginOAuth(handler);
  const callback = await handler(
    new Request(
      `https://proxy.example/callback?code=VALID_CODE_123&state=${state}`,
    ),
  );
  const body = await callback.text();
  assertEquals(callback.status, 200, "valid callback should succeed");
  assertEquals(
    calls.length,
    2,
    "callback should exchange the code and verify the user",
  );
  assert(
    !body.includes("github-secret-token"),
    "callback HTML must never contain the GitHub token",
  );
  assert(
    body.includes(`\"session\":\"${SESSION}\"`),
    "callback should return only the BFF session",
  );
  assert(
    body.includes('"login":"tron-user"'),
    "callback should return the verified login",
  );
  assert(
    body.includes(`postMessage(data, \"${ORIGIN}\")`),
    "result should target only the initiating origin",
  );

  const exchangeBody = JSON.parse(String(calls[0].init?.body || "{}"));
  assertEquals(
    exchangeBody.code_verifier,
    VERIFIER,
    "token exchange should use the stored PKCE verifier",
  );

  const replay = await handler(
    new Request(
      `https://proxy.example/callback?code=VALID_CODE_123&state=${state}`,
    ),
  );
  assertEquals(replay.status, 400, "replayed state must fail");
  assertEquals(
    calls.length,
    2,
    "replayed state must fail before GitHub is contacted",
  );
});

Deno.test("session is origin-bound and can be revoked", async () => {
  const { store, cipher } = await createTestDependencies();
  await store.saveSession(SESSION, {
    origin: ORIGIN,
    encryptedToken: await cipher.encrypt("github-secret-token"),
    login: "tron-user",
    userId: 42,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  const upstreamCalls: string[] = [];
  const handler = createRequestHandler({
    clientId: "client",
    clientSecret: "secret",
    allowedOrigins: [ORIGIN, "https://other.example"],
    authStore: store,
    tokenCipher: cipher,
    rateCheck: allowRate,
    fetchFn: (input) => {
      upstreamCalls.push(String(input));
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });

  const sessionRequest = (origin: string, method = "GET") =>
    new Request("https://proxy.example/session", {
      method,
      headers: { origin, "x-tronide-session": SESSION },
    });

  const valid = await handler(sessionRequest(ORIGIN));
  assertEquals(valid.status, 200, "issuing origin should validate the session");
  assertEquals(
    (await valid.json()).login,
    "tron-user",
    "session should expose the verified login",
  );

  const wrongOrigin = await handler(sessionRequest("https://other.example"));
  assertEquals(
    wrongOrigin.status,
    401,
    "a different allow-listed origin must not reuse the session",
  );

  const deleted = await handler(sessionRequest(ORIGIN, "DELETE"));
  assertEquals(deleted.status, 204, "disconnect should revoke the session");
  assert(
    upstreamCalls.some((url) => url.includes("/applications/client/token")),
    "disconnect should best-effort revoke the GitHub OAuth token",
  );
  const afterDelete = await handler(sessionRequest(ORIGIN));
  assertEquals(afterDelete.status, 401, "revoked session must not be reusable");
});

Deno.test("restricted REST BFF injects the server token and rejects browser credentials", async () => {
  const { store, cipher } = await createTestDependencies();
  await store.saveSession(SESSION, {
    origin: ORIGIN,
    encryptedToken: await cipher.encrypt("github-secret-token"),
    login: "tron-user",
    userId: 42,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  let upstreamAuthorization = "";
  let upstreamUrl = "";
  const handler = createRequestHandler({
    allowedOrigins: [ORIGIN],
    authStore: store,
    tokenCipher: cipher,
    rateCheck: allowRate,
    fetchFn: (input, init) => {
      upstreamUrl = String(input);
      upstreamAuthorization = new Headers(init?.headers).get("authorization") ||
        "";
      return Promise.resolve(Response.json({ login: "tron-user" }));
    },
  });
  const headers = { origin: ORIGIN, "x-tronide-session": SESSION };

  const allowed = await handler(
    new Request("https://proxy.example/api/user", { headers }),
  );
  assertEquals(allowed.status, 200, "allow-listed API operation should pass");
  assertEquals(
    upstreamUrl,
    "https://api.github.com/user",
    "API target should be pinned to GitHub",
  );
  assertEquals(
    upstreamAuthorization,
    "Bearer github-secret-token",
    "BFF should inject its decrypted token",
  );
  assertEquals(
    allowed.headers.get("cache-control"),
    "no-store",
    "authenticated GitHub API responses must never be cached",
  );

  const forbidden = await handler(
    new Request("https://proxy.example/api/orgs/tronweb3/members", { headers }),
  );
  assertEquals(
    forbidden.status,
    403,
    "arbitrary GitHub API paths must be rejected",
  );

  const rawCredential = await handler(
    new Request("https://proxy.example/api/user", {
      headers: { ...headers, authorization: "Bearer browser-token" },
    }),
  );
  assertEquals(
    rawCredential.status,
    400,
    "browser GitHub credentials must be rejected",
  );
});

Deno.test("git proxy allows anonymous public reads and injects session auth only server-side", async () => {
  const { store, cipher } = await createTestDependencies();
  await store.saveSession(SESSION, {
    origin: ORIGIN,
    encryptedToken: await cipher.encrypt("github-secret-token"),
    login: "tron-user",
    userId: 42,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  const authorizations: string[] = [];
  const handler = createRequestHandler({
    allowedOrigins: [ORIGIN],
    authStore: store,
    tokenCipher: cipher,
    rateCheck: allowRate,
    fetchFn: (_input, init) => {
      authorizations.push(
        new Headers(init?.headers).get("authorization") || "",
      );
      return Promise.resolve(new Response("git-data", { status: 200 }));
    },
  });
  const url =
    "https://proxy.example/git/github.com/tronprotocol/tronbox/info/refs?service=git-upload-pack";

  const publicResponse = await handler(
    new Request(url, { headers: { origin: ORIGIN } }),
  );
  assertEquals(
    publicResponse.status,
    200,
    "anonymous public Git request should pass",
  );
  assertEquals(
    authorizations[0],
    "",
    "anonymous request must not get credentials",
  );

  const privateResponse = await handler(
    new Request(url, {
      headers: { origin: ORIGIN, "x-tronide-session": SESSION },
    }),
  );
  assertEquals(
    privateResponse.status,
    200,
    "session-authenticated Git request should pass",
  );
  assert(
    authorizations[1].startsWith("Basic ") &&
      !authorizations[1].includes("github-secret-token"),
    "GitHub Basic auth should be created only inside the BFF",
  );
  assertEquals(
    atob(authorizations[1].slice("Basic ".length)),
    "github-secret-token:x-oauth-basic",
    "OAuth App token must be the Git HTTPS username",
  );
  assertEquals(
    privateResponse.headers.get("cache-control"),
    "no-store",
    "authenticated Git responses must never be cached",
  );

  const rawCredential = await handler(
    new Request(url, {
      headers: { origin: ORIGIN, authorization: "Basic browser-token" },
    }),
  );
  assertEquals(
    rawCredential.status,
    400,
    "raw browser Git credentials must be rejected",
  );

  const oversized = await handler(
    new Request(
      url.replace("info/refs?service=git-upload-pack", "git-receive-pack"),
      {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-length": String(64 * 1024 * 1024 + 1),
        },
        body: "oversized",
      },
    ),
  );
  assertEquals(oversized.status, 413, "oversized Git uploads must be rejected");
});

Deno.test("git proxy rejects disallowed origins and SSRF paths before upstream fetch", async () => {
  const { store, cipher } = await createTestDependencies();
  let fetches = 0;
  const handler = createRequestHandler({
    allowedOrigins: [ORIGIN],
    authStore: store,
    tokenCipher: cipher,
    rateCheck: allowRate,
    fetchFn: () => {
      fetches++;
      return Promise.resolve(new Response("unexpected"));
    },
  });

  const disallowed = await handler(
    new Request(
      "https://proxy.example/git/github.com/tronprotocol/tronbox/info/refs?service=git-upload-pack",
      { headers: { origin: "https://evil.example" } },
    ),
  );
  assertEquals(disallowed.status, 403, "disallowed origin should be rejected");

  const ssrf = await handler(
    new Request(
      "https://proxy.example/git/github.com@evil.example/tronprotocol/tronbox/info/refs?service=git-upload-pack",
      { headers: { origin: ORIGIN } },
    ),
  );
  assertEquals(ssrf.status, 400, "invalid Git target should be rejected");
  assertEquals(
    fetches,
    0,
    "rejected Git requests must not contact an upstream",
  );
});
