import { useCallback, useRef, useState } from "react";
import { runPool } from "@bamboo-ep/core";
import type { Preview } from "./preview";

/**
 * Certificate previews, fetched on demand and cached for the session.
 *
 * The pull is deliberately two-phase - phase 1 reads and proposes, phase 2
 * downloads - so file BYTES do not exist during review. Previewing needs them,
 * which looks like a violation but is not: a preview is a read, and reading is
 * exactly what phase 1 is allowed to do. Nothing reaches disk until the user
 * confirms.
 *
 * Downloads are cached by file id and deduplicated while in flight, because
 * the same file backs a thumbnail, a full-size view, and (later) an AI
 * verification request, and BambooHR should be asked for it once.
 */

export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: Preview }
  | { status: "failed"; message: string };

const IDLE: PreviewState = { status: "idle" };

export interface Previews {
  stateOf: (fileId: string) => PreviewState;
  /** Fetch and render, or return what is already cached. Rejects on failure. */
  ensure: (fileId: string) => Promise<Preview>;
  /** Bulk warm-up. Never rejects; per-file failures land in `stateOf`. */
  requestAll: (fileIds: readonly string[]) => Promise<void>;
  /** How many of the given files are still unrendered. */
  pendingCount: (fileIds: readonly string[]) => number;
}

export function usePreviews(render: (fileId: string) => Promise<Preview>): Previews {
  const [states, setStates] = useState<Record<string, PreviewState>>({});
  const cache = useRef(new Map<string, Preview>());
  const inFlight = useRef(new Map<string, Promise<Preview>>());

  const setState = useCallback((fileId: string, state: PreviewState) => {
    setStates((prev) => ({ ...prev, [fileId]: state }));
  }, []);

  const ensure = useCallback(
    (fileId: string): Promise<Preview> => {
      const cached = cache.current.get(fileId);
      if (cached) return Promise.resolve(cached);

      // Two callers wanting the same file must share one download, not race
      // to start two.
      const existing = inFlight.current.get(fileId);
      if (existing) return existing;

      const task = (async () => {
        setState(fileId, { status: "loading" });
        try {
          const preview = await render(fileId);
          cache.current.set(fileId, preview);
          setState(fileId, { status: "ready", preview });
          return preview;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setState(fileId, { status: "failed", message });
          throw err;
        } finally {
          inFlight.current.delete(fileId);
        }
      })();

      inFlight.current.set(fileId, task);
      return task;
    },
    [render, setState],
  );

  const requestAll = useCallback(
    async (fileIds: readonly string[]) => {
      const wanted = fileIds.filter(
        (id) => !cache.current.has(id) && !inFlight.current.has(id),
      );
      // The same bounded pool the download phase uses. Rasterising a PDF is
      // CPU-bound in a single worker, so more parallelism buys nothing and
      // makes BambooHR more likely to throttle.
      await runPool(wanted, 4, async (fileId) => {
        // A failure is already recorded on the individual state; letting it
        // escape here would abandon every remaining file in the batch.
        await ensure(fileId).catch(() => undefined);
      });
    },
    [ensure],
  );

  const pendingCount = useCallback(
    (fileIds: readonly string[]) =>
      fileIds.filter((id) => !cache.current.has(id)).length,
    // `states` is not read here, but a re-render must recompute the count -
    // the cache is a ref and changing it alone would not refresh the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [states],
  );

  const stateOf = useCallback(
    (fileId: string): PreviewState => states[fileId] ?? IDLE,
    [states],
  );

  return { stateOf, ensure, requestAll, pendingCount };
}
