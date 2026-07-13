# Changelog

## 0.3.0 — Consistent tool naming

- **Breaking:** renamed `fleet_list_sites` → `wp_list_sites`,
  `fleet_search_abilities` → `wp_search_abilities`, and
  `fleet_get_ability` → `wp_get_ability`.
- This aligns every tool under the `wp_` prefix after the `wp-fleet` →
  `wp-mcp-router` package rename.

## 0.2.2 — add-site prompt + npx-aware suggestions

- The credential prompt no longer claims the login is shown on the WordPress
  approval page (it isn't — WP shows only the app name + password). It now asks
  for the username-or-email you sign in with and points to Users → Profile.
  Handles email logins.
- Suggested follow-up commands are prefixed with `npx ` when the tool was
  launched via npx, so they're copy-paste runnable.
- Approval button label matches WP core ("Yes, I approve of this connection").

## 0.2.1 — add-site: manual paste by default; clearer flow

- `install` now also targets **Codex** (`~/.codex/config.toml`) in addition to
  Claude Desktop / Claude Code / Cursor. Codex config is TOML: the block is
  appended if absent (existing servers preserved, `.bak` written), and left
  untouched if `[mcp_servers.wp-mcp-router]` already exists.
- `add-site` now uses the **manual paste** flow by default: approve in the
  browser, WordPress shows the application password, you paste it back. The
  localhost-callback flow is opt-in via `add-site --auto` (and falls back to
  paste if the callback isn't received).
- The `--auto` callback uses `http://127.0.0.1:<port>`, which IS a valid
  WordPress authorize `success_url` (WP core allows the `127.0.0.1` / `[::1]`
  loopback host over http regardless of environment; `localhost` is NOT allowed
  and is rejected). So `--auto` works on standard sites — no public IP needed;
  the site only redirects *your* browser to *your* machine's callback.

### Note: "The URL must be served over a secure connection"

WordPress uses this same error for a *site-level* check too:
`authorize-application.php` requires `is_ssl()` to be true. Behind a reverse
proxy / CDN that terminates TLS and forwards plain HTTP to the origin (common
on managed hosts), `is_ssl()` can be **false** even though your browser shows
HTTPS — and the authorize page then errors regardless of the callback URL. Fix
it on the WordPress side by trusting the forwarded protocol, e.g. in
`wp-config.php`:

```php
if ( isset( $_SERVER['HTTP_X_FORWARDED_PROTO'] ) && 'https' === $_SERVER['HTTP_X_FORWARDED_PROTO'] ) {
    $_SERVER['HTTPS'] = 'on';
}
```

Or create the application password manually (Users → Profile → Application
Passwords) and paste it into `add-site`.

## 0.2.0 — Zero-friction onboarding

Adds a browser-based setup flow so connecting a site takes two commands and no
manual credential handling.

- `wp-mcp-router add-site [url]` — connect a site via WordPress core's Application
  Passwords authorization flow: opens the browser, the user clicks "Approve", and the
  minted credential is caught on a localhost callback, written to the registry (0600),
  and verified against the live MCP endpoint. No manual credential copying.
- `wp-mcp-router install [client]` — auto-detect and inject the server into Claude
  Desktop / Claude Code / Cursor config (merges, backs up to `.bak`, never clobbers).
- `wp-mcp-router setup` — guided one-shot wizard chaining both.
- `--help` with full usage; a "run setup" nudge when started with no config.
- Audit log file/dir hardened to `0600`/`0700` with a one-time `FULL`-mode warning.

Node built-ins only — no new dependencies.

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
