# Getting started

This server speaks [MCP](https://modelcontextprotocol.io) over Streamable HTTP at `{{ORIGIN}}/mcp`.
Every request needs a bearer API key, created for you from the **Users** section on the Home page.

## 1. Get a key

Ask an admin to add a user for you from the Home page, or run it yourself if you have admin access.
The key is shown **once**, right after creation — copy it somewhere safe (a password manager or a
local secrets file). If you lose it, revoke the user and create a new one.

## 2. Add it to your MCP client

Most clients (Claude Desktop, Claude Code, Cursor) read an `.mcp.json` (or equivalent) with an
`mcpServers` block. Point it at this server:

```json
{
  "mcpServers": {
    "figma-team": {
      "type": "http",
      "url": "{{ORIGIN}}/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY_HERE" }
    }
  }
}
```

Prefer an environment variable over a hardcoded key if your client supports interpolation, e.g.
`"Authorization": "Bearer ${FIGMA_MCP_API_KEY}"`.

## 3. Verify it works

Ask your agent to call `figma_quota_status` first — it's free (doesn't touch Figma) and confirms
the key and connection are good before you spend any quota. Then try `figma_list_frames` on a
real file URL.

## 4. Paste Figma URLs, not raw ids

Every tool accepts a full Figma URL (`https://www.figma.com/design/<key>/...?node-id=1-2`) — the
server parses the file key and node id for you. Copy the link off a selected frame and hand it
over as-is; you never need to dig the node id out yourself.

## Where to go next

- **Design to code** — the four calls that turn a Figma screen into markup, and what the API will
  not give you. Start here if that's the job.
- **Tools** — what each call costs and returns, and which of the overlapping ones to reach for.
- **Rate limits & quota** — how the shared budget is paced across your team, and what to do when
  you hit it.
