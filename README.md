# wp-mcp-router

[![npm version](https://img.shields.io/npm/v/wp-mcp-router.svg)](https://www.npmjs.com/package/wp-mcp-router)
[![CI](https://github.com/danieliser/wp-mcp-router/actions/workflows/ci.yml/badge.svg)](https://github.com/danieliser/wp-mcp-router/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/wp-mcp-router.svg)](https://www.npmjs.com/package/wp-mcp-router)
[![license](https://img.shields.io/npm/l/wp-mcp-router.svg)](./LICENSE)

**One MCP connection for a whole fleet of WordPress sites — routing to any plugin's abilities, on any site, by name.**

Connect once in Claude / Cursor / any MCP client and address your sites the way you already do on
the command line: `ssh wppopupmaker`, `wp @wppopupmaker …` → `wp_run({ site: "wppopupmaker", … })`.
wp-mcp-router discovers what each site can actually do (via the WordPress
[Abilities API](https://developer.wordpress.org/news/2026/02/from-abilities-to-ai-agents-introducing-the-wordpress-mcp-adapter/)
+ [`mcp-adapter`](https://github.com/WordPress/mcp-adapter)), lets you search across all of them, runs
abilities on one site or fans out across many, and **stops you from calling a tool on a site that
doesn't have it** — turning a confusing remote error into *"not on B; available on A and C."*

## Quick start

Two commands. No hunting through wp-admin for credentials, no editing JSON by hand.

```bash
# 1. Connect a WordPress site. Opens your browser; you click "Approve" and
#    WordPress mints a scoped, revocable application password for you.
npx wp-mcp-router add-site example.com

# 2. Wire it into your AI client (auto-detects Claude Desktop / Claude Code / Cursor / Codex).
npx wp-mcp-router install
```

Restart your client and you're connected. Add more sites any time with
`npx wp-mcp-router add-site another-site.com` — they all live behind the one connection.

Prefer a guided walk-through? `npx wp-mcp-router setup` does both steps interactively.
Want to check everything? `npx wp-mcp-router --doctor`.

> The credential comes from WordPress core's built-in **Application Passwords authorization
> flow** (WP 5.6+, on by default over HTTPS) — the same "approve in your browser" UX as OAuth,
> no plugin required. You approve in the browser, WordPress shows a scoped, revocable
> application password, and you paste it back once. Scope it tighter by approving as a
> limited-role user (e.g. an "admin-minus" account — see
> [jarvis-agent-role](https://github.com/code-atlantic/jarvis-agent-role)).
>
> Prefer not to copy/paste? `add-site --auto` catches the password via a `http://127.0.0.1`
> localhost callback (spec-valid — WP allows the loopback host over http; no public IP needed,
> since the site only redirects *your* browser to *your* machine). Paste is the default because
> it makes no assumptions about the site.
>
> **Hitting "The URL must be served over a secure connection"?** That's a *site-side* check —
> WordPress's `authorize-application.php` requires `is_ssl()` to be true, and behind a reverse
> proxy / CDN that terminates TLS, `is_ssl()` can be false even though your browser shows HTTPS.
> Trust the forwarded protocol in `wp-config.php`
> (`if ( ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https' ) $_SERVER['HTTPS'] = 'on';`),
> or create the password manually under **Users → Profile → Application Passwords** and paste it.

Each target site also needs the [`mcp-adapter`](https://github.com/WordPress/mcp-adapter) plugin
active (it registers the `/wp-json/mcp/…` endpoint the router talks to).

## Where this fits

The WordPress-MCP space forked along two axes — **what** you talk to (WordPress core `/wp/v2` REST vs
the plugin-driven Abilities API) and **how many** sites (single vs federated):

| | Single site | **Federated (many sites)** |
| --- | --- | --- |
| **Core `/wp/v2` REST** | — | [InstaWP/mcp-wp](https://github.com/InstaWP/mcp-wp), [docdyhr/mcp-wordpress](https://www.npmjs.com/package/mcp-wordpress), [emzimmer/server-wp-mcp](https://github.com/emzimmer/server-wp-mcp) |
| **Abilities API** | [`@automattic/mcp-wordpress-remote`](https://www.npmjs.com/package/@automattic/mcp-wordpress-remote), [Easy MCP AI](https://wordpress.org/plugins/easy-mcp-ai/), [Royal MCP](https://wordpress.org/plugins/royal-mcp/) | **wp-mcp-router** |

The REST-based tools ship a **fixed, hand-authored** tool set — they can't see a plugin's own
abilities (Popup Maker's popups, FluentCRM's contacts, GravityKit's blocks) unless someone codes
support for each. The Abilities-API tools surface whatever a plugin registers — but are
**single-site**, one connection per site, each blind to the others.

wp-mcp-router is the one in the bottom-right cell: **plugin-driven abilities, federated across the
fleet.** If a plugin registers an ability, it appears here automatically — across every site — from
one connection. As the Abilities API ecosystem grows, this surface grows with it, for free.

It builds directly on Automattic's excellent [`mcp-wordpress-remote`](https://www.npmjs.com/package/@automattic/mcp-wordpress-remote)
groundwork — same WordPress endpoint, same session handshake, the same battle-tested error handling
and timeout defaults — but where that proxy is one process per site, this federates many and routes
by a `site` argument.

## Why the guard matters

`mcp-adapter` exposes the same three meta-tools on every site
(`discover-abilities`, `get-ability-info`, `execute-ability`). The *real* capability surface —
the abilities behind `discover-abilities` — **differs per site**. One site has Popup Maker,
FluentCRM, and AI abilities; another only the block + SEO ones. Calling an ability on the
wrong site is a silent failure waiting to happen.

wp-mcp-router makes capabilities first-class:

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

`wp_get_content_by_url` is a URL/path → post resolver (the ergonomic idea is borrowed from
InstaWP's `find_content_by_url`, re-implemented ability-native rather than against `/wp/v2`). It
wraps the site's URL-resolver ability (`gk-block-mcp/resolve-url`), fails with a clear message —
naming sites that *can* resolve URLs — if the target doesn't expose one, and with
`with_content: true` chains `gk-block-mcp/get-post-info` for the resolved post in one call.

### On SQL, and the abilities-native philosophy

There's no built-in `sql_query` tool, on purpose. This router surfaces only what the Abilities API
exposes — it doesn't bolt a bespoke `/wp/v2`-style SQL endpoint onto WordPress the way some
REST-based servers do. Instead, ability-providing plugins own their surface: the companion
[jarvis-agent-role](https://github.com/code-atlantic/jarvis-agent-role) plugin registers a gated,
read-only `jarvis/execute-sql` ability, and it appears here automatically — routed, guarded, and
audited like any other. Any plugin that registers a SQL (or any) ability lights up the same way.

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

## Manual setup (from source, or without the wizard)

If you'd rather not use `add-site` / `install`, wire it up by hand. The MCP client
config `install` writes is just this:

```jsonc
{
  "mcpServers": {
    "wp-mcp-router": {
      "command": "npx",
      "args": ["-y", "wp-mcp-router"],
      "env": { "WP_MCP_ROUTER_CONFIG": "/path/to/sites.json" }
    }
  }
}
```

And the registry (`sites.json`) is the file described under **Configuration** below — copy
`sites.example.json` and fill in each site's `url`, `username`, and an
[Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/).

From a source checkout:

```bash
npm install && npm run build
npm run doctor            # connectivity + ability report, no server
node dist/index.js        # run as an MCP stdio server
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
- The log file is created `0600` and its directory `0700` (owner-only), so it isn't
  world-readable. In `FULL` mode the server also prints a one-time stderr warning.

| Env var | Effect |
| --- | --- |
| `WP_MCP_ROUTER_AUDIT=off` | Disable the audit log entirely. |
| `WP_MCP_ROUTER_AUDIT_FULL=1` | Log **full, unredacted** args. The file becomes a secret sink — it's kept `0600`, but only enable this with a log location you control. |
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
