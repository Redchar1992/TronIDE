# tronide-gh-oauth — GitHub OAuth proxy for the static IDE

GitHub Pages is static, so it can't hold the OAuth client secret or call GitHub's
token endpoint (no CORS). This one-file Deno Deploy function is the only
server-side piece. The IDE opens a GitHub authorization popup; this function
exchanges the returned `code` for an access token and posts it back to the
opener.

## 1. Register the GitHub OAuth App

https://github.com/settings/applications/new

| Field | Value |
| --- | --- |
| Application name | `TronIDE` |
| Homepage URL | `https://tronide.io` |
| Authorization callback URL | `https://tronide-gh-oauth.redchar1992.deno.net/callback` |
| Enable Device Flow | off |

Copy the **Client ID** (goes in the frontend, public). Click **Generate a new
client secret** (goes in Deno env only — never in the frontend).

## 2. Deploy to Deno Deploy

```sh
deno install -A jsr:@deno/deployctl --global   # once
cd services/github-oauth
deployctl deploy --project=tronide-gh-oauth main.ts
```

(Or connect this repo in the Deno Deploy dashboard and point it at
`services/github-oauth/main.ts`.)

## 3. Set environment variables (Deno Deploy → Settings → Environment Variables)

| Var | Value |
| --- | --- |
| `GITHUB_CLIENT_ID` | the OAuth App client id |
| `GITHUB_CLIENT_SECRET` | the OAuth App client secret |
| `REDIRECT_URI` | `https://tronide-gh-oauth.redchar1992.deno.net/callback` |
| `ALLOWED_ORIGINS` | `https://tronide.io` (add `,https://<user>.github.io` if used) |
| `OAUTH_RATE_LIMIT` | Optional OAuth callback attempts/client/minute (default `10`) |
| `GIT_PUBLIC_RATE_LIMIT` | Optional anonymous Git proxy requests/client/minute (default `30`) |
| `GIT_AUTH_RATE_LIMIT` | Optional authenticated Git proxy requests/client/minute (default `120`) |

Attach a Deno KV database to the deployment so rate-limit counters are shared
across edge isolates. The service falls back to bounded in-memory counters for
local development or a temporary deployment where KV is unavailable.

## 4. Wire the frontend

Set `clientId` (and `proxyOrigin`, if your project URL differs) in
`apps/remix-ide/src/lib/github-oauth.js`, then connect via
`connectWithGithubOAuth()`. See that file's header for the exact wiring.

## Notes

- The token is posted to **each** `ALLOWED_ORIGINS` entry; the browser only
  delivers a `postMessage` when the opener's origin matches, so this never leaks
  the token to an unintended origin.
- `state` is generated in the browser and checked for the expected 32-hex form;
  the frontend also verifies the exact value (CSRF).
- OAuth callback and Git smart-HTTP traffic are rate-limited before any GitHub
  request. Browser Git requests with a non-allow-listed `Origin` are rejected.
- Local dev: register a second OAuth App with callback
  `http://localhost:8080/callback`, run `deno task dev`, and point the frontend
  `proxyOrigin` at `http://localhost:8000`.
