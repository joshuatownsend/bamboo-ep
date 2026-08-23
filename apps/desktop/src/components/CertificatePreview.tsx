import { useEffect } from "react";
import type { PreviewState } from "../usePreviews";

/**
 * The thumbnail shown beside each proposed pairing.
 *
 * This is the single highest-value data-quality feature in the app. Every one
 * of the six certificates mislabelled in the first live run was obviously
 * wrong once the page was visible, and none of them was obviously wrong from
 * the filename alone - which is all the matcher ever sees.
 */

interface Props {
  state: PreviewState;
  /** Shown as the image's alternative text and the lightbox caption. */
  label: string;
  onLoad: () => void;
  onZoom: () => void;
}

export function CertificatePreview({ state, label, onLoad, onZoom }: Props) {
  if (state.status === "ready") {
    return (
      <button
        type="button"
        className="preview-thumb"
        onClick={onZoom}
        title="Click to see the full page"
      >
        <img src={state.preview.dataUrl} alt={`First page of ${label}`} />
      </button>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="preview-thumb preview-thumb-empty" role="status">
        Loading…
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="preview-thumb preview-thumb-empty preview-thumb-failed">
        {/* The reason matters: "not a PDF or image" is a different problem
            from "the download was refused", and only one is worth retrying. */}
        <span title={state.message}>No preview</span>
        <button type="button" className="link-button" onClick={onLoad}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <button type="button" className="preview-thumb preview-thumb-empty" onClick={onLoad}>
      Show page
    </button>
  );
}

interface LightboxProps {
  dataUrl: string;
  label: string;
  onClose: () => void;
}

/**
 * A thumbnail is enough to tell two certificates apart; it is not enough to
 * read a name or an expiry date off a scan. This is the full-resolution view.
 */
export function PreviewLightbox({ dataUrl, label, onClose }: LightboxProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={label}>
      {/* The backdrop is the dismiss target, so a click anywhere outside the
          page closes it - the behaviour every image viewer has trained for. */}
      <button
        type="button"
        className="lightbox-backdrop"
        aria-label="Close preview"
        onClick={onClose}
      />
      <figure className="lightbox-figure">
        <img src={dataUrl} alt={`First page of ${label}`} />
        <figcaption>
          <span>{label}</span>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </figcaption>
      </figure>
    </div>
  );
}
