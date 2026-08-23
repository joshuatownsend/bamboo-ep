import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_TEMPLATE,
  FilenameAllocator,
  applyFileNameFallback,
  MANIFEST_FILENAME,
  SUMMARY_CSV_FILENAME,
  buildFilename,
  stemOf,
} from "@bamboo-ep/core";
import { SUMMARY_PDF_FILENAME } from "../pdf";
import type { EmployeeIdentity, TrainingItem, Verification, Workspace } from "@bamboo-ep/core";
import { chooseOutputDirectory } from "../platform";
import type { Settings } from "../platform";
import { renderPreview } from "../preview";
import { usePreviews } from "../usePreviews";
import { CertificatePreview, PreviewLightbox } from "../components/CertificatePreview";
import { AiSettingsPanel } from "../components/AiSettingsPanel";
import { VerificationSignal } from "../components/VerificationSignal";
import { useVerification } from "../useVerification";

/**
 * Match review.
 *
 * BambooHR records no link between a certificate file and a training record,
 * so the pairings shown here are guesses. This screen exists to turn those
 * guesses into decisions: every row can be repointed at a different file or
 * cleared, and nothing is written until the user says so. Confirmed choices
 * are remembered, so a correction is made once and not re-guessed next time.
 */

interface Props {
  workspace: Workspace;
  settings: Settings;
  busy: boolean;
  onSettingsChange: (settings: Settings) => void;
  onDownload: (
    confirmed: Record<string, string>,
    excludedItemKeys: string[],
    /**
     * The complete set of choices to remember, REPLACING what was stored.
     * Replacement rather than merge is what lets a cleared pairing actually
     * be forgotten.
     */
    nextSaved: Record<string, string>,
    /** Document checks that survived to the moment of saving. */
    verifications: Record<string, Verification>,
  ) => void;
  /** Discard every saved choice for this company and re-match from scratch. */
  onClearSaved: () => void;
  onBack: () => void;
  /**
   * Fetches one file's bytes without writing anything. Injected rather than
   * built here so this screen stays unaware of BambooHR and of Tauri.
   */
  loadFileBytes: (
    fileId: string,
  ) => Promise<{ bytes: Uint8Array; contentType: string | null }>;
  /** The employee whose profile this is, for the "right person?" check. */
  identity: EmployeeIdentity | null;
  /**
   * Names already spoken for in the output folder. The preview allocates
   * against these so the filename shown is the filename written, including
   * the collision suffix.
   */
  reservedFilenames: readonly string[];
  /** Lets the reservations be recomputed when a new folder is picked. */
  onOutputDirChosen: (directory: string) => void;
}

