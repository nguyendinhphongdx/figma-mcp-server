# Design to code

A recipe for turning a Figma screen into working markup, and the parts that will not come out of
the API no matter which tool you call.

## The four calls

Say a designer sends you a link to a screen.

**1. Find it.** Paste the link straight into any tool — the server parses the file key and node id
for you. If you only have a name, search for it:

```text
figma_search_nodes  { file: "<url or key>", query: "vai tro" }
```

Free once anyone on the team has read that file.

If the shallow search finds nothing, `deep: true` reaches nested layers — but read the warning on
the **Tools** page first. It pulls the whole file tree in one request, and Figma bills that endpoint
by response size, so a deep index of a big file can exhaust the shared budget on its own. Keep
`depth` at the default and check `figma_quota_status` before raising it.

**2. Read it.**

```text
figma_get_node_spec  { ids: ["<frame url or id>"] }
```

One request. You get the layout, paints, radii, shadows and type as CSS declarations, plus every
string on the screen — however deep the text layer sits. Note `vectorNodes` in the response.

**3. Get the icons.**

```text
figma_get_svg  { nodes: [ ...vectorNodes from step 2 ] }
```

Paste the returned source into your markup. Skip this and you will end up drawing icons by hand
from their bounding boxes, which is the one part of a design people reliably get wrong.

**4. Check your work.**

```text
figma_export_frames  { nodes: ["<same frame>"], format: "png", scale: 2, inline: true }
```

The rendered image comes back in the result, so you can compare it against what you built instead
of assuming. This is the step most people skip and the one that catches mistakes.

## Reading a spec correctly

**`sizing` is not decoration.** When an axis says `FILL` or `HUG` there is no `width` in the CSS,
because Figma's answer depends on the parent and CSS's does not. Translate it yourself:

| Figma | Usually means |
| --- | --- |
| `HUG` | the element sizes to its content — `width: fit-content`, or nothing at all on a flex item |
| `FILL` | it stretches along the parent's axis — `flex: 1`, or `align-self: stretch` across it |
| `FIXED` | a real number, already emitted as `width` / `height` |

**Fixed sizes are a starting point, not a contract.** A spec for a 1200 px frame gives you a 1200 px
layout. Figma has no breakpoints, so anything responsive is your decision, not the design's — say
so when you hand the work over rather than letting the reviewer assume the design covered it.

**`componentId` marks a real component.** Any node with a `componentId` is an instance of something
in the design system. Run `figma_list_components` once and match the ids: those are the places to
reuse a component you already have instead of writing new markup.

## What the API will not give you

Worth knowing before you promise a pixel-perfect result.

- **Vector paths, except through `figma_get_svg`.** Nothing in a node tree describes an icon's
  shape. If you need the icon, you need that call.
- **Figma Variables.** `figma_get_design_tokens` reads *published styles* only. Modern design
  systems keep tokens in Variables, with light/dark modes that styles cannot express — and the
  Variables REST API needs an Enterprise plan. If the file's colours look thin, this is why.
- **Interaction and state.** Hover, focus, disabled, transitions: not in the REST API. If the file
  has separate frames for them (`Button/Hover`), read those frames; otherwise ask the designer.
- **Intent.** The spec says `gap: 318.01px` when a designer meant "push these apart". Auto-layout
  spacing derived from `SPACE_BETWEEN` is a measurement of the result, not a rule — read
  `justify-content` in the spec and use that instead of the number next to it.

## Spending the shared budget well

Everyone here shares one Figma token and one rate-limit budget.

- **Batch ids into one call.** Every tool that takes a list batches it into as few Figma requests
  as possible. Ten separate calls cost ten times what one call with ten ids costs.
- **Do not pass `refresh: true` out of habit.** It bypasses the cache and spends real quota. Use it
  when you know the design changed since the last read, and not otherwise.
- **Check before a big job.** `figma_quota_status` is free and never touches Figma.
- **Re-exporting is free.** Rendered image URLs are cached for 29 days, so exporting the same
  frames again costs nothing. Exporting a whole page *speculatively* is not free — scope it.

See **Rate limits & quota** for what happens when the budget runs out, and **Tools** for what each
call costs and returns.
