import { useState } from "react";
import type { EpOutcome, EpPlanItem, EpTemplate, Manifest } from "@bamboo-ep/core";
import { useEssper, type UploadState } from "../useEssper";

/**
 * Submitting the exported certifications to Essential Personnel.
 *
 * EP is LC-CFRS's system of record and a member's submission goes straight to
 * Active - there is no approval step to catch a mistake. This screen is the
 * only thing between a bad match and a wrong credential on someone's record,
 * so nothing here is submitted without being shown first, and the questions it
 * asks default to doing nothing.
 */

interface Props {
  manifest: Manifest | null;
  directory: string | null;
  onBack: () => void;
}

/** The order the buckets are worth reading in. */
const SECTIONS: Array<{ outcome: EpOutcome; title: string; blurb: string }> = [
  {
    outcome: "ready",
    title: "Ready to send",
    blurb: "Matched to an Essential Personnel certification, and not already on your record.",
  },
  {
    outcome: "needsTriage",
    title: "Needs your decision",
    blurb:
      "No confident match. Pick the right certification, ask for it to be added, or mark it as something LC-CFRS does not track.",
  },
  {
    outcome: "expiryNotStated",
    title: "Expiry needs confirming",
    blurb:
      "BambooHR records no expiry for these, so the date shown was calculated from the renewal frequency. Essential Personnel reads a blank expiry as never expiring, so these are not sent automatically.",
  },
  {
    outcome: "noFile",
    title: "No certificate found",
    blurb:
      "A full official transcript may be submitted instead - partial transcripts and single pages are not accepted.",
  },
  {
    outcome: "duplicateInPlan",
    title: "Recorded twice in BambooHR",
    blurb: "The same certification appears more than once; the most recent one is being sent.",
  },
  {
    outcome: "alreadyInEp",
    title: "Already on your record",
    blurb: "Nothing to do.",
  },
  {
    outcome: "importedByTargetSolutions",
    title: "Imported from Target Solutions",
    blurb: "The General Order says these do not need re-uploading.",
  },
  { outcome: "skipped", title: "Not tracked by LC-CFRS", blurb: "You marked these as out of scope." },
  {
    outcome: "requested",
    title: "To request as new categories",
    blurb: "Email these names to the training captain so they can be added.",
  },
];

