import * as pdfjs from "pdfjs-dist";
// Vite rewrites this to a hashed URL and emits the worker as its own asset, so
// the worker is served from the app's own origin. Loading it from a CDN would
// need a CSP hole and would break offline, which this app must not require.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * Rendering the first page of a certificate to a small image.
 *
 * This is the cheapest possible data-quality check: BambooHR records no link
 * between a file and a training record, so every pairing this app shows is a
 * guess. Six certificates were mislabelled in the first live run, and every
 * one of them would have been obvious to a human who could see the document.
 * Showing the page is therefore worth more than any amount of extra scoring.
 *
 * The same rasteriser feeds the AI verification path, which needs an image of
 * page 1 rather than a PDF, so this module is a shared dependency rather than
 * a UI convenience.
 */

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface Preview {
  /** A `data:` URL suitable for both an <img> tag and an AI image payload. */
  dataUrl: string;
  /** Mime type of `dataUrl`, so callers do not have to parse it back out. */
  mimeType: string;
  /** True when the source was a PDF that had to be rasterised. */
  rasterised: boolean;
}

/** Longest edge of the rendered image, in pixels. */
const PAGE_EDGE = 1568;

/**
 * One render serves two readers, so it is sized for the harder one.
 *
 * A 300px thumbnail is enough for a person to tell two certificates apart, but
 * a model has to read body text - and on a certificate the credential is
 * frequently NOT the heading: the page says "Certificate of Commendation" in
 * display type and names the actual qualification in a line of ordinary prose
 * underneath. A live run missed exactly that. 1568px is the largest edge
 * Anthropic's vision models use before downscaling, so it is the most detail
 * available for the same cost. The <img> tag is scaled down by CSS.
 */
export async function renderPreview(
  bytes: Uint8Array,
  contentType: string | null,
  originalFileName: string | null,
): Promise<Preview> {
  if (isPdf(bytes, contentType, originalFileName)) {
    return renderPdfFirstPage(bytes);
  }
  const mimeType = imageMimeType(contentType, originalFileName);
  if (mimeType) {
    return { dataUrl: toDataUrl(bytes, mimeType), mimeType, rasterised: false };
  }
  throw new Error(
    "This file is neither a PDF nor an image, so it cannot be previewed.",
  );
}

async function renderPdfFirstPage(bytes: Uint8Array): Promise<Preview> {
  // pdf.js takes ownership of the buffer it is given and detaches it when the
  // document is destroyed. The caller's copy is cached and reused for the AI
  // path, so hand over a copy rather than the original.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // The app must work offline and its CSP allows no outbound host, so every
    // optional asset fetch is refused rather than left to fail at render time.
    useWorkerFetch: false,
    useSystemFonts: false,
  });

  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = PAGE_EDGE / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale: Math.min(scale, 4) });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This system could not provide a 2D canvas.");

    // Scanned certificates are frequently transparent-background PDFs; without
    // this they render as black-on-transparent and look blank once the image
    // is composited onto a dark UI.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvas, viewport }).promise;
    // JPEG rather than PNG: a scanned page compresses roughly 5-10x better,
    // which matters because these data URLs are also what gets uploaded to a
    // model. Quality is set high because the payload is TEXT - JPEG artefacts
    // land hardest on small lettering, which is exactly what has to be read.
    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.92),
      mimeType: "image/jpeg",
      rasterised: true,
    };
  } finally {
    // Destroying the loading task, not the document: it also tears down the
    // worker port, which is what actually leaks if a preview is abandoned.
    await task.destroy();
  }
}

/**
 * Sniff the PDF magic number as well as trusting the headers. BambooHR serves
 * some files as `application/octet-stream`, and a user-uploaded file may have
 * any extension at all, so the bytes are the only reliable answer.
 */
function isPdf(
  bytes: Uint8Array,
  contentType: string | null,
  originalFileName: string | null,
): boolean {
  if (bytes.length >= 5) {
    const header = String.fromCharCode(...bytes.slice(0, 5));
    if (header === "%PDF-") return true;
  }
  if (contentType?.toLowerCase().includes("pdf")) return true;
  return /\.pdf$/i.test(originalFileName ?? "");
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

function imageMimeType(
  contentType: string | null,
  originalFileName: string | null,
): string | null {
  const declared = contentType?.split(";")[0]?.trim().toLowerCase();
  if (declared?.startsWith("image/")) return declared;

  const name = (originalFileName ?? "").toLowerCase();
  for (const [extension, mime] of Object.entries(IMAGE_EXTENSIONS)) {
    if (name.endsWith(extension)) return mime;
  }
  return null;
}

/**
 * Chunked rather than `String.fromCharCode(...bytes)`: spreading a multi-
 * megabyte array into an argument list overflows the call stack, which showed
 * up only on the largest scans.
 */
export function toDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** Strip the `data:...;base64,` prefix, which model APIs do not want. */
export function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
