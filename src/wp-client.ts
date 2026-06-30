/**
 * Session-aware JSON-RPC client for one mcp-adapter site.
 *
 * The mcp-adapter "Streamable HTTP" transport is session-stateful (verified
 * against live sites running mcp-adapter):
 *
 *   1. POST `initialize`  → response carries an `Mcp-Session-Id` header.
 *   2. POST `notifications/initialized` with that header.
 *   3. Every subsequent `tools/list` / `tools/call` MUST echo the header.
 *
 * Responses may come back as plain JSON or as a single SSE `data:` frame
 * depending on negotiated Accept; both are handled.
 *
 * Sessions are established lazily and reused. On a real session-expired error
 * (codes -32602 / -32005, message contains "Invalid or expired session" or
 * "Session not found" — constants empirically calibrated by the upstream
 * @automattic/mcp-wordpress-remote proxy against the live adapter) the client
 * refreshes the session and retries the request ONCE.
 *
 * Two distinct timeouts:
 *   - initTimeoutMs (default 25s) bounds the initialize handshake. The MCP
 *     client waits on this at startup, so failing fast matters.
 *   - requestTimeoutMs (default 120s) bounds every other tool call.
 *
 * Network errors are mapped to actionable messages naming the field to fix
 * (DNS, TLS, connection refused, timeout) rather than passed through as opaque
 * Node error codes.
 */

import type { SiteConfig } from "./config.js";

const PROTOCOL_VERSION = "2025-06-18";

/**
 * Session-invalid detection constants — taken verbatim from
 * @automattic/mcp-wordpress-remote so behavior matches what the live
 * mcp-adapter actually returns (not a regex guess on the error message).
 */
const INVALID_SESSION_ERROR_CODES = new Set<number>([-32602, -32005]);
const INVALID_SESSION_ERROR_MESSAGE = "Invalid or expired session";
const SESSION_NOT_FOUND_ERROR_MESSAGE = "Session not found";

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class WpRpcError extends Error {
  constructor(
    public readonly siteId: string,
    public readonly rpc: JsonRpcError,
  ) {
    super(`[${siteId}] ${rpc.message} (code ${rpc.code})`);
    this.name = "WpRpcError";
  }
}

