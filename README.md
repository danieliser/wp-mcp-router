# wp-mcp-router

A multi-site WordPress MCP router. Put several [`mcp-adapter`](https://github.com/WordPress/mcp-adapter)
WordPress sites behind **one** MCP server, with per-site capability discovery, cross-site
search, fan-out, and a guard that stops you from calling an ability on a site that doesn't have it.

It wraps the same WordPress endpoint the official
[`@automattic/mcp-wordpress-remote`](https://www.npmjs.com/package/@automattic/mcp-wordpress-remote)
proxy targets — but where that proxy is one-process-per-site, wp-mcp-router federates many sites and
routes by a `site` argument.

## Why

`mcp-adapter` exposes the same three meta-tools on every site
(`discover-abilities`, `get-ability-info`, `execute-ability`). The *real* capability surface —
the abilities behind `discover-abilities` — **differs per site**. One site has Popup Maker,
FluentCRM, and AI abilities; another only has the block + SEO ones. Calling an ability on the
wrong site is a silent failure waiting to happen.

wp-mcp-router fixes that by making capabilities first-class:

- **Discovery, cached per site** — it knows each site's real ability catalog.
- **Search across the fleet** — "which site has `create-popup`?" before you call.
- **A guard on execution** — calling a missing ability returns *"not on site B; available on A, C"*,
  not an opaque remote error.

## Tools

| Tool | Purpose |
| --- | --- |
| `fleet_list_sites` | Sites + tags + ability counts + namespace groups. The map. |
| `fleet_search_abilities` | Keyword search across sites; results grouped by site. |
| `fleet_get_ability` | Input/output schema for one ability on one site. |
| `wp_run` | Execute an ability on **one** site (guarded). |
| `wp_run_across` | Execute the same ability on **many** sites in parallel (fan-out). |

Every site-targeting tool takes a `site` argument; omit it to use the configured `defaultSite`.

## Configuration

The site registry carries credentials, so it is **never committed**. It is resolved at runtime,
in priority order:

1. `WP_MCP_ROUTER_SITES` — the whole registry as inline JSON in one env var.
2. `WP_MCP_ROUTER_CONFIG` — path to a JSON file.
3. `./sites.json` next to the package (gitignored).
4. `~/.config/wp-mcp-router/sites.json`.

For single-site/dev use it also falls back to the upstream proxy's own env contract
(`WP_API_URL` / `WP_API_USERNAME` / `WP_API_PASSWORD`).

See [`sites.example.json`](./sites.example.json). Each site needs a `url`, a `username`, and a
WordPress **Application Password** (`appPassword`). The MCP endpoint defaults to
`<url>/wp-json/mcp/mcp-adapter-default-server`; override per site with `endpoint`.

```jsonc
{
  "defaultSite": "main",
  "sites": [
    { "id": "main", "url": "https://example.com", "username": "jarvis", "appPassword": "xxxx xxxx …", "tags": ["ecommerce"] }
  ]
}
```

## Usage

```bash
npm install
npm run build

# Verify connectivity to every configured site (no MCP server, just a report):
npm run doctor

# Run as an MCP stdio server:
node dist/index.js
```

### As an MCP server (Claude Code / Claude Desktop)

```jsonc
{
  "mcpServers": {
    "wp-mcp-router": {
      "command": "node",
      "args": ["/path/to/wp-mcp-router/dist/index.js"],
      "env": { "WP_MCP_ROUTER_CONFIG": "/path/to/sites.json" }
    }
  }
}
```

## Requirements

Each target WordPress site needs the [`mcp-adapter`](https://github.com/WordPress/mcp-adapter)
plugin active (it registers the `/wp-json/mcp/…` endpoint), plus whatever ability-providing
plugins you want exposed. A site without `mcp-adapter` returns `rest_no_route` (404) — `doctor`
reports that clearly.

## Security

- Credentials live only in the gitignored registry / env — never in the repo.
- Auth is per-site WordPress Application Passwords (Basic auth over HTTPS). Rotate by deleting
  and re-minting the app password; nothing else changes.
- Scope the agent user's role tightly (e.g. an "admin-minus" role) so a leaked credential can
  edit content and settings but cannot execute code or escalate accounts.

## License

GPL-2.0-or-later.