export function ReviewScreen({
  workspace,
  settings,
  busy,
  onSettingsChange,
  onDownload,
  onClearSaved,
  onBack,
  loadFileBytes,
  identity,
  reservedFilenames,
  onOutputDirChosen,
}: Props) {
  // itemKey -> fileId. Seeded from the proposed plan, then edited freely.
  const proposed = useMemo(
    () => Object.fromEntries(workspace.plan.matches.map((m) => [m.itemKey, m.fileId])),
    [workspace.plan.matches],
  );
  const [assignments, setAssignments] = useState<Record<string, string>>(proposed);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  /**
   * A useState initialiser runs once, on mount. "Forget saved matches"
   * replaces the workspace without leaving the review step, so React kept the
   * component alive and the old assignments with it: the freshly re-matched
   * plan was computed, displayed nowhere, and the discarded pairings were
   * saved straight back as though the user had chosen them. Re-seeding when
   * the plan changes is what makes that button actually forget.
   */
  useEffect(() => {
    setAssignments(proposed);
    setExcluded(new Set());
    // The checks go with them. A re-match can point an item at a different
    // file, and a verdict formed against the old one would sit beside the new
    // file looking like a judgment on it - green or warning, either way wrong,
    // and read at the moment the user decides whether to save.
    checks.forgetAll();
    // `checks` is a fresh object each render; depending on it would clear the
    // checks continuously. The plan changing is the only trigger wanted here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposed]);

  const filesById = useMemo(
    () => new Map(workspace.files.map((f) => [f.id, f])),
    [workspace.files],
  );
  const matchByItem = useMemo(
    () => new Map(workspace.plan.matches.map((m) => [m.itemKey, m])),
    [workspace.plan.matches],
  );

  // The original filename is what tells a PDF from a JPEG when BambooHR serves
  // the file as octet-stream, so the renderer is built here where the file
  // metadata lives rather than inside the caching hook.
  const renderFile = useCallback(
    async (fileId: string) => {
      const file = workspace.files.find((f) => f.id === fileId);
      const { bytes, contentType } = await loadFileBytes(fileId);
      return renderPreview(bytes, contentType, file?.originalFileName ?? file?.name ?? null);
    },
    [loadFileBytes, workspace.files],
  );
  const pagePreviews = usePreviews(renderFile);
  const [zoomed, setZoomed] = useState<{ fileId: string; label: string } | null>(null);
  const zoomedState = zoomed ? pagePreviews.stateOf(zoomed.fileId) : null;

  const [aiKeyPresent, setAiKeyPresent] = useState(false);
  const checks = useVerification({
    settings: settings.ai,
    identity,
    items: workspace.items,
    previews: pagePreviews,
    currentFileIdOf: (itemKey) => assignments[itemKey],
  });

  const itemsByKey = useMemo(
    () => new Map(workspace.items.map((i) => [i.key, i])),
    [workspace.items],
  );

  /**
   * Repointing a row throws away any check it had. The check was about the
   * PAIR, so keeping it would relabel a verdict onto a document nobody looked
   * at - the same reason executePull re-checks the file id before writing.
   */
  const assign = (itemKey: string, fileId: string | null) => {
    const next = { ...assignments };
    if (fileId) next[itemKey] = fileId;
    else delete next[itemKey];
    setAssignments(next);
    if (assignments[itemKey] !== fileId) checks.forget(itemKey);
  };

  /**
   * Which rows are worth spending a model call on.
   *
   * The decision was flagged-only: anything the scorer did not rate "high" and
   * anything the user has repointed by hand. The gap this leaves is real and
   * was accepted - a colleague's certificate whose filename happens to match
   * cleanly scores high and is never checked - which is why every row also has
   * its own button.
   */
  const isFlagged = (itemKey: string): boolean => {
    const assigned = assignments[itemKey];
    if (!assigned) return false;
    const match = matchByItem.get(itemKey);
    return !(match && match.fileId === assigned && match.confidence === "high");
  };

  /**
   * A check that did not produce an answer, for either reason it can fail.
   *
   * The two cases look different in the data and identical to the user. A
   * refused request never reaches the model and lands as `failed`; a model
   * that replied unusably lands as `done` with an error inside it. Both mean
   * "we asked and learned nothing", and both are worth asking again - a
   * provider outage, an expired key, or a spending limit reached mid-sweep
   * can leave a whole batch in this state through no fault of the documents.
   */
  const needsAnotherAttempt = (itemKey: string): boolean => {
    const state = checks.stateOf(itemKey);
    if (state.status === "failed") return true;
    return state.status === "done" && state.verification.error != null;
  };

  const checkable = (itemKey: string): boolean =>
    !excluded.has(itemKey) && Boolean(assignments[itemKey]);

  const pairsFor = (keys: readonly string[]) =>
    keys.map((key) => ({
      item: itemsByKey.get(key) as TrainingItem,
      fileId: assignments[key]!,
    }));

  const flaggedPairs = useMemo(
    () =>
      pairsFor(
        workspace.items
          .map((i) => i.key)
          .filter(
            (key) =>
              checkable(key) && isFlagged(key) && checks.stateOf(key).status === "idle",
          ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assignments, excluded, matchByItem, workspace.items, checks],
  );

  /**
   * Retries are NOT restricted to flagged rows. A row the user checked by hand
   * was an explicit request, and a failure is no reason to quietly drop it
   * from the retry - it would be the one row left behind by a button that
   * claims to retry everything.
   */
  const retryablePairs = useMemo(
    () => pairsFor(workspace.items.map((i) => i.key).filter((key) => checkable(key) && needsAnotherAttempt(key))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assignments, excluded, workspace.items, checks],
  );

  /**
   * A file may back only one record, so offer only what is still free.
   *
   * An excluded row holds nothing: its assignment is ignored everywhere else,
   * so continuing to count it as claimed made its file unofferable to any
   * other record - and, with orphan saving off, silently dropped from the
   * export rather than reassignable.
   */
  const availableFilesFor = (itemKey: string) => {
    const claimed = new Set(
      Object.entries(assignments)
        .filter(([key]) => key !== itemKey && !excluded.has(key))
        .map(([, fileId]) => fileId),
    );
    return workspace.files.filter((f) => !claimed.has(f.id));
  };

  // Preview the filenames live, using the same allocator the pull will use so
  // collision suffixes shown here are the ones actually written.
  const savedAsPreviews = useMemo(() => {
    // Same reservations the pull makes, so the preview shows the collision
    // suffixes that will actually be written.
    const allocator = new FilenameAllocator([
      MANIFEST_FILENAME,
      SUMMARY_CSV_FILENAME,
      SUMMARY_PDF_FILENAME,
      ...reservedFilenames,
    ]);
    const out = new Map<string, string>();
    for (const item of workspace.items) {
      if (excluded.has(item.key)) continue;
      const fileId = assignments[item.key];
      if (!fileId) continue;
      const file = filesById.get(fileId);
      if (!file) continue;
      // The pull renames a placeholder item after its matched file before
      // rendering the template. Skipping that here showed "Training 12" in the
      // preview while "Bloodborne Pathogens" was what got written - the one
      // value on this screen the user is entitled to take literally.
      const named = applyFileNameFallback(item, stemOf(file.originalFileName ?? file.name));
      out.set(
        item.key,
        buildFilename({
          template: settings.filenameTemplate || DEFAULT_TEMPLATE,
          values: {
            name: named.name,
            completed: named.completed,
            expires: named.expires,
            category: named.category ?? file.categoryName,
            original: stemOf(file.originalFileName ?? file.name),
          },
          originalFileName: file.originalFileName ?? file.name,
          allocator,
        }),
      );
    }
    return out;
  }, [
    assignments,
    excluded,
    filesById,
    reservedFilenames,
    settings.filenameTemplate,
    workspace.items,
  ]);

  const selectedCount = workspace.items.filter((i) => !excluded.has(i.key)).length;
  const withFileCount = savedAsPreviews.size;

  const submit = () => {
    // core keys confirmations by fileId, since a file backs at most one record.
    const confirmed: Record<string, string> = {};
    const nextSaved: Record<string, string> = {};

    for (const [itemKey, fileId] of Object.entries(assignments)) {
      if (excluded.has(itemKey) || !fileId) continue;
      confirmed[fileId] = itemKey;

      // Remember a pairing only when the user chose it: either they changed
      // it now, or it is a choice they made on an earlier run and have left
      // in place. An accepted suggestion is NOT remembered - hardening a
      // guess would make it immune to later matcher improvements.
      const changedNow = proposed[itemKey] !== fileId;
      const keptEarlierChoice = matchByItem.get(itemKey)?.confirmedByUser === true;
      if (changedNow || keptEarlierChoice) nextSaved[fileId] = itemKey;
    }

    // nextSaved REPLACES what was stored, so a pairing the user cleared or
    // repointed disappears instead of resurfacing on the next run.
    onDownload(confirmed, [...excluded], nextSaved, { ...checks.all });
  };

  const savedCount = workspace.plan.matches.filter((m) => m.confirmedByUser).length;

  const assignedFileIds = useMemo(
    () =>
      workspace.items
        .filter((i) => !excluded.has(i.key))
        .map((i) => assignments[i.key])
        .filter((id): id is string => Boolean(id)),
    [assignments, excluded, workspace.items],
  );
  const unrenderedCount = pagePreviews.pendingCount(assignedFileIds);

  return (
    <div className="screen screen-wide">
      <div className="screen-main">
        <h2>Review what will be saved</h2>
        <p className="lede">
          BambooHR does not record which file belongs to which training, so these pairings
          are suggestions. Check them before saving — corrections are remembered.
        </p>

        {workspace.warnings.length > 0 && (
          <div className="banner warn">
            <ul>
              {workspace.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="review-toolbar">
          <button
            type="button"
            className="secondary"
            disabled={unrenderedCount === 0}
            onClick={() => void pagePreviews.requestAll(assignedFileIds)}
          >
            {unrenderedCount === 0
              ? "All pages shown"
              : `Show all ${unrenderedCount} certificate page${unrenderedCount === 1 ? "" : "s"}`}
          </button>
          {aiKeyPresent && (
            <button
              type="button"
              className="secondary"
              disabled={flaggedPairs.length === 0 || checks.busy}
              onClick={() => void checks.verifyMany(flaggedPairs)}
            >
              {checks.busy
                ? "Checking…"
                : flaggedPairs.length === 0
                  ? "No uncertain pairings left"
                  : `Check ${flaggedPairs.length} uncertain pairing${flaggedPairs.length === 1 ? "" : "s"} with AI`}
            </button>
          )}

          {/* Only shown when there is something to retry. A permanently
              visible retry button would read as "the last run went badly"
              on every run that went fine. */}
          {aiKeyPresent && retryablePairs.length > 0 && (
            <button
              type="button"
              className="secondary"
              disabled={checks.busy}
              onClick={() => void checks.verifyMany(retryablePairs)}
            >
              {checks.busy
                ? "Retrying…"
                : `Retry ${retryablePairs.length} check${retryablePairs.length === 1 ? "" : "s"} that did not complete`}
            </button>
          )}
          <span className="field-hint">
            Reading each page is the fastest way to catch a certificate paired with the
            wrong record. Nothing is saved to your computer by doing this.
          </span>
        </div>

        <table className="review-table">
          <thead>
            <tr>
              <th className="col-include">Include</th>
              <th className="col-preview">Page 1</th>
              <th>Certification</th>
              <th>Completed</th>
              <th>Certificate file</th>
              <th>Will be saved as</th>
            </tr>
          </thead>
          <tbody>
            {workspace.items.map((item) => {
              const isExcluded = excluded.has(item.key);
              const match = matchByItem.get(item.key);
              const assigned = assignments[item.key] ?? "";
              return (
                <tr key={item.key} className={isExcluded ? "row-excluded" : ""}>
                  <td className="col-include">
                    <input
                      type="checkbox"
                      checked={!isExcluded}
                      aria-label={`Include ${item.name}`}
                      onChange={(e) => {
                        const next = new Set(excluded);
                        if (e.target.checked) next.delete(item.key);
                        else next.add(item.key);
                        setExcluded(next);
                      }}
                    />
                  </td>

                  <td className="col-preview">
                    {assigned ? (
                      <CertificatePreview
                        state={pagePreviews.stateOf(assigned)}
                        label={item.name}
                        onLoad={() => void pagePreviews.ensure(assigned).catch(() => undefined)}
                        onZoom={() => setZoomed({ fileId: assigned, label: item.name })}
                      />
                    ) : (
                      <div className="preview-thumb preview-thumb-empty">No file</div>
                    )}
                  </td>

                  <td>
                    <strong>{item.name}</strong>
                    {/* A fallback name is flagged so it is never mistaken for
                        the real certification title. */}
                    {item.nameSource === "placeholder" && (
                      <span className="tag tag-warn">name unavailable</span>
                    )}
                    {item.source === "certifications" && (
                      <span className="tag">certifications table</span>
                    )}
                  </td>

                  <td className="muted">
                    {item.completed ?? "—"}
                    {item.expires && (
                      <div className="sub">
                        expires {item.expires}
                        {item.expiresDerived && " (estimated)"}
                      </div>
                    )}
                  </td>

                  <td>
                    <select
                      value={assigned}
                      disabled={isExcluded}
                      aria-label={`Certificate file for ${item.name}`}
                      onChange={(e) => assign(item.key, e.target.value || null)}
                    >
                      <option value="">No file</option>
                      {availableFilesFor(item.key).map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.originalFileName ?? f.name} · {f.categoryName}
                        </option>
                      ))}
                    </select>
                    {assigned && !isExcluded && (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => assign(item.key, null)}
                      >
                        Clear — free this file for another record
                      </button>
                    )}
                    {match && assigned === match.fileId && (
                      <div className={`sub confidence-${match.confidence}`}>
                        {match.confirmedByUser
                          ? "Your earlier choice"
                          : `${match.confidence} confidence — ${match.reasons[0] ?? "weak signal"}`}
                      </div>
                    )}

                    {/* The third signal, after the score and the thumbnail:
                        what the document itself says. */}
                    <VerificationSignal
                      state={checks.stateOf(item.key)}
                      nameOf={(key) => itemsByKey.get(key)?.name}
                      onRetry={() => void checks.verify(item, assigned)}
                    />
                    {assigned && !isExcluded && aiKeyPresent &&
                      checks.stateOf(item.key).status === "idle" && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => void checks.verify(item, assigned)}
                        >
                          Check this certificate with AI
                        </button>
                      )}
                  </td>

                  <td className="muted mono">
                    {isExcluded ? "—" : (savedAsPreviews.get(item.key) ?? "No file to save")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {workspace.items.length === 0 && (
          <p className="field-hint">No training records were found on your profile.</p>
        )}

        <div className="actions">
          <button type="button" onClick={onBack} className="secondary" disabled={busy}>
            Back
          </button>
          {/* `submit` snapshots the checks as they stand. Saving mid-sweep
              would drop every result still in flight from the manifest, with
              nothing to show that it had happened. */}
          <button
            type="button"
            onClick={submit}
            className="primary"
            disabled={busy || checks.busy}
          >
            {busy
              ? "Saving…"
              : checks.busy
                ? "Waiting for the certificate checks…"
                : `Save ${selectedCount} record${selectedCount === 1 ? "" : "s"} (${withFileCount} with files)`}
          </button>
        </div>
      </div>

      <aside className="screen-aside">
        <h3>Options</h3>

        <label className="field">
          <span className="field-label">File name format</span>
          <input
            type="text"
            value={settings.filenameTemplate}
            onChange={(e) =>
              onSettingsChange({ ...settings, filenameTemplate: e.target.value })
            }
            spellCheck={false}
          />
          <span className="field-hint">
            Available: <code>{"{name}"}</code> <code>{"{completed}"}</code>{" "}
            <code>{"{expires}"}</code> <code>{"{category}"}</code> <code>{"{original}"}</code>
          </span>
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.includeOrphanFiles}
            onChange={(e) =>
              onSettingsChange({ ...settings, includeOrphanFiles: e.target.checked })
            }
          />
          <span>
            Also save files that match no record
            <small>
              {workspace.plan.unmatchedFileIds.length} such file
              {workspace.plan.unmatchedFileIds.length === 1 ? "" : "s"} on your profile
            </small>
          </span>
        </label>

        <div className="field">
          <span className="field-label">Save to</span>
          <button
            type="button"
            className="secondary full"
            onClick={async () => {
              const dir = await chooseOutputDirectory();
              if (!dir) return;
              onSettingsChange({ ...settings, outputDir: dir });
              onOutputDirChosen(dir);
            }}
          >
            {settings.outputDir ?? "Choose a folder…"}
          </button>
        </div>

        {savedCount > 0 && (
          <div className="field">
            <span className="field-label">Saved choices</span>
            <button type="button" className="secondary full" onClick={onClearSaved}>
              Forget {savedCount} saved match{savedCount === 1 ? "" : "es"}
            </button>
            <span className="field-hint">
              Choices you made on an earlier run are being reused and are shown as
              “Your earlier choice”. Forget them to match everything from scratch.
            </span>
          </div>
        )}

        {zoomed && zoomedState?.status === "ready" && (
          <PreviewLightbox
            dataUrl={zoomedState.preview.dataUrl}
            label={zoomed.label}
            onClose={() => setZoomed(null)}
          />
        )}

        <AiSettingsPanel
          settings={settings.ai}
          onChange={(ai) => onSettingsChange({ ...settings, ai })}
          onKeyPresenceChange={setAiKeyPresent}
        />

        <p className="aside-note">
          Every record is written to the summary, including those with no certificate file —
          a BambooHR record is evidence in its own right.
        </p>
      </aside>
    </div>
  );
}
