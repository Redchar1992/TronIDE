/*
 * TronIDE — GitHub OAuth backend-for-frontend (Deno Deploy).
 *
 * The browser never receives a GitHub access token. Deno owns OAuth state and
 * PKCE, encrypts the token in KV, and gives the browser only a short-lived,
 * origin-bound TronIDE session handle. GitHub REST and smart-HTTP calls are
 * allow-listed and authenticated here.
 */

const CLIENT_ID = Deno.env.get("GITHUB_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GITHUB_CLIENT_SECRET") ?? "";
const REDIRECT_URI = Deno.env.get("REDIRECT_URI") ??
  "https://tronide-gh-oauth.redchar1992.deno.net/callback";
const SESSION_ENCRYPTION_KEY = Deno.env.get("SESSION_ENCRYPTION_KEY") ?? "";
const ALLOWED_ORIGINS =
  (Deno.env.get("ALLOWED_ORIGINS") ?? "https://tronide.io")
    .split(",").map((value) => value.trim()).filter(Boolean);
const GITHUB_SCOPE = Deno.env.get("GITHUB_SCOPE") ?? "gist repo";
const OAUTH_RATE_LIMIT = positiveInt(Deno.env.get("OAUTH_RATE_LIMIT"), 10);
const API_RATE_LIMIT = positiveInt(Deno.env.get("API_RATE_LIMIT"), 120);
const GIT_PUBLIC_RATE_LIMIT = positiveInt(
  Deno.env.get("GIT_PUBLIC_RATE_LIMIT"),
  30,
);
const GIT_AUTH_RATE_LIMIT = positiveInt(
  Deno.env.get("GIT_AUTH_RATE_LIMIT"),
  120,
);
const SESSION_TTL_MS =
  positiveInt(Deno.env.get("SESSION_TTL_SECONDS"), 8 * 60 * 60) * 1000;
const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;
const SESSION_HEADER = "x-tronide-session";
const MAX_API_BODY_BYTES = 5 * 1024 * 1024;
const MAX_GIT_BODY_BYTES = 64 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type RateRecord = { count: number; resetAt: number };
type RateResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};
type RateCheck = (
  req: Request,
  bucket: string,
  limit: number,
  windowMs: number,
  info?: unknown,
) => RateResult | Promise<RateResult>;

export type OAuthAttempt = {
  origin: string;
  channel: string;
  verifier: string;
  expiresAt: number;
};

export type StoredSession = {
  origin: string;
  encryptedToken: string;
  login: string;
  userId: number;
  createdAt: number;
  expiresAt: number;
};

export interface AuthStore {
  saveAttempt(state: string, attempt: OAuthAttempt): Promise<void>;
  consumeAttempt(state: string): Promise<OAuthAttempt | null>;
  saveSession(handle: string, session: StoredSession): Promise<void>;
  getSession(handle: string): Promise<StoredSession | null>;
  deleteSession(handle: string): Promise<void>;
}

export interface TokenCipher {
  encrypt(token: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

function positiveInt(
  value: string | null | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomToken(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function createTokenCipher(secret: string): Promise<TokenCipher> {
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(secret);
  } catch (_error) {
    throw new Error("SESSION_ENCRYPTION_KEY must be base64 encoded");
  }
  if (keyBytes.length !== 32) {
    throw new Error("SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    async encrypt(token: string): Promise<string> {
      const iv = new Uint8Array(12);
      crypto.getRandomValues(iv);
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoder.encode(token),
      );
      return `v1.${bytesToBase64Url(iv)}.${
        bytesToBase64Url(new Uint8Array(encrypted))
      }`;
    },
    async decrypt(value: string): Promise<string> {
      const [version, ivValue, encryptedValue, extra] = value.split(".");
      if (
        version !== "v1" || !ivValue || !encryptedValue || extra !== undefined
      ) throw new Error("Invalid encrypted token");
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(ivValue) },
        key,
        base64ToBytes(encryptedValue),
      );
      return decoder.decode(decrypted);
    },
  };
}

