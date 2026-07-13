/**
 * Zero-friction onboarding.
 *
 * The hardest part of connecting an AI client to WordPress is getting a
 * credential. WordPress core (5.6+) ships an Application Passwords *authorization*
 * flow — the same "click Approve in your browser" UX as OAuth, but built in and
 * requiring no plugin:
 *
 *   1. We open  {site}/wp-admin/authorize-application.php?app_name=…&success_url=…
 *   2. The user logs in (if needed) and clicks "Yes, I approve".
 *   3. WordPress mints a fresh application password and redirects to success_url
 *      with ?user_login=…&password=… (and site_url).
 *   4. We catch that on a tiny localhost callback server, write it into the
 *      registry, and verify it against the live MCP endpoint.
 *
 * No manual "Users → Profile → scroll → create → copy" dance. The credential is
 * scoped, revocable, and never touches the clipboard.
 *
 * `install` then wires the server into the user's MCP client config
 * (Claude Desktop / Claude Code / Cursor) so the whole thing is two commands.
 *
 * Node built-ins only — no new dependencies.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_MCP_PATH, type SiteConfig } from "./config.js";
import { WpClient } from "./wp-client.js";

const APP_NAME = "wp-mcp-router";

/* ---------------------------------------------------------------- helpers -- */

function log(msg = ""): void {
  process.stderr.write(msg + "\n");
}

/**
 * How the user invoked us, so suggested commands are copy-paste runnable.
 * `npx` sets npm_command=exec; a globally-installed bin or `node dist/index.js`
 * does not. When run via npx we prefix suggestions with `npx `.
 */
export function selfCmd(rest = ""): string {
  const viaNpx = process.env.npm_command === "exec" || !!process.env.npm_execpath;
  const base = viaNpx ? "npx wp-mcp-router" : "wp-mcp-router";
  return rest ? `${base} ${rest}` : base;
}

/** Open a URL in the user's default browser, cross-platform, no dependency. */
function openBrowser(url: string): void {
  const cmd =
    platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* fall through — the URL is also printed for manual open. */
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Normalize a user-typed site into a clean base URL. */
function normalizeSiteUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  // Validate it parses.
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

/** Default registry path: ./sites.json if we're in a package dir, else XDG. */
function defaultRegistryPath(): string {
  const cwdCandidate = join(process.cwd(), "sites.json");
  if (existsSync(cwdCandidate)) return cwdCandidate;
  if (process.env.WP_MCP_ROUTER_CONFIG) return process.env.WP_MCP_ROUTER_CONFIG;
  return join(homedir(), ".config", "wp-mcp-router", "sites.json");
}

interface Registry {
  defaultSite?: string;
  catalogTtlMs?: number;
  requestTimeoutMs?: number;
  initTimeoutMs?: number;
  sites: Partial<SiteConfig>[];
  [k: string]: unknown;
}

function readRegistry(path: string): Registry {
  if (!existsSync(path)) return { sites: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw.sites)) raw.sites = [];
    return raw;
  } catch {
    return { sites: [] };
  }
}

function writeRegistry(path: string, reg: Registry): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(reg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
    chmodSync(dirname(path), 0o700);
  } catch {
    /* best effort */
  }
}

function siteIdFrom(url: string): string {
  return new URL(url)
    .hostname.replace(/^www\./, "")
    .replace(/\.[a-z]+$/i, "")
    .replace(/[^a-z0-9]+/gi, "");
}

/* --------------------------------------------- WP app-password auth flow -- */

interface AuthResult {
  user_login: string;
  password: string;
  site_url?: string;
}

/**
 * Run the WordPress Application Passwords authorization flow for one site.
 * Resolves with the minted credential. Rejects if the user denies or times out.
 */
