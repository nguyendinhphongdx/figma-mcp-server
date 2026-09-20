# figma-mcp-server

A self-hosted, **read-only** [MCP](https://modelcontextprotocol.io) server for Figma, built for a team that shares one Figma
seat and one rate-limit budget.

Why not just use the official Figma MCP? This server does not raise Figma's limits (it cannot; it calls the same REST API
with the same per-token quota). What it adds is *control over how the quota is spent*:

- **One shared governor** paces every Figma call, opens a circuit breaker on `429` and answers immediately with a precise
  "retry in N minutes" instead of hammering Figma (which only extends the penalty).
- **Shared read-through cache with single-flight**: ten teammates asking for the same file cost one Figma request.
- **Bulk export done right**: all nodes are batched into as few `GET /v1/images` calls as possible, image URLs are cached
  for 29 days, and the images are stored on the server and returned as signed, expiring links instead of flooding the
  model's context.
- **A `figma_quota_status` tool** so an agent can check the budget before starting a large job.

## Tools

| Tool | Figma cost on a cold cache | Purpose |
| --- | --- | --- |
| `figma_list_frames` | 1 × Tier 1 | Pages and top-level frames/sections/components with ids and sizes. |
| `figma_get_node_tree` | 1 × Tier 1 (all ids batched) | Trimmed layer tree; optional layout, style and text detail; capped by `maxNodes`. |
| `figma_export_frames` | ⌈n/100⌉ × Tier 1 (+ names) | Bulk export to jpg/png/svg/pdf; signed download links and a zip. |
| `figma_list_styles` | 1 × Tier 3 | Published styles with node ids. |
| `figma_list_components` | 1 × Tier 3 | Published components (main file only). |
| `figma_get_design_tokens` | 1 × Tier 3 + 1 × Tier 1 per 100 styles | Colours, typography, shadows; optional CSS custom properties. Variables are not included. |
| `figma_get_comments` | 1 × Tier 2 | Comment threads with replies, resolved state and pinned node. |
| `figma_quota_status` | free | Requests used, free slots and active penalties per tier. |

Every tool result is cached; passing `refresh: true` re-reads from Figma. Tool descriptions state their cost so a model
can plan around it.

## Architecture

Hexagonal (ports and adapters). Dependencies point inward; `src/app.ts` is the only composition root.

```
src/
  cli.ts                     `fmcp` CLI: start/stop/status/logs/init, spawns main.js
  main.ts                    process entry: config, logger, graceful shutdown
  app.ts                     composition root (wires ports to adapters)
  config/                    zod-validated environment -> typed AppConfig
  core/                      framework-free building blocks
    domain/                  errors, Figma URL / node-id parsing
    admin/                   AdminStore (hot-reloadable Figma token + users), admin sessions
    figma/                   FigmaApi port, HTTP adapter, image downloader
    rate-limit/              token-bucket governor + per-tier circuit breaker
    cache/                   memory LRU, disk, layered cache, CachedLoader (single-flight)
    security/                API keys, URL signer, file allow-list, image URL (SSRF) policy
    storage/                 ExportStorage port + local-disk adapter, file naming
  features/                  one use case per capability (frames, nodes, export, library, tokens, comments, quota)
  adapters/
    mcp/                     tool registration and error mapping (McpServer)
    http/                    /mcp, Admin UI + API, signed downloads, zip streaming, limiter
  infra/                     logger, retry with backoff, bounded concurrency
```

Notable decisions:

