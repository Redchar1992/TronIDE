# tronide-gh-oauth — GitHub OAuth BFF for TronIDE

TronIDE is a static application, so its GitHub credential boundary lives in this
Deno backend-for-frontend (BFF). Deno owns OAuth state and PKCE, exchanges the
code, verifies the GitHub identity, encrypts the access token in KV, and returns
only a short-lived TronIDE session handle to the browser.

The browser uses that opaque session for restricted GitHub REST and Git
smart-HTTP endpoints. A GitHub token is never sent through `postMessage`, web
storage, frontend state, or browser request headers.

The frontend BFF origin is public build configuration:
`TRONIDE_GITHUB_BFF_ORIGIN`. Set it to the team-owned deployment during
cut-over; no source edit is required when the Deno project/domain changes.

See [`BFF_MIGRATION.md`](./BFF_MIGRATION.md) for the architecture, rollout,
rollback, and acceptance criteria.

## 1. GitHub OAuth App

Configure the team-owned OAuth App with:

| Field                      | Value                                  |
| -------------------------- | -------------------------------------- |
| Application name           | `TronIDE`                              |
| Homepage URL               | `https://tronide.io`                   |
| Authorization callback URL | `<REDIRECT_URI>` ending in `/callback` |
| Enable Device Flow         | off                                    |

The OAuth App and the Deno project are separate resources. Create or transfer
the OAuth App and create the Deno project under the organization, then verify
both; transferring the source repository alone changes neither one.

## 2. Deno deployment

Attach a Deno KV database, then deploy `main.ts`:

```sh
deno install -A jsr:@deno/deployctl --global
cd services/github-oauth
deployctl deploy --project=tronide-gh-oauth main.ts
```

A linked repository may deploy the same entry point automatically. The main
TronIDE frontend pipeline does not deploy this service.

## 3. Environment variables

| Variable                 | Required | Description                                            |
| ------------------------ | -------- | ------------------------------------------------------ |
| `GITHUB_CLIENT_ID`       | yes      | Team-owned GitHub OAuth App client id                  |
| `GITHUB_CLIENT_SECRET`   | yes      | OAuth App client secret; Deno only                     |
| `SESSION_ENCRYPTION_KEY` | yes      | Exactly 32 random bytes, base64 encoded                |
| `REDIRECT_URI`           | yes      | Public Deno/team BFF `/callback` URL                   |
| `ALLOWED_ORIGINS`        | yes      | Comma-separated exact TronIDE origins                  |
| `GITHUB_SCOPE`           | no       | Defaults to `gist repo`                                |
| `SESSION_TTL_SECONDS`    | no       | BFF session lifetime; defaults to 8 hours              |
| `OAUTH_RATE_LIMIT`       | no       | OAuth starts/callbacks per client/minute; default `10` |
| `API_RATE_LIMIT`         | no       | Authenticated REST calls/client/minute; default `120`  |
| `GIT_PUBLIC_RATE_LIMIT`  | no       | Anonymous Git calls/client/minute; default `30`        |
| `GIT_AUTH_RATE_LIMIT`    | no       | Authenticated Git calls/client/minute; default `120`   |

Generate the encryption key without printing or committing it to source:

```sh
openssl rand -base64 32
```

Store it only in Deno's secret/environment settings. Sessions fail closed when
KV or the encryption key is unavailable; only rate limiting has an in-memory
fallback.

## 4. Endpoints

| Endpoint            | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `GET /health`       | Reports `mode=bff-v1`                                               |
| `GET /capabilities` | Machine-readable BFF capability probe                               |
| `GET /oauth/start`  | Creates state + PKCE and redirects to GitHub with account selection |
| `GET /callback`     | Consumes state, verifies GitHub, creates encrypted server session   |
| `GET /session`      | Validates and hydrates the current session                          |
| `DELETE /session`   | Revokes the local session and best-effort GitHub token              |
| `/api/*`            | Allow-listed `/user`, repository contents, and gist operations      |
| `/git/*`            | GitHub-only smart-HTTP proxy for isomorphic-git                     |

Authenticated browser calls send `X-TronIDE-Session`; `Authorization` from the
browser is rejected. Sessions are bound to the exact `Origin` that initiated
OAuth.

## 5. Local verification

```sh
cd services/github-oauth
deno task test
deno check main.ts
```

For a full local OAuth flow, create a separate development OAuth App and set its
callback to the local BFF. Never reuse production client secrets in committed
files or test fixtures.
