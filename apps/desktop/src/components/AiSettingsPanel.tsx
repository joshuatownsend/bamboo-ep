import { useEffect, useState } from "react";
import { AI_DEFAULTS, aiKeyStore, aiNeedsKey } from "../platform";
import type { AiProvider, AiSettings } from "../platform";

/**
 * Where the user sets up a document check.
 *
 * The decision on this was explicit: a cloud provider is configured once here,
 * not confirmed again on every run. What survives from that decision is
 * disclosure rather than consent - the provider is named wherever a result
 * appears and is written into the manifest, so the exported folder records
 * where these documents were sent.
 */

interface Props {
  settings: AiSettings;
  onChange: (settings: AiSettings) => void;
  /**
   * Whether checks can actually be run - a saved key, OR an endpoint that
   * needs none. Bubbled up so the row buttons can enable themselves.
   */
  onReadyChange: (ready: boolean) => void;
}

const PROVIDER_LABELS: Readonly<Record<AiProvider, string>> = {
  anthropic: "Claude (Anthropic)",
  openai: "OpenAI-compatible",
};

export function AiSettingsPanel({ settings, onChange, onReadyChange }: Props) {
  const needsKey = aiNeedsKey(settings);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void aiKeyStore
      .has(settings.provider)
      .then((present) => {
        if (cancelled) return;
        setHasKey(present);
        onReadyChange(present || !needsKey);
      })
      .catch(() => {
        // A credential store that will not answer is a real state, not a
        // crash: the user can still run checks against a local model.
        if (cancelled) return;
        setHasKey(false);
        onReadyChange(!needsKey);
      });
    return () => {
      cancelled = true;
    };
  }, [needsKey, onReadyChange, settings.provider]);

  const saveKey = async () => {
    const trimmed = draftKey.trim();
    if (!trimmed) return;
    try {
      await aiKeyStore.save(settings.provider, trimmed);
      // Cleared immediately: there is no reason for the key to stay in a React
      // state object once it is in the keychain.
      setDraftKey("");
      setHasKey(true);
      onReadyChange(true);
      setNote("Saved to this computer's credential store.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

  const forgetKey = async () => {
    await aiKeyStore.remove(settings.provider);
    setHasKey(false);
    onReadyChange(!needsKey);
    setNote("Removed.");
  };

  const defaults = AI_DEFAULTS[settings.provider];

  return (
    <div className="ai-panel">
      <span className="field-label">Check certificates with AI</span>
      <p className="field-hint">
        Optional. The first page of a certificate is sent to the model you choose here, and
        what it reads is compared against the BambooHR record on this computer.
      </p>

      <label className="field">
        <span className="field-label">Provider</span>
        <select
          value={settings.provider}
          // Model and address are cleared with the provider, not carried over.
          // An OpenAI address ending in /v1 kept across a switch to Anthropic
          // produces requests to <old-address>/v1/messages with an OpenAI model
          // name - every check failing, for a reason nothing on screen explains.
          // Empty means "use this provider's default", which is what the
          // placeholders already show.
          onChange={(e) =>
            onChange({ provider: e.target.value as AiProvider, model: "", baseUrl: "" })
          }
        >
          {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field-label">Model</span>
        <input
          type="text"
          value={settings.model}
          placeholder={defaults.model}
          spellCheck={false}
          onChange={(e) => onChange({ ...settings, model: e.target.value })}
        />
      </label>

      <label className="field">
        <span className="field-label">Address</span>
        <input
          type="text"
          value={settings.baseUrl}
          placeholder={defaults.baseUrl}
          spellCheck={false}
          onChange={(e) => onChange({ ...settings, baseUrl: e.target.value })}
        />
        <span className="field-hint">
          Point this at a model running on your own machine — for example{" "}
          <code>http://localhost:11434/v1</code> — and no certificate leaves this computer.
        </span>
      </label>

      {!needsKey && !hasKey ? (
        <div className="field">
          <span className="field-label">API key</span>
          <p className="field-hint">
            Not needed — that address is on this computer, and local model
            servers accept requests without one. Certificates checked this way
            never leave the machine.
          </p>
        </div>
      ) : hasKey ? (
        <div className="field">
          <span className="field-label">API key</span>
          <p className="field-hint">Saved in this computer's credential store.</p>
          <button type="button" className="secondary full" onClick={() => void forgetKey()}>
            Forget this key
          </button>
        </div>
      ) : (
        <label className="field">
          <span className="field-label">API key</span>
          <input
            type="password"
            value={draftKey}
            spellCheck={false}
            autoComplete="off"
            placeholder={settings.provider === "anthropic" ? "sk-ant-…" : "sk-…"}
            onChange={(e) => setDraftKey(e.target.value)}
          />
          <button
            type="button"
            className="secondary full"
            disabled={!draftKey.trim()}
            onClick={() => void saveKey()}
          >
            Save key
          </button>
          <span className="field-hint">
            Stored in your operating system's credential store, never in a settings file,
            and never read back into this window.
          </span>
        </label>
      )}

      {note && <p className="field-hint">{note}</p>}
    </div>
  );
}