- **Stateless Streamable HTTP.** Each `POST /mcp` builds a fresh `McpServer` for the authenticated principal, so instances
  can be added behind a load balancer without sticky sessions (see [Limitations](#limitations) for what is still per-instance).
- **Ports for everything that changes.** `FigmaApi`, `RateLimitGate`, `CachePort`, `ExportStorage`, `DownloadLinks` and
  `Logger` are interfaces; swapping the disk cache for Redis or the disk storage for S3 touches `app.ts` and one adapter.
- **Errors are values for the model.** Domain errors map to MCP tool results with `isError: true` and an actionable
  message (what failed, when to retry, which scope is missing) rather than protocol errors.

## Quick start

Requirements: Node ≥ 20.6.

### CLI (recommended)

```bash
npm install -g .                   # or: npm install -g @hanoilab/figma-mcp-server, once published
fmcp init                          # creates ~/.fmcp/.env with a generated signing secret
fmcp start                         # starts in the background, prints the Admin UI URL
```

Open the Admin UI URL it prints (`http://localhost:3000/` by default). The first visit walks you
through creating an admin account, then setting the Figma token and adding users — no `.env`
editing, no restart. `fmcp logs -f` / `fmcp status` / `fmcp stop` manage the running process.

### From source

```bash
pnpm install --frozen-lockfile
cp .env.example .env               # only PUBLIC_BASE_URL and DOWNLOAD_SIGNING_SECRET are required
pnpm dev
```

Then open `PUBLIC_BASE_URL` in a browser to finish setup (Figma token, admin account, users) —
same Admin UI as above. `FIGMA_TOKEN`/`MCP_API_KEYS` in `.env` are optional and only used to seed
that setup for scripted/non-interactive deployments (see [.env.example](.env.example)).

Docker:

```bash
docker build -t figma-mcp-server .
docker run --env-file .env -p 3000:3000 -v figma-mcp-data:/data figma-mcp-server
```

Terminate TLS in front of it (reverse proxy or ingress) and set `PUBLIC_BASE_URL` to the public https origin.

### Figma token

Create a personal access token on a dedicated service account with the scopes `file_content:read`,
`file_comments:read` and `library_content:read`. All MCP users share this identity, so **share only the files you want
exposed with that account**, and set `FIGMA_ALLOWED_FILE_KEYS` as a second fence. Paste it into the Admin UI
(`PUBLIC_BASE_URL/`) — it applies immediately, no restart needed.

### Connect a client

Give each user their own key, created from the Admin UI (or `fmcp key <name>` / `pnpm key:generate -- <name>`
as a scripted alternative). Users keep it in an environment variable and reference it from `.mcp.json`
(see [`examples/mcp.json`](examples/mcp.json)):

```json
{
  "mcpServers": {
    "figma-team": {
      "type": "http",
      "url": "https://figma-mcp.your-company.example/mcp",
      "headers": { "Authorization": "Bearer ${FIGMA_MCP_API_KEY}" }
    }
  }
}
```

## Configuration

All configuration is environment variables, validated at start-up (the process exits with code 78 and a readable list of
problems otherwise). See [`.env.example`](.env.example) for the full list. The important ones:

| Variable | Required | Notes |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | yes | Origin used to build download links and the Admin UI URL. |
| `DOWNLOAD_SIGNING_SECRET` | yes | ≥ 32 characters. Rotating it invalidates outstanding links. `fmcp init` generates it. |
| `FIGMA_TOKEN` | no | Service-account token. Only seeds the Admin UI on first run; set it there instead. Never logged. |
| `MCP_API_KEYS` | no | `name=<sha256 hex>` pairs; only used to seed the Admin UI on first run — add users there instead. |
| `FIGMA_ALLOWED_FILE_KEYS` | no, but recommended | Empty means every file the token can open. |
| `FIGMA_TIER{1,2,3}_RPM` | no | Defaults 10 / 25 / 50, matching a Professional Dev/Full seat. Tune to your plan. |
| `IMAGE_HOST_ALLOWLIST` | no | Default `amazonaws.com,figma.com`. See the note below. |

Figma's limits depend on plan and seat type (Tier 1 is 10 / 15 / 20 requests per minute for Dev/Full seats on
Professional / Organization / Enterprise, and far lower for View/Collab seats). Check the current numbers in
[Figma's rate limit docs](https://developers.figma.com/docs/rest-api/rate-limits/) and set the `*_RPM` values
accordingly. The governor can only keep you under the number you give it.

## Security model

| Threat | Mitigation |
| --- | --- |
| Unauthenticated access | Bearer API key on `/mcp`; keys are 256-bit random, stored as SHA-256, compared in constant time. |
| A leaked env dump | Only key hashes are configured; the Figma token is redacted from logs. |
| One user or agent loop burning the team's quota | Per-user sliding-window limit plus the shared governor. |
| Every user seeing every file the token can open | `FIGMA_ALLOWED_FILE_KEYS`. |
| Cross-site calls from a browser | Requests carrying an `Origin` header are rejected unless listed in `ALLOWED_ORIGINS`. |
| SSRF through image URLs | https only, host suffix allow-list, no credentials, redirects refused, size cap; the Figma token is never sent to the CDN. |
| Guessable / forever-valid download links | HMAC-SHA256 signed, expiring (`DOWNLOAD_URL_TTL_SECONDS`), constant-time verified, generic 403 on any failure. |
| Path traversal | Export ids are 32 hex characters; file names are re-validated on read and sanitised on write. |
| Partial / corrupt files | Atomic writes (`.part` then rename); mid-stream download errors abort the file. |
| Unauthorised admin access | Admin UI/API needs a separate admin login (first-run setup), unrelated to MCP `MCP_API_KEYS`; passwords hashed with scrypt, sessions are random 256-bit cookies (`HttpOnly`, `SameSite=Lax`, `Secure` over https). |
| Admin login brute force | Sliding-window rate limit on `/api/admin/login`. |
| CSRF against the Admin API | Same-origin check (request `Origin`, when present, must match the request's own `Host`). |

Download links are bearer links: anyone who has one can fetch that file until it expires. Treat them like a short-lived
secret.

## Operations

- **Health:** `GET /healthz`.
- **Admin:** `PUBLIC_BASE_URL/` — Figma token, admin account and users. Session TTL is 12 hours.
- **Logs:** JSON on stdout (pino). Each tool call logs tool name, principal, duration and outcome; never tokens or keys.
- **Housekeeping:** every 10 minutes exports older than `EXPORT_RETENTION_HOURS` and expired cache files/admin
  sessions are removed.
- **Shutdown:** `SIGTERM`/`SIGINT` stop accepting connections and drain; a hard exit follows after 10 seconds.
- **Backups:** back up `<DATA_DIR>/admin.json` (Figma token, user key hashes, admin account) — losing it means
  redoing setup. Everything else on disk is a cache or a temporary export and needs no backup.

## Limitations

Read these before running more than one instance.

- **The governor's state is per process and in memory.** After a restart it forgets an active `429` penalty and starts with
  a full burst, and two instances would each pace against the full budget. Run a single instance, or replace
  `TokenBucketGovernor` with a Redis-backed `RateLimitGate` (the port is small).
- **Cache, exports and `admin.json` (Figma token, users, admin account) are on local disk, and admin sessions are
  in memory.** With several instances, put `DATA_DIR` on shared storage (or swap in a different `CachePort` /
  `ExportStorage`) and expect to log into the Admin UI separately on each instance.
- **The image-host allow-list default is unverified.** Figma's image endpoint currently returns pre-signed S3 URLs
  (`*.amazonaws.com`), but that is an implementation detail Figma does not document as a contract. If exports fail with
  "Image host ... is not in IMAGE_HOST_ALLOWLIST", add the host reported in the error after confirming it is legitimate.
- **Figma Variables are not exposed.** The variables REST API needs an Enterprise plan; tokens are derived from published
  styles only.
- **Styles and components** are read from the file's published library and need the main file, not a branch.
- **Comment message text** is not part of Figma's documented comment type; the server reads it defensively.
- **MCP SDK v1.x is pinned.** A v2 of `@modelcontextprotocol/sdk` exists; moving to it is a contained change in
  `src/adapters`.

## Development

```bash
pnpm typecheck
pnpm test            # unit tests + integration tests
pnpm build
```

CI (`.github/workflows/ci.yml`) runs typecheck, test and build on every push/PR.

Releases use [Changesets](https://github.com/changesets/changesets): add one with `pnpm changeset` on any PR
that should ship a release (patch/minor/major + a short description). Merging to `main` runs
`.github/workflows/release.yml`, which bumps the version and `CHANGELOG.md`, commits that straight to `main`,
and publishes to npm — no intermediate PR, fully automatic. A push with no pending changesets is a no-op.
Requires an `NPM_TOKEN` repo secret with publish rights to the `@hanoilab` scope.

Integration tests start the real server and talk to it through the official MCP client against an in-process fake of the
Figma REST API and image CDN (`test/support/fake-figma.ts`), including scripted `429`s, unrenderable nodes and CDN
failures. **They never contact the real Figma API**, so verify a new deployment with `figma_quota_status` and
`figma_list_frames` on a real file before rolling it out.

### Adding a tool

1. Add a method to the `FigmaApi` port if a new endpoint is needed, and implement it in `http-figma-api.ts` with the
   right tier.
2. Write a use case under `src/features/<name>/` that depends only on ports.
3. Wire it in `src/app.ts` and register it in `src/adapters/mcp/tools.ts`, stating the Figma cost in the description.
4. Cover it with a test in `test/integration` (and a unit test for any non-trivial pure logic).
