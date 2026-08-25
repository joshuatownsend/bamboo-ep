import { invoke } from "@tauri-apps/api/core";
import { EpClient, type EpFetch, type EpCreateBody } from "@bamboo-ep/core";

/**
 * The desktop side of talking to Essential Personnel.
 *
 * Every request goes through Rust, which holds the member's session cookies
 * from the sign-in window and pins each call to their company's host. See
 * `src-tauri/src/essper.rs` for why the page itself is never asked to make
 * these calls on the app's behalf.
 */

interface EpResponse {
  status: number;
  ok: boolean;
  body: string;
}

/**
 * `EpClient` takes a `fetch`, and this is what it gets: the same shape, but
 * carried over Tauri's bridge. The path is passed through rather than the full
 * URL, because Rust decides which host it belongs to.
 */
function fetchFor(tenant: string): EpFetch {
  return async (input, init) => {
    const path = input.startsWith("http") ? new URL(input).pathname + new URL(input).search : input;
    const response = await invoke<EpResponse>("essper_request", {
      tenant,
      method: init?.method ?? "GET",
      path,
      body: typeof init?.body === "string" ? init.body : null,
    });
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body,
    };
  };
}

/**
 * The base is a path, not a URL. `EpClient` concatenates it with each endpoint
 * and hands the result to the fetch above, where Rust supplies the host.
 */
export function clientFor(tenant: string): EpClient {
  // The app key is read from the company's own config.js in Rust and attached
  // there, so nothing here needs to know it.
  return new EpClient(fetchFor(tenant), "/api", "");
}

export function openEssperLogin(tenant: string): Promise<void> {
  return invoke("essper_open_login", { tenant });
}

export function closeEssperLogin(): Promise<void> {
  return invoke("essper_close_login");
}

export interface EssperMember {
  id: string;
  name: string | null;
}

/**
 * Who Essential Personnel thinks is signed in.
 *
 * Returns `null` for "nobody yet" rather than throwing, because that is the
 * ordinary state while the member is still signing in - the screen polls this
 * and a failure every second is not news.
 */
export async function signedInMember(tenant: string): Promise<EssperMember | null> {
  let response: EpResponse;
  try {
    response = await invoke<EpResponse>("essper_session", { tenant });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  try {
    const body = JSON.parse(response.body) as {
      _id?: unknown;
      profile?: { firstName?: unknown; lastName?: unknown };
    };
    const id = typeof body._id === "string" ? body._id : null;
    if (!id) return null;
    const first = typeof body.profile?.firstName === "string" ? body.profile.firstName.trim() : "";
    const last = typeof body.profile?.lastName === "string" ? body.profile.lastName.trim() : "";
    const name = [first, last].filter(Boolean).join(" ");
    return { id, name: name || null };
  } catch {
    return null;
  }
}

/**
 * Upload one certificate and create the record that cites it.
 *
 * Two requests, in this order, because that is what Essential Personnel
 * expects: the file first, then a record naming the URL it returned. If the
 * second fails the stored file is orphaned - harmless, invisible to the
 * member, and not something this app can clean up, so the caller reports the
 * failure rather than pretending it is recoverable.
 */
export async function submitCertification(
  tenant: string,
  userId: string,
  directory: string,
  submission: {
    templateId: string;
    completed: string;
    expires: string | null;
    institution: string | null;
    savedAs: string;
  },
  file: { contentType: string | null; sha256: string },
): Promise<string> {
  const uploaded = await invoke<EpResponse>("essper_upload_file", {
    tenant,
    directory,
    filename: submission.savedAs,
    contentType: file.contentType,
    expectedSha256: file.sha256,
  });
  if (!uploaded.ok) {
    throw new Error(`Essential Personnel would not accept the file (${uploaded.status}).`);
  }

  const documentUrl = readDocumentUrl(uploaded.body);
  const body: EpCreateBody = {
    userId,
    certificationTemplateId: submission.templateId,
    year: submission.completed,
    expires: submission.expires,
    documentUrl,
  };
  if (submission.institution) body.school = submission.institution;

  return clientFor(tenant).createCertification(body);
}

function readDocumentUrl(raw: string): string {
  let parsed: { file?: unknown };
  try {
    parsed = JSON.parse(raw) as { file?: unknown };
  } catch {
    throw new Error("Essential Personnel accepted the file but its answer could not be read.");
  }
  const url = typeof parsed.file === "string" ? parsed.file.trim() : "";
  if (!url) {
    throw new Error("Essential Personnel accepted the file but returned no address for it.");
  }
  return url;
}
