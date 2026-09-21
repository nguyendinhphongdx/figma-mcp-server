# Rate limits & quota

Everyone on this server shares **one** Figma personal access token, which means one Figma
rate-limit budget. This server does not — and cannot — raise that budget; it only paces how it's
spent so one runaway agent loop doesn't starve everyone else.

## How pacing works

- A **token-bucket governor**, shared across all users, paces every call against the
  `FIGMA_TIER{1,2,3}_RPM` limits configured by your admin.
- **Large responses cost more than small ones.** Figma bills `GET /v1/files` by response size, not
  by request count, so the governor charges a response extra slots for its size. One call that
  pulls a whole file slows down what comes after it, instead of looking as cheap as a small read.
- If Figma answers with `429`, a **circuit breaker** opens for that tier: further calls fail fast
  with a precise "retry in N seconds" instead of hammering Figma and extending the penalty. The
  penalty is written to disk, so restarting the server does not forget it and does not throw a
  fresh request at a limit that is still in force.
- A **per-user sliding-window limit** stops a single user or agent loop from consuming the whole
  team's budget on its own.

## Checking the budget

Call `figma_quota_status` before starting a large job (a full-file export, a batch of node-tree
reads). It's free — it never touches the Figma API — and returns requests used, bytes downloaded,
free slots and any active penalty, per tier.

Admins can see the same numbers, refreshed automatically, in the **Figma quota** panel on the
Admin UI home page — including a banner naming the moment a blocked tier comes back.

## If you get a 429 / "retry in N" error

Wait for the time given. Retrying immediately does not help — it only makes the penalty last
longer for everyone sharing the token. If this happens often, ask your admin to check the
`FIGMA_TIER{1,2,3}_RPM` values against your actual Figma plan (Professional / Organization /
Enterprise have different limits, and View/Collab seats are far lower than Dev/Full seats — see
[Figma's rate limit docs](https://developers.figma.com/docs/rest-api/rate-limits/)).

## Why caching helps

Every tool result is cached and shared: ten teammates asking about the same file cost one Figma
request, not ten. Only pass `refresh: true` when you know the design changed since the last
read — it bypasses the cache and spends real quota.
