import { useEffect, useState } from "react";
import type { Credentials } from "@bamboo-ep/core";
import { credentialStore } from "../platform";
import type { Settings } from "../platform";

/**
 * Connect screen.
 *
 * The whole per-employee model rests on the user being able to create an API
 * key, and BambooHR's own documentation hedges that the "API Keys" menu item
 * appears only "if they have sufficient permissions". So the instructions are
 * on this screen rather than buried in a help page, and the failure case is
 * named explicitly.
 */

interface Props {
  settings: Settings;
  busy: boolean;
  onConnect: (credentials: Credentials, remember: boolean) => void;
  onSettingsChange: (settings: Settings) => void;
}

export function SetupScreen({ settings, busy, onConnect }: Props) {
  const [subdomain, setSubdomain] = useState(settings.subdomain);
  const [apiKey, setApiKey] = useState("");
  const [remember, setRemember] = useState(true);
  const [loadedFromKeychain, setLoadedFromKeychain] = useState(false);

  useEffect(() => setSubdomain(settings.subdomain), [settings.subdomain]);

  // Offer the stored key back once a known subdomain is typed, so returning
  // users do not have to find their key again.
  useEffect(() => {
    let cancelled = false;
    if (!subdomain.trim()) return;
    void credentialStore
      .load(subdomain.trim())
      .then((stored) => {
        if (cancelled || !stored) return;
        setApiKey(stored);
        setLoadedFromKeychain(true);
      })
      .catch(() => {
        /* No stored key, or no credential store. Typing one still works. */
      });
    return () => {
      cancelled = true;
    };
  }, [subdomain]);

  const canSubmit = subdomain.trim().length > 0 && apiKey.trim().length > 0 && !busy;

  return (
    <div className="screen">
      <div className="screen-main">
        <h2>Connect to BambooHR</h2>
        <p className="lede">
          This app reads only your own training records and certificate files. It never
          changes anything in BambooHR.
        </p>

        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            onConnect({ subdomain: subdomain.trim(), apiKey: apiKey.trim() }, remember);
          }}
        >
          <label className="field">
            <span className="field-label">Company subdomain</span>
            <input
              type="text"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              placeholder="acme"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <span className="field-hint">
              The part of your BambooHR web address before <code>.bamboohr.com</code>.
            </span>
          </label>

          <label className="field">
            <span className="field-label">API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setLoadedFromKeychain(false);
              }}
              placeholder="Paste your key"
              spellCheck={false}
            />
            <span className="field-hint">
              {loadedFromKeychain
                ? "Loaded from your saved credentials."
                : "Stored in your operating system's credential manager, never in a file."}
            </span>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Remember this key on this computer</span>
          </label>

          <button type="submit" className="primary" disabled={!canSubmit}>
            {busy ? "Checking…" : "Check my access"}
          </button>
        </form>
      </div>

      <aside className="screen-aside">
        <h3>Getting an API key</h3>
        <ol className="instructions">
          <li>Log in to BambooHR in your browser.</li>
          <li>
            Click <strong>your name</strong> in the <strong>lower-left corner</strong>.
          </li>
          <li>
            Choose <strong>API Keys</strong>.
          </li>
          <li>Generate a key and paste it here.</li>
        </ol>
        <p className="aside-note">
          If <strong>API Keys</strong> is not in that menu, your BambooHR account is not
          permitted to create one. Ask your BambooHR administrator to enable API access
          for you — it cannot be worked around from this app.
        </p>
      </aside>
    </div>
  );
}
