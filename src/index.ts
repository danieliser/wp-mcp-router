#!/usr/bin/env node
/**
 * wp-mcp-router entry point.
 *
 *   wp-mcp-router            → start the MCP server on stdio
 *   wp-mcp-router --doctor   → load config, hit every site, report ability counts,
 *                         then exit (no MCP server). Use to verify connectivity.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { Catalog } from "./catalog.js";
import { auditStatus } from "./audit.js";

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
  if (process.argv.includes("--doctor")) {
    process.exit(await runDoctor());
  }

  let config;
  try {
    config = loadConfig().config;
  } catch (err) {
    process.stderr.write(`wp-mcp-router: ${(err as Error).message}\n`);
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
