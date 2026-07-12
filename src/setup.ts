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

  let cred: AuthResult;
  try {
    cred = await authorizeApplicationPassword(siteUrl);
  } catch (err) {
    log(`\n✗ ${(err as Error).message}`);
    log("  Tip: the site must be WordPress 5.6+ with Application Passwords enabled");
    log("  (on by default over HTTPS).");
    return 1;
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

  log(`\nDone. Run \`wp-mcp-router --doctor\` to see everything, or`);
  log(`\`wp-mcp-router install\` to wire it into Claude / Cursor.`);
  return 0;
}

/* -------------------------------------------------------------- install -- */

interface ClientTarget {
  name: string;
  path: string;
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
    });
  } else if (p === "win32") {
    targets.push({
      name: "Claude Desktop",
      path: join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json"),
    });
  } else {
    targets.push({
      name: "Claude Desktop",
      path: join(home, ".config", "Claude", "claude_desktop_config.json"),
    });
  }

  // Claude Code (project-agnostic user config)
  targets.push({ name: "Claude Code", path: join(home, ".claude.json") });

  // Cursor
  targets.push({ name: "Cursor", path: join(home, ".cursor", "mcp.json") });

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
        ? `No known client matches "${which}". Options: Claude Desktop, Claude Code, Cursor.`
        : "No MCP client config found. Pass one explicitly: wp-mcp-router install \"Claude Desktop\"",
    );
    // Still print a copy-paste snippet so the user isn't stuck.
    printManualSnippet(registryPath, entry);
    return 1;
  }

  let wrote = 0;
  for (const t of targets) {
    try {
      let cfg: any = {};
      if (existsSync(t.path)) {
        cfg = JSON.parse(readFileSync(t.path, "utf8") || "{}");
      } else {
        mkdirSync(dirname(t.path), { recursive: true });
      }
      cfg.mcpServers = cfg.mcpServers ?? {};
      const existed = !!cfg.mcpServers["wp-mcp-router"];
      cfg.mcpServers["wp-mcp-router"] = entry;

      // Back up before overwriting an existing config.
      if (existsSync(t.path)) {
        writeFileSync(t.path + ".bak", readFileSync(t.path));
      }
      writeFileSync(t.path, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      log(`✓ ${existed ? "Updated" : "Added"} wp-mcp-router in ${t.name} (${t.path})`);
      wrote++;
    } catch (err) {
      log(`✗ ${t.name}: ${(err as Error).message}`);
    }
  }

  if (wrote > 0) {
    log(`\nRestart ${targets.map((t) => t.name).join(" / ")} to load the server.`);
  }
  return wrote > 0 ? 0 : 1;
}

function printManualSnippet(registryPath: string, entry: Record<string, unknown>): void {
  log("\nAdd this to your MCP client's config under \"mcpServers\":\n");
  log(JSON.stringify({ "wp-mcp-router": entry }, null, 2));
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
  log("This links a WordPress site to your AI client in two steps: approve in the");
  log("browser, then wire it in. No manual credential copying.\n");

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
