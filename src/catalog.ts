/**
 * Per-site capability catalog.
 *
 * Why this exists: mcp-adapter's `tools/list` returns the SAME 3 meta-tools on
 * every site (discover-abilities / get-ability-info / execute-ability). The real,
 * DIVERGING capability surface is the set of *abilities* behind discover-abilities
 * — verified live: wppopupmaker exposes 128, contentcontrolplugin 56, a 72-ability
 * gap (FluentCRM, Popup Maker, AI, Akismet, ...).
 *
 * So "does site B have the thing I want to call?" cannot be answered from the MCP
 * tool list. This module discovers each site's ability catalog, caches it with a
 * TTL, lets callers search across the fleet, and — critically — gates execution so
 * a call to an ability a site doesn't have fails fast with a helpful message
 * ("not on B; available on A, C") instead of a confusing remote error.
 */

import type { FleetConfig } from "./config.js";
import { WpClient } from "./wp-client.js";

/** The meta-tool that lists a site's underlying abilities. */
const DISCOVER_TOOL = "mcp-adapter-discover-abilities";
const INFO_TOOL = "mcp-adapter-get-ability-info";
export const EXECUTE_TOOL = "mcp-adapter-execute-ability";

export interface Ability {
  name: string;
  description?: string;
  /** Namespace prefix, e.g. "fluent-crm" from "fluent-crm/list-contacts". */
  group?: string;
}

interface CatalogEntry {
  abilities: Ability[];
  byName: Map<string, Ability>;
  fetchedAt: number;
  error?: string;
}

/** Pull the structured payload out of an MCP tool-call result envelope. */
function extractToolPayload(result: any): any {
  if (result == null) return result;
  // mcp-adapter returns { content: [{ type:"text", text:"<json>" }], ... }
  const content = result.content;
  if (Array.isArray(content)) {
    const textNode = content.find((c) => c?.type === "text" && typeof c.text === "string");
    if (textNode) {
      try {
        return JSON.parse(textNode.text);
      } catch {
        return textNode.text;
      }
    }
  }
  if (result.structuredContent != null) return result.structuredContent;
  return result;
}

/** Normalize whatever shape discover-abilities returns into Ability[]. */
function normalizeAbilities(payload: any): Ability[] {
  let list: any[] = [];
  if (Array.isArray(payload)) list = payload;
  else if (Array.isArray(payload?.abilities)) list = payload.abilities;
  else if (Array.isArray(payload?.tools)) list = payload.tools;
  else if (payload && typeof payload === "object") {
    // map of name -> meta
    list = Object.entries(payload).map(([k, v]) => ({ name: k, ...(v as object) }));
  }

  return list
    .map((item) => {
      const name =
        typeof item === "string"
          ? item
          : item?.name ?? item?.ability ?? item?.id ?? item?.slug;
      if (!name) return null;
      const description =
        typeof item === "object" ? item?.description ?? item?.summary ?? item?.label : undefined;
      const group = String(name).includes("/") ? String(name).split("/")[0] : undefined;
      return { name: String(name), description, group } as Ability;
    })
    .filter((a): a is Ability => a != null);
}

export class Catalog {
  private clients = new Map<string, WpClient>();
  private cache = new Map<string, CatalogEntry>();

  constructor(private readonly config: FleetConfig) {}

  client(siteId: string): WpClient {
    let c = this.clients.get(siteId);
    if (!c) {
      const site = this.config.sites.find((s) => s.id === siteId);
      if (!site) throw new Error(`Unknown site "${siteId}".`);
      c = new WpClient(site, this.config.requestTimeoutMs);
      this.clients.set(siteId, c);
    }
    return c;
  }

  private fresh(entry: CatalogEntry | undefined): entry is CatalogEntry {
    return !!entry && !entry.error && Date.now() - entry.fetchedAt < this.config.catalogTtlMs;
  }

  /** Discover (or return cached) abilities for a site. */
  async getCatalog(siteId: string, force = false): Promise<CatalogEntry> {
    const cached = this.cache.get(siteId);
    if (!force && this.fresh(cached)) return cached;

    try {
      const result = await this.client(siteId).callTool(DISCOVER_TOOL, {});
      const abilities = normalizeAbilities(extractToolPayload(result));
      const entry: CatalogEntry = {
        abilities,
        byName: new Map(abilities.map((a) => [a.name, a])),
        fetchedAt: Date.now(),
      };
      this.cache.set(siteId, entry);
      return entry;
    } catch (err) {
      const entry: CatalogEntry = {
        abilities: [],
        byName: new Map(),
        fetchedAt: Date.now(),
        error: (err as Error).message,
      };
      this.cache.set(siteId, entry);
      return entry;
    }
  }

  async getAbilityInfo(siteId: string, abilityName: string): Promise<any> {
    const result = await this.client(siteId).callTool(INFO_TOOL, { ability_name: abilityName });
    return extractToolPayload(result);
  }

  /** Which configured sites are eligible for fan-out. */
  fanoutSiteIds(explicit?: string[]): string[] {
    if (explicit && explicit.length) return explicit;
    return this.config.sites.filter((s) => !s.excludeFromFanout).map((s) => s.id);
  }

  /**
   * Search abilities across the fleet. Returns, per site, the abilities whose
   * name/description/group match the query (case-insensitive substring; empty
   * query returns everything). This is the "tool search per site" primitive.
   */
  async search(
    query: string,
    siteIds?: string[],
  ): Promise<Array<{ site: string; matches: Ability[]; error?: string }>> {
    const ids = siteIds && siteIds.length ? siteIds : this.config.sites.map((s) => s.id);
    const q = query.trim().toLowerCase();
    const entries = await Promise.all(
      ids.map(async (id) => {
        const cat = await this.getCatalog(id);
        if (cat.error) return { site: id, matches: [], error: cat.error };
        const matches = !q
          ? cat.abilities
          : cat.abilities.filter(
              (a) =>
                a.name.toLowerCase().includes(q) ||
                (a.description?.toLowerCase().includes(q) ?? false) ||
                (a.group?.toLowerCase().includes(q) ?? false),
            );
        return { site: id, matches };
      }),
    );
    return entries;
  }

  /**
   * Validation gate: is `abilityName` available on `siteId`? Returns the list of
   * OTHER sites that DO have it, so the caller can produce a helpful redirect.
   */
  async checkAbility(
    siteId: string,
    abilityName: string,
  ): Promise<{ available: boolean; alsoOn: string[] }> {
    const cat = await this.getCatalog(siteId);
    const available = cat.byName.has(abilityName);
    const alsoOn: string[] = [];
    if (!available) {
      for (const s of this.config.sites) {
        if (s.id === siteId) continue;
        const other = await this.getCatalog(s.id);
        if (other.byName.has(abilityName)) alsoOn.push(s.id);
      }
    }
    return { available, alsoOn };
  }
}
