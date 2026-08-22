import { useMemo, useState } from "react";
import {
  DEFAULT_TEMPLATE,
  FilenameAllocator,
  MANIFEST_FILENAME,
  SUMMARY_CSV_FILENAME,
  buildFilename,
  stemOf,
} from "@bamboo-ep/core";
import { SUMMARY_PDF_FILENAME } from "../pdf";
import type { Workspace } from "@bamboo-ep/core";
import { chooseOutputDirectory } from "../platform";
import type { Settings } from "../platform";

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
    /** Only the pairings the user actually changed, for persistence. */
    userEdited: Record<string, string>,
  ) => void;
  onBack: () => void;
}

export function ReviewScreen({
  workspace,
  settings,
  busy,
  onSettingsChange,
  onDownload,
  onBack,
}: Props) {
  // itemKey -> fileId. Seeded from the proposed plan, then edited freely.
  const proposed = useMemo(
    () => Object.fromEntries(workspace.plan.matches.map((m) => [m.itemKey, m.fileId])),
    [workspace.plan.matches],
  );
  const [assignments, setAssignments] = useState<Record<string, string>>(proposed);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const filesById = useMemo(
    () => new Map(workspace.files.map((f) => [f.id, f])),
    [workspace.files],
  );
  const matchByItem = useMemo(
    () => new Map(workspace.plan.matches.map((m) => [m.itemKey, m])),
    [workspace.plan.matches],
  );

  /** A file may back only one record, so offer only what is still free. */
  const availableFilesFor = (itemKey: string) => {
    const claimed = new Set(
      Object.entries(assignments)
        .filter(([key]) => key !== itemKey)
        .map(([, fileId]) => fileId),
    );
    return workspace.files.filter((f) => !claimed.has(f.id));
  };

  // Preview the filenames live, using the same allocator the pull will use so
  // collision suffixes shown here are the ones actually written.
  const previews = useMemo(() => {
    // Same reservations the pull makes, so the preview shows the collision
    // suffixes that will actually be written.
    const allocator = new FilenameAllocator([
      MANIFEST_FILENAME,
      SUMMARY_CSV_FILENAME,
      SUMMARY_PDF_FILENAME,
    ]);
    const out = new Map<string, string>();
    for (const item of workspace.items) {
      if (excluded.has(item.key)) continue;
      const fileId = assignments[item.key];
      if (!fileId) continue;
      const file = filesById.get(fileId);
      if (!file) continue;
      out.set(
        item.key,
        buildFilename({
          template: settings.filenameTemplate || DEFAULT_TEMPLATE,
          values: {
            name: item.name,
            completed: item.completed,
            expires: item.expires,
            category: item.category ?? file.categoryName,
            original: stemOf(file.originalFileName ?? file.name),
          },
          originalFileName: file.originalFileName ?? file.name,
          allocator,
        }),
      );
    }
    return out;
  }, [assignments, excluded, filesById, settings.filenameTemplate, workspace.items]);

  const selectedCount = workspace.items.filter((i) => !excluded.has(i.key)).length;
  const withFileCount = previews.size;

  const submit = () => {
    // core keys confirmations by fileId, since a file backs at most one record.
    const confirmed: Record<string, string> = {};
    const userEdited: Record<string, string> = {};
    for (const [itemKey, fileId] of Object.entries(assignments)) {
      if (excluded.has(itemKey) || !fileId) continue;
      confirmed[fileId] = itemKey;
      // Only a pairing the user actually CHANGED is remembered. Persisting
      // accepted suggestions too would harden a guess into a permanent
      // "confirmed" mapping that bypasses scoring on every later run - so a
      // wrong guess could never be corrected by improving the matcher.
      if (proposed[itemKey] !== fileId) userEdited[fileId] = itemKey;
    }
    onDownload(confirmed, [...excluded], userEdited);
  };

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

        <table className="review-table">
          <thead>
            <tr>
              <th className="col-include">Include</th>
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
                      onChange={(e) => {
                        const next = { ...assignments };
                        if (e.target.value) next[item.key] = e.target.value;
                        else delete next[item.key];
                        setAssignments(next);
                      }}
                    >
                      <option value="">No file</option>
                      {availableFilesFor(item.key).map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.originalFileName ?? f.name} · {f.categoryName}
                        </option>
                      ))}
                    </select>
                    {match && assigned === match.fileId && (
                      <div className={`sub confidence-${match.confidence}`}>
                        {match.confirmedByUser
                          ? "Your earlier choice"
                          : `${match.confidence} confidence — ${match.reasons[0] ?? "weak signal"}`}
                      </div>
                    )}
                  </td>

                  <td className="muted mono">
                    {isExcluded ? "—" : (previews.get(item.key) ?? "No file to save")}
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
          <button type="button" onClick={submit} className="primary" disabled={busy}>
            {busy
              ? "Saving…"
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
              if (dir) onSettingsChange({ ...settings, outputDir: dir });
            }}
          >
            {settings.outputDir ?? "Choose a folder…"}
          </button>
        </div>

        <p className="aside-note">
          Every record is written to the summary, including those with no certificate file —
          a BambooHR record is evidence in its own right.
        </p>
      </aside>
    </div>
  );
}
