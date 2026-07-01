/**
 * wp-mcp-router MCP server.
 *
 * Exposes a small, stable tool surface that is identical regardless of how many
 * sites are behind it. Every site-targeting tool takes a `site` argument (falling
 * back to the configured default). Discovery tools answer "what can each site do?"
 * so the agent looks up capabilities BEFORE calling, and a guard turns a
 * wrong-site call into a helpful redirect instead of an opaque remote error.
 *
 * Tools:
 *   fleet_list_sites        — sites + tags + ability counts (the map)
 *   fleet_search_abilities  — search abilities across sites (per-site results)
 *   fleet_get_ability       — input/output schema for one ability on one site
 *   wp_run                  — execute an ability on ONE site (guarded)
 *   wp_run_across           — execute the SAME ability on MANY sites (fan-out)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { FleetConfig } from "./config.js";
import { Catalog, EXECUTE_TOOL } from "./catalog.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string, extra?: Record<string, unknown>) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  };
}

export function buildServer(config: FleetConfig): Server {
  const catalog = new Catalog(config);
  const siteIds = config.sites.map((s) => s.id);
  const siteEnum = { type: "string" as const, enum: siteIds, description: "Target site id." };

  const resolveSite = (arg: unknown): { id: string } | { error: string } => {
    const id = (typeof arg === "string" && arg) || config.defaultSite;
    if (!id) return { error: `No site given and no defaultSite configured. Sites: ${siteIds.join(", ")}.` };
    if (!siteIds.includes(id)) return { error: `Unknown site "${id}". Configured: ${siteIds.join(", ")}.` };
    return { id };
  };

  const server = new Server(
    { name: "wp-mcp-router", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "fleet_list_sites",
        description:
          "TIER 1 discovery — the fleet map. Returns each site's id, label, tags, ability count, and namespace GROUPS (e.g. 'popup-maker', 'fluent-crm'). Deliberately compact: no ability names, no schemas. Call this first to see which site is likely to have what you need, then use fleet_search_abilities to drill in.",
        inputSchema: {
          type: "object",
          properties: {
            refresh: { type: "boolean", description: "Force re-discovery of ability catalogs (ignore cache)." },
          },
        },
      },
      {
        name: "fleet_search_abilities",
        description:
          "TIER 2 discovery — drill into abilities. Keyword search across sites' ability catalogs (matches name, description, or namespace). Returns matches grouped by site with names + descriptions but NOT full schemas. Empty query lists everything for the specified sites. Use fleet_get_ability for a specific ability's full schema.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keyword, e.g. 'popup', 'contact', 'create'. Empty = list all." },
            sites: { type: "array", items: { type: "string" }, description: "Limit to these site ids (default: all). Narrow with fleet_list_sites first for large fleets." },
          },
        },
      },
      {
        name: "fleet_get_ability",
        description:
          "TIER 3 discovery — the full input/output schema and description for one ability on one site. Call this before wp_run when you need to know the exact parameters. Result is cached per (site, ability) with the same TTL as the site catalog.",
        inputSchema: {
          type: "object",
          properties: {
            site: siteEnum,
            ability_name: { type: "string", description: "Full ability name, e.g. 'popup-maker/create-popup'." },
          },
          required: ["ability_name"],
        },
      },
      {
        name: "wp_run",
        description:
          "Execute a WordPress ability on a single site. Guarded: if the ability is not available on the target site, returns an error naming the sites that DO have it (no blind cross-site calls).",
        inputSchema: {
          type: "object",
          properties: {
            site: siteEnum,
            ability_name: { type: "string", description: "Full ability name, e.g. 'core/get-site-info'." },
            arguments: { type: "object", description: "Arguments object for the ability (see fleet_get_ability)." },
          },
          required: ["ability_name"],
        },
      },
      {
        name: "wp_run_across",
        description:
          "Execute the SAME ability on MANY sites in parallel (federation/fan-out). Sites that lack the ability are reported as skipped, not failed. Use for fleet-wide reads or coordinated writes.",
        inputSchema: {
          type: "object",
          properties: {
            ability_name: { type: "string", description: "Full ability name to run on each site." },
            arguments: { type: "object", description: "Arguments applied to every site." },
            sites: { type: "array", items: { type: "string" }, description: "Target site ids (default: all not excluded from fan-out)." },
          },
          required: ["ability_name"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "fleet_list_sites": {
          const refresh = args.refresh === true;
          const rows = await Promise.all(
            config.sites.map(async (s) => {
              if (refresh) await catalog.getCatalog(s.id, true);
              const { groups, error, abilityCount } = await catalog.siteGroups(s.id);
              return {
                id: s.id,
                label: s.label,
                url: s.url,
                tags: s.tags,
                default: s.id === config.defaultSite,
                ability_count: abilityCount,
                groups,
                ...(error ? { error } : {}),
              };
            }),
          );
          return ok({
            default_site: config.defaultSite,
            sites: rows,
            hint: "Use fleet_search_abilities({sites:['<id>']}) to see abilities on a specific site, or fleet_search_abilities({query:'…'}) to search across the fleet.",
          });
        }

        case "fleet_search_abilities": {
          const query = typeof args.query === "string" ? args.query : "";
          const sites = Array.isArray(args.sites) ? (args.sites as string[]) : undefined;
          const results = await catalog.search(query, sites);
          return ok({
            query,
            results: results.map((r) => ({
              site: r.site,
              count: r.matches.length,
              ...(r.error ? { error: r.error } : {}),
              abilities: r.matches.map((m) => ({ name: m.name, description: m.description })),
            })),
          });
        }

        case "fleet_get_ability": {
          const site = resolveSite(args.site);
          if ("error" in site) return fail(site.error);
          const abilityName = String(args.ability_name ?? "");
          if (!abilityName) return fail("ability_name is required.");
          const info = await catalog.getAbilityInfo(site.id, abilityName);
          return ok({ site: site.id, ability: abilityName, info });
        }

        case "wp_run": {
          const site = resolveSite(args.site);
          if ("error" in site) return fail(site.error);
          const abilityName = String(args.ability_name ?? "");
          if (!abilityName) return fail("ability_name is required.");

          const check = await catalog.checkAbility(site.id, abilityName);
          if (!check.available) {
            return fail(`Ability "${abilityName}" is not available on site "${site.id}".`, {
              available_on: check.alsoOn,
              hint:
                check.alsoOn.length > 0
                  ? `Re-run with site="${check.alsoOn[0]}", or use fleet_search_abilities to find the right site.`
                  : "No site in the fleet exposes this ability. Check the name with fleet_search_abilities.",
            });
          }

          const result = await catalog
            .client(site.id)
            .callTool(EXECUTE_TOOL, {
              ability_name: abilityName,
              parameters: (args.arguments as object) ?? {},
            });
          return ok({ site: site.id, ability: abilityName, result });
        }

        case "wp_run_across": {
          const abilityName = String(args.ability_name ?? "");
          if (!abilityName) return fail("ability_name is required.");
          const targets = catalog.fanoutSiteIds(Array.isArray(args.sites) ? (args.sites as string[]) : undefined);
          const params = (args.arguments as object) ?? {};

          const outcomes = await Promise.all(
            targets.map(async (id) => {
              try {
                const check = await catalog.checkAbility(id, abilityName);
                if (!check.available) return { site: id, status: "skipped" as const, reason: "ability not available" };
                const result = await catalog.client(id).callTool(EXECUTE_TOOL, {
                  ability_name: abilityName,
                  parameters: params,
                });
                return { site: id, status: "ok" as const, result };
              } catch (err) {
                return { site: id, status: "error" as const, error: (err as Error).message };
              }
            }),
          );
          return ok({
            ability: abilityName,
            summary: {
              ok: outcomes.filter((o) => o.status === "ok").length,
              skipped: outcomes.filter((o) => o.status === "skipped").length,
              error: outcomes.filter((o) => o.status === "error").length,
            },
            outcomes,
          });
        }

        default:
          return fail(`Unknown tool "${name}".`);
      }
    } catch (err) {
      return fail((err as Error).message);
    }
  });

  return server;
}
