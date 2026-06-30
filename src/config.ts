/**
 * Site registry + config loading.
 *
 * The registry is the list of WordPress sites this server federates. It carries
 * credentials, so it is NEVER committed — it is resolved at runtime, in priority
 * order, from:
 *
 *   1. WP_MCP_ROUTER_SITES         — inline JSON (whole registry as one env var)
 *   2. WP_MCP_ROUTER_CONFIG        — path to a JSON file
 *   3. ./sites.json           — next to the package (gitignored)
 *   4. ~/.config/wp-mcp-router/sites.json
 *
 * Per-site env fallback is also supported for single-site/dev use:
 *   WP_MCP_ROUTER_DEFAULT_SITE, and the @automattic/mcp-wordpress-remote vars
 *   WP_API_URL / WP_API_USERNAME / WP_API_PASSWORD.
 *
 * Nothing here is CompanyKit-specific: the file path, env var names, and the
 * default endpoint template are all overridable. The package runs standalone.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default REST path mcp-adapter registers its default server at. */
export const DEFAULT_MCP_PATH = "/wp-json/mcp/mcp-adapter-default-server";

export interface SiteConfig {
  /** Stable id used as the `site` argument value, e.g. "main" or "shop". */
  id: string;
  /** Human label for list_sites output. */
  label?: string;
  /** Site base URL, e.g. "https://example.com". */
  url: string;
  /**
   * Full MCP endpoint URL. If omitted, derived as `${url}${DEFAULT_MCP_PATH}`.
   * Set this to target a custom server id / namespace.
   */
  endpoint?: string;
  /** WordPress username for Basic (application-password) auth. */
  username: string;
  /** WordPress application password. Spaces are allowed and preserved. */
  appPassword: string;
  /** Optional freeform tags for search/grouping ("ecommerce", "crm", ...). */
  tags?: string[];
  /** When true, excluded from fan-out unless explicitly targeted. */
  excludeFromFanout?: boolean;
  /**
   * Extra HTTP request headers merged into every call to this site. Use for
   * Cloudflare Access tokens (`CF-Access-Client-Id` / `CF-Access-Client-Secret`),
   * Sucuri allow-list headers, custom WAF tokens, X-Forwarded-* spoofs against
   * local-only origins, etc. Values override the built-in headers on conflict.
   * Per-site to avoid leaking one site's auth header to another.
   */
  customHeaders?: Record<string, string>;
}

export interface FleetConfig {
  sites: SiteConfig[];
  /** id of the site used when a tool call omits `site`. */
  defaultSite?: string;
  /** ms; how long a site's discovered ability catalog is cached. */
  catalogTtlMs: number;
  /** ms; per-tool-call timeout to a site endpoint. */
  requestTimeoutMs: number;
  /**
   * ms; tighter timeout for the `initialize` handshake (MCP clients wait on
   * this at startup, so a slow handshake stalls the whole agent boot).
   */
  initTimeoutMs: number;
}

interface RawConfig {
  sites?: Partial<SiteConfig>[];
  defaultSite?: string;
  catalogTtlMs?: number;
  requestTimeoutMs?: number;
  initTimeoutMs?: number;
}

function endpointFor(site: SiteConfig): string {
  if (site.endpoint && site.endpoint.trim()) return site.endpoint.trim();
  return site.url.replace(/\/+$/, "") + DEFAULT_MCP_PATH;
}

function normalizeSite(raw: Partial<SiteConfig>, index: number): SiteConfig {
  if (!raw.url) throw new Error(`Site #${index} is missing "url".`);
  if (!raw.username) throw new Error(`Site "${raw.id ?? raw.url}" is missing "username".`);
  if (!raw.appPassword) throw new Error(`Site "${raw.id ?? raw.url}" is missing "appPassword".`);
  const id =
    raw.id ??
    new URL(raw.url).hostname.replace(/^www\./, "").replace(/\.[a-z]+$/i, "").replace(/[^a-z0-9]+/gi, "");
  const site: SiteConfig = {
    id,
    label: raw.label ?? id,
    url: raw.url.replace(/\/+$/, ""),
    endpoint: raw.endpoint,
    username: raw.username,
    appPassword: raw.appPassword,
    tags: raw.tags ?? [],
    excludeFromFanout: raw.excludeFromFanout ?? false,
    customHeaders: raw.customHeaders ?? undefined,
  };
  site.endpoint = endpointFor(site);
  return site;
}

