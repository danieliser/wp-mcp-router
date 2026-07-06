/**
 * Opt-in, lossless response compaction.
 *
 * WordPress REST / ability payloads are verbose — the biggest offender is the
 * `_links` HAL hypermedia block, which appears on most WP objects and is pure
 * noise to an LLM (it never needs to follow a `self` / `collection` link). A
 * single post can carry several KB of `_links` alone.
 *
 * This strips ONLY things that carry no information for an agent:
 *   - `_links`  (HAL hypermedia)
 *   - `_embedded` when `_links` is being removed (it's the expansion of links)
 *
 * It does NOT truncate strings, drop fields, or cap arrays — those are lossy
 * and belong behind a separate explicit flag if we ever add them. This pass is
 * safe to run without the agent losing anything it would act on.
 *
 * NOTE on payoff: Abilities API responses are curated by the plugin author, so
 * they usually DON'T carry `_links` (unlike raw wp/v2 REST objects, where this
 * technique — borrowed from docdyhr/mcp-wordpress — cuts 90%+). On lean ability
 * output the savings are small (single-digit %). The flag earns its keep when
 * an ability wraps a raw REST object or an author includes hypermedia. Lossless
 * and cheap either way, so it's safe to leave available.
 *
 * mcp-adapter wraps ability output as `{ content: [{ type:"text", text:"<json>" }] }`.
 * We parse that inner JSON, compact it, and re-serialize so the savings actually
 * reach the wire, then hand the compacted envelope back.
 */

/** Keys removed everywhere they appear (recursively). Lossless for an LLM. */
const STRIP_KEYS = new Set(["_links", "_embedded"]);

/** Recursively drop STRIP_KEYS. Returns a new structure; input is untouched. */
function stripKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripKeys);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_KEYS.has(k)) continue;
      out[k] = stripKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Compact an mcp-adapter tool-call result envelope in place-safe fashion.
 * Walks `content[].text` (JSON string) and `structuredContent`, stripping HAL
 * noise. Falls back to a plain deep-strip for non-envelope shapes.
 *
 * Returns `{ result, bytesBefore, bytesAfter }` so the caller can report the
 * savings (useful signal, and proves the flag did something).
 */
export function compactResult(result: any): { result: any; bytesBefore: number; bytesAfter: number } {
  const before = safeSize(result);

  if (result && typeof result === "object" && Array.isArray(result.content)) {
    const content = result.content.map((node: any) => {
      if (node?.type === "text" && typeof node.text === "string") {
        try {
          const parsed = JSON.parse(node.text);
          return { ...node, text: JSON.stringify(stripKeys(parsed)) };
        } catch {
          return node; // not JSON — leave text as-is (lossless).
        }
      }
      return node;
    });
    const out: any = { ...result, content };
    if (out.structuredContent != null) out.structuredContent = stripKeys(out.structuredContent);
    return { result: out, bytesBefore: before, bytesAfter: safeSize(out) };
  }

  const stripped = stripKeys(result);
  return { result: stripped, bytesBefore: before, bytesAfter: safeSize(stripped) };
}

function safeSize(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}
