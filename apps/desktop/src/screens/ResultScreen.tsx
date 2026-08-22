import { openPath } from "@tauri-apps/plugin-opener";
import type { PullResult } from "@bamboo-ep/core";

/**
 * Outcome screen.
 *
 * Reports what actually happened rather than declaring success: partial
 * failures are listed individually, because a user submitting to Essential
 * Personnel needs to know precisely which certificate did not come through.
 */

interface Props {
  result: PullResult;
  outputDir: string | null;
  onRestart: () => void;
}

export function ResultScreen({ result, outputDir, onRestart }: Props) {
  const { summary } = result.manifest;
  const hasFailures = result.failures.length > 0;

  return (
    <div className="screen">
      <div className="screen-main">
        <h2>{hasFailures ? "Finished with some problems" : "Finished"}</h2>

        <dl className="stats">
          <div>
            <dt>Records exported</dt>
            <dd>{summary.totalRecords}</dd>
          </div>
          <div>
            <dt>Certificates saved</dt>
            <dd>{summary.withFile}</dd>
          </div>
          <div>
            <dt>Records without a file</dt>
            <dd>{summary.withoutFile}</dd>
          </div>
          {result.manifest.orphanFiles.length > 0 && (
            <div>
              <dt>Extra files saved</dt>
              <dd>{result.manifest.orphanFiles.length}</dd>
            </div>
          )}
        </dl>

        {hasFailures && (
          <div className="banner error">
            <strong>
              {result.failures.length} file
              {result.failures.length === 1 ? "" : "s"} could not be downloaded:
            </strong>
            <ul>
              {result.failures.map((failure) => (
                <li key={failure.fileId}>
                  {failure.label} — {failure.message}
                </li>
              ))}
            </ul>
            <p>
              Those records are still listed in the summary, marked as having no file
              attached.
            </p>
          </div>
        )}

        <div className="actions">
          {outputDir && (
            <button type="button" className="primary" onClick={() => void openPath(outputDir)}>
              Open the folder
            </button>
          )}
          <button type="button" className="secondary" onClick={onRestart}>
            Start again
          </button>
        </div>
      </div>

      <aside className="screen-aside">
        <h3>What is in the folder</h3>
        <ul className="file-legend">
          <li>
            <strong>One file per certificate</strong>, named after the certification.
          </li>
          <li>
            <strong>Training Summary.pdf</strong> — printable list of every record,
            including those with no file.
          </li>
          <li>
            <strong>Training Summary.csv</strong> — the same list, as a spreadsheet.
          </li>
          <li>
            <strong>manifest.json</strong> — machine-readable details. Keep this: the
            Essential Personnel upload step reads it.
          </li>
        </ul>
      </aside>
    </div>
  );
}
