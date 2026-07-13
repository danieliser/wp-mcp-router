/**
 * Per-user directories, platform-native.
 *
 * Windows gets the native app-data locations; everywhere else follows the
 * XDG Base Directory spec (honoring the XDG_* overrides). Two distinct
 * dirs on purpose: config is small and user-edited, state (the audit log)
 * is append-only and grows — and config dirs are what dotfile-sync and
 * backup tools sweep, so the log deliberately lives outside them.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const APP = "wp-mcp-router";

/** Config dir: %APPDATA%\wp-mcp-router on Windows, else $XDG_CONFIG_HOME/wp-mcp-router. */
export function userConfigDir(): string {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(base, APP);
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, APP);
}

/** State dir (logs): %LOCALAPPDATA%\wp-mcp-router on Windows, else $XDG_STATE_HOME/wp-mcp-router. */
export function userStateDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, APP);
  }
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, APP);
}
