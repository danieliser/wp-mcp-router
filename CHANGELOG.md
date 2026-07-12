# Changelog

## 0.1.0 — Initial public release

First public release. Multi-site WordPress MCP router: one MCP connection for a
fleet of `mcp-adapter` (Abilities API) sites.

### Tools

- `fleet_list_sites` — the fleet map (sites, tags, ability counts, namespace groups).
- `fleet_search_abilities` — keyword search across sites, grouped by site.
- `fleet_get_ability` — full schema for one ability on one site (cached per (site, ability)).
- `wp_run` — execute an ability on one site, guarded (missing → names the sites that have it).
- `wp_run_across` — run the same ability across many sites in parallel (fan-out).
- `wp_get_content_by_url` — resolve a URL/path to its post, optionally with full content.

### Transport & reliability

- Session-aware JSON-RPC client (`initialize` → `Mcp-Session-Id` → `initialized` → echo header),
  handling both JSON and SSE response framing, with one-shot session-recovery on expiry.
- Split timeouts: tighter `initTimeoutMs` (25s) for the handshake vs `requestTimeoutMs` (120s)
  for tool calls.
- Network errors mapped to actionable messages (DNS / TLS / refused / timeout).
- Per-site `customHeaders` for sites behind Cloudflare Access, Sucuri, or a WAF.

### Observability & efficiency

- Client-side audit log (JSONL), on by default, args redacted by default, `0600`/`0700` perms,
  opt-in `FULL` mode with a stderr warning, and an `=off` switch.
- Opt-in lossless response compaction (`compact: true`) — strips `_links` / `_embedded`.

### Safety

- Registry (credentials) is never committed and never shipped to npm — `files` whitelist +
  `.npmignore` guarantee only `dist/`, docs, and the example config ship.
