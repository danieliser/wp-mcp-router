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
| `wp_get_content_by_url` | Resolve a URL/path → post (id, type, title, status), optionally with full content. One step instead of list-and-filter. |

Every site-targeting tool takes a `site` argument; omit it to use the configured `defaultSite`.

`wp_get_content_by_url` is a convenience wrapper over the site's URL-resolver ability
(`gk-block-mcp/resolve-url`) — it fails with a clear message, naming sites that *can* resolve
URLs, if the target site doesn't expose one. Pass `with_content: true` to also chain
`gk-block-mcp/get-post-info` for the resolved post in the same call.

### Roadmap

- **`wp_sql_query`** (read-only SQL) — deferred until an installed plugin registers a SQL
  ability. Unlike REST-based servers that bolt on a custom `execute_sql_query` endpoint, this
  router only surfaces what the Abilities API exposes, so a SQL tool lights up automatically the
  moment a site registers `…/execute-sql` (or similar) — no dead tool in the meantime.

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

The deprecated [`wordpress-mcp`](https://github.com/Automattic/wordpress-mcp) plugin (which
exposes its endpoint at `/wp-json/wp/v2/wpmcp`) is **not** supported — point at a custom
`endpoint` URL if you have a non-default mcp-adapter server, otherwise install `mcp-adapter`.

## Sites behind a WAF or Cloudflare Access

Add a `customHeaders` object to a site entry. The headers are merged into every request and
override the built-ins on conflict — use them for Cloudflare Access service tokens, Sucuri
allow-list headers, or any other front-edge auth your origin requires:

```jsonc
{
  "id": "protected",
  "url": "https://protected.example.com",
  "username": "jarvis",
  "appPassword": "…",
  "customHeaders": {
    "CF-Access-Client-Id":     "<service-token-id>",
    "CF-Access-Client-Secret": "<service-token-secret>"
  }
}
```

## Timeouts

Two knobs, both in milliseconds:

- `requestTimeoutMs` (default 120 000) — per tool-call timeout
- `initTimeoutMs` (default 25 000) — tighter timeout for the `initialize` handshake.
  Your MCP client waits on this at startup, so a dead site fails fast instead of stalling
  the agent for two minutes.

Override per-fleet in the config file or via `WP_MCP_ROUTER_TIMEOUT_MS` /
`WP_MCP_ROUTER_INIT_TIMEOUT_MS` env vars.

## Errors

Network failures are translated to actionable messages naming the field most likely at fault:

- DNS lookup failure → "DNS lookup failed for …, check the URL for typos"
- Connection refused → "connection refused by …, check the site is up"
- TLS hostname mismatch / expired cert → exact cert problem named
- Timeouts → "timed out talking to …, raise requestTimeoutMs / initTimeoutMs"

JSON-RPC errors from the upstream MCP server pass through with their code + message.

## Not yet supported (PRs welcome)

- **OAuth 2.1 with PKCE / dynamic client registration** — present in
  [`@automattic/mcp-wordpress-remote`](https://www.npmjs.com/package/@automattic/mcp-wordpress-remote);
  we currently only do app-password Basic auth, which is what `mcp-adapter` itself supports
  natively. If your site requires OAuth, use the Automattic proxy in single-site mode for now.
- **JWT auth** — same story, defer to the Automattic proxy.
- **WooCommerce REST consumer key/secret auth** — same story.
- **System HTTP/HTTPS/SOCKS proxy auto-detection** — Node's native `fetch` honors
  `NODE_OPTIONS` and CA env vars but not `HTTPS_PROXY` by default. Set
  `NODE_EXTRA_CA_CERTS` for self-signed CAs; for full proxy support open an issue.

## Audit log

Every routed call is recorded to a client-side JSONL trail — a second, independent
witness to the site-side log. **On by default.**

- One JSON object per line: `ts`, `pid`, `tool`, `site`, `ability`, `args`, `durationMs`,
  `ok`, `error`.
- **Args are redacted by default** — keys matching `password`/`token`/`secret`/`api_key`/… are
  masked. Oversized strings are clipped.
- Enforced in the request path: no tool call can bypass the log. Write failures never break a
  call (auditing observes, it doesn't gate).

| Env var | Effect |
| --- | --- |
| `WP_MCP_ROUTER_AUDIT=off` | Disable the audit log entirely. |
| `WP_MCP_ROUTER_AUDIT_FULL=1` | Log **full, unredacted** args. Only with a secured log location — the file becomes a secret sink. |
| `WP_MCP_ROUTER_AUDIT_FILE=<path>` | Override the log path (default `~/.wp-mcp-router/audit.jsonl`). |

The router log is a *client-side* trail — it sees what the router brokered, not raw SSH / WP-CLI
you run outside it. For a site-side trail that captures every channel converging on the site,
pair it with the [jarvis-agent-role](https://github.com/code-atlantic/jarvis-agent-role) plugin,
which logs ability executions and WP-CLI commands on the WordPress side.

## Compaction

`wp_run` / `wp_run_across` accept `compact: true` to losslessly strip `_links` / `_embedded`
(HAL hypermedia) from results. Abilities API responses are usually already lean, so the savings
are modest — the flag earns its keep when an ability wraps a raw `wp/v2` REST object.

## Security

- Credentials live only in the gitignored registry / env — never in the repo.
- Auth is per-site WordPress Application Passwords (Basic auth over HTTPS). Rotate by deleting
  and re-minting the app password; nothing else changes.
- Scope the agent user's role tightly (e.g. an "admin-minus" role) so a leaked credential can
  edit content and settings but cannot execute code or escalate accounts.

## License

GPL-2.0-or-later.
