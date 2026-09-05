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

/** One list of every certification, shared by every row that needs one. */
const CATALOGUE_LIST_ID = "ep-catalogue";

/** The order the buckets are worth reading in. */
const SECTIONS = [
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
    outcome: "noCompletionDate",
    title: "No completion date",
    blurb:
      "Essential Personnel will not accept a certification without one. Correct the date in BambooHR and export again.",
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
  {
    outcome: "skipped",
    title: "Not being sent",
    // Two different reasons land here - training the county does not track,
    // and a row whose automatic match was wrong. Saying "out of scope" made
    // the screen assert something untrue about the second kind.
    blurb: "You chose not to send these. Nothing about them goes to Essential Personnel.",
  },
  {
    outcome: "requested",
    title: "To request as new categories",
    blurb: "Email these names to the training captain so they can be added.",
  },
] satisfies ReadonlyArray<{ outcome: EpOutcome; title: string; blurb: string }>;

/**
 * Every outcome the planner can produce has a section here.
 *
 * The screen renders by filtering the plan for each section in turn, so an
 * outcome nobody listed is not an empty bucket - it is a record that vanishes.
 * `noCompletionDate` did exactly that: the member was never told why a
 * certification they could see in BambooHR had gone missing. `satisfies` above
 * keeps the literal types, so this line fails to compile the next time an
 * outcome is added without a home.
 */
const _everyOutcomeIsShown: EpOutcome extends (typeof SECTIONS)[number]["outcome"] ? true : never =
  true;
void _everyOutcomeIsShown;

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

                  {section.outcome === "needsTriage" && (
                    <p>
                      <button
                        className="secondary"
                        onClick={() =>
                          ep.decideMany(
                            items.map((i) => i.entry.key),
                            { handling: { kind: "skip" } },
                          )
                        }
                      >
                        Mark all {items.length} as not tracked by LC-CFRS
                      </button>{" "}
                      <span className="muted">
                        Then pick out the few that should be requested. Nothing is sent
                        either way, and each one can be undone.
                      </span>
                    </p>
                  )}

                  {section.outcome === "skipped" && (
                    <p>
                      <button
                        className="link-button"
                        onClick={() => ep.forget(items.map((i) => i.entry.key))}
                      >
                        Put all {items.length} back
                      </button>
                    </p>
                  )}
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

            <datalist id={CATALOGUE_LIST_ID}>
              {ep.templates.map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>

            {ep.plan.catalogueRequests.length > 0 && (
              <section className="ep-section">
                <h3>Email to the training captain</h3>
                <p className="muted">
                  The General Order asks for these to be requested by name. Copy this list.
                </p>
                <pre className="ep-requests">{ep.plan.catalogueRequests.join("\n")}</pre>
              </section>
            )}

            <p className="muted">
              These go onto your Essential Personnel record immediately — there is no
              approval step to undo a mistake.
            </p>
          </>
        )}

        {/*
          One Back, rendered in every state rather than inside a branch.
          Two rounds of review found two different states with no way out -
          before sign-in, and after signing in when reading the record fails.
          A third copy would only have waited for a fourth state; this cannot
          go missing because there is nowhere for it to be missing from. It is
          disabled only while uploads are in flight, which is the one moment
          leaving would abandon work half-done.
        */}
        <div className="actions">
          <button onClick={() => void ep.signOut().finally(onBack)} disabled={ep.busy}>
            Back
          </button>
          {ep.plan && (
            <button
              className="primary"
              disabled={ep.busy || readyCount === 0}
              onClick={() => void ep.submitAll()}
            >
              {ep.busy
                ? "Sending…"
                : `Send ${readyCount} certification${readyCount === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
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
            <button className="link-button" onClick={() => onDecide(key, { expiry: null })}>
              Change
            </button>
          </span>
        )}
      </div>

      {(item.outcome === "needsTriage" || item.outcome === "ready") && (
        <div className="ep-row-actions">
          {item.candidates.length > 0 && (
            <select
              defaultValue=""
              onChange={(e) =>
                e.target.value === ""
                  ? onDecide(key, { handling: null })
                  : onDecide(key, { handling: { kind: "template", templateId: e.target.value } })
              }
            >
              <option value="">
                {item.outcome === "ready" ? "Change to…" : "Closest matches…"}
              </option>
              {item.candidates.map((c) => (
                <option key={c.template.id} value={c.template.id}>
                  {c.template.name} ({Math.round(c.score * 100)}%)
                </option>
              ))}
            </select>
          )}
          {/*
            A typed search against one shared <datalist>, rather than 401
            options repeated in every row. With 144 records needing a decision
            that was over fifty thousand option elements, which is why the
            screen crawled - and typing beats scrolling a list that long
            regardless.
          */}
          <input
            list={CATALOGUE_LIST_ID}
            placeholder="or search all 401…"
            onChange={(e) => {
              const match = templates.find((t) => t.name === e.target.value);
              if (match) {
                onDecide(key, { handling: { kind: "template", templateId: match.id } });
              }
            }}
          />
          {/*
            Asking for a new category makes no sense for a row already matched
            to one, so a ready row gets only the two controls that do: pick a
            different certification, or leave it out.
          */}
          {item.outcome === "needsTriage" && (
            <button onClick={() => onDecide(key, { handling: { kind: "request" } })}>
              Ask for it to be added
            </button>
          )}
          <button onClick={() => onDecide(key, { handling: { kind: "skip" } })}>
            {item.outcome === "ready" ? "Do not send" : "Not tracked by LC-CFRS"}
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
          <button onClick={() => onDecide(key, { handling: null })}>Undo</button>
        </div>
      )}
    </li>
  );
}
