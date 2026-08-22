import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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

// --- The AI provider ----------------------------------------------------------

/**
 * "openai" names a request SHAPE, not a vendor. Ollama, LM Studio, OpenRouter,
 * Together and most proxies speak it, which is how a local model - the option
 * that sends nothing anywhere - is reached.
 */
export type AiProvider = "anthropic" | "openai";

export interface AiSettings {
  provider: AiProvider;
  /** Empty means "use the provider's own default", resolved on use. */
  baseUrl: string;
  model: string;
}

export const AI_DEFAULTS: Readonly<Record<AiProvider, { baseUrl: string; model: string }>> = {
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-opus-5" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
};

/**
 * The provider key is held in the OS credential store and is never returned to
 * the web layer - `has` answers whether one exists, and that is the only
 * question this side of the app needs answered. The request that uses it is
 * built in Rust, so the secret goes from the keychain to the wire without ever
 * being a JavaScript string.
 */
export const aiKeyStore = {
  save: (provider: AiProvider, apiKey: string): Promise<void> =>
    invoke("save_ai_key", { provider, apiKey }),

  has: (provider: AiProvider): Promise<boolean> => invoke("has_ai_key", { provider }),

  remove: (provider: AiProvider): Promise<void> => invoke("delete_ai_key", { provider }),
};

/**
 * Send one page image to the model. Returns the model's answer as raw text;
 * making sense of it is `packages/core`'s job, so the prompt, the schema and
 * the parser stay together where they can be tested.
 */
export function aiExtract(args: {
  settings: AiSettings;
  prompt: string;
  schema: unknown;
  imageBase64: string;
  imageMime: string;
}): Promise<string> {
  const defaults = AI_DEFAULTS[args.settings.provider];
  return invoke("ai_extract", {
    provider: args.settings.provider,
    baseUrl: args.settings.baseUrl.trim() || defaults.baseUrl,
    model: args.settings.model.trim() || defaults.model,
    prompt: args.prompt,
    schema: args.schema,
    imageBase64: args.imageBase64,
    imageMime: args.imageMime,
  });
}

// --- Settings -----------------------------------------------------------------

export interface Settings {
  subdomain: string;
  filenameTemplate: string;
  outputDir: string | null;
  includeOrphanFiles: boolean;
  /** Match corrections, keyed by subdomain then fileId, so they survive re-runs. */
  confirmedMatches: Record<string, Record<string, string>>;
  /**
   * Which model to use if the user asks for a document check. Non-secret by
   * construction: the key itself lives in the credential store, so this file
   * records only where requests would go, never what authorises them.
   */
  ai: AiSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  subdomain: "",
  filenameTemplate: "{name} - {completed}",
  outputDir: null,
  includeOrphanFiles: false,
  confirmedMatches: {},
  ai: { provider: "anthropic", baseUrl: "", model: "" },
};

const SETTINGS_FILE = "settings.json";
const SETTINGS_KEY = "settings";

/** Non-secret preferences only. The API key never comes near this file. */
export async function loadSettings(): Promise<Settings> {
  try {
    const store = await load(SETTINGS_FILE, { autoSave: true });
    const stored = await store.get<Partial<Settings>>(SETTINGS_KEY);
    // `ai` is merged one level deeper: a settings file written before this
    // block existed has no `ai` key at all, and a shallow spread would leave
    // it undefined for every reader downstream.
    return {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      ai: { ...DEFAULT_SETTINGS.ai, ...(stored?.ai ?? {}) },
    };
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
 *
 * Writes go through our own Rust command rather than `tauri-plugin-fs`. That
 * plugin grants its path scope as a side effect of the folder dialog, so a
 * remembered output folder - picked in an earlier session - was rejected as a
 * "forbidden path" on every later run that skipped the dialog.
 */
export function directoryWriter(
  directory: string,
): (filename: string, bytes: Uint8Array) => Promise<void> {
  return async (filename, bytes) => {
    await invoke("write_export_file", {
      directory,
      filename,
      contents: Array.from(bytes),
    });
  };
}

export async function ensureDirectory(directory: string): Promise<void> {
  await invoke("ensure_export_directory", { directory });
}