export class WpHttpError extends Error {
  constructor(
    public readonly siteId: string,
    public readonly status: number,
    body: string,
  ) {
    super(`[${siteId}] HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "WpHttpError";
  }
}

function basicAuth(site: SiteConfig): string {
  // App passwords are presented with spaces in the WP UI; the Basic auth
  // scheme accepts them verbatim. WP normalizes internally.
  const token = Buffer.from(`${site.username}:${site.appPassword}`).toString("base64");
  return `Basic ${token}`;
}

/** Parse a response body that is either JSON or a single SSE data frame. */
function parseBody(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  // SSE: pull the last `data:` line.
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) {
    throw new Error(`Unparseable response body: ${trimmed.slice(0, 200)}`);
  }
  return JSON.parse(dataLines[dataLines.length - 1]);
}

/**
 * Detect whether a JSON-RPC error indicates the session is gone (vs any other
 * server-side failure). Matches the upstream proxy's exact heuristic — both
 * codes AND one of three known message substrings must be present, so generic
 * -32602 (Invalid Params) errors don't trigger a spurious session refresh.
 */
function isInvalidSessionError(err: JsonRpcError | undefined | null): boolean {
  if (!err || !INVALID_SESSION_ERROR_CODES.has(err.code)) return false;
  const msg = typeof err.message === "string" ? err.message : "";
  return (
    msg === INVALID_SESSION_ERROR_MESSAGE ||
    msg.includes(SESSION_NOT_FOUND_ERROR_MESSAGE) ||
    msg.includes(INVALID_SESSION_ERROR_MESSAGE)
  );
}

/**
 * Translate a fetch / Node network error into an actionable message naming the
 * config field most likely at fault. Drawn from the upstream proxy's catalog —
 * these are the codes Node actually surfaces in production and the wording
 * that users find useful.
 */
function mapNetworkError(siteId: string, endpoint: string, err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string }; name?: string; message?: string };
  const code = e.code ?? e.cause?.code ?? "";
  const msg = String(e.message ?? "");

  if (e.name === "AbortError" || /timeout|aborted/i.test(msg) || code === "UND_ERR_HEADERS_TIMEOUT") {
    return `[${siteId}] timed out talking to ${endpoint}. Check network/firewall/proxy, or raise requestTimeoutMs / initTimeoutMs.`;
  }
  switch (code) {
    case "CERT_HAS_EXPIRED":
      return `[${siteId}] TLS certificate has expired for ${endpoint}. Renew it on the WordPress host.`;
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return `[${siteId}] TLS certificate hostname mismatch for ${endpoint} (host/SAN mismatch).`;
    case "ECONNREFUSED":
      return `[${siteId}] connection refused by ${endpoint}. Check the site is up and the URL is correct.`;
    case "ENOTFOUND":
      return `[${siteId}] DNS lookup failed for ${endpoint}. Check the URL for typos.`;
    case "ECONNRESET":
      return `[${siteId}] connection reset by ${endpoint}. Could be a server crash, idle-kill, or upstream firewall.`;
    case "EHOSTUNREACH":
      return `[${siteId}] host unreachable: ${endpoint}. Check routing / firewall.`;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return `[${siteId}] TLS certificate verification failed for ${endpoint}. Trust the CA via NODE_EXTRA_CA_CERTS or fix the cert chain.`;
  }
  return `[${siteId}] request failed: ${msg || code || "unknown error"}`;
}

interface Session {
  id: string | null;
  initializing: Promise<void> | null;
}

export class WpClient {
  private session: Session = { id: null, initializing: null };
  private nextId = 1;

  constructor(
    public readonly site: SiteConfig,
    private readonly requestTimeoutMs: number,
    private readonly initTimeoutMs: number,
  ) {}

  /**
   * One HTTP POST to the site's MCP endpoint. The `timeoutMs` override lets
   * the initialize handshake use a tighter budget than regular tool calls —
   * a dead server should fail fast at startup, not after a 2-minute wait.
   */
  private async rawPost(
    payload: unknown,
    opts: { withSession: boolean; timeoutMs?: number } = { withSession: true },
  ): Promise<{ headers: Headers; body: any; status: number }> {
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;

    // Built-in headers first, then merge any site-level custom headers
    // (for Cloudflare Access / Sucuri / WAF tokens / X-Forwarded-* / etc.).
    // Custom headers can override built-ins on purpose: e.g. a WAF setup
    // might need a different Accept or its own Authorization scheme.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: basicAuth(this.site),
      "User-Agent": `wp-mcp-router/0.1.0 (+https://github.com/danieliser/wp-mcp-router)`,
    };
    if (opts.withSession && this.session.id) {
      headers["Mcp-Session-Id"] = this.session.id;
    }
    if (this.site.customHeaders) {
      for (const [k, v] of Object.entries(this.site.customHeaders)) {
        if (typeof v === "string") headers[k] = v;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.site.endpoint!, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(mapNetworkError(this.site.id, this.site.endpoint!, err));
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok && res.status !== 200) {
      // 4xx/5xx without a JSON-RPC error envelope.
      let parsed: any;
      try {
        parsed = parseBody(text);
      } catch {
        throw new WpHttpError(this.site.id, res.status, text);
      }
      if (!parsed?.error) throw new WpHttpError(this.site.id, res.status, text);
      return { headers: res.headers, body: parsed, status: res.status };
    }
    return { headers: res.headers, body: text ? parseBody(text) : undefined, status: res.status };
  }

  /** Establish (or reuse) a session. Idempotent + concurrency-safe. */
  private async ensureSession(): Promise<void> {
    if (this.session.id) return;
    if (this.session.initializing) return this.session.initializing;

    this.session.initializing = (async () => {
      const initRes = await this.rawPost(
        {
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "wp-mcp-router", version: "0.1.0" },
          },
        },
        { withSession: false, timeoutMs: this.initTimeoutMs },
      );
      if (initRes.body?.error) throw new WpRpcError(this.site.id, initRes.body.error);

      const sid = initRes.headers.get("mcp-session-id");
      this.session.id = sid; // may be null for stateless servers; that's fine.

      // Acknowledge initialization (notification → no response expected).
      await this.rawPost(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { withSession: true, timeoutMs: this.initTimeoutMs },
      );
    })();

    try {
      await this.session.initializing;
    } finally {
      this.session.initializing = null;
    }
  }

  /**
   * Issue a JSON-RPC request, refreshing the session and retrying ONCE if the
   * adapter reports an invalid-or-expired session. The retry is deliberately
   * not applied to the initialize call itself (would loop), and not to other
   * error classes (would mask real failures).
   */
  async call<T = any>(method: string, params: unknown = {}): Promise<T> {
    await this.ensureSession();
    const send = () =>
      this.rawPost({ jsonrpc: "2.0", id: this.nextId++, method, params });

    let res = await send();
    if (res.body?.error && method !== "initialize" && isInvalidSessionError(res.body.error)) {
      this.session.id = null;
      await this.ensureSession();
      res = await send();
    }
    if (res.body?.error) throw new WpRpcError(this.site.id, res.body.error);
    return res.body?.result as T;
  }

  /** The 3 meta-tools mcp-adapter exposes (identical across sites). */
  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const result = await this.call<{ tools: any[] }>("tools/list");
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.call("tools/call", { name, arguments: args });
  }
}
