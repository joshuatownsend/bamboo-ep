import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BambooClient,
  BambooHttp,
  DEFAULT_TEMPLATE,
  MANIFEST_FILENAME,
  executePull,
  gatherWorkspace,
  runProbe,
  serializeManifest,
} from "@bamboo-ep/core";
import type {
  Connection,
  Credentials,
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
  ensureDirectory,
  listExportDirectory,
  loadSettings,
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
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(
    null,
  );

  useEffect(() => {
    void loadSettings().then(setSettings);
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
      setStep("review");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }, [client, connection, settings.confirmedMatches]);

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

      const directory = settings.outputDir ?? (await chooseOutputDirectory());
      if (!directory) return;

      setError(null);
      setBusy("Downloading…");
      setProgress({ done: 0, total: 0, label: "" });

      try {
        await ensureDirectory(directory);

        // A folder holding our own manifest is a previous export, where
        // replacing last run's output is the intent. Any other folder belongs
        // to someone else, so every name already in it is reserved and the
        // write itself refuses to replace anything.
        const existing = await listExportDirectory(directory);
        const isPriorExport = existing.includes(MANIFEST_FILENAME);
        const write = directoryWriter(directory, isPriorExport);

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
          // cannot be allocated the name the PDF below will take. On a folder
          // that is not one of our own exports, everything already in it is
          // claimed too, so no existing document can be displaced.
          reservedFilenames: isPriorExport
            ? [SUMMARY_PDF_FILENAME]
            : [SUMMARY_PDF_FILENAME, ...existing],
          appVersion: APP_VERSION,
          writeFile: write,
          onProgress: (p) =>
            setProgress({ done: p.completed, total: p.total, label: p.currentLabel }),
        });

        // The printable summary is generated here rather than in core, since
        // it is presentation and core stays free of rendering dependencies.
        // Its failure must not erase a pull that otherwise succeeded: the
        // certificates and the manifest are already on disk by this point.
        let finalResult = pullResult;
        try {
          await write(SUMMARY_PDF_FILENAME, buildSummaryPdf(pullResult.manifest));
        } catch (err) {
          const message = `The printable summary could not be created: ${messageOf(err)}. Every certificate and the spreadsheet summary were still saved.`;
          const manifest = {
            ...pullResult.manifest,
            warnings: [...pullResult.manifest.warnings, message],
          };
          finalResult = {
            ...pullResult,
            manifest,
            // Recorded as a failure, not only as a warning. The result screen
            // decides "Finished" from this list, so a run that quietly claims
            // a PDF it never wrote would otherwise look like a clean one.
            failures: [
              ...pullResult.failures,
              { fileId: SUMMARY_PDF_FILENAME, label: "Printable summary", message },
            ],
          };
          // executePull wrote manifest.json before this point, so the warning
          // would otherwise live only in memory - invisible to Part 2 and to
          // anyone reading the folder later.
          try {
            await write(MANIFEST_FILENAME, encodeUtf8(serializeManifest(manifest)));
          } catch {
            /* The manifest on disk is then simply the one without this note. */
          }
        }

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
        {step === "setup" && (
          <SetupScreen
            settings={settings}
            busy={busy != null}
            onConnect={handleConnect}
          />
        )}

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
          />
        )}

        {step === "result" && result && (
          <ResultScreen
            result={result}
            outputDir={settings.outputDir}
            onRestart={restart}
          />
        )}
      </section>
    </main>
  );
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