function readJsonFile(path: string): RawConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawConfig;
  } catch (err) {
    throw new Error(`Failed to read fleet config at ${path}: ${(err as Error).message}`);
  }
}

function resolveRawConfig(): { raw: RawConfig; source: string } {
  if (process.env.WP_MCP_ROUTER_SITES) {
    try {
      return { raw: JSON.parse(process.env.WP_MCP_ROUTER_SITES) as RawConfig, source: "WP_MCP_ROUTER_SITES env" };
    } catch (err) {
      throw new Error(`WP_MCP_ROUTER_SITES is not valid JSON: ${(err as Error).message}`);
    }
  }

  const candidates = [
    process.env.WP_MCP_ROUTER_CONFIG,
    join(process.cwd(), "sites.json"),
    resolve(__dirname, "..", "sites.json"),
    join(homedir(), ".config", "wp-mcp-router", "sites.json"),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (existsSync(path)) return { raw: readJsonFile(path), source: path };
  }

  // Single-site fallback from the upstream proxy's own env contract.
  if (process.env.WP_API_URL && process.env.WP_API_USERNAME && process.env.WP_API_PASSWORD) {
    const url = new URL(process.env.WP_API_URL);
    return {
      raw: {
        sites: [
          {
            id: process.env.WP_MCP_ROUTER_DEFAULT_SITE ?? url.hostname.replace(/^www\./, "").split(".")[0],
            url: `${url.protocol}//${url.host}`,
            endpoint: process.env.WP_API_URL,
            username: process.env.WP_API_USERNAME,
            appPassword: process.env.WP_API_PASSWORD,
          },
        ],
      },
      source: "WP_API_* env (single-site fallback)",
    };
  }

  throw new Error(
    "No site registry found. Set WP_MCP_ROUTER_SITES (inline JSON), WP_MCP_ROUTER_CONFIG (file path), " +
      "or create ./sites.json. See sites.example.json.",
  );
}

export function loadConfig(): { config: FleetConfig; source: string } {
  const { raw, source } = resolveRawConfig();
  if (!raw.sites || raw.sites.length === 0) {
    throw new Error(`Fleet config from ${source} has no sites.`);
  }

  const sites = raw.sites.map((s, i) => normalizeSite(s, i));
  const ids = new Set<string>();
  for (const s of sites) {
    if (ids.has(s.id)) throw new Error(`Duplicate site id "${s.id}" in ${source}.`);
    ids.add(s.id);
  }

  const defaultSite =
    raw.defaultSite ?? process.env.WP_MCP_ROUTER_DEFAULT_SITE ?? (sites.length === 1 ? sites[0].id : undefined);
  if (defaultSite && !ids.has(defaultSite)) {
    throw new Error(`defaultSite "${defaultSite}" is not a configured site id.`);
  }

  return {
    config: {
      sites,
      defaultSite,
      catalogTtlMs: raw.catalogTtlMs ?? Number(process.env.WP_MCP_ROUTER_CATALOG_TTL_MS ?? 5 * 60_000),
      requestTimeoutMs: raw.requestTimeoutMs ?? Number(process.env.WP_MCP_ROUTER_TIMEOUT_MS ?? 120_000),
      initTimeoutMs: raw.initTimeoutMs ?? Number(process.env.WP_MCP_ROUTER_INIT_TIMEOUT_MS ?? 25_000),
    },
    source,
  };
}