export function createMemoryAuthStore(
  options: { now?: () => number } = {},
): AuthStore {
  const now = options.now || Date.now;
  const attempts = new Map<string, OAuthAttempt>();
  const sessions = new Map<string, StoredSession>();

  return {
    async saveAttempt(state, attempt) {
      attempts.set(await sha256Base64Url(state), structuredClone(attempt));
    },
    async consumeAttempt(state) {
      const key = await sha256Base64Url(state);
      const attempt = attempts.get(key) || null;
      attempts.delete(key);
      return attempt && attempt.expiresAt > now()
        ? structuredClone(attempt)
        : null;
    },
    async saveSession(handle, session) {
      sessions.set(await sha256Base64Url(handle), structuredClone(session));
    },
    async getSession(handle) {
      const key = await sha256Base64Url(handle);
      const session = sessions.get(key) || null;
      if (!session || session.expiresAt <= now()) {
        sessions.delete(key);
        return null;
      }
      return structuredClone(session);
    },
    async deleteSession(handle) {
      sessions.delete(await sha256Base64Url(handle));
    },
  };
}

export function createKvAuthStore(
  kv: Deno.Kv,
  options: { now?: () => number } = {},
): AuthStore {
  const now = options.now || Date.now;
  const attemptKey = async (
    state: string,
  ): Promise<Deno.KvKey> => [
    "github-oauth-attempt-v2",
    await sha256Base64Url(state),
  ];
  const sessionKey = async (
    handle: string,
  ): Promise<Deno.KvKey> => [
    "github-session-v2",
    await sha256Base64Url(handle),
  ];

  return {
    async saveAttempt(state, attempt) {
      await (kv.set as unknown as (
        key: Deno.KvKey,
        value: unknown,
        options?: { expireIn?: number },
      ) => Promise<unknown>)(await attemptKey(state), attempt, {
        expireIn: Math.max(1, attempt.expiresAt - now()),
      });
    },
    async consumeAttempt(state) {
      const key = await attemptKey(state);
      for (let retry = 0; retry < 4; retry++) {
        const entry = await kv.get<OAuthAttempt>(key);
        if (!entry.value) return null;
        const committed = await kv.atomic().check(entry).delete(key).commit();
        if (committed.ok) {
          return entry.value.expiresAt > now() ? entry.value : null;
        }
      }
      return null;
    },
    async saveSession(handle, session) {
      await (kv.set as unknown as (
        key: Deno.KvKey,
        value: unknown,
        options?: { expireIn?: number },
      ) => Promise<unknown>)(await sessionKey(handle), session, {
        expireIn: Math.max(1, session.expiresAt - now()),
      });
    },
    async getSession(handle) {
      const key = await sessionKey(handle);
      const entry = await kv.get<StoredSession>(key);
      if (!entry.value) return null;
      if (entry.value.expiresAt <= now()) {
        await kv.delete(key);
        return null;
      }
      return entry.value;
    },
    async deleteSession(handle) {
      await kv.delete(await sessionKey(handle));
    },
  };
}

function peerHostname(info?: unknown): string {
  if (!info || typeof info !== "object" || !("remoteAddr" in info)) return "";
  const remoteAddr = (info as { remoteAddr?: unknown }).remoteAddr;
  if (
    !remoteAddr || typeof remoteAddr !== "object" || !("hostname" in remoteAddr)
  ) return "";
  const hostname = (remoteAddr as { hostname?: unknown }).hostname;
  return typeof hostname === "string" ? hostname : "";
}

function clientAddress(req: Request, info?: unknown): string {
  const remote = peerHostname(info);
  const forwarded = req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return remote || forwarded || "unknown";
}

async function hashClientAddress(address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(address));
  return Array.from(new Uint8Array(digest)).slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Deno KV makes counters consistent across edge isolates. A bounded in-memory
