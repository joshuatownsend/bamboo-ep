/**
 * Capability probe, runnable from a terminal.
 *
 * This exists so the three questions the documentation cannot answer can be
 * settled against a real BambooHR account before any UI is built:
 *
 *   1. Does this company answer on the modern host or the legacy gateway?
 *   2. Can a regular employee's key read /training/type (the only source of
 *      human-readable training names), or does it 403?
 *   3. Which of Training, the certifications table, and Employee Files does
 *      this company actually populate?
 *
 * Usage:
 *   BAMBOO_API_KEY=... pnpm probe --subdomain acme [--json report.json]
 */

import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { runProbe } from "../probe.js";
import type { FetchLike } from "../http.js";
import type { ProbeResult } from "../probe.js";

const STATUS_MARK: Record<ProbeResult["status"], string> = {
  ok: "PASS",
  empty: "EMPTY",
  forbidden: "DENIED",
  unavailable: "N/A",
  error: "FAIL",
};

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const subdomain = args.get("subdomain") ?? process.env["BAMBOO_SUBDOMAIN"];
  if (!subdomain) {
    console.error("Missing --subdomain (or set BAMBOO_SUBDOMAIN).");
    console.error("This is the part of your BambooHR web address before .bamboohr.com");
    return 2;
  }

  // Prefer the environment variable so the key never enters shell history.
  let apiKey = process.env["BAMBOO_API_KEY"] ?? args.get("key");
  if (!apiKey) apiKey = await promptForKey();
  if (!apiKey) {
    console.error("No API key supplied.");
    return 2;
  }

  console.log(`\nProbing BambooHR for "${subdomain}"...\n`);

  const report = await runProbe(globalThis.fetch as unknown as FetchLike, {
    subdomain,
    apiKey,
  });

  const width = Math.max(...report.results.map((r) => r.label.length));
  for (const result of report.results) {
    const mark = STATUS_MARK[result.status].padEnd(6);
    console.log(`  ${mark} ${result.label.padEnd(width)}  ${result.detail}`);
  }

  if (report.advice.length > 0) {
    console.log("\nNotes:");
    for (const line of report.advice) console.log(`  - ${wrap(line, 4)}`);
  }

  console.log(
    `\nResult: ${report.usable ? "usable" : "NOT usable"}` +
      (report.connection ? ` via the ${report.connection.style} endpoint` : ""),
  );

  // The answers this run exists to capture, stated plainly.
  if (report.connection) {
    const types = report.results.find((r) => r.id === "trainingTypes");
    console.log("\nOpen questions, answered for this account:");
    console.log(`  1. Endpoint form in use:      ${report.connection.style}`);
    console.log(
      `  2. /training/type readable:   ${
        types?.status === "forbidden" ? "NO (403) - name fallbacks required" : "yes"
      }`,
    );
    console.log(`  3. Populated sources:         ${populatedSources(report.results)}`);
  }

  const jsonPath = args.get("json");
  if (jsonPath) {
    // The credentials live on report.connection; strip them before writing.
    const redacted = {
      ...report,
      connection: report.connection
        ? {
            baseUrl: report.connection.baseUrl,
            style: report.connection.style,
            employeeId: report.connection.employeeId,
          }
        : null,
    };
    await writeFile(jsonPath, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
    console.log(`\nWrote ${jsonPath}`);
  }

  return report.usable ? 0 : 1;
}

function populatedSources(results: ProbeResult[]): string {
  const populated = results
    .filter((r) => r.status === "ok" && r.id !== "connection" && r.id !== "self")
    .map((r) => `${r.label} (${r.count ?? 0})`);
  return populated.length > 0 ? populated.join(", ") : "none";
}

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const [flag, inline] = arg.slice(2).split("=", 2);
    if (!flag) continue;
    if (inline !== undefined) {
      out.set(flag, inline);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.set(flag, next);
        i++;
      }
    }
  }
  return out;
}

async function promptForKey(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("BambooHR API key: ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

function wrap(text: string, indent: number): string {
  const width = 76 - indent;
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${" ".repeat(indent)}`);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
