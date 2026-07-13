/**
 * Required/companion plugin detection and remediation over the WP REST API.
 *
 * The router is useless against a site without `mcp-adapter`, and much less
 * useful without an ability-providing plugin. With an admin-scoped app
 * password we can see plugin state (`GET /wp/v2/plugins`), activate an
 * installed-but-inactive plugin, and install by slug from WordPress.org.
 * Plugins hosted off-org (GitHub releases) cannot be installed over REST —
 * for those we fall back to guided manual install (open the zip + the
 * site's upload page in the browser).
 */

export interface PluginProbe {
  status: "active" | "inactive" | "missing" | "unknown";
  /** Plugin basename (e.g. "mcp-adapter/mcp-adapter") when found. */
  plugin?: string;
  /** Why the probe couldn't answer (permissions, network, …). */
  reason?: string;
}

export interface PluginSpec {
  /** Directory slug the plugin installs under (basename prefix). */
  slug: string;
  /** Human name for prompts. */
  name: string;
  /** Why the user should want it — one line. */
  why: string;
  /** True when installable by slug from WordPress.org over REST. */
  onOrg: boolean;
  /** Fallback download URL for manual install (GitHub release, …). */
  zipUrl?: string;
}

export const REQUIRED_PLUGIN: PluginSpec = {
  slug: "mcp-adapter",
  name: "MCP Adapter",
  why: "registers the /wp-json/mcp/… endpoint the router talks to (required)",
  // Not in the wordpress.org directory yet; we still attempt a slug install
  // first so this starts working automatically the day it lands there.
  onOrg: false,
  zipUrl: "https://github.com/WordPress/mcp-adapter/releases/latest",
};

export const COMPANION_BLOCK_MCP: PluginSpec = {
  slug: "gk-block-mcp",
  name: "Block MCP by GravityKit",
  why: "registers content abilities (create/edit posts, resolve URLs, terms, media) for the router to call (recommended)",
  onOrg: false,
  // Fork with Abilities API registration; PR to upstream GravityKit/block-mcp pending.
  zipUrl: "https://github.com/danieliser/block-mcp/releases/latest",
};

function authHeader(username: string, appPassword: string): string {
  return "Basic " + Buffer.from(`${username}:${appPassword}`).toString("base64");
}

interface RestPlugin {
  plugin?: string;
  status?: string;
}

/** Pure classification, separated for testing. */
export function classifyPlugins(list: RestPlugin[], slug: string): PluginProbe {
  const hit = list.find((p) => (p.plugin ?? "").split("/")[0] === slug);
  if (!hit) return { status: "missing" };
  return {
    status: hit.status === "active" ? "active" : "inactive",
    plugin: hit.plugin,
  };
}

/** Look up one plugin's install/activation state. Never throws. */
export async function probePlugin(
  siteUrl: string,
  username: string,
  appPassword: string,
  slug: string,
  timeoutMs = 15_000,
): Promise<PluginProbe> {
  try {
    const res = await fetch(`${siteUrl}/wp-json/wp/v2/plugins?per_page=100`, {
      headers: { Authorization: authHeader(username, appPassword) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      return { status: "unknown", reason: "this user cannot manage plugins (needs an administrator)" };
    }
    if (!res.ok) {
      return { status: "unknown", reason: `plugins API returned HTTP ${res.status}` };
    }
    const list = (await res.json()) as RestPlugin[];
    if (!Array.isArray(list)) return { status: "unknown", reason: "unexpected plugins API response" };
    return classifyPlugins(list, slug);
  } catch (err) {
    return { status: "unknown", reason: (err as Error).message };
  }
}

/** Activate an installed plugin. Returns an error message, or null on success. */
export async function activatePlugin(
  siteUrl: string,
  username: string,
  appPassword: string,
  plugin: string,
  timeoutMs = 30_000,
): Promise<string | null> {
  try {
    const res = await fetch(`${siteUrl}/wp-json/wp/v2/plugins/${plugin}`, {
      method: "POST",
      headers: {
        Authorization: authHeader(username, appPassword),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "active" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return body.message || `HTTP ${res.status}`;
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Install (and activate) a plugin by wordpress.org slug. Error message or null. */
export async function installFromOrg(
  siteUrl: string,
  username: string,
  appPassword: string,
  slug: string,
  timeoutMs = 120_000,
): Promise<string | null> {
  try {
    const res = await fetch(`${siteUrl}/wp-json/wp/v2/plugins`, {
      method: "POST",
      headers: {
        Authorization: authHeader(username, appPassword),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ slug, status: "active" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return body.message || `HTTP ${res.status}`;
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export interface EnsureIo {
  log(msg?: string): void;
  /** Yes/no prompt; implementations return the default when non-interactive. */
  confirm(question: string, def: boolean): Promise<boolean>;
  /** Open a URL in the user's browser (best effort). */
  openUrl(url: string): void;
}

/**
 * Ensure one plugin is active on a site: activate if inactive, install from
 * WordPress.org when possible, otherwise guide a manual install. Returns
 * true when the plugin is active by the end.
 */
export async function ensurePlugin(
  siteUrl: string,
  username: string,
  appPassword: string,
  spec: PluginSpec,
  io: EnsureIo,
): Promise<boolean> {
  const probe = await probePlugin(siteUrl, username, appPassword, spec.slug);

  switch (probe.status) {
    case "active":
      return true;

    case "unknown":
      io.log(`  Couldn't check ${spec.name}: ${probe.reason}`);
      return false;

    case "inactive": {
      io.log(`  ${spec.name} is installed but not active — it ${spec.why}.`);
      if (!(await io.confirm(`  Activate ${spec.name} now?`, true))) return false;
      const err = await activatePlugin(siteUrl, username, appPassword, probe.plugin!);
      if (err) {
        io.log(`  ✗ Activation failed: ${err}`);
        return false;
      }
      io.log(`  ✓ ${spec.name} activated.`);
      return true;
    }

    case "missing": {
      io.log(`  ${spec.name} is not installed — it ${spec.why}.`);
      if (!(await io.confirm(`  Install ${spec.name} now?`, true))) return false;

      // Try the .org slug first — free upgrade path the day it's listed there.
      const orgErr = await installFromOrg(siteUrl, username, appPassword, spec.slug);
      if (!orgErr) {
        io.log(`  ✓ ${spec.name} installed and activated from WordPress.org.`);
        return true;
      }
      if (spec.onOrg) {
        io.log(`  ✗ Install failed: ${orgErr}`);
        return false;
      }

      // Not on .org: REST can't install from a zip URL, so guide the human.
      io.log(`  ${spec.name} isn't in the WordPress.org directory, so it needs a one-time manual upload:`);
      if (spec.zipUrl) io.log(`    1. Download the zip: ${spec.zipUrl}`);
      io.log(`    2. Upload it at: ${siteUrl}/wp-admin/plugin-install.php?tab=upload`);
      io.log(`    3. Click "Activate", then re-run this command.`);
      if (spec.zipUrl && (await io.confirm("  Open both pages in your browser?", true))) {
        io.openUrl(spec.zipUrl);
        io.openUrl(`${siteUrl}/wp-admin/plugin-install.php?tab=upload`);
      }
      return false;
    }
  }
}