// fallback is acceptable for throttling, but never for OAuth attempts/sessions.
export function createRateLimiter(options: {
  now?: () => number;
  kvFactory?: () => Deno.Kv | null | Promise<Deno.Kv | null>;
} = {}): RateCheck {
  const now = options.now || Date.now;
  const local = new Map<string, RateRecord>();
  let kvPromise: Promise<Deno.Kv | null> | null = null;
  const getKv = () => {
    if (!kvPromise) {
      kvPromise = (async () => {
        try {
          if (options.kvFactory) return await options.kvFactory();
          if (typeof Deno.openKv !== "function") return null;
          return await Deno.openKv();
        } catch (error) {
          console.warn(
            "[rate-limit] Deno KV unavailable; using per-isolate counters",
            error,
          );
          return null;
        }
      })();
    }
    return kvPromise;
  };

  return async (req, bucket, limit, windowMs, info) => {
    const client = await hashClientAddress(clientAddress(req, info));
    const localKey = `${bucket}:${client}`;
    const key: Deno.KvKey = ["rate-limit-v1", bucket, client];
    const timestamp = now();
    const kv = await getKv();

    if (kv) {
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const entry = await kv.get<RateRecord>(key);
          const current = entry.value && entry.value.resetAt > timestamp
            ? entry.value
            : { count: 0, resetAt: timestamp + windowMs };
          if (current.count >= limit) {
            return {
              allowed: false,
              limit,
              remaining: 0,
              resetAt: current.resetAt,
            };
          }
          const next = { count: current.count + 1, resetAt: current.resetAt };
          const committed = await kv.atomic().check(entry).set(key, next)
            .commit();
          if (committed.ok) {
            return {
              allowed: true,
              limit,
              remaining: Math.max(0, limit - next.count),
              resetAt: next.resetAt,
            };
          }
        }
      } catch (error) {
        console.warn(
          "[rate-limit] Deno KV transaction failed; using per-isolate counters",
          error,
        );
      }
    }

    const current = local.get(localKey);
    const active = current && current.resetAt > timestamp
      ? current
      : { count: 0, resetAt: timestamp + windowMs };
    if (active.count >= limit) {
      return { allowed: false, limit, remaining: 0, resetAt: active.resetAt };
    }
    const next = { count: active.count + 1, resetAt: active.resetAt };
    local.set(localKey, next);
    if (local.size > 10_000) {
      for (const [entryKey, record] of local) {
        if (record.resetAt <= timestamp) local.delete(entryKey);
      }
      while (local.size > 10_000) {
        const oldestKey = local.keys().next().value;
        if (oldestKey === undefined) break;
        local.delete(oldestKey);
      }
    }
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - next.count),
      resetAt: next.resetAt,
    };
  };
}

const defaultRateCheck = createRateLimiter();

const SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "unsafe-none",
};

function setSecurityHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}

function rateHeaders(result: RateResult): Record<string, string> {
  return {
    "x-ratelimit-limit": String(result.limit),
    "x-ratelimit-remaining": String(result.remaining),
    "x-ratelimit-reset": String(Math.ceil(result.resetAt / 1000)),
  };
}

function rateLimitedResponse(
  result: RateResult,
  headers: Record<string, string> = {},
): Response {
  const retryAfter = Math.max(
    1,
    Math.ceil((result.resetAt - Date.now()) / 1000),
  );
  return new Response("Too many requests", {
    status: 429,
    headers: setSecurityHeaders(
      new Headers({
        ...headers,
        ...rateHeaders(result),
        "retry-after": String(retryAfter),
        "cache-control": "no-store",
      }),
    ),
  });
}

function escapeForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function resultPage(
  targetOrigin: string,
  channel: string,
  payload: Record<string, unknown>,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  const data = escapeForScript(
    JSON.stringify({ source: "tronide-github-oauth", channel, ...payload }),
  );
  const origin = escapeForScript(JSON.stringify(targetOrigin));
  const nonce = randomToken(18);
  const body =
    `<!doctype html><html><head><meta charset="utf-8"><title>GitHub</title></head>
<body style="font:14px system-ui;padding:24px;color:#333">
<script nonce="${nonce}">
(function () {
  var data = ${data};
  try { if (window.opener) window.opener.postMessage(data, ${origin}); } catch (e) {}
  document.body.textContent = data.error
    ? ('GitHub connect failed: ' + data.error + '. You can close this window.')
    : 'GitHub connected. You can close this window.';
  setTimeout(function () { try { window.close(); } catch (e) {} }, 300);
})();
</script>
<noscript>Enable JavaScript to finish connecting to GitHub.</noscript>
</body></html>`;
  return new Response(body, {
    status,
    headers: setSecurityHeaders(
      new Headers({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
        ...extraHeaders,
      }),
    ),
  });
}

function standaloneErrorPage(error: string, status: number): Response {
  const body =
    `<!doctype html><html><head><meta charset="utf-8"><title>GitHub</title></head><body>GitHub connect failed: ${error}. You can close this window.</body></html>`;
  return new Response(body, {
    status,
    headers: setSecurityHeaders(
      new Headers({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
      }),
    ),
  });
}

function corsOrigin(req: Request, allowedOrigins: string[]): string {
  const origin = req.headers.get("origin") ?? "";
  return allowedOrigins.includes(origin) ? origin : "";
}

const BFF_ALLOW_HEADERS = [
  "accept",
  "content-type",
  "if-none-match",
  "git-protocol",
  "pragma",
  "cache-control",
  "x-requested-with",
  SESSION_HEADER,
];
const BFF_EXPOSE_HEADERS = [
  "content-type",
  "etag",
  "last-modified",
  "link",
  "www-authenticate",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "retry-after",
];