async function authorizeApplicationPassword(siteUrl: string): Promise<AuthResult> {
  return new Promise<AuthResult>((resolve, reject) => {
    const appId = randomUUID();
    let settled = false;

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const params = reqUrl.searchParams;
      // WordPress rejects (user clicked "No") → success=false, no password.
      const user_login = params.get("user_login") ?? "";
      const password = params.get("password") ?? "";
      const site_url = params.get("site_url") ?? undefined;

      const ok = !!user_login && !!password;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        ok
          ? `<!doctype html><meta charset=utf-8><title>Connected</title>
             <body style="font:16px system-ui;max-width:32rem;margin:4rem auto;text-align:center">
             <h2>✅ Connected to WordPress</h2>
             <p><code>${escapeHtml(site_url ?? siteUrl)}</code> is now linked to wp-mcp-router as
             <strong>${escapeHtml(user_login)}</strong>.</p>
             <p>You can close this tab and return to the terminal.</p></body>`
          : `<!doctype html><meta charset=utf-8><title>Not approved</title>
             <body style="font:16px system-ui;max-width:32rem;margin:4rem auto;text-align:center">
             <h2>⚠️ Authorization was not completed</h2>
             <p>No application password was granted. Return to the terminal to retry.</p></body>`,
      );

      cleanup();
      if (ok) resolve({ user_login, password, site_url });
      else reject(new Error("Authorization was denied or returned no credential."));
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for browser authorization (5 min)."));
    }, 5 * 60_000);

    function cleanup(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
    }

    // Bind to an ephemeral localhost port, then build the authorize URL.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const successUrl = `http://127.0.0.1:${port}/callback`;
      const authorizeUrl =
        `${siteUrl}/wp-admin/authorize-application.php` +
        `?app_name=${encodeURIComponent(APP_NAME)}` +
        `&app_id=${appId}` +
        `&success_url=${encodeURIComponent(successUrl)}`;

      log();
      log("Opening your browser to approve the connection…");
      log("If it doesn't open, paste this URL manually:");
      log(`  ${authorizeUrl}`);
      log();
      log("Waiting for approval… (Ctrl-C to cancel)");
      openBrowser(authorizeUrl);
    });

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Manual fallback: open the authorize page WITHOUT a success_url so WordPress
 * shows the generated password on-screen, then have the user paste it back.
 * Works on every WordPress config — no localhost callback, so nothing for a
 * security plugin or a strict success_url check to reject.
 */
async function manualAuthorize(siteUrl: string): Promise<AuthResult> {
  const authorizeUrl =
    `${siteUrl}/wp-admin/authorize-application.php` +
    `?app_name=${encodeURIComponent(APP_NAME)}` +
    `&app_id=${randomUUID()}`;

  log();
  log('Opening the WordPress "Authorize Application" page…');
  log('  1. Log in if prompted, then click "Yes, I approve of this connection".');
  log("  2. WordPress shows a generated application password — copy it.");
  log("  3. Paste it below.");
  log();
  log("If your browser didn't open, visit this URL manually:");
  log(`  ${authorizeUrl}`);
  log();
  openBrowser(authorizeUrl);

  // The approval screen does NOT show which login the password belongs to — it
  // only shows the app name and the password. So we ask. It's the username OR
  // email you sign in with; if unsure, it's on Users → Profile (the "Username"
  // field). The top-right "Howdy, <name>" is a display name, not the login.
  const username = await prompt(
    "Your WordPress login — the username or email you sign in with\n" +
      "(if unsure, see the Username field on Users → Profile): ",
  );
  const password = await prompt(
    "Application password from the approval page (paste it — spaces are fine): ",
  );
  if (!username.trim() || !password.trim()) {
    throw new Error("Login and application password are both required.");
  }
  return { user_login: username.trim(), password: password.trim() };
}

/* ------------------------------------------------------------- add-site -- */

/**
 * `wp-mcp-router add-site [url]` — authorize + persist one site, then verify.
 */