export function EssperScreen({ manifest, directory, onBack }: Props) {
  const ep = useEssper(manifest, directory);
  const [company, setCompany] = useState("");

  if (!manifest || !directory) {
    return (
      <div className="screen">
        <div className="screen-main">
          <h2>Send to Essential Personnel</h2>
          <p>Export your records first — this reads the folder that export produced.</p>
          <button onClick={onBack}>Back</button>
        </div>
      </div>
    );
  }

  const readyCount = ep.plan?.items.filter((i) => i.outcome === "ready").length ?? 0;

  return (
    <div className="screen">
      <div className="screen-main">
        <h2>Send to Essential Personnel</h2>

        {ep.error && (
          <div className="banner error">
            <strong>{ep.error}</strong>
          </div>
        )}

        {!ep.member ? (
          <section>
            <p>
              Sign in with your Active Directory account, in the window this opens. The app
              never sees your password — it borrows the session afterwards.
            </p>
            <label className="field">
              <span className="field-label">Your Essential Personnel address</span>
              <input
                value={company}
                placeholder="lccfrs"
                onChange={(e) => setCompany(e.target.value)}
              />
              <span className="field-hint">
                Just the first part of the address you sign in at — for Loudoun County, "lccfrs".
              </span>
            </label>
            <button
              className="primary"
              disabled={company.trim() === "" || ep.loading != null}
              onClick={() => void ep.signIn(company.trim())}
            >
              {ep.loading ?? "Open Essential Personnel"}
            </button>
          </section>
        ) : (
          <>
            <p className="muted">
              Signed in as {ep.member.name ?? "your account"}
              {ep.plan ? null : " — read your record to see what needs sending."}
            </p>

            {!ep.plan && (
              <button
                className="primary"
                disabled={ep.loading != null}
                onClick={() => void ep.load()}
              >
                {ep.loading ?? "Read my Essential Personnel record"}
              </button>
            )}
          </>
        )}

        {ep.plan && (
          <>
            {SECTIONS.map((section) => {
              const items = ep.plan!.items.filter((i) => i.outcome === section.outcome);
              if (items.length === 0) return null;
              return (
                <section key={section.outcome} className="ep-section">
                  <h3>
                    {section.title} ({items.length})
                  </h3>
                  <p className="muted">{section.blurb}</p>
                  <ul className="ep-list">
                    {items.map((item) => (
                      <Row
                        key={item.entry.key}
                        item={item}
                        templates={ep.templates}
                        upload={ep.uploads[item.entry.key]}
                        onDecide={ep.decide}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}

            {ep.plan.catalogueRequests.length > 0 && (
              <section className="ep-section">
                <h3>Email to the training captain</h3>
                <p className="muted">
                  The General Order asks for these to be requested by name. Copy this list.
                </p>
                <pre className="ep-requests">{ep.plan.catalogueRequests.join("\n")}</pre>
              </section>
            )}

            <div className="actions">
              <button onClick={onBack} disabled={ep.busy}>
                Back
              </button>
              <button
                className="primary"
                disabled={ep.busy || readyCount === 0}
                onClick={() => void ep.submitAll()}
              >
                {ep.busy
                  ? "Sending…"
                  : `Send ${readyCount} certification${readyCount === 1 ? "" : "s"}`}
              </button>
            </div>
            <p className="muted">
              These go onto your Essential Personnel record immediately — there is no
              approval step to undo a mistake.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  item,
  templates,
  upload,
  onDecide,
}: {
  item: EpPlanItem;
  templates: readonly EpTemplate[];
  upload: UploadState | undefined;
  onDecide: ReturnType<typeof useEssper>["decide"];
}) {
  const key = item.entry.key;
  const flagged = item.entry.verification?.extracted?.legible === false;

  return (
    <li className="ep-row">
      <div className="ep-row-main">
        <strong>{item.entry.name}</strong>
        <span className="muted">
          {item.entry.completed ?? "no completion date"}
          {item.template ? ` → ${item.template.name}` : null}
        </span>
        <span className="muted">{item.explanation}</span>

        {flagged && (
          <span className="tag tag-warn">
            The certificate was hard to read. The General Order makes legibility your
            responsibility — check it before sending.
          </span>
        )}

        {upload?.status === "sent" && <span className="tag">Sent</span>}
        {upload?.status === "sending" && <span className="muted">Sending…</span>}
        {upload?.status === "failed" && <span className="tag tag-warn">{upload.message}</span>}

        {item.expiry && (
          <span className="muted">
            You said{" "}
            {item.expiry.expires ? `it expires ${item.expiry.expires}` : "it does not expire"}.{" "}
            <button className="link-button" onClick={() => onDecide(key, null)}>
              Change
            </button>
          </span>
        )}
      </div>

      {item.outcome === "needsTriage" && (
        <div className="ep-row-actions">
          <select
            defaultValue=""
            onChange={(e) =>
              e.target.value === ""
                ? onDecide(key, null)
                : onDecide(key, { handling: { kind: "template", templateId: e.target.value } })
            }
          >
            <option value="">Pick a certification…</option>
            {item.candidates.map((c) => (
              <option key={c.template.id} value={c.template.id}>
                {c.template.name} ({Math.round(c.score * 100)}%)
              </option>
            ))}
            <optgroup label="Everything else">
              {templates
                .filter((t) => !item.candidates.some((c) => c.template.id === t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </optgroup>
          </select>
          <button onClick={() => onDecide(key, { handling: { kind: "request" } })}>
            Ask for it to be added
          </button>
          <button onClick={() => onDecide(key, { handling: { kind: "skip" } })}>
            Not tracked by LC-CFRS
          </button>
        </div>
      )}

      {item.outcome === "expiryNotStated" && (
        <div className="ep-row-actions">
          <button
            className="primary"
            onClick={() => onDecide(key, { expiry: { expires: item.entry.expires } })}
          >
            Expires {item.entry.expires}
          </button>
          <button onClick={() => onDecide(key, { expiry: { expires: null } })}>
            Does not expire
          </button>
        </div>
      )}

      {(item.outcome === "skipped" || item.outcome === "requested") && (
        <div className="ep-row-actions">
          <button onClick={() => onDecide(key, null)}>Undo</button>
        </div>
      )}
    </li>
  );
}
