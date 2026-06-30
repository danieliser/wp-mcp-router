/**
 * Session-aware JSON-RPC client for one mcp-adapter site.
 *
 * The mcp-adapter "Streamable HTTP" transport is session-stateful (verified
 * against live sites running mcp-adapter):
 *
 *   1. POST `initialize`  → response carries an `Mcp-Session-Id` header.
 *   2. POST `notifications/initialized` with that header.
 *   3. Every subsequent `tools/list` / `tools/call` MUST echo the header,
 *      else the server returns -32600 "Missing Mcp-Session-Id header".
 *
 * Responses may come back as plain JSON or as a single SSE `data:` frame
 * depending on negotiated Accept; both are handled.
 *
 * Sessions are established lazily and reused. On a session error (expired id)
 * the client re-initializes once and retries.
 */

import type { SiteConfig } from "./config.js";

const PROTOCOL_VERSION = "2025-06-18";

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

interface Session {
  id: string | null;
  initializing: Promise<void> | null;
}

export class WpClient {
  private session: Session = { id: null, initializing: null };
  private nextId = 1;

  constructor(
    public readonly site: SiteConfig,
    private readonly timeoutMs: number,
  ) {}

  private async rawPost(
    payload: unknown,
    opts: { withSession: boolean } = { withSession: true },
  ): Promise<{ headers: Headers; body: any; status: number }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: basicAuth(this.site),
    };
    if (opts.withSession && this.session.id) {
      headers["Mcp-Session-Id"] = this.session.id;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.site.endpoint!, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(`[${this.site.id}] request failed: ${(err as Error).message}`);
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
        { withSession: false },
      );
      if (initRes.body?.error) throw new WpRpcError(this.site.id, initRes.body.error);

      const sid = initRes.headers.get("mcp-session-id");
      this.session.id = sid; // may be null for stateless servers; that's fine.

      // Acknowledge initialization (notification → no response expected).
      await this.rawPost({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();

    try {
      await this.session.initializing;
    } finally {
      this.session.initializing = null;
    }
  }

  /** Issue a JSON-RPC request, re-initializing once on a session error. */
  async call<T = any>(method: string, params: unknown = {}): Promise<T> {
    await this.ensureSession();
    const send = () =>
      this.rawPost({ jsonrpc: "2.0", id: this.nextId++, method, params });

    let res = await send();
    if (res.body?.error) {
      const code = res.body.error.code;
      const msg = String(res.body.error.message ?? "");
      const sessionLost = code === -32600 && /session/i.test(msg);
      if (sessionLost) {
        this.session.id = null;
        await this.ensureSession();
        res = await send();
      }
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
