# Tools

Every tool result is cached; pass `refresh: true` to force a re-read from Figma. Costs below are
for a cold cache — a cache hit is free and instant.

| Tool | Figma cost (cold cache) | Purpose |
| --- | --- | --- |
| `figma_search_nodes` | free, or expensive with `deep` ⚠️ | Find layers by name; returns ids, type, page and path. |
| `figma_list_frames` | 1 × Tier 1 | Pages and top-level frames/sections/components with ids and sizes. Paged. |
| `figma_get_node_spec` | 1 × Tier 1 (all ids batched) | A frame flattened into CSS declarations and text — what you implement from. |
| `figma_get_node_tree` | 1 × Tier 1 (all ids batched) | Figma's exact structure with raw field values; capped by `maxNodes`. |
| `figma_get_svg` | ⌈n/100⌉ × Tier 1 | SVG source of icons and vectors, inline and ready to paste. |
| `figma_export_frames` | ⌈n/100⌉ × Tier 1 (+ names) | Bulk export to jpg/png/svg/pdf; signed links and a zip. `inline: true` also returns the images. |
| `figma_list_styles` | 1 × Tier 3 | Published styles with node ids. |
| `figma_list_components` | 1 × Tier 3 | Published components (main file only). |
| `figma_get_design_tokens` | 1 × Tier 3 + 1 × Tier 1 per 100 styles | Colours, typography, shadows; optional CSS custom properties. Variables are not included. |
| `figma_get_comments` | 1 × Tier 2 | Comment threads with replies, resolved state and pinned node. |
| `figma_quota_status` | free | Requests used, free slots and active penalties per tier. |

## Picking the right tool

Several tools overlap. Picking wrong costs you round trips, not just quota.

| You want to… | Use | Not |
| --- | --- | --- |
| Find a frame you know the name of | `figma_search_nodes` | `figma_list_frames` — a big file runs to thousands of frames and you would page through all of them |
| See what's in a file you don't know | `figma_list_frames` | — |
| Write code for a screen | `figma_get_node_spec` | `figma_get_node_tree` — see below |
| Inspect Figma's real structure, or a field the spec doesn't emit | `figma_get_node_tree` | — |
| Reproduce an icon | `figma_get_svg` | `figma_export_frames` — that gives a file to download, not markup |
| Look at a frame | `figma_export_frames` with `inline: true` | — |
| Hand images to a designer or a build step | `figma_export_frames` | `inline: true` — the links and zip are the point |

### Why `figma_get_node_spec` and not `figma_get_node_tree`

`figma_get_node_tree` mirrors Figma exactly, which sounds like what you want and usually isn't.
Real files are full of layers that hold nothing — `Data > Margin > Container > Container > TEXT` is
ordinary. So the frame carrying the padding and the background sits three or four levels above its
own text, and every `depth` you pick is wrong in one direction: too shallow and the text is missing,
too deep and you pull back the whole subtree.

`figma_get_node_spec` reads deep by default, drops the layers that only add nesting, and hands back
CSS declarations instead of raw Figma fields:

```json
{
  "id": "1408:9840",
  "name": "Button",
  "type": "FRAME",
  "sizing": { "horizontal": "HUG" },
  "css": {
    "display": "flex", "align-items": "center", "gap": "8px",
    "padding": "8px 16px", "border-radius": "8px", "background": "#2563eb"
  },
  "children": [{ "id": "1408:9843", "type": "TEXT", "text": "Tạo vai trò tùy chỉnh",
    "css": { "color": "#ffffff", "font-family": "Inter", "font-weight": "500", "font-size": "14px" } }]
}
```

Two fields worth knowing:

- **`sizing`** appears when an axis is `FILL` or `HUG`. Those have no CSS equivalent on their own —
  they depend on the parent — so they are reported rather than guessed at as `width: 100%`. Only a
  `FIXED` axis gets a `width` or `height`.
- **`vectorNodes`** lists every vector layer in the result. Pass that list straight to
  `figma_get_svg`; it is the one thing the spec cannot give you.

Use `figma_get_node_tree` when you need something the spec deliberately drops: the exact nesting,
a field with no CSS equivalent, or the ids of the wrapper layers themselves.

### Why `figma_get_svg` exists

The REST API describes a `VECTOR` layer by its bounds, its stroke and its fill — never by its path.
So a node tree tells you an icon is 16×16 and grey, and nothing about its shape. Exporting it
produces the shape, but as a file to download, which does not help if you are writing markup.

`figma_get_svg` returns the source itself, minified, in the tool result. The render URLs are shared
with `figma_export_frames`, so if you exported the same nodes as `svg` first, this call is free.

## A typical flow

1. `figma_search_nodes` for the screen by name — free once anyone has touched the file.
2. `figma_get_node_spec` on that node. One call: layout, colours, type and all the text.
3. `figma_get_svg` on the ids in `vectorNodes` from step 2.
4. `figma_export_frames` with `inline: true` to compare what you built against the design.

That is two Figma requests for a full screen. The same work through `figma_get_node_tree` takes
four or five calls, because each one either truncates the content or drags in layers you discard.

## Notes

- `figma_search_nodes` ignores case **and** Vietnamese diacritics, so `truong ban` finds
  `Trường bắn`. Without `deep: true` it searches the top level of every page and reuses the same
  cached outline as `figma_list_frames` — which is why it is free. Results are ranked by relevance:
  an exact name beats a paragraph that merely contains the words, which matters because Figma names
  every text layer after its own content.
- **`deep: true` is the most expensive call on this server.** It reads the whole file tree in one
  request, and Figma bills `GET /v1/files` by *response size*, not by request count — so "one
  request" is not one request's worth of budget. On a large file a single deep index at depth 6 is
  enough to exhaust the shared Tier-1 budget and block everyone for days. Search shallow first, keep
  `depth` at the default 3, and check `figma_quota_status` before going deeper.
- `figma_list_frames` returns at most 200 nodes by default. `hasMore` tells you there are more;
  raise `limit` or pass `offset` to keep paging.
- `inline: true` on an export is capped at 5 png/jpg images. When it declines, `inlineSkipped`
  says why — it never silently drops the request.
- `figma_get_design_tokens` does not include Figma Variables — the Variables REST API needs an
  Enterprise plan, so tokens are derived from published styles only.
- `figma_list_styles` / `figma_list_components` read from the file's published library, so they
  need the main file, not a branch.
