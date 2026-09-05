import { useCallback, useMemo, useRef, useState } from "react";
import {
  applyDecisionPatch,
  buildEpPlan,
  type EpDecisionPatch,
  type EpDecisions,
  type EpPlan,
  type EpTemplate,
  type EpUserCertification,
  type Manifest,
  submissionFor,
} from "@bamboo-ep/core";
import {
  clientFor,
  closeEssperLogin,
  hideEssperLogin,
  openEssperLogin,
  signedInMember,
  submitCertification,
  type EssperMember,
} from "./essper";

/**
 * The Essential Personnel submission, as state.
 *
 * Everything about *what* to submit lives in `packages/core`; this holds only
 * what the screen needs to ask and to show - who is signed in, what EP said,
 * what the member has decided, and how each upload went.
 */

export type UploadState =
  | { status: "waiting" }
  | { status: "sending" }
  | { status: "sent"; id: string }
  | { status: "failed"; message: string };

export interface EssperState {
  member: EssperMember | null;
  loading: string | null;
  error: string | null;
  plan: EpPlan | null;
  templates: readonly EpTemplate[];
  uploads: Readonly<Record<string, UploadState>>;
  busy: boolean;
}

export function useEssper(manifest: Manifest | null, directory: string | null) {
  const [tenant, setTenant] = useState("");
  const [member, setMember] = useState<EssperMember | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<readonly EpTemplate[]>([]);
  const [existing, setExisting] = useState<readonly EpUserCertification[]>([]);
  const [decisions, setDecisions] = useState<EpDecisions>({});
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [busy, setBusy] = useState(false);

  /**
   * Decisions are held for this session only and never written to disk.
   *
   * Part of the answer to a question review raised twice: an answer given for
   * a record BambooHR gave no id to is keyed by that record's POSITION, which
   * means a different certification on the next run. Not saving anything makes
   * the question moot - the member is looking at the list as they answer, and
   * a submission happens once. Remembering can be added later, for stable keys
   * only, if re-answering ever proves worth avoiding.
   */
  const polling = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (polling.current !== null) {
      window.clearInterval(polling.current);
      polling.current = null;
    }
  }, []);

  /** Open the sign-in window and watch for the session to appear. */
  const signIn = useCallback(
    async (company: string) => {
      setError(null);
      setTenant(company);
      try {
        await openEssperLogin(company);
      } catch (e) {
        setError(messageOf(e));
        return;
      }

      setLoading("Waiting for you to sign in…");
      stopPolling();
      polling.current = window.setInterval(async () => {
        const who = await signedInMember(company);
        if (!who) return;
        stopPolling();
        setMember(who);
        setLoading(null);
      }, 2000);
    },
    [stopPolling],
  );

  /** Read the catalogue and what EP already holds, then plan. */
  const load = useCallback(async () => {
    if (!member || !manifest) return;
    setError(null);
    setLoading("Reading your Essential Personnel record…");
    try {
      const client = clientFor(tenant);
      const [catalogue, held] = await Promise.all([
        client.listTemplates(),
        client.listCertifications(member.id),
      ]);
      setTemplates(catalogue);
      setExisting(held);
      // Out of sight, but NOT closed. Left visible it is a second copy of the
      // member's record sitting behind the app, easy to mistake for the thing
      // they are working in - but that window holds the session cookies every
      // later request depends on, so closing it here signed them out just
      // before the uploads that needed them.
      await hideEssperLogin().catch(() => undefined);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setLoading(null);
    }
  }, [manifest, member, tenant]);

  const plan = useMemo(
    () =>
      manifest && templates.length > 0
        ? buildEpPlan({ entries: manifest.entries, templates, existing, decisions })
        : null,
    [manifest, templates, existing, decisions],
  );

  /**
   * Answer a whole bucket at once.
   *
   * Most of what lands in triage is training the member's own department runs
   * and the county does not track - for a real record that was 144 of 166.
   * Asking someone to click that 144 times is asking them to stop reading
   * after the first twenty, which is worse than a bulk action they can undo:
   * nothing is uploaded either way, and every row keeps its own Undo.
   */
  const decideMany = useCallback((keys: readonly string[], patch: EpDecisionPatch) => {
    setDecisions((current) => {
      const next = { ...current };
      for (const key of keys) merge(next, key, patch);
      return next;
    });
  }, []);

  /** Take back one field's answer across a bucket, leaving the other alone. */
  const forget = useCallback(
    (keys: readonly string[], patch: EpDecisionPatch = { handling: null }) => {
      decideMany(keys, patch);
    },
    [decideMany],
  );

  const decide = useCallback((key: string, patch: EpDecisionPatch | null) => {
    setDecisions((current) => {
      const next = { ...current };
      if (patch === null) delete next[key];
      else merge(next, key, patch);
      return next;
    });
  }, []);

  /**
   * Send everything the plan says is ready.
   *
   * Sequential, not parallel. These are writes to a system of record, and a
   * member watching a list settle one line at a time can tell what happened;
   * eight at once that half-fail cannot be read at a glance. It is also the
   * gentler thing to do to someone else's API.
   */
  const submitAll = useCallback(async () => {
    if (!plan || !member || !directory) return;
    setBusy(true);
    setError(null);

    for (const item of plan.items) {
      if (item.outcome !== "ready") continue;
      const submission = submissionFor(item);
      const file = item.entry.file;
      if (!submission || !file) continue;
      if (uploads[item.entry.key]?.status === "sent") continue;

      setUploads((u) => ({ ...u, [item.entry.key]: { status: "sending" } }));
      try {
        const id = await submitCertification(tenant, member.id, directory, submission, {
          contentType: file.contentType,
          sha256: file.sha256,
        });
        setUploads((u) => ({ ...u, [item.entry.key]: { status: "sent", id } }));
      } catch (e) {
        setUploads((u) => ({
          ...u,
          [item.entry.key]: { status: "failed", message: messageOf(e) },
        }));
      }
    }

    // What EP holds has changed, so the duplicate check is now out of date.
    // Re-reading is what stops a second run of this screen offering to upload
    // everything again.
    await load();
    setBusy(false);
  }, [directory, load, member, plan, tenant, uploads]);

  /**
   * Leave Essential Personnel: close the window, and with it the session.
   *
   * The counterpart to hiding. Once the member is off this screen there is
   * nothing left that needs their session, and a hidden window they cannot see
   * is not something to leave holding one.
   */
  const signOut = useCallback(async () => {
    stopPolling();
    await closeEssperLogin().catch(() => undefined);
    // Everything read or decided belonged to the account that just left. Only
    // clearing `member` left the catalogue, the held records, the answers and
    // the upload results in place, so signing in as someone else would show
    // them a plan built from the previous member's record. The screen unmounts
    // on Back today, which hides this - but the reset is what makes that a
    // convenience rather than the only thing standing between two accounts.
    setMember(null);
    setTemplates([]);
    setExisting([]);
    setDecisions({});
    setUploads({});
    setError(null);
  }, [stopPolling]);

  return {
    tenant,
    member,
    loading,
    error,
    plan,
    templates,
    uploads,
    busy,
    signIn,
    load,
    decide,
    decideMany,
    forget,
    submitAll,
    signOut,
    stopPolling,
  };
}

/** `applyDecisionPatch` against a mutable draft, since every caller has one. */
function merge(draft: Record<string, EpDecisions[string]>, key: string, patch: EpDecisionPatch) {
  const merged = applyDecisionPatch(draft[key], patch);
  if (merged) draft[key] = merged;
  else delete draft[key];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
