import { useCallback, useRef, useState } from "react";
import { EXTRACTION_JSON_SCHEMA, EXTRACTION_PROMPT, compareExtraction, parseExtraction, runPool } from "@bamboo-ep/core";
import type { EmployeeIdentity, TrainingItem, Verification } from "@bamboo-ep/core";
import { aiExtract } from "./platform";
import type { AiSettings } from "./platform";
import { base64Of } from "./preview";
import type { Previews } from "./usePreviews";

/**
 * Running a document check and holding the results.
 *
 * The sequence is: rasterise page 1 (already cached from the thumbnail), send
 * the image to the model, parse what it says, then compare it against the
 * record IN LOCAL CODE. The model never sees the record it is being checked
 * against, and is never asked whether the pairing is right - only what the
 * page says. Everything downstream of that is deterministic.
 *
 * Asking the model a narrower question is not a technicality. A model shown
 * both the document and the expected answer will tend to agree with the
 * expected answer, which would make the check confirm exactly the mistakes it
 * exists to catch.
 */

export type VerifyState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; verification: Verification }
  | { status: "failed"; message: string };

const IDLE: VerifyState = { status: "idle" };

export interface Verifications {
  stateOf: (itemKey: string) => VerifyState;
  /** Every completed check, keyed by item key, ready for the manifest. */
  all: Readonly<Record<string, Verification>>;
  verify: (item: TrainingItem, fileId: string) => Promise<void>;
  verifyMany: (
    pairs: ReadonlyArray<{ item: TrainingItem; fileId: string }>,
  ) => Promise<void>;
  /** Forget a check, for when its row has been repointed. */
  forget: (itemKey: string) => void;
  busy: boolean;
}

export interface VerificationInput {
  settings: AiSettings;
  identity: EmployeeIdentity | null;
  /** Every record, so a contradiction can name the record that fits better. */
  items: readonly TrainingItem[];
  previews: Previews;
  /**
   * The file a row points at right now. Read when a check COMPLETES, not when
   * it starts: a model call takes seconds, and the row can be repointed while
   * it is in flight.
   */
  currentFileIdOf: (itemKey: string) => string | undefined;
}

export function useVerification(input: VerificationInput): Verifications {
  const { settings, identity, items, previews } = input;
  const [states, setStates] = useState<Record<string, VerifyState>>({});
  const [all, setAll] = useState<Record<string, Verification>>({});
  const running = useRef(0);
  const [busy, setBusy] = useState(false);

  // Held in a ref, and refreshed on every render, so a check that started
  // before a reassignment still reads the CURRENT answer when it finishes
  // rather than the one captured in its closure.
  const currentFileIdOf = useRef(input.currentFileIdOf);
  currentFileIdOf.current = input.currentFileIdOf;

  const verify = useCallback(
    async (item: TrainingItem, fileId: string) => {
      setStates((prev) => ({ ...prev, [item.key]: { status: "running" } }));
      running.current += 1;
      setBusy(true);

      const base = {
        provider: settings.provider,
        model: settings.model || "(provider default)",
        verifiedAt: new Date().toISOString(),
        bambooFileId: fileId,
      };

      /**
       * Land a finished check, unless the row has moved on without it.
       *
       * A late result attached to a newly chosen file would show the reviewer
       * a verdict about a document they are no longer looking at - a false
       * green or a false warning at the exact moment they are deciding
       * whether to save. `executePull` drops the mismatch before writing, but
       * by then the decision has already been made on bad information.
       */
      const land = (verification: Verification, state: VerifyState) => {
        if (currentFileIdOf.current(item.key) !== fileId) return;
        setAll((prev) => ({ ...prev, [item.key]: verification }));
        setStates((prev) => ({ ...prev, [item.key]: state }));
      };

      try {
        const preview = await previews.ensure(fileId);
        const answer = await aiExtract({
          settings,
          prompt: EXTRACTION_PROMPT,
          schema: EXTRACTION_JSON_SCHEMA,
          imageBase64: base64Of(preview.dataUrl),
          imageMime: preview.mimeType,
        });

        const parsed = parseExtraction(answer);
        // A model that answered unusably is recorded as such rather than
        // dropped. "We asked and could not tell" is a different state from
        // "we never asked", and the manifest has to be able to say so.
        const verification: Verification =
          "error" in parsed
            ? {
                ...base,
                extracted: null,
                verdicts: {
                  name: "inconclusive",
                  date: "inconclusive",
                  person: "inconclusive",
                },
                suggestedItemKey: null,
                error: parsed.error,
              }
            : {
                ...base,
                extracted: parsed.extracted,
                ...compareExtraction({
                  item,
                  extracted: parsed.extracted,
                  identity,
                  allItems: items,
                }),
                error: null,
              };

        land(verification, { status: "done", verification });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Recorded in `all`, not only in the UI. `all` is what reaches the
        // manifest, and a dropped failure would be written as
        // `verification: null` - indistinguishable from never having asked.
        // The whole point of Verification.error is to keep that difference.
        land(
          {
            ...base,
            extracted: null,
            verdicts: {
              name: "inconclusive",
              date: "inconclusive",
              person: "inconclusive",
            },
            suggestedItemKey: null,
            error: message,
          },
          { status: "failed", message },
        );
      } finally {
        running.current -= 1;
        if (running.current === 0) setBusy(false);
      }
    },
    [identity, items, previews, settings],
  );

  const verifyMany = useCallback(
    async (pairs: ReadonlyArray<{ item: TrainingItem; fileId: string }>) => {
      // Two at a time. Vision requests are the most rate-limited thing most
      // providers sell, and a burst of twenty would earn a 429 that looks to
      // the user like the feature being broken.
      await runPool(pairs, 2, async ({ item, fileId }) => {
        await verify(item, fileId);
      });
    },
    [verify],
  );

  const forget = useCallback((itemKey: string) => {
    setAll((prev) => {
      if (!(itemKey in prev)) return prev;
      const next = { ...prev };
      delete next[itemKey];
      return next;
    });
    setStates((prev) => ({ ...prev, [itemKey]: IDLE }));
  }, []);

  const stateOf = useCallback(
    (itemKey: string): VerifyState => states[itemKey] ?? IDLE,
    [states],
  );

  return { stateOf, all, verify, verifyMany, forget, busy };
}
