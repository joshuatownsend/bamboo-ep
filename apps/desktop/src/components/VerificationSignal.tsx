import type { Verification } from "@bamboo-ep/core";
import type { VerifyState } from "../useVerification";

/**
 * The third signal on a row, after the matcher's confidence and the thumbnail.
 *
 * It is worded as evidence, never as a ruling: "the page reads X" rather than
 * "wrong". The decision was that a contradiction warns and never blocks, and
 * the wording has to match - a check that talks like an authority gets
 * switched off the first time it is wrong, and then catches nothing at all.
 */

interface Props {
  state: VerifyState;
  /** Certification names by item key, so a suggestion can be named. */
  nameOf: (itemKey: string) => string | undefined;
  onRetry: () => void;
}

export function VerificationSignal({ state, nameOf, onRetry }: Props) {
  if (state.status === "idle") return null;

  if (state.status === "running") {
    return <div className="sub verdict-pending">Reading the certificate…</div>;
  }

  if (state.status === "failed") {
    return (
      <div className="sub verdict-failed">
        The check could not run: {state.message}
        <button type="button" className="link-button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <Verdicts verification={state.verification} nameOf={nameOf} onRetry={onRetry} />
  );
}

function Verdicts({
  verification,
  nameOf,
  onRetry,
}: {
  verification: Verification;
  nameOf: (itemKey: string) => string | undefined;
  onRetry: () => void;
}) {
  const { verdicts, extracted, suggestedItemKey, provider, error } = verification;

  if (error) {
    return (
      <div className="sub verdict-failed">
        {provider} could not read this page: {error}
        {/* A model that answered unusably is a completed check with nothing in
            it. Without a way back to "run it again" the row would be stuck,
            re-runnable only by repointing it away and back. */}
        <button type="button" className="link-button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  const problems: string[] = [];
  if (verdicts.person === "contradicts") {
    problems.push(
      `it appears to be issued to ${extracted?.personName ?? "someone else"}`,
    );
  }
  if (verdicts.name === "contradicts") {
    const suggestion = suggestedItemKey ? nameOf(suggestedItemKey) : undefined;
    problems.push(
      suggestion
        ? `the page reads “${extracted?.certificationName ?? "?"}”, which matches ${suggestion}`
        : `the page reads “${extracted?.certificationName ?? "?"}”`,
    );
  }
  if (verdicts.date === "contradicts") {
    problems.push(`the date printed is ${extracted?.issuedDate ?? "different"}`);
  }

  if (problems.length > 0) {
    return (
      <div className="sub verdict-contradicts">
        <strong>Check this one:</strong> {problems.join("; ")}.
        <span className="verdict-source"> Read by {provider}.</span>
      </div>
    );
  }

  const confirmed = Object.values(verdicts).filter((v) => v === "confirms").length;
  if (confirmed === 0) {
    // Every axis inconclusive. Saying only that resolves nothing for the user -
    // they still have to open the document to find out why. So the reading
    // itself is shown: "the page reads X, dated Y" is something a person can
    // act on in a second, and it is what the check actually learned.
    const read = [
      extracted?.certificationName ? `reads “${extracted.certificationName}”` : null,
      extracted?.issuedDate ? `is dated ${extracted.issuedDate}` : null,
      extracted?.personName ? `names ${extracted.personName}` : null,
    ].filter((part): part is string => part != null);

    return (
      <div className="sub verdict-inconclusive">
        {read.length > 0
          ? `Nothing to confirm or contradict — the page ${read.join(", ")}.`
          : "The page did not say enough to confirm or contradict this."}
        <span className="verdict-source"> Read by {provider}.</span>
      </div>
    );
  }

  return (
    <div className="sub verdict-confirms">
      The page agrees{describeAgreement(verdicts)}.
      <span className="verdict-source"> Read by {provider}.</span>
    </div>
  );
}

/** Name what was actually checked, so "agrees" is never mistaken for "all of it". */
function describeAgreement(verdicts: Verification["verdicts"]): string {
  const parts = [
    verdicts.name === "confirms" ? "the certification" : null,
    verdicts.date === "confirms" ? "the date" : null,
    verdicts.person === "confirms" ? "your name" : null,
  ].filter((v): v is string => v != null);
  return parts.length > 0 ? ` on ${parts.join(", ")}` : "";
}