export async function addSite(argUrl?: string): Promise<number> {
  const raw = argUrl || (await prompt("WordPress site URL (e.g. example.com): "));
  if (!raw) {
    log("No site URL given.");
    return 1;
  }

  let siteUrl: string;
  try {
    siteUrl = normalizeSiteUrl(raw);
  } catch {
    log(`"${raw}" is not a valid URL.`);
    return 1;
  }

  log(`\nConnecting to ${siteUrl} …`);

  // Two paths to the same credential:
  //   • Manual (default) — WordPress shows the password after you approve, and
  //     you paste it here. Zero assumptions about the site; the paste always
  //     works, and it's a natural place to drop in a password created any other
  //     way (Users → Profile → Application Passwords) too.
  //   • Automatic (--auto) — a localhost callback catches the password so you
  //     don't paste anything. The http://127.0.0.1 success_url IS spec-valid
  //     (WP allows the 127.0.0.1 / [::1] loopback host over http; `localhost` is
  //     NOT allowed), and needs no public IP — the site just redirects *your*
  //     browser to *your* machine. It fails only if the site's own is_ssl() is
  //     false (e.g. a reverse proxy hides HTTPS from WordPress), in which case
  //     the authorize page errors regardless — so paste is the safe default.
  const auto = process.argv.includes("--auto");

  let cred: AuthResult;
  try {
    cred = auto ? await authorizeApplicationPassword(siteUrl) : await manualAuthorize(siteUrl);
  } catch (err) {
    if (auto) {
      log(`\n⚠️  Automatic authorization didn't complete: ${(err as Error).message}`);
      log("   Falling back to manual approval…");
      try {
        cred = await manualAuthorize(siteUrl);
      } catch (err2) {
        log(`\n✗ ${(err2 as Error).message}`);
        return 1;
      }
    } else {
      log(`\n✗ ${(err as Error).message}`);
      return 1;
    }
  }

  const registryPath = defaultRegistryPath();
  const reg = readRegistry(registryPath);

  const id = siteIdFrom(siteUrl);
  const site: Partial<SiteConfig> = {
    id,
    label: new URL(siteUrl).host,
    url: siteUrl,
    username: cred.user_login,
    appPassword: cred.password,
  };

  // Replace an existing entry for the same id, else append.
  const idx = reg.sites.findIndex((s) => s.id === id || s.url === siteUrl);
  if (idx >= 0) reg.sites[idx] = { ...reg.sites[idx], ...site };
  else reg.sites.push(site);
  if (!reg.defaultSite) reg.defaultSite = id;

  writeRegistry(registryPath, reg);
  log(`\n✓ Saved credentials for "${id}" to ${registryPath}`);

  // Verify against the live endpoint so the user knows it actually works.
  log("Verifying the connection…");
  const client = new WpClient(
    {
      id,
      url: siteUrl,
      endpoint: siteUrl + DEFAULT_MCP_PATH,
      username: cred.user_login,
      appPassword: cred.password,
    } as SiteConfig,
    30_000,
    25_000,
  );
  try {
    await client.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: APP_NAME, version: "0.1.0" },
    });
    log(`✓ ${siteUrl} is reachable and speaking MCP.`);
  } catch (err) {
    log(`⚠️  Saved, but the MCP endpoint check failed: ${(err as Error).message}`);
    log("   The site may need the `mcp-adapter` plugin. Credentials are stored regardless.");
  }

  log(`\nDone. Run  ${selfCmd("--doctor")}  to see everything, or`);
  log(`${selfCmd("install")}  to wire it into Claude / Cursor / Codex.`);
  return 0;
}

/* -------------------------------------------------------------- install -- */

interface ClientTarget {
  name: string;
  path: string;
  /** Config file format. Claude/Cursor use JSON; Codex uses TOML. */
  format: "json" | "toml";
}

/** Known MCP-client config locations per platform. */
function clientTargets(): ClientTarget[] {
  const home = homedir();
  const targets: ClientTarget[] = [];
  const p = platform();

  // Claude Desktop
  if (p === "darwin") {
    targets.push({
      name: "Claude Desktop",
      path: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      format: "json",
    });
  } else if (p === "win32") {
    targets.push({
      name: "Claude Desktop",
      path: join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json"),
      format: "json",
    });
  } else {
    targets.push({
      name: "Claude Desktop",
      path: join(home, ".config", "Claude", "claude_desktop_config.json"),
      format: "json",
    });
  }

  // Claude Code (project-agnostic user config)
  targets.push({ name: "Claude Code", path: join(home, ".claude.json"), format: "json" });

  // Cursor
  targets.push({ name: "Cursor", path: join(home, ".cursor", "mcp.json"), format: "json" });

  // Codex CLI (~/.codex/config.toml, TOML format)
  targets.push({ name: "Codex", path: join(home, ".codex", "config.toml"), format: "toml" });

  return targets;
}

/** The mcpServers entry we inject. Uses the resolved registry path via env. */
function serverEntry(registryPath: string): Record<string, unknown> {
  return {
    command: "npx",
    args: ["-y", "wp-mcp-router"],
    env: { WP_MCP_ROUTER_CONFIG: registryPath },
  };
}

/**
 * `wp-mcp-router install [client]` — inject the mcpServers entry into a detected
 * MCP client config. With no arg, installs into every config file that exists.
 */
