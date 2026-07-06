/**
 * Client-side transaction audit log.
 *
 * The router is the chokepoint for every call it brokers, so it's the natural
 * place to record a client-side trail: what tool was invoked, against which
 * site/ability, with what args, how long it took, and whether it succeeded.
 * This is independent of (and cross-checkable against) the site-side Jarvis
 * plugin log — two witnesses, no reconciliation required.
 *
 * Design decisions (per project requirements):
 *   - ON BY DEFAULT. Opt out with WP_MCP_ROUTER_AUDIT=off|false|0.
 *   - Enforced in the request path (every tool call goes through record()),
 *     so no invocation can silently skip the log.
 *   - Args are REDACTED by default (password/token/secret/api_key/… masked).
 *     Set WP_MCP_ROUTER_AUDIT_FULL=1 to log full, unredacted args — do this
 *     only when the log location is secured, since it becomes a secret sink.
 *   - JSON-per-line (JSONL) for trivial appending + downstream parsing.
 *   - Default path ~/.wp-mcp-router/audit.jsonl; override with
 *     WP_MCP_ROUTER_AUDIT_FILE. Failures to write NEVER break a tool call —
 *     auditing observes, it doesn't gate.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Substrings that mark a key as credential-shaped (case-insensitive). */
const SECRET_KEY_PATTERNS = [
  "password",
  "passwd",
  "token",
  "secret",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "credential",
  "private_key",
  "app_password",
  "consumer_secret",
  "consumer_key",
  "nonce",
];

const REDACTED = "«redacted»";
const MAX_FIELD = 20_000; // clip oversized string values so lines stay sane.

function envOff(): boolean {
  const v = (process.env.WP_MCP_ROUTER_AUDIT ?? "").toLowerCase();
  return v === "off" || v === "false" || v === "0" || v === "no";
}

function fullMode(): boolean {
  const v = (process.env.WP_MCP_ROUTER_AUDIT_FULL ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

function auditPath(): string {
  return (
    process.env.WP_MCP_ROUTER_AUDIT_FILE ||
    join(homedir(), ".wp-mcp-router", "audit.jsonl")
  );
}

function looksSecret(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p));
}

/** Deep-redact credential-shaped keys and clip oversized strings. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "«deep»";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = looksSecret(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > MAX_FIELD) {
    return value.slice(0, MAX_FIELD) + `…(+${value.length - MAX_FIELD} chars)`;
  }
  return value;
}

export interface AuditEntry {
  /** Tool the agent invoked (fleet_list_sites, wp_run, …). */
  tool: string;
  /** Target site id, when the call is site-scoped. */
  site?: string;
  /** Ability name, for wp_run / wp_run_across / wp_get_content_by_url. */
  ability?: string;
  /** Raw tool arguments (redacted unless WP_MCP_ROUTER_AUDIT_FULL). */
  args?: unknown;
  /** Wall-clock duration of the call. */
  durationMs: number;
  /** true on success, false when the tool returned an error. */
  ok: boolean;
  /** Error message when !ok. */
  error?: string;
}

/**
 * Append one audit line. Never throws — a broken audit file must not take down
 * the router. `timestamp` is injected by the caller (the workflow/runtime owns
 * the clock) or defaults to an ISO string here.
 */
export function record(entry: AuditEntry): void {
  if (envOff()) return;
  try {
    const line = {
      ts: new Date().toISOString(),
      pid: process.pid,
      ...entry,
      args: entry.args === undefined ? undefined : fullMode() ? entry.args : redact(entry.args),
    };
    const path = auditPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
  } catch {
    /* auditing observes; it never gates the request. */
  }
}

/** For the doctor / status banner: describe the active audit config. */
export function auditStatus(): string {
  if (envOff()) return "audit: off (WP_MCP_ROUTER_AUDIT)";
  return `audit: ${auditPath()}${fullMode() ? " (FULL args — no redaction)" : " (args redacted)"}`;
}