function corsHeaders(
  req: Request,
  allowedOrigins: string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": BFF_ALLOW_HEADERS.join(", "),
    "access-control-expose-headers": BFF_EXPOSE_HEADERS.join(", "),
    "access-control-max-age": "600",
    vary: "Origin",
  };
  const origin = corsOrigin(req, allowedOrigins);
  if (origin) headers["access-control-allow-origin"] = origin;
  return headers;
}

function responseWithCors(
  req: Request,
  allowedOrigins: string[],
  body: BodyInit | null,
  init: ResponseInit = {},
): Response {
  const headers = new Headers({
    ...corsHeaders(req, allowedOrigins),
    "cache-control": "no-store",
  });
  if (init.headers) {
    new Headers(init.headers).forEach((value, name) =>
      headers.set(name, value)
    );
  }
  return new Response(body, { ...init, headers: setSecurityHeaders(headers) });
}

function jsonWithCors(
  req: Request,
  allowedOrigins: string[],
  payload: Record<string, unknown>,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return responseWithCors(req, allowedOrigins, JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function validSessionHandle(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validState(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validChannel(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function isAllowedOrigin(origin: string, allowedOrigins: string[]): boolean {
  return !!origin && allowedOrigins.includes(origin);
}

function basicAuth(username: string, password: string): string {
  return `Basic ${bytesToBase64(encoder.encode(`${username}:${password}`))}`;
}

async function revokeGithubToken(
  fetchFn: typeof fetch,
  clientId: string,
  clientSecret: string,
  token: string,
): Promise<void> {
  if (!clientId || !clientSecret || !token) return;
  try {
    await fetchFn(
      `https://api.github.com/applications/${
        encodeURIComponent(clientId)
      }/token`,
      {
        method: "DELETE",
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "tronide-github-bff",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ access_token: token }),
        redirect: "manual",
      },
    );
  } catch (_error) {
    // Session deletion must succeed even if GitHub is temporarily unavailable.
  }
}

function allowedApiRequest(
  path: string,
  method: string,
  searchParams: URLSearchParams,
): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch (_error) {
    return false;
  }
  if (
    !decoded.startsWith("/") || decoded.includes("\\") ||
    decoded.includes("\0") || decoded.includes("//") || decoded.includes("@")
  ) return false;
  if (
    decoded.split("/").some((segment) => segment === "." || segment === "..")
  ) return false;

  const noQuery = searchParams.size === 0;
  if (decoded === "/user") return method === "GET" && noQuery;
  if (decoded === "/gists") return method === "POST" && noQuery;
  if (/^\/gists\/[A-Za-z0-9]+$/.test(decoded)) {
    return (method === "GET" || method === "PATCH") && noQuery;
  }
  if (
    /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/contents(?:\/.*)?$/.test(
      decoded,
    )
  ) {
    if (method === "PUT") return noQuery;
    if (method !== "GET") return false;
    return Array.from(searchParams.keys()).every((key) => key === "ref");
  }
  return false;
}

function gitTarget(url: URL): URL | null {
  const rest = url.pathname.slice("/git/".length).replace(/^https?:\/\//i, "");
  const pathPattern =
    /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;
  const queryPattern = /^(?:\?service=git-(?:upload|receive)-pack)?$/;
  if (
    !rest || rest.includes("..") || rest.includes("@") || rest.includes("//") ||
    rest.includes("\\") ||
    !pathPattern.test(rest) || !queryPattern.test(url.search)
  ) return null;
  try {
    const target = new URL(`https://${rest}${url.search}`);
    return target.protocol === "https:" && target.hostname === "github.com"
      ? target
      : null;
  } catch (_error) {
    return null;
  }
}

export function createRequestHandler(options: {
  fetchFn?: typeof fetch;
  rateCheck?: RateCheck;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  allowedOrigins?: string[];
  githubScope?: string;
  authStore?: AuthStore | Promise<AuthStore>;
  tokenCipher?: TokenCipher | Promise<TokenCipher>;
  sessionEncryptionKey?: string;
  sessionTtlMs?: number;
  oauthAttemptTtlMs?: number;
  now?: () => number;
  randomTokenFn?: (length?: number) => string;
} = {}) {
  const fetchFn = options.fetchFn || fetch;
  const rateCheck = options.rateCheck || defaultRateCheck;
  const clientId = options.clientId === undefined
    ? CLIENT_ID
    : options.clientId;
  const clientSecret = options.clientSecret === undefined
    ? CLIENT_SECRET
    : options.clientSecret;
  const redirectUri = options.redirectUri || REDIRECT_URI;
  const allowedOrigins = options.allowedOrigins || ALLOWED_ORIGINS;
  const githubScope = options.githubScope || GITHUB_SCOPE;
  const sessionTtlMs = options.sessionTtlMs || SESSION_TTL_MS;
  const oauthAttemptTtlMs = options.oauthAttemptTtlMs || OAUTH_ATTEMPT_TTL_MS;
  const now = options.now || Date.now;
  const makeRandomToken = options.randomTokenFn || randomToken;
  let storePromise: Promise<AuthStore> | null = options.authStore
    ? Promise.resolve(options.authStore)
    : null;
  let cipherPromise: Promise<TokenCipher> | null = options.tokenCipher
    ? Promise.resolve(options.tokenCipher)
    : null;

  const getStore = (): Promise<AuthStore> => {
    if (!storePromise) {
      storePromise = (async () => {
        if (typeof Deno.openKv !== "function") {
          throw new Error("Deno KV is required for OAuth sessions");
        }
        return createKvAuthStore(await Deno.openKv(), { now });
      })();
    }
    return storePromise;
  };

  const getCipher = (): Promise<TokenCipher> => {
    if (!cipherPromise) {
      cipherPromise = createTokenCipher(
        options.sessionEncryptionKey ?? SESSION_ENCRYPTION_KEY,
      );
    }
    return cipherPromise;
  };

  const authenticate = async (req: Request): Promise<
    | { ok: true; handle: string; session: StoredSession; token: string }
    | { ok: false; response: Response }
  > => {
    const origin = req.headers.get("origin") || "";
    if (!isAllowedOrigin(origin, allowedOrigins)) {
      return {
        ok: false,
        response: responseWithCors(req, allowedOrigins, "Origin not allowed", {
          status: 403,
        }),
      };
    }
    if (req.headers.has("authorization")) {
      return {
        ok: false,
        response: responseWithCors(
          req,
          allowedOrigins,
          "Raw GitHub credentials are not accepted",
          { status: 400 },
        ),
      };
    }
    const handle = String(req.headers.get(SESSION_HEADER) || "").trim();
    if (!validSessionHandle(handle)) {
      return {
        ok: false,
        response: jsonWithCors(req, allowedOrigins, {
          error: "session_required",
        }, 401),
      };
    }
    try {
      const store = await getStore();
      const session = await store.getSession(handle);
      if (!session || session.origin !== origin) {
        return {
          ok: false,
          response: jsonWithCors(req, allowedOrigins, {
            error: "invalid_session",
          }, 401),
        };
      }
      const token = await (await getCipher()).decrypt(session.encryptedToken);
      if (!token) throw new Error("Empty token");
      return { ok: true, handle, session, token };
    } catch (_error) {
      return {
        ok: false,
        response: jsonWithCors(req, allowedOrigins, {
          error: "session_unavailable",
        }, 503),
      };
    }
  };

  return async (req: Request, info?: unknown): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("tronide-gh-oauth: ok; mode=bff-v1", {
        headers: setSecurityHeaders(
          new Headers({
            "cache-control": "no-store",
            "x-tronide-auth-mode": "bff-v1",
          }),
        ),
      });
    }

    if (url.pathname === "/capabilities") {
      if (req.method === "OPTIONS") {
        return responseWithCors(req, allowedOrigins, null, { status: 204 });
      }
      if (req.method !== "GET") {
        return responseWithCors(req, allowedOrigins, "Method not allowed", {
          status: 405,
        });
      }
      const requestOrigin = req.headers.get("origin");
      if (requestOrigin && !corsOrigin(req, allowedOrigins)) {
        return responseWithCors(req, allowedOrigins, "Origin not allowed", {
          status: 403,
        });
      }
      return jsonWithCors(req, allowedOrigins, {
        authMode: "bff-v1",
        githubTokenInBrowser: false,
      });
    }

    if (url.pathname === "/oauth/start") {
      if (req.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: setSecurityHeaders(new Headers()),
        });
      }
      const origin = url.searchParams.get("origin") || "";
      const channel = url.searchParams.get("channel") || "";
      if (!isAllowedOrigin(origin, allowedOrigins)) {
        return new Response("Origin not allowed", {
          status: 403,
          headers: setSecurityHeaders(
            new Headers({ "cache-control": "no-store" }),
          ),
        });
      }
      if (!validChannel(channel)) {
        return new Response("Invalid OAuth channel", {
          status: 400,
          headers: setSecurityHeaders(
            new Headers({ "cache-control": "no-store" }),
          ),
        });
      }
      if (!clientId || !redirectUri) {
        return new Response("OAuth server is not configured", {
          status: 503,
          headers: setSecurityHeaders(
            new Headers({ "cache-control": "no-store" }),
          ),
        });
      }

      const rate = await rateCheck(
        req,
        "oauth-start",
        OAUTH_RATE_LIMIT,
        RATE_WINDOW_MS,
        info,
      );
      if (!rate.allowed) return rateLimitedResponse(rate);

      try {
        const state = makeRandomToken(32);
        const verifier = makeRandomToken(32);
        if (!validState(state) || !validState(verifier)) {
          throw new Error("Invalid secure random source");
        }
        const challenge = await sha256Base64Url(verifier);
        await (await getStore()).saveAttempt(state, {
          origin,
          channel,
          verifier,
          expiresAt: now() + oauthAttemptTtlMs,
        });
        const authorize = new URL("https://github.com/login/oauth/authorize");
        authorize.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: githubScope,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          allow_signup: "false",
          prompt: "select_account",
        }).toString();
        return new Response(null, {
          status: 302,
          headers: setSecurityHeaders(
            new Headers({
              location: authorize.toString(),
              "cache-control": "no-store",
              ...rateHeaders(rate),
            }),
          ),
        });
      } catch (error) {
        console.error("[oauth-start] unable to persist OAuth attempt", error);
        return new Response("OAuth session storage is unavailable", {
          status: 503,
          headers: setSecurityHeaders(
            new Headers({ "cache-control": "no-store" }),
          ),
        });
      }
    }

    if (url.pathname === "/callback") {
      if (req.method !== "GET") {
        return standaloneErrorPage("method_not_allowed", 405);
      }
      const state = url.searchParams.get("state") || "";
      if (!validState(state)) return standaloneErrorPage("invalid_state", 400);

      const rate = await rateCheck(
        req,
        "oauth-callback",
        OAUTH_RATE_LIMIT,
        RATE_WINDOW_MS,
        info,
      );
      if (!rate.allowed) return standaloneErrorPage("rate_limited", 429);

      let attempt: OAuthAttempt | null;
      try {
        attempt = await (await getStore()).consumeAttempt(state);
      } catch (error) {
        console.error(
          "[oauth-callback] unable to consume OAuth attempt",
          error,
        );
        return standaloneErrorPage("session_unavailable", 503);
      }
      if (!attempt) {
        return standaloneErrorPage("invalid_or_replayed_state", 400);
      }

      const fail = (error: string, status: number) =>
        resultPage(
          attempt!.origin,
          attempt!.channel,
          { error },
          status,
          rateHeaders(rate),
        );
      const oauthError = url.searchParams.get("error");
      if (oauthError) return fail("authorization_denied", 400);
      const code = url.searchParams.get("code") || "";
      if (!/^[A-Za-z0-9_-]{10,256}$/.test(code)) {
        return fail(code ? "invalid_code" : "missing_code", 400);
      }
      if (!clientId || !clientSecret || !redirectUri) {
        return fail("server_misconfigured", 503);
      }

      let token = "";
      try {
        const exchange = await fetchFn(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "User-Agent": "tronide-github-bff",
            },
            body: JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              code,
              redirect_uri: redirectUri,
              code_verifier: attempt.verifier,
            }),
            redirect: "manual",
          },
        );
        if (!exchange.ok) return fail("exchange_failed", 502);
        const data = await exchange.json();
        token = typeof data.access_token === "string" ? data.access_token : "";
        if (!token) return fail("exchange_failed", 400);
      } catch (_error) {
        return fail("exchange_request_failed", 502);
      }

      let login = "";
      let userId = 0;
      try {
        const userResponse = await fetchFn("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "tronide-github-bff",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          redirect: "manual",
        });
        if (!userResponse.ok) {
          await revokeGithubToken(fetchFn, clientId, clientSecret, token);
          return fail("identity_verification_failed", 502);
        }
        const user = await userResponse.json();
        login = typeof user.login === "string" ? user.login : "";
        userId = Number.isSafeInteger(user.id) && user.id > 0 ? user.id : 0;
        if (!login || !userId) {
          await revokeGithubToken(fetchFn, clientId, clientSecret, token);
          return fail("identity_verification_failed", 502);
        }
      } catch (_error) {
        await revokeGithubToken(fetchFn, clientId, clientSecret, token);
        return fail("identity_verification_failed", 502);
      }

      try {
        const handle = makeRandomToken(32);
        if (!validSessionHandle(handle)) {
          throw new Error("Invalid secure random source");
        }
        const createdAt = now();
        const expiresAt = createdAt + sessionTtlMs;
        const encryptedToken = await (await getCipher()).encrypt(token);
        await (await getStore()).saveSession(handle, {
          origin: attempt.origin,
          encryptedToken,
          login,
          userId,
          createdAt,
          expiresAt,
        });
        return resultPage(
          attempt.origin,
          attempt.channel,
          {
            session: handle,
            login,
            userId,
            expiresAt,
          },
          200,
          rateHeaders(rate),
        );
      } catch (error) {
        console.error("[oauth-callback] unable to create BFF session", error);
        await revokeGithubToken(fetchFn, clientId, clientSecret, token);
        return fail("session_unavailable", 503);
      }
    }

    if (url.pathname === "/session") {
      if (req.method === "OPTIONS") {
        return responseWithCors(req, allowedOrigins, null, { status: 204 });
      }
      if (req.method !== "GET" && req.method !== "DELETE") {
        return responseWithCors(req, allowedOrigins, "Method not allowed", {
          status: 405,
        });
      }
      const authenticated = await authenticate(req);
      if (!authenticated.ok) return authenticated.response;
      if (req.method === "DELETE") {
        try {
          await (await getStore()).deleteSession(authenticated.handle);
          await revokeGithubToken(
            fetchFn,
            clientId,
            clientSecret,
            authenticated.token,
          );
        } catch (_error) {
          return jsonWithCors(req, allowedOrigins, {
            error: "session_unavailable",
          }, 503);
        }
        return responseWithCors(req, allowedOrigins, null, { status: 204 });
      }
      return jsonWithCors(req, allowedOrigins, {
        connected: true,
        login: authenticated.session.login,
        userId: authenticated.session.userId,
        expiresAt: authenticated.session.expiresAt,
      });
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") {
        return responseWithCors(req, allowedOrigins, null, { status: 204 });
      }
      const apiPath = url.pathname.slice("/api".length);
      if (!allowedApiRequest(apiPath, req.method, url.searchParams)) {
        return responseWithCors(
          req,
          allowedOrigins,
          "GitHub API operation not allowed",
          { status: 403 },
        );
      }
      const rate = await rateCheck(
        req,
        "github-api",
        API_RATE_LIMIT,
        RATE_WINDOW_MS,
        info,
      );
      if (!rate.allowed) {
        return rateLimitedResponse(rate, corsHeaders(req, allowedOrigins));
      }
      const authenticated = await authenticate(req);
      if (!authenticated.ok) return authenticated.response;

      let requestBody: Uint8Array | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const declaredLength = Number(req.headers.get("content-length") || 0);
        if (declaredLength > MAX_API_BODY_BYTES) {
          return responseWithCors(
            req,
            allowedOrigins,
            "Request body too large",
            { status: 413 },
          );
        }
        const body = new Uint8Array(await req.arrayBuffer());
        if (body.byteLength > MAX_API_BODY_BYTES) {
          return responseWithCors(
            req,
            allowedOrigins,
            "Request body too large",
            { status: 413 },
          );
        }
        requestBody = body;
      }

      const upstreamHeaders = new Headers({
        Authorization: `Bearer ${authenticated.token}`,
        Accept: req.headers.get("accept") || "application/vnd.github+json",
        "User-Agent": "tronide-github-bff",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      const contentType = req.headers.get("content-type");
      if (contentType) upstreamHeaders.set("content-type", contentType);
      const etag = req.headers.get("if-none-match");
      if (etag) upstreamHeaders.set("if-none-match", etag);

      let upstream: Response;
      try {
        upstream = await fetchFn(
          `https://api.github.com${apiPath}${url.search}`,
          {
            method: req.method,
            headers: upstreamHeaders,
            body: requestBody,
            redirect: "manual",
          },
        );
      } catch (_error) {
        return responseWithCors(
          req,
          allowedOrigins,
          "Upstream GitHub API request failed",
          { status: 502 },
        );
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        return responseWithCors(
          req,
          allowedOrigins,
          "Upstream redirect rejected",
          { status: 502 },
        );
      }
      if (upstream.status === 401) {
        await (await getStore()).deleteSession(authenticated.handle);
      }

      const responseHeaders = new Headers({
        ...corsHeaders(req, allowedOrigins),
        ...rateHeaders(rate),
        "cache-control": "no-store",
      });
      for (const name of BFF_EXPOSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) responseHeaders.set(name, value);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: setSecurityHeaders(responseHeaders),
      });
    }

    if (url.pathname === "/git" || url.pathname.startsWith("/git/")) {
      if (req.method === "OPTIONS") {
        return responseWithCors(req, allowedOrigins, null, { status: 204 });
      }
      const origin = req.headers.get("origin") || "";
      if (!isAllowedOrigin(origin, allowedOrigins)) {
        return responseWithCors(req, allowedOrigins, "Origin not allowed", {
          status: 403,
        });
      }
      if (req.method !== "GET" && req.method !== "POST") {
        return responseWithCors(req, allowedOrigins, "Method not allowed", {
          status: 405,
        });
      }
      if (req.headers.has("authorization")) {
        return responseWithCors(
          req,
          allowedOrigins,
          "Raw GitHub credentials are not accepted",
          { status: 400 },
        );
      }
      const target = gitTarget(url);
      if (!target) {
        return responseWithCors(req, allowedOrigins, "Bad git proxy request", {
          status: 400,
        });
      }

      const declaredGitLength = Number(req.headers.get("content-length") || 0);
      if (
        req.method === "POST" &&
        (!Number.isFinite(declaredGitLength) ||
          declaredGitLength > MAX_GIT_BODY_BYTES)
      ) {
        return responseWithCors(req, allowedOrigins, "Request body too large", {
          status: 413,
        });
      }

      const hasSession = !!req.headers.get(SESSION_HEADER);
      let authenticated: { handle: string; token: string } | null = null;
      if (hasSession) {
        const result = await authenticate(req);
        if (!result.ok) return result.response;
        authenticated = { handle: result.handle, token: result.token };
      }
      const rate = await rateCheck(
        req,
        authenticated ? "git-auth" : "git-public",
        authenticated ? GIT_AUTH_RATE_LIMIT : GIT_PUBLIC_RATE_LIMIT,
        RATE_WINDOW_MS,
        info,
      );
      if (!rate.allowed) {
        return rateLimitedResponse(rate, corsHeaders(req, allowedOrigins));
      }

      const upstreamHeaders = new Headers();
      for (
        const name of [
          "accept",
          "content-type",
          "git-protocol",
          "pragma",
          "cache-control",
        ]
      ) {
        const value = req.headers.get(name);
        if (value !== null) upstreamHeaders.set(name, value);
      }
      upstreamHeaders.set("user-agent", "tronide-github-bff");
      if (authenticated) {
        upstreamHeaders.set(
          "authorization",
          // OAuth App access tokens authenticate Git smart-HTTP as the Basic
          // username. (GitHub App installation tokens use the password slot;
          // this service currently owns an OAuth App token.)
          basicAuth(authenticated.token, "x-oauth-basic"),
        );
      }

      let upstream: Response;
      try {
        upstream = await fetchFn(target.toString(), {
          method: req.method,
          headers: upstreamHeaders,
          body: req.method === "POST" ? req.body : undefined,
          redirect: "manual",
        });
      } catch (_error) {
        return responseWithCors(
          req,
          allowedOrigins,
          "Upstream git request failed",
          { status: 502 },
        );
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        return responseWithCors(
          req,
          allowedOrigins,
          "Upstream redirect rejected",
          { status: 502 },
        );
      }
      if (upstream.status === 401 && authenticated) {
        await (await getStore()).deleteSession(authenticated.handle);
      }

      const responseHeaders = new Headers({
        ...corsHeaders(req, allowedOrigins),
        ...rateHeaders(rate),
        "cache-control": "no-store",
      });
      for (
        const name of [
          "content-type",
          "cache-control",
          "expires",
          "pragma",
          "www-authenticate",
        ]
      ) {
        const value = upstream.headers.get(name);
        if (value !== null) responseHeaders.set(name, value);
      }
      // Never let upstream cache policy make a private, session-authenticated
      // Git response reusable by a browser or intermediary.
      responseHeaders.set("cache-control", "no-store");
      return new Response(upstream.body, {
        status: upstream.status,
        headers: setSecurityHeaders(responseHeaders),
      });
    }

    return new Response("Not found", {
      status: 404,
      headers: setSecurityHeaders(new Headers()),
    });
  };
}

if (import.meta.main) Deno.serve(createRequestHandler());
