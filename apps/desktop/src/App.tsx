import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BambooClient,
  BambooHttp,
  DEFAULT_TEMPLATE,
  MANIFEST_FILENAME,
  SUMMARY_CSV_FILENAME,
  executePull,
  gatherWorkspace,
  parseManifest,
  runProbe,
  serializeManifest,
} from "@bamboo-ep/core";
import type {
  Connection,
  Credentials,
  Manifest,
  ProbeReport,
  PullResult,
  Verification,
  Workspace,
} from "@bamboo-ep/core";
import {
  DEFAULT_SETTINGS,
  chooseOutputDirectory,
  credentialStore,
  directoryWriter,
  deleteExportFile,
  ensureDirectory,
  listExportDirectory,
  loadSettings,
  readExportFile,
  platformFetch,
  saveSettings,
} from "./platform";
import type { Settings } from "./platform";
import { SetupScreen } from "./screens/SetupScreen";
import { ProbeScreen } from "./screens/ProbeScreen";
import { ReviewScreen } from "./screens/ReviewScreen";
import { ResultScreen } from "./screens/ResultScreen";
import { SUMMARY_PDF_FILENAME, buildSummaryPdf } from "./pdf";
import "./App.css";

const APP_VERSION = "0.1.0";

type Step = "setup" | "probe" | "review" | "result";

