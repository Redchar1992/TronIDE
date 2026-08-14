# GitHub OAuth BFF migration plan

## Problem

The legacy flow completes the confidential OAuth exchange in Deno, then sends
the GitHub access token back to the browser. TronIDE stores that token in
`sessionStorage` and sends it to GitHub REST and Git smart-HTTP. The exchange is
server-side, but the credential boundary is still client-side.

The target architecture makes Deno the GitHub backend-for-frontend (BFF):

```mermaid
sequenceDiagram
  participant UI as TronIDE browser
  participant BFF as Deno GitHub BFF
  participant GH as GitHub
  UI->>BFF: GET /oauth/start (origin + channel)
  BFF->>BFF: create state + PKCE verifier (single-use, 10 min)
  BFF->>GH: authorize (state + PKCE + select_account)
  GH->>BFF: /callback (code + state)
  BFF->>BFF: atomically consume state
  BFF->>GH: exchange code + verify /user
  BFF->>BFF: encrypt token in KV; create scoped session
  BFF-->>UI: postMessage(session handle + login; never GitHub token)
  UI->>BFF: /api/* or /git/* + session handle
  BFF->>GH: allow-listed request + server-held GitHub token
```

## Security and API contract

- Deno generates OAuth `state` and the PKCE verifier. State is atomically
  consumed from KV and expires after 10 minutes.
- `prompt=select_account` remains a server-owned authorization parameter.
- The callback validates the GitHub identity through `GET /user` before a
  session is issued.
- GitHub tokens are AES-GCM encrypted in Deno KV. The KV key is a SHA-256 hash
  of the random TronIDE session handle, so neither the raw handle nor token is
  persisted.
- The callback sends only an opaque, revocable TronIDE session handle and the
  verified login to the opener. It is bound to the exact requesting origin and
  has an eight-hour default lifetime.
- The browser keeps that handle in tab-scoped `sessionStorage`; it is not a
  GitHub credential and is accepted only by this BFF, its allow-listed routes,
  and the origin that created it.
- `GET /session` validates/hydrates a session. `DELETE /session` revokes the
  local session and best-effort revokes the upstream OAuth token.
- `/api/*` exposes only the REST operations TronIDE uses (`/user`, repository
  contents, and gists). It cannot act as an arbitrary GitHub proxy.
- `/git/*` remains pinned to GitHub smart-HTTP paths. Incoming browser
  `Authorization` headers are rejected; the BFF injects upstream credentials
  only after validating `X-TronIDE-Session`.
- Requests are origin-checked, rate-limited, redirect-disabled, and protected by
  no-store and browser security headers.

## Implementation order

1. Add the Deno state/session store, token encryption, OAuth start/callback,
   session, restricted REST, and authenticated Git proxy endpoints.
2. Replace the browser token store with the opaque BFF session store.
3. Route landing-page repository calls, gist calls, and Git smart-HTTP auth
   through the BFF; remove the browser PAT flow.
4. Add server unit tests, frontend security-contract tests, and update browser
   tests to seed/mock a BFF session instead of a GitHub token.
5. Run formatting/linting, focused tests, core tests, and a production build.

## Deployment and cut-over

The frontend pipelines do **not** deploy `services/github-oauth`; Deno must be
deployed separately. Do not point production at the BFF frontend until the
service and secrets below are ready.

1. Create or transfer the GitHub OAuth App and create the Deno project under the
   `tronweb3` organization. Verify both resources, their secrets, and deployment
   access are organization-controlled. Repository ownership alone changes
   neither resource.
2. Attach Deno KV and configure:
   - `GITHUB_CLIENT_ID`
   - `GITHUB_CLIENT_SECRET`
   - `SESSION_ENCRYPTION_KEY` (32 random bytes, base64 encoded)
   - `REDIRECT_URI`
   - `ALLOWED_ORIGINS` (production and test origins)
   - optional rate/session lifetime variables documented in `README.md`
3. Deploy this service source and verify `/health` reports `bff-v1` and
   `/oauth/start` redirects with `state`, `code_challenge`, and
   `prompt=select_account`.
4. Update the GitHub OAuth App callback to the team-owned BFF `/callback`.
5. Set the frontend build variable `TRONIDE_GITHUB_BFF_ORIGIN` to the same
   team-owned BFF origin, then deploy this branch/current online build to a
   test or preview environment;
   run connect, refresh, gist, public/private repository import,
   commit/push/pull, disconnect, and expiry checks. Confirm DevTools never
   contains a GitHub access token.
6. Promote the same pair (BFF, then frontend) to production.

If the BFF is unavailable, fail closed by disabling GitHub connect; never fall
back to returning a GitHub token to the browser. Roll back the frontend and BFF
as a pair, or leave GitHub connect temporarily unavailable while preserving the
rest of TronIDE.

## Acceptance criteria

- No GitHub access token appears in callback HTML, `postMessage`, web storage,
  frontend state, browser request headers, logs, or error messages.
- Replayed/expired OAuth state and replayed/revoked/expired sessions fail.
- A session issued for one allowed origin fails from every other origin.
- REST and Git proxy path traversal, arbitrary hosts, redirects, and raw browser
  credentials are rejected.
- Account selection is shown on every new OAuth connection.
- Test-environment build SHA matches the pushed PR SHA and all required GitHub
  checks pass.
