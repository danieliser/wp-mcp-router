# wp-mcp-router

[![npm version](https://img.shields.io/npm/v/wp-mcp-router.svg)](https://www.npmjs.com/package/wp-mcp-router)
[![CI](https://github.com/danieliser/wp-mcp-router/actions/workflows/ci.yml/badge.svg)](https://github.com/danieliser/wp-mcp-router/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/wp-mcp-router.svg)](./LICENSE)

**One MCP connection for all your WordPress sites.**

wp-mcp-router is an MCP (stdio) server that fronts any number of WordPress sites running the
[Abilities API](https://developer.wordpress.org/news/2026/02/from-abilities-to-ai-agents-introducing-the-wordpress-mcp-adapter/)
via the [`mcp-adapter`](https://github.com/WordPress/mcp-adapter) plugin. Instead of one MCP
server per site, you connect your AI client (Claude Desktop / Claude Code / Cursor / Codex)
once and address each site by name. The router discovers what each site can actually do,
lets you search abilities across all of them, and guards execution — calling an ability on a
site that doesn't have it returns *"not on B; available on A and C"* instead of an opaque error.

## Quick start

```bash
npx wp-mcp-router setup
```

The wizard connects your first site (opens your browser; you approve, WordPress mints a
scoped application password, you paste it back once) and wires the server into your AI
client (auto-detects Claude Desktop / Claude Code / Cursor / Codex). Restart your client
and you're connected.

Prefer the steps individually?

```bash
npx wp-mcp-router add-site example.com   # connect a site (repeat per site)
npx wp-mcp-router install                # add to your AI client's config
```

Add more sites any time with `add-site` — they all live behind the one connection.
`npx wp-mcp-router --doctor` checks connectivity and lists abilities per site.

Each target site needs the [`mcp-adapter`](https://github.com/WordPress/mcp-adapter) plugin
active (it registers the `/wp-json/mcp/…` endpoint the router talks to). `add-site` and
`--doctor` check for it: if it's installed but inactive they offer to activate it, and if
it's missing they walk you through the one-time install (this requires connecting as a user
who can manage plugins). `add-site` also offers
[Block MCP](https://github.com/danieliser/block-mcp/releases/latest), a recommended companion
that registers content abilities (posts, blocks, media, terms) for the router to call.

## Tools

| Tool | Purpose |
| --- | --- |
| `wp_list_sites` | Sites + tags + ability counts + namespace groups. |
| `wp_search_abilities` | Keyword search across sites; results grouped by site. |
| `wp_get_ability` | Input/output schema for one ability on one site. |
| `wp_run` | Execute an ability on **one** site (guarded). |
| `wp_run_across` | Execute the same ability on **many** sites in parallel. |
| `wp_get_content_by_url` | Resolve a URL/path → post, optionally with full content. |

Every site-targeting tool takes a `site` argument; omit it to use the configured `defaultSite`.

## Configuration

The site registry carries credentials, so it is **never committed**. Resolved at runtime, in
priority order:

1. `WP_MCP_ROUTER_SITES` — the whole registry as inline JSON in one env var.
2. `WP_MCP_ROUTER_CONFIG` — path to a JSON file.
3. `./sites.json` next to the package (gitignored).
4. `~/.config/wp-mcp-router/sites.json` (Windows: `%APPDATA%\wp-mcp-router\sites.json`).

See [`sites.example.json`](./sites.example.json). Each site needs a `url`, a `username`, and a
WordPress [Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/)
(`appPassword`):

```jsonc
{
  "defaultSite": "main",
  "sites": [
    { "id": "main", "url": "https://example.com", "username": "agent", "appPassword": "xxxx xxxx …", "tags": ["ecommerce"] }
  ]
}
```

Useful per-site / global options:

- `endpoint` — override the MCP endpoint (default `<url>/wp-json/mcp/mcp-adapter-default-server`).
- `customHeaders` — extra headers merged into every request (Cloudflare Access service
  tokens, WAF allow-list headers, etc.).
- `requestTimeoutMs` (default 120000) / `initTimeoutMs` (default 25000) — call and
  handshake timeouts; also settable via `WP_MCP_ROUTER_TIMEOUT_MS` / `WP_MCP_ROUTER_INIT_TIMEOUT_MS`.

## Security

Auth is per-site WordPress Application Passwords (Basic auth over HTTPS) — scoped, revocable,
never your real login; rotate by deleting and re-minting the app password. Credentials live
only in the gitignored registry or env vars, never in the repo or the npm package. Every
routed call is written to a local audit log (`~/.local/state/wp-mcp-router/audit.jsonl`,
Windows: `%LOCALAPPDATA%\wp-mcp-router\audit.jsonl`; args redacted, owner-only permissions;
`WP_MCP_ROUTER_AUDIT=off` disables it, `WP_MCP_ROUTER_AUDIT_FILE` relocates it).

**Recommendation:** connect each site as a dedicated limited-role user — enough to edit
content, not enough to execute code or manage users — so a leaked credential has a small
blast radius.

## License

GPL-2.0-or-later.
