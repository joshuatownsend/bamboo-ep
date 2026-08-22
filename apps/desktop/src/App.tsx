import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BambooClient,
  BambooHttp,
  executePull,
  gatherWorkspace,
  runProbe,
} from "@bamboo-ep/core";
import type {
  Connection,
  Credentials,
  ProbeReport,
  PullResult,
  Workspace,
} from "@bamboo-ep/core";
import {
  DEFAULT_SETTINGS,
  chooseOutputDirectory,
  credentialStore,
  directoryWriter,
  ensureDirectory,
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

        if (remember && probeReport.connection) {
          await credentialStore.save(credentials.subdomain, credentials.apiKey);
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
    ) => {
      if (!client || !connection || !workspace) return;

      const directory = settings.outputDir ?? (await chooseOutputDirectory());
      if (!directory) return;

      setError(null);
      setBusy("Downloading…");
      setProgress({ done: 0, total: 0, label: "" });

      try {
        await ensureDirectory(directory);
        const write = directoryWriter(directory);

        const pullResult = await executePull({
          client,
          connection,
          workspace,
          decisions: {
            confirmed,
            excludedItemKeys,
            includeOrphanFiles: settings.includeOrphanFiles,
          },
          filenameTemplate: settings.filenameTemplate,
          // Claimed up front so a certification named "Training Summary"
          // cannot be allocated the name the PDF below will take.
          reservedFilenames: [SUMMARY_PDF_FILENAME],
          appVersion: APP_VERSION,
          writeFile: write,
          onProgress: (p) =>
            setProgress({ done: p.completed, total: p.total, label: p.currentLabel }),
        });

        // The printable summary is generated here rather than in core, since
        // it is presentation and core stays free of rendering dependencies.
        // Its failure must not erase a pull that otherwise succeeded: the
        // certificates and the manifest are already on disk by this point.
        let pdfWarning: string | null = null;
        try {
          await write(SUMMARY_PDF_FILENAME, buildSummaryPdf(pullResult.manifest));
        } catch (err) {
          pdfWarning = `The printable summary could not be created: ${messageOf(err)}. Every certificate and the spreadsheet summary were still saved.`;
        }

        setResult(
          pdfWarning
            ? {
                ...pullResult,
                manifest: {
                  ...pullResult.manifest,
                  warnings: [...pullResult.manifest.warnings, pdfWarning],
                },
              }
            : pullResult,
        );
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

  /** Discard saved choices for this company and re-run matching from scratch. */
  const handleClearSaved = useCallback(async () => {
    if (!client || !connection) return;
    const subdomain = connection.credentials.subdomain;

    const next: Settings = {
      ...settings,
      confirmedMatches: { ...settings.confirmedMatches, [subdomain]: {} },
    };
    await persist(next);

    setBusy("Re-matching your records…");
    try {
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
