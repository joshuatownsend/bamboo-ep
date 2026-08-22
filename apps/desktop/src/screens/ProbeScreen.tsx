import type { ProbeReport, ProbeResult } from "@bamboo-ep/core";

/**
 * Access check results.
 *
 * A BambooHR key's permissions cannot be known in advance, and a regular
 * employee's key is often refused on some endpoints while working fine on
 * others. Showing the whole matrix - rather than stopping at the first
 * refusal - lets a user see exactly what they will and will not get, and gives
 * them something concrete to take to their administrator.
 */

interface Props {
  report: ProbeReport;
  busy: boolean;
  onContinue: () => void;
  onBack: () => void;
}

const STATUS_TEXT: Record<ProbeResult["status"], string> = {
  ok: "Available",
  empty: "Nothing recorded",
  forbidden: "Not permitted",
  unavailable: "Unavailable",
  error: "Failed",
};

export function ProbeScreen({ report, busy, onContinue, onBack }: Props) {
  return (
    <div className="screen">
      <div className="screen-main">
        <h2>What your account can access</h2>

        <ul className="probe-list">
          {report.results.map((result) => (
            <li key={result.id} className={`probe-row status-${result.status}`}>
              <span className={`pill pill-${result.status}`}>{STATUS_TEXT[result.status]}</span>
              <div className="probe-text">
                <strong>{result.label}</strong>
                <span>{result.detail}</span>
              </div>
            </li>
          ))}
        </ul>

        <div className="actions">
          <button type="button" onClick={onBack} className="secondary" disabled={busy}>
            Back
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="primary"
            disabled={busy || !report.usable}
          >
            {busy ? "Reading records…" : "Continue"}
          </button>
        </div>

        {!report.usable && (
          <p className="field-hint">
            Nothing could be read from this account, so there is nothing to export yet.
          </p>
        )}
      </div>

      {report.advice.length > 0 && (
        <aside className="screen-aside">
          <h3>What this means</h3>
          <ul className="advice">
            {report.advice.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