export async function install(which?: string): Promise<number> {
  const registryPath = defaultRegistryPath();
  const entry = serverEntry(registryPath);
  const all = clientTargets();
  const targets = which
    ? all.filter((t) => t.name.toLowerCase().includes(which.toLowerCase()))
    : all.filter((t) => existsSync(t.path)); // only existing configs when unspecified.

  if (targets.length === 0) {
    log(
      which
        ? `No known client matches "${which}". Options: Claude Desktop, Claude Code, Cursor, Codex.`
        : `No MCP client config found. Pass one explicitly: ${selfCmd('install "Claude Desktop"')}`,
    );
    // Still print a copy-paste snippet so the user isn't stuck.
    printManualSnippet(registryPath, entry);
    return 1;
  }

  let wrote = 0;
  for (const t of targets) {
    try {
      const done = t.format === "toml"
        ? installToml(t, registryPath)
        : installJson(t, entry);
      if (done) wrote++;
    } catch (err) {
      log(`✗ ${t.name}: ${(err as Error).message}`);
    }
  }

  if (wrote > 0) {
    log(`\nRestart ${targets.map((t) => t.name).join(" / ")} to load the server.`);
  }
  return wrote > 0 ? 0 : 1;
}

/** Merge the server entry into a JSON MCP-client config (Claude / Cursor). */
function installJson(t: ClientTarget, entry: Record<string, unknown>): boolean {
  let cfg: any = {};
  if (existsSync(t.path)) {
    cfg = JSON.parse(readFileSync(t.path, "utf8") || "{}");
  } else {
    mkdirSync(dirname(t.path), { recursive: true });
  }
  cfg.mcpServers = cfg.mcpServers ?? {};
  const existed = !!cfg.mcpServers["wp-mcp-router"];
  cfg.mcpServers["wp-mcp-router"] = entry;

  if (existsSync(t.path)) writeFileSync(t.path + ".bak", readFileSync(t.path));
  writeFileSync(t.path, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  log(`✓ ${existed ? "Updated" : "Added"} wp-mcp-router in ${t.name} (${t.path})`);
  return true;
}

/**
 * Add the server block to a TOML config (Codex). We don't ship a TOML parser
 * (zero-dep), so rather than risk a surgical rewrite we APPEND the block when
 * it's absent, and refuse (with a printed snippet) when it's already present —
 * safer than corrupting a hand-tuned config.tomL.
 */
function installToml(t: ClientTarget, registryPath: string): boolean {
  const block = tomlBlock(registryPath);
  const exists = existsSync(t.path);
  const current = exists ? readFileSync(t.path, "utf8") : "";

  if (/^\s*\[mcp_servers\.wp-mcp-router\]/m.test(current)) {
    log(`• ${t.name} already has [mcp_servers.wp-mcp-router] — leaving it untouched.`);
    log(`  To change it, edit ${t.path}. Desired block:\n`);
    log(block);
    return false;
  }

  if (!exists) mkdirSync(dirname(t.path), { recursive: true });
  else writeFileSync(t.path + ".bak", current);

  const sep = current && !current.endsWith("\n") ? "\n\n" : current ? "\n" : "";
  writeFileSync(t.path, current + sep + block + "\n", "utf8");
  log(`✓ Added wp-mcp-router in ${t.name} (${t.path})`);
  return true;
}

/** The Codex/TOML form of the server entry. */
function tomlBlock(registryPath: string): string {
  // Basic-string escaping for the path (backslashes on Windows, quotes).
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    `[mcp_servers.wp-mcp-router]`,
    `command = "npx"`,
    `args = ["-y", "wp-mcp-router@latest"]`,
    ``,
    `[mcp_servers.wp-mcp-router.env]`,
    `WP_MCP_ROUTER_CONFIG = "${esc(registryPath)}"`,
  ].join("\n");
}

function printManualSnippet(registryPath: string, entry: Record<string, unknown>): void {
  log("\nAdd this to your MCP client's config.\n");
  log("JSON clients (Claude Desktop / Claude Code / Cursor) — under \"mcpServers\":");
  log(JSON.stringify({ "wp-mcp-router": entry }, null, 2));
  log("\nCodex (~/.codex/config.toml):");
  log(tomlBlock(registryPath));
  log(`\n(registry: ${registryPath})`);
}

/* ---------------------------------------------------------------- setup -- */

/**
 * `wp-mcp-router setup` — the one-shot wizard: add a first site, then offer to
 * wire it into the detected MCP clients.
 */
export async function setup(): Promise<number> {
  log("wp-mcp-router setup");
  log("──────────────────");
  log("Links a WordPress site to your AI client in two steps: approve the");
  log("connection in your browser, then wire it in.\n");

  const code = await addSite();
  if (code !== 0) return code;

  const ans = (await prompt("\nWire wp-mcp-router into your MCP clients now? [Y/n] ")).toLowerCase();
  if (ans === "" || ans === "y" || ans === "yes") {
    await install();
  } else {
    printManualSnippet(defaultRegistryPath(), serverEntry(defaultRegistryPath()));
  }
  log("\n✓ Setup complete.");
  return 0;
}
