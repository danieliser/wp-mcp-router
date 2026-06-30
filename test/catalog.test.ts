import { test } from "node:test";
import assert from "node:assert/strict";
import { Catalog } from "../src/catalog.ts";
import type { FleetConfig } from "../src/config.ts";

/**
 * Unit tests for the catalog's search + guard logic. We stub the per-site
 * WpClient so no network is touched: each site returns a fixed ability list
 * from the discover-abilities meta-tool.
 */

function makeConfig(): FleetConfig {
  return {
    sites: [
      { id: "alpha", label: "Alpha", url: "https://alpha.test", endpoint: "https://alpha.test/x", username: "u", appPassword: "p", tags: [], excludeFromFanout: false },
      { id: "beta", label: "Beta", url: "https://beta.test", endpoint: "https://beta.test/x", username: "u", appPassword: "p", tags: [], excludeFromFanout: false },
    ],
    defaultSite: "alpha",
    catalogTtlMs: 60_000,
    requestTimeoutMs: 1000,
    initTimeoutMs: 500,
  };
}

const ABILITIES: Record<string, string[]> = {
  alpha: ["core/get-site-info", "popup-maker/create-popup", "fluent-crm/list-contacts"],
  beta: ["core/get-site-info", "rank-math/analyze"],
};

function stub(catalog: Catalog) {
  catalog.client = ((siteId: string) =>
    ({
      callTool: async (tool: string) => {
        if (tool === "mcp-adapter-discover-abilities") {
          return { content: [{ type: "text", text: JSON.stringify({ abilities: ABILITIES[siteId].map((name) => ({ name })) }) }] };
        }
        return { content: [{ type: "text", text: "{}" }] };
      },
    }) as any) as any;
}

test("getCatalog discovers and groups abilities", async () => {
  const c = new Catalog(makeConfig());
  stub(c);
  const cat = await c.getCatalog("alpha");
  assert.equal(cat.abilities.length, 3);
  assert.ok(cat.byName.has("popup-maker/create-popup"));
  assert.equal(cat.abilities.find((a) => a.name === "popup-maker/create-popup")?.group, "popup-maker");
});

test("search matches by name/namespace across sites", async () => {
  const c = new Catalog(makeConfig());
  stub(c);
  const results = await c.search("popup");
  const alpha = results.find((r) => r.site === "alpha")!;
  const beta = results.find((r) => r.site === "beta")!;
  assert.equal(alpha.matches.length, 1);
  assert.equal(beta.matches.length, 0);
});

test("empty query returns all abilities per site", async () => {
  const c = new Catalog(makeConfig());
  stub(c);
  const results = await c.search("");
  assert.equal(results.find((r) => r.site === "alpha")!.matches.length, 3);
});

test("checkAbility guards and reports other sites that have it", async () => {
  const c = new Catalog(makeConfig());
  stub(c);
  // beta lacks popup-maker/create-popup; alpha has it.
  const check = await c.checkAbility("beta", "popup-maker/create-popup");
  assert.equal(check.available, false);
  assert.deepEqual(check.alsoOn, ["alpha"]);

  const shared = await c.checkAbility("beta", "core/get-site-info");
  assert.equal(shared.available, true);
});
