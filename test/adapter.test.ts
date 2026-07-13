import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPlugins } from "../src/adapter.js";

const plugins = [
  { plugin: "akismet/akismet", status: "active" },
  { plugin: "mcp-adapter/mcp-adapter", status: "active" },
  { plugin: "gk-block-mcp/gk-block-mcp", status: "inactive" },
];

test("classifyPlugins finds an active plugin by slug", () => {
  const p = classifyPlugins(plugins, "mcp-adapter");
  assert.equal(p.status, "active");
  assert.equal(p.plugin, "mcp-adapter/mcp-adapter");
});

test("classifyPlugins reports inactive with basename", () => {
  const p = classifyPlugins(plugins, "gk-block-mcp");
  assert.equal(p.status, "inactive");
  assert.equal(p.plugin, "gk-block-mcp/gk-block-mcp");
});

test("classifyPlugins reports missing when absent", () => {
  assert.equal(classifyPlugins(plugins, "not-installed").status, "missing");
});

test("classifyPlugins matches slug prefix exactly, not substring", () => {
  // "mcp" must not match "mcp-adapter/…"
  assert.equal(classifyPlugins(plugins, "mcp").status, "missing");
});
