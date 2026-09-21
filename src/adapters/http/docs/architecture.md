# Architecture

Hexagonal (ports and adapters). Dependencies point inward; `src/app.ts` is the only composition
root.

```text
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
  features/                  one use case per capability (frames, search, nodes, export, library, tokens, comments, quota)
  adapters/
    mcp/                     tool registration and error mapping (McpServer)
    http/                    /mcp, Admin UI + API, signed downloads, zip streaming, limiter
  infra/                     logger, retry with backoff, bounded concurrency
```

## Notable decisions

- **Stateless Streamable HTTP.** Each `POST /mcp` builds a fresh `McpServer` for the authenticated
  principal, so instances can be added behind a load balancer without sticky sessions — see
  **Limitations** below for what is still per-instance.
- **Ports for everything that changes.** `FigmaApi`, `RateLimitGate`, `CachePort`, `ExportStorage`,
  `DownloadLinks` and `Logger` are interfaces; swapping the disk cache for Redis or disk storage
  for S3 touches `app.ts` and one adapter.
- **Errors are values for the model.** Domain errors map to MCP tool results with
  `isError: true` and an actionable message (what failed, when to retry, which scope is missing)
  rather than protocol errors.

## Limitations

Read these before running more than one instance.

- **The governor's state is per-process and in memory.** After a restart it forgets an active
  `429` penalty and starts with a full burst, and two instances would each pace against the full
  budget. Run a single instance, or replace `TokenBucketGovernor` with a Redis-backed
  `RateLimitGate` (the port is small).
- **Cache, exports and `admin.json`** (Figma token, users, admin account) **are on local disk**, and
  admin sessions are in memory. With several instances, put `DATA_DIR` on shared storage and
  expect to log into the Admin UI separately on each instance.
- **Figma Variables are not exposed** — the Variables REST API needs an Enterprise plan.
- **MCP SDK v1.x is pinned.** Moving to v2 is a contained change in `src/adapters`.
