import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, writeFile, exists, BaseDirectory } from "@tauri-apps/plugin-fs";
import { load } from "@tauri-apps/plugin-store";
import type { FetchLike } from "@bamboo-ep/core";

/**
 * Everything platform-specific, in one place.
 *
 * `packages/core` deliberately imports no filesystem, no HTTP client and no
 * secret storage - it takes them as arguments. This module is where those
 * arguments come from on the desktop, and it is the only file that would need
 * rewriting to host the same logic somewhere else.
 */

/**
 * BambooHR sends no CORS headers, so the webview's own `fetch` can never reach
 * it. This one is issued from Rust by `tauri-plugin-http` and is therefore not
 * subject to browser origin rules. The hosts it may call are pinned in
 * `src-tauri/capabilities/default.json` - both the modern host and the legacy
 * gateway, since the probe falls back between them.
 */
export const platformFetch: FetchLike = tauriFetch as unknown as FetchLike;

// --- Credentials --------------------------------------------------------------

/**
 * The API key lives in the OS credential store (Windows Credential Manager,
 * macOS Keychain, Linux Secret Service) and never touches a config file.
 */
export const credentialStore = {
  save: (subdomain: string, apiKey: string): Promise<void> =>
    invoke("save_api_key", { subdomain, apiKey }),

  load: (subdomain: string): Promise<string | null> =>
    invoke("load_api_key", { subdomain }),

  remove: (subdomain: string): Promise<void> => invoke("delete_api_key", { subdomain }),
};

// --- Settings -----------------------------------------------------------------

export interface Settings {
  subdomain: string;
  filenameTemplate: string;
  outputDir: string | null;
  includeOrphanFiles: boolean;
  /** Match corrections, keyed by subdomain then fileId, so they survive re-runs. */
  confirmedMatches: Record<string, Record<string, string>>;
}

export const DEFAULT_SETTINGS: Settings = {
  subdomain: "",
  filenameTemplate: "{name} - {completed}",
  outputDir: null,
  includeOrphanFiles: false,
  confirmedMatches: {},
};

const SETTINGS_FILE = "settings.json";
const SETTINGS_KEY = "settings";

/** Non-secret preferences only. The API key never comes near this file. */
export async function loadSettings(): Promise<Settings> {
  try {
    const store = await load(SETTINGS_FILE, { autoSave: true });
    const stored = await store.get<Partial<Settings>>(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  } catch {
    // A corrupt or unreadable settings file must not block the app; defaults
    // are always a valid starting point.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const store = await load(SETTINGS_FILE, { autoSave: true });
  await store.set(SETTINGS_KEY, settings);
  await store.save();
}

// --- Filesystem ---------------------------------------------------------------

export async function chooseOutputDirectory(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose where to save your training records",
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Returns a writer bound to one directory. `core` calls it with a bare
 * filename and never learns the path, which keeps path handling - and the
 * platform separator - out of the portable code.
 */
export function directoryWriter(
  directory: string,
): (filename: string, bytes: Uint8Array) => Promise<void> {
  return async (filename, bytes) => {
    const path = joinPath(directory, filename);
    await writeFile(path, bytes);
  };
}

export async function ensureDirectory(path: string): Promise<void> {
  if (!(await exists(path))) {
    await mkdir(path, { recursive: true });
  }
}

/** Windows accepts forward slashes, so one join works on every platform. */
export function joinPath(directory: string, filename: string): string {
  const trimmed = directory.replace(/[\\/]+$/, "");
  return `${trimmed}/${filename}`;
}

export { BaseDirectory };
