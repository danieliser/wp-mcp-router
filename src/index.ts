#!/usr/bin/env node
/**
 * wp-mcp-router entry point.
 *
 *   wp-mcp-router                 → start the MCP server on stdio (default)
 *   wp-mcp-router setup           → guided first-run: connect a site + wire in a client
 *   wp-mcp-router add-site [url]   → connect a WordPress site via the browser
 *                                    (Application Passwords authorize flow)
 *   wp-mcp-router install [client] → inject the server into Claude / Cursor config
 *   wp-mcp-router --doctor         → hit every site, report ability counts, exit
 *   wp-mcp-router --help           → usage
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { Catalog } from "./catalog.js";
import { auditStatus } from "./audit.js";
import { addSite, install, setup } from "./setup.js";

const HELP = `wp-mcp-router — one MCP connection for a fleet of WordPress sites

Usage:
  wp-mcp-router                  Start the MCP server (stdio). This is what your
                                 AI client runs.
  wp-mcp-router setup            Guided setup: connect a site in your browser,
                                 then wire it into Claude / Cursor. Start here.
  wp-mcp-router add-site [url]    Connect one WordPress site. Opens the browser
                                 to approve; no manual credential copying.
  wp-mcp-router install [client] Add wp-mcp-router to an MCP client's config
                                 (Claude Desktop | Claude Code | Cursor).
  wp-mcp-router --doctor         Check connectivity + list abilities per site.
  wp-mcp-router --help           This message.

Config: sites live in a gitignored registry (./sites.json, WP_MCP_ROUTER_CONFIG,
or ~/.config/wp-mcp-router/sites.json). See sites.example.json.
`;

async function runDoctor(): Promise<number> {
  const { config, source } = loadConfig();
  process.stderr.write(`wp-mcp-router doctor — config from ${source}\n`);
  process.stderr.write(`default site: ${config.defaultSite ?? "(none)"}\n`);
  process.stderr.write(`${auditStatus()}\n\n`);
  const catalog = new Catalog(config);
  let failures = 0;
  for (const site of config.sites) {
    process.stderr.write(`• ${site.id} (${site.url})\n`);
    try {
      const cat = await catalog.getCatalog(site.id, true);
      if (cat.error) {
        failures++;
        process.stderr.write(`    ✗ ${cat.error}\n`);
      } else {
        const groups = [...new Set(cat.abilities.map((a) => a.group).filter(Boolean))];
        process.stderr.write(`    ✓ ${cat.abilities.length} abilities — groups: ${groups.join(", ") || "(none)"}\n`);
      }
    } catch (err) {
      failures++;
      process.stderr.write(`    ✗ ${(err as Error).message}\n`);
    }
  }
  process.stderr.write(`\n${failures === 0 ? "All sites reachable." : `${failures} site(s) failed.`}\n`);
  return failures === 0 ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.find((a) => !a.startsWith("-"));

  if (args.includes("--help") || args.includes("-h") || cmd === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.includes("--doctor") || cmd === "doctor") {
    process.exit(await runDoctor());
  }
  if (cmd === "setup") {
    process.exit(await setup());
  }
  if (cmd === "add-site") {
    // The URL (if any) is the first non-flag arg after the command.
    const url = args.filter((a) => !a.startsWith("-"))[1];
    process.exit(await addSite(url));
  }
  if (cmd === "install") {
    const client = args.filter((a) => !a.startsWith("-")).slice(1).join(" ") || undefined;
    process.exit(await install(client));
  }

  // No recognized subcommand → run as the MCP stdio server.
  let config;
  try {
    config = loadConfig().config;
  } catch (err) {
    process.stderr.write(`wp-mcp-router: ${(err as Error).message}\n`);
    process.stderr.write(`\nNo sites configured yet. Run:  wp-mcp-router setup\n`);
    process.exit(1);
  }

  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`wp-mcp-router ready — ${config.sites.length} site(s): ${config.sites.map((s) => s.id).join(", ")}\n`);
}

main().catch((err) => {
  process.stderr.write(`wp-mcp-router fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