const STEP_LABELS: Array<{ step: Step; label: string }> = [
  { step: "setup", label: "Connect" },
  { step: "probe", label: "Check access" },
  { step: "review", label: "Review matches" },
  { step: "result", label: "Done" },
];

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [step, setStep] = useState<Step>("setup");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [report, setReport] = useState<ProbeReport | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [result, setResult] = useState<PullResult | null>(null);
  /**
   * Held in state so the review screen's "Will be saved as" column allocates
   * against the same reservations the pull will. Without it the preview
   * promised `CPR.pdf` while the export wrote `CPR (2).pdf` - wrong precisely
   * when the collision protection did something.
   */
  const [exportPlan, setExportPlan] = useState<ExportPlan>(EMPTY_PLAN);
  /**
   * Trouble with the export itself - the printable summary, the manifest, or
   * clearing a previous run's files - as opposed to a certificate that would
   * not download. Held apart because the two need different words and send the
   * user to different places.
   */
  const [exportProblems, setExportProblems] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(
    null,
  );

  /**
   * False until the stored settings have arrived. The setup form is not shown
   * before then: this load overwrites `subdomain`, and a user who had already
   * typed a company and pasted a key would have the company silently swapped
   * under them - sending that key to whichever company was stored last.
   */
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    void loadSettings().then((stored) => {
      setSettings(stored);
      setSettingsLoaded(true);
    });
  }, []);

  const client = useMemo(
    () =>
      connection
        ? new BambooClient(
            new BambooHttp(platformFetch, connection.baseUrl, connection.credentials),
          )
        : null,
    [connection],
  );

  const persist = useCallback(async (next: Settings) => {
    setSettings(next);
    await saveSettings(next);
  }, []);

  /** Step 1: probe. Answers what this particular key is allowed to do. */
  const handleConnect = useCallback(
    async (credentials: Credentials, remember: boolean) => {
      setError(null);
      setBusy("Checking your BambooHR access…");
      try {
        const probeReport = await runProbe(platformFetch, credentials);
        setReport(probeReport);
        setConnection(probeReport.connection);
        setStep("probe");

        // Unticking "remember" has to REMOVE what is stored, not merely skip
        // saving. Otherwise a key saved on an earlier run outlives the user
        // explicitly opting out, and is offered back on the next launch.
        if (probeReport.connection) {
          if (remember) {
            await credentialStore.save(credentials.subdomain, credentials.apiKey);
          } else {
            await credentialStore.remove(credentials.subdomain);
          }
        }
        await persist({ ...settings, subdomain: credentials.subdomain });
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusy(null);
      }
    },
    [persist, settings],
  );

  /** Step 2: read everything and propose matches. Writes nothing yet. */
  const handleGather = useCallback(async () => {
    if (!client || !connection) return;
    setError(null);
    setBusy("Reading your training records…");
    try {
      const confirmed = settings.confirmedMatches[connection.credentials.subdomain] ?? {};
      const gathered = await gatherWorkspace(client, connection, { confirmed });
      setWorkspace(gathered);
      setExportPlan(
        settings.outputDir ? await planExportInto(settings.outputDir, connection) : EMPTY_PLAN,
      );
      setStep("review");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }, [client, connection, settings.confirmedMatches, settings.outputDir]);

  /**
   * Step 3: download. Only reached after the user has confirmed the pairings,
   * because the matching is a heuristic and mislabelled certificates are worse
   * than no certificates.
   */
  const handleDownload = useCallback(
    async (
      confirmed: Record<string, string>,
      excludedItemKeys: string[],
      nextSaved: Record<string, string>,
      verifications: Record<string, Verification>,
    ) => {
      if (!client || !connection || !workspace) return;

      // Picking the folder here rather than on the review screen means the
      // filenames the user just read were allocated against no folder at all.
      // If the chosen one already holds a colliding name, the export would
      // quietly add a suffix to something they were shown without it. So the
      // choice is taken, the preview updated, and the save left for them to
      // confirm - the "Will be saved as" column is a promise, and this is the
      // one path that could have broken it silently.
      if (!settings.outputDir) {
        const chosen = await chooseOutputDirectory();
        if (!chosen) return;
        await persist({ ...settings, outputDir: chosen });
        setExportPlan(await planExportInto(chosen, connection));
        setError(
          `Saving to ${chosen}. Check the file names below, then press Save again.`,
        );
        return;
      }
      const directory = settings.outputDir;

      setError(null);
      setBusy("Downloading…");
      setProgress({ done: 0, total: 0, label: "" });

      try {
        await ensureDirectory(directory);

        // Recomputed here rather than reused from the review screen: the
        // folder may only have been chosen a moment ago, and its contents can
        // have changed while the user was reviewing.
        const plan = await planExportInto(directory, connection);
        // Only what the previous export actually produced may be replaced.
        const replaceable = new Set(plan.priorOutputs);

        // The manifest and the two summaries are written under fixed names,
        // which the allocator can steer certificates away from but cannot
        // rename. In a folder that is not ours those names may already be
        // taken, and the write refuses to replace them - after every
        // certificate has been downloaded, leaving a folder of files with no
        // manifest to describe them. Better to say so before starting.
        // Compared case-insensitively, because the filesystems this runs on
            // mostly are. `Manifest.json` already occupies the path that
            // `manifest.json` needs, and a case-sensitive check would let the
            // export download every certificate before failing on the one
            // filename it cannot vary. FilenameAllocator already folds case
            // for exactly this reason.
        const takenLower = new Set(plan.reserved.map((name) => name.toLowerCase()));
        const blocked = FIXED_OUTPUT_NAMES.filter((name) =>
          takenLower.has(name.toLowerCase()),
        );
        if (blocked.length > 0) {
          throw new Error(
            `That folder already contains ${blocked.join(", ")}, which this export ` +
              "would have to replace, and it was not written by this app. Choose an " +
              "empty folder, or one you exported to before.",
          );
        }

        const write = directoryWriter(directory, replaceable);

        const pullResult = await executePull({
          client,
          connection,
          workspace,
          decisions: {
            confirmed,
            excludedItemKeys,
            includeOrphanFiles: settings.includeOrphanFiles,
            verifications,
          },
          // Normalised here rather than left to core's `??`, which catches
          // only undefined: once the user cleared the format field, the empty
          // string reached the pull while the review preview had already
          // fallen back to the default, so the name shown was not the name
          // written.
          filenameTemplate: settings.filenameTemplate || DEFAULT_TEMPLATE,
          // Claimed up front so a certification named "Training Summary"
          // cannot be allocated the name the PDF below will take, plus
          // whatever in the folder belongs to someone other than this export.
          reservedFilenames: [SUMMARY_PDF_FILENAME, ...plan.reserved],
          appVersion: APP_VERSION,
          writeFile: write,
          onProgress: (p) =>
            setProgress({ done: p.completed, total: p.total, label: p.currentLabel }),
        });

        // The printable summary is generated here rather than in core, since
        // it is presentation and core stays free of rendering dependencies.
        // Its failure must not erase a pull that otherwise succeeded: the
        // certificates and the manifest are already on disk by this point.
        // Always rewritten after the printable summary is attempted, so
        // `outputs` names what this export ACTUALLY produced - including
        // whether the PDF made it. That record is what lets the next run
        // replace its own files without ever touching one of the user's.
        // The manifest is ours by construction - this run wrote it moments ago -
        // so it is replaceable even on a first export into an empty folder.
        const replace = directoryWriter(directory, new Set([MANIFEST_FILENAME]));

        // Two separate operations, two separate outcomes. Sharing one catch
        // meant a failure to rewrite the manifest was reported as the PDF
        // having failed - while the PDF sat on disk, unclaimed by a manifest
        // that had not been updated, so the NEXT export saw a fixed output
        // name occupied by a file it did not own and refused the folder.
        let pdfWritten = false;
        const problems: string[] = [];

        try {
          await write(SUMMARY_PDF_FILENAME, buildSummaryPdf(pullResult.manifest));
          pdfWritten = true;
        } catch (err) {
          problems.push(
            `The printable summary could not be created: ${messageOf(err)}. ` +
              "Every certificate and the spreadsheet summary were still saved.",
          );
        }

        // Files the last export produced that this one did not. A changed
        // filename template, an excluded record, or a file removed in BambooHR
        // all leave certificates behind that appear in no manifest and no
        // summary - and a stale certificate in an export folder is exactly the
        // kind of thing someone downstream takes at face value.
        //
        // Only ever prior-manifest outputs: anything the user put there
        // themselves was never ours to remove.
        //
        // Done BEFORE the manifest is rewritten, so a file that could not be
        // removed is recorded in the manifest rather than only in memory.
        const produced = new Set<string>([
          ...pullResult.filesWritten,
          MANIFEST_FILENAME,
          SUMMARY_CSV_FILENAME,
          ...(pdfWritten ? [SUMMARY_PDF_FILENAME] : []),
        ]);
        const undeleted: string[] = [];
        for (const name of plan.priorOutputs.filter((name) => !produced.has(name))) {
          // A folder left slightly untidy is a far smaller problem than a
          // failed export, so this never sinks the run - but it is reported.
          // Silence here would recreate the very thing the cleanup exists to
          // prevent: a stale certificate sitting in a folder whose manifest,
          // summary and result screen all say the export is complete.
          await deleteExportFile(directory, name).catch(() => undeleted.push(name));
        }
        if (undeleted.length > 0) {
          problems.push(
            "These files from a previous export could not be removed and are still " +
              `in the folder, though they appear in no summary: ${undeleted.join(", ")}.`,
          );
        }

        // Rewritten whatever happened, so `outputs` names what is actually in
        // the folder. executePull wrote the manifest before the PDF existed.
        const manifest = {
          ...pullResult.manifest,
          outputs: pdfWritten
            ? [...pullResult.manifest.outputs, SUMMARY_PDF_FILENAME]
            : pullResult.manifest.outputs,
        };

        try {
          // Deliberately NOT `write`: on a first export into an empty folder
          // that writer is in create-new mode, so rewriting a file it just
          // created is guaranteed to fail. Replacing our own manifest, seconds
          // after writing it, is the one case where overwriting is
          // unambiguously right.
          await replace(
            MANIFEST_FILENAME,
            encodeUtf8(serializeManifest({ ...manifest, warnings: [...manifest.warnings, ...problems] })),
          );
        } catch (err) {
          problems.push(`The manifest could not be updated: ${messageOf(err)}.`);
          // The manifest on disk is now the one executePull wrote, which does
          // not claim the PDF. Leaving the PDF there would make the folder
          // disagree with its own manifest and lock the next export out of it,
          // so the unclaimed file goes rather than the record being wrong.
          if (pdfWritten) {
            // Removing it is what keeps the folder agreeing with its own
            // manifest. If that fails too, the folder is left in a state the
            // NEXT export will refuse - a fixed output name held by a file no
            // manifest claims - so the user is told plainly what to delete
            // rather than meeting an unexplained refusal later.
            try {
              await deleteExportFile(directory, SUMMARY_PDF_FILENAME);
              pdfWritten = false;
            } catch (removalError) {
              problems.push(
                `"${SUMMARY_PDF_FILENAME}" was written but the manifest does not ` +
                  `list it, and it could not be removed: ${messageOf(removalError)}. ` +
                  "Delete that file before exporting to this folder again.",
              );
            }
          }
        }

        // Kept OUT of `failures`, which means "a certificate could not be
        // downloaded" - the result screen tells the user those records are
        // marked as having no file and sends them looking for missing
        // certificates. A summary that could not be written, or a stale file
        // that could not be removed, is a different problem with a different
        // remedy, and every certificate may well have saved perfectly.
        const finalResult = {
          ...pullResult,
          manifest: { ...manifest, warnings: [...manifest.warnings, ...problems] },
        };
        setExportProblems(problems);


        setResult(finalResult);
        setStep("result");

        // REPLACE this company's saved choices rather than merging into them.
        // Merging could only ever add, so a pairing the user cleared kept
        // coming back on the next run with no way to remove it.
        await persist({
          ...settings,
          outputDir: directory,
          confirmedMatches: {
            ...settings.confirmedMatches,
            [connection.credentials.subdomain]: nextSaved,
          },
        });
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusy(null);
        setProgress(null);
      }
    },
    [client, connection, persist, settings, workspace],
  );

  /**
   * Read one file's bytes without writing anything, for the review previews.
   * This is a read, so it belongs to phase 1 - the two-phase split is about
   * not WRITING before the user has confirmed, not about not looking.
   */
  const loadFileBytes = useCallback(
    async (fileId: string) => {
      if (!client || !connection) throw new Error("Not connected to BambooHR.");
      const { bytes, contentType } = await client.downloadFile(
        connection.employeeId,
        fileId,
      );
      return { bytes, contentType };
    },
    [client, connection],
  );

  /** Discard saved choices for this company and re-run matching from scratch. */
  const handleClearSaved = useCallback(async () => {
    if (!client || !connection) return;
    const subdomain = connection.credentials.subdomain;

    setBusy("Re-matching your records…");
    try {
      // Inside the try: a settings store that cannot write would otherwise
      // reject unhandled, leaving in-memory state already changed and the
      // error banner never shown.
      await persist({
        ...settings,
        confirmedMatches: { ...settings.confirmedMatches, [subdomain]: {} },
      });
      // Deliberately gathered with no confirmations, so every pairing is
      // scored fresh rather than inherited.
      setWorkspace(await gatherWorkspace(client, connection, { confirmed: {} }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }, [client, connection, persist, settings]);

  const restart = useCallback(() => {
    setStep("setup");
    setReport(null);
    setConnection(null);
    setWorkspace(null);
    setResult(null);
    setExportProblems([]);
    setError(null);
  }, []);

  return (
    <main className="app">
      <header className="app-header">
        <h1>BambooHR Training Export</h1>
        <ol className="steps">
          {STEP_LABELS.map(({ step: s, label }, index) => (
            <li
              key={s}
              className={
                s === step ? "current" : index < STEP_LABELS.findIndex((x) => x.step === step)
                  ? "done"
                  : ""
              }
            >
              <span className="step-index">{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </header>

      {error && (
        <div className="banner error" role="alert">
          <strong>Something went wrong.</strong> {error}
        </div>
      )}

      {busy && (
        <div className="banner busy" role="status">
          {busy}
          {progress && progress.total > 0 && (
            <>
              {" "}
              <span className="progress-count">
                {progress.done} of {progress.total}
              </span>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ transform: `scaleX(${progress.done / progress.total})` }}
                />
              </div>
              {progress.label && <span className="progress-label">{progress.label}</span>}
            </>
          )}
        </div>
      )}

      <section className="app-body">
        {step === "setup" &&
          (settingsLoaded ? (
            <SetupScreen
              settings={settings}
              busy={busy != null}
              onConnect={handleConnect}
            />
          ) : (
            <p className="muted">Loading your saved settings…</p>
          ))}

        {step === "probe" && report && (
          <ProbeScreen
            report={report}
            busy={busy != null}
            onContinue={handleGather}
            onBack={restart}
          />
        )}

        {step === "review" && workspace && (
          <ReviewScreen
            workspace={workspace}
            settings={settings}
            busy={busy != null}
            onSettingsChange={persist}
            onDownload={handleDownload}
            onClearSaved={handleClearSaved}
            onBack={() => setStep("probe")}
            loadFileBytes={loadFileBytes}
            identity={connection?.employee ?? null}
            reservedFilenames={exportPlan.reserved}
            onOutputDirChosen={async (directory) => {
              if (!connection) return;
              setExportPlan(await planExportInto(directory, connection));
            }}
          />
        )}

        {step === "result" && result && (
          <ResultScreen
            result={result}
            exportProblems={exportProblems}
            outputDir={settings.outputDir}
            onRestart={restart}
          />
        )}
      </section>
    </main>
  );
}

/** What may be replaced in the chosen folder, and what may not. */
export interface ExportPlan {
  /** Names the allocator must not hand out, because something else owns them. */
  reserved: string[];
  /** Whether a generated name may replace a file already at that path. */
  overwrite: boolean;
  /**
   * Files the previous export produced and that are still on disk. Anything
   * here the new export does not produce is superseded and can be cleared.
   */
  priorOutputs: string[];
}

const EMPTY_PLAN: ExportPlan = { reserved: [], overwrite: false, priorOutputs: [] };

/** Written under names the allocator cannot vary, so collisions are fatal. */
const FIXED_OUTPUT_NAMES = [
  MANIFEST_FILENAME,
  SUMMARY_CSV_FILENAME,
  SUMMARY_PDF_FILENAME,
] as const;

/**
 * Work out what is safe to write over in a folder.
 *
 * Two separate questions, and conflating them was the bug. Whether the folder
 * is a previous export of THIS employee decides whether replacing is the
 * intent at all. But even then, ownership of the folder is not ownership of
 * everything in it: a document the user dropped in afterwards is theirs, and a
 * certificate must not be allowed to take its name. So the prior manifest is
 * read for the list of files it actually produced, and anything present but
 * unaccounted for is reserved.
 */
async function planExportInto(
  directory: string,
  connection: Connection,
): Promise<ExportPlan> {
  const existing = await listExportDirectory(directory).catch((): string[] => []);
  if (existing.length === 0) return EMPTY_PLAN;

  const prior = existing.includes(MANIFEST_FILENAME)
    ? await readPriorManifest(directory, connection)
    : null;

  // Not ours: nothing here may be touched, so every name is claimed.
  if (!prior) return { reserved: existing, overwrite: false, priorOutputs: [] };

  const ours = outputsOf(prior);
  return {
    reserved: existing.filter((name) => !ours.has(name)),
    overwrite: true,
    priorOutputs: existing.filter((name) => ours.has(name)),
  };
}

/**
 * The prior manifest, but only if it describes this same employee. Another
 * employee's export, an unreadable file, or one edited by hand all mean "treat
 * this as someone else's folder" - settings remember a single output folder
 * while credentials and matches both support several companies, so a second
 * employee exporting here is an ordinary thing to do, not an odd one.
 */
async function readPriorManifest(
  directory: string,
  connection: Connection,
): Promise<Manifest | null> {
  const text = await readExportFile(directory, MANIFEST_FILENAME).catch(() => null);
  if (!text) return null;

  const parsed = parseManifest(text);
  if ("error" in parsed) return null;

  // parseManifest checks the version and that `entries` is an array, which is
  // all Part 2 needs to refuse a file it cannot read. Authorising REPLACEMENT
  // is a stronger claim, so every field read below is checked here: a manifest
  // that was partially copied or hand-edited must fall back to "not ours",
  // which is what the surrounding contract promises, rather than throwing on
  // a missing array and stranding the user before the review screen.
  const manifest = parsed.manifest;
  const structurallySound =
    Array.isArray(manifest.entries) &&
    Array.isArray(manifest.orphanFiles) &&
    typeof manifest.source?.subdomain === "string" &&
    typeof manifest.source?.employeeId === "string";
  if (!structurallySound) return null;

  const sameEmployee =
    manifest.source.subdomain === connection.credentials.subdomain &&
    manifest.source.employeeId === connection.employeeId;
  return sameEmployee ? manifest : null;
}

/**
 * Every filename a previous run of this app put in the folder.
 *
 * Read from the manifest's own record of what it wrote. The earlier version
 * derived this, and assumed the two summaries and the manifest were always
 * present - but the printable summary is written AFTER the manifest and can
 * fail, so a folder could be missing it. A user who then put their own
 * "Training Summary.pdf" there would have had it replaced by the next export,
 * on the strength of a file we had merely assumed we once wrote.
 *
 * The manifest and the CSV are still claimed unconditionally: executePull
 * writes both before the manifest exists at all, so a manifest being there is
 * proof they were produced.
 */
function outputsOf(manifest: Manifest): Set<string> {
  const names = new Set<string>([MANIFEST_FILENAME, SUMMARY_CSV_FILENAME]);
  // Type-checked rather than trusted: a name that is not a string would
  // otherwise be added as one and quietly mark some real file as ours - the
  // same over-claiming this function exists to prevent.
  for (const name of Array.isArray(manifest.outputs) ? manifest.outputs : []) {
    if (typeof name === "string") names.add(name);
  }
  for (const entry of manifest.entries) {
    if (typeof entry?.file?.savedAs === "string") names.add(entry.file.savedAs);
  }
  for (const orphan of manifest.orphanFiles) {
    if (typeof orphan?.savedAs === "string") names.add(orphan.savedAs);
  }
  return names;
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
