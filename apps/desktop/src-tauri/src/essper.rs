//! Talking to Essential Personnel on behalf of the signed-in member.
//!
//! LC-CFRS mandates Active Directory SSO as the only authorized login, so
//! there is no credential this app could hold even if it wanted to. The member
//! signs in themselves, in a window of their own, and what this module borrows
//! afterwards is that session.
//!
//! # Why the requests are made here and not in the login window
//!
//! The obvious implementation is to let the Essential Personnel page issue the
//! calls, since it already has the session, and hand the results back over
//! Tauri's IPC. That would mean granting a **remote origin** the ability to
//! invoke this application's commands - the same commands that read the
//! operating system's credential store and write files to disk. One cross-site
//! scripting flaw anywhere in a large third-party application, or a
//! compromise of the site itself, would then reach the member's BambooHR API
//! key. No convenience is worth that.
//!
//! Instead the login window is given nothing at all: no IPC, no injected
//! script, no privileges. Tauri can read the cookies that window holds, so the
//! requests are issued from Rust with the session attached, and the page is
//! never asked to do anything on this app's behalf.
//!
//! # What this module will not do
//!
//! Every request is pinned to the one tenant host the member named. `path` is
//! required to be a rooted path and is rejected if it carries a scheme, a
//! host, or a protocol-relative prefix - so no caller, and no data returned by
//! Essential Personnel, can redirect these authenticated requests somewhere
//! else.

use serde::Serialize;
use std::time::Duration;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The label of the sign-in window. Fixed, so a second attempt reuses the
/// window the member already has open rather than stacking another on top.
const LOGIN_WINDOW: &str = "essper-login";

/// Certificates are small; this is a guard against a runaway response, not a
/// meaningful limit. Essential Personnel's own form accepts up to 100 MB.
const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Serialize)]
pub struct EpResponse {
    status: u16,
    ok: bool,
    body: String,
}

/// `lccfrs` -> `https://lccfrs.essper.com`.
///
/// Accepts a bare company label, or a full address whose host is already under
/// `essper.com`. Anything else is refused rather than repaired: an earlier
/// version took the text before the first dot, which quietly turned
/// `evil.com/` into `evil.essper.com` and sent the member somewhere they never
/// asked to go, with no sign anything had been changed.
fn tenant_origin(tenant: &str) -> Result<String, String> {
    let raw = tenant.trim();
    let complaint = || {
        format!(
            "\"{tenant}\" is not an Essential Personnel address. Use just the company name, \
             like \"lccfrs\", or the full address you sign in at."
        )
    };

    let label = if raw.contains("://") || raw.contains('/') || raw.contains('.') {
        // Treat it as an address. Parsing is what decides the host - not
        // string surgery, which is how the previous version went wrong.
        let with_scheme = if raw.contains("://") {
            raw.to_string()
        } else {
            format!("https://{raw}")
        };
        let url = Url::parse(&with_scheme).map_err(|_| complaint())?;
        if url.scheme() != "https" && url.scheme() != "http" {
            return Err(complaint());
        }
        let host = url.host_str().ok_or_else(complaint)?.to_ascii_lowercase();
        let label = host.strip_suffix(".essper.com").ok_or_else(complaint)?;
        if label.contains('.') {
            return Err(complaint());
        }
        label.to_string()
    } else {
        raw.to_ascii_lowercase()
    };

    let valid = !label.is_empty()
        && label.len() <= 63
        && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !label.starts_with('-')
        && !label.ends_with('-');

    if !valid {
        return Err(complaint());
    }
    Ok(format!("https://{label}.essper.com"))
}

/// A rooted path on the tenant host, and nothing else.
fn tenant_url(tenant: &str, path: &str) -> Result<String, String> {
    // `//evil.example` is protocol-relative and would resolve to another host;
    // a backslash is treated as a slash by some parsers. Both are refused
    // rather than normalised, because there is no legitimate caller for either.
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains("://")
    {
        return Err(format!("Refusing to request \"{path}\": not a path on this company's site."));
    }
    Ok(format!("{}{}", tenant_origin(tenant)?, path))
}

/// Open the window where the member signs in.
///
/// Deliberately a plain browser window: no `initialization_script`, no
/// capabilities, and therefore no way for the page to reach this application.
#[tauri::command]
pub async fn essper_open_login(app: tauri::AppHandle, tenant: String) -> Result<(), String> {
    let origin = tenant_origin(&tenant)?;
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = Url::parse(&origin).map_err(|e| format!("Could not open {origin}: {e}"))?;
    WebviewWindowBuilder::new(&app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title("Sign in to Essential Personnel")
        .inner_size(1100.0, 900.0)
        .build()
        .map_err(|e| format!("Could not open the Essential Personnel window: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn essper_close_login(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        window
            .close()
            .map_err(|e| format!("Could not close the Essential Personnel window: {e}"))?;
    }
    Ok(())
}

/// The member's session, taken from the login window.
///
/// Returns an empty string when there is no window or no cookie yet, which is
/// the ordinary "not signed in" state rather than a failure.
fn session_cookies(app: &tauri::AppHandle, tenant: &str) -> Result<String, String> {
    let Some(window) = app.get_webview_window(LOGIN_WINDOW) else {
        return Ok(String::new());
    };
    let origin = tenant_origin(tenant)?;
    let url = Url::parse(&origin).map_err(|e| format!("Could not read the session: {e}"))?;

    let cookies = window
        .cookies_for_url(url)
        .map_err(|e| format!("Could not read the Essential Personnel session: {e}"))?;

    Ok(cookies
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; "))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // A redirect off the tenant host would carry the session cookie with
        // it. Nothing in this API legitimately redirects, so any redirect is
        // refused outright rather than followed carefully.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Could not start an HTTP client: {e}"))
}

/// Whether the member is signed in, and who Essential Personnel thinks they are.
#[tauri::command]
pub async fn essper_session(app: tauri::AppHandle, tenant: String) -> Result<EpResponse, String> {
    essper_request(app, tenant, "GET".into(), "/api/user/me".into(), None).await
}

/// A JSON request against the tenant's API, carrying the member's session.
#[tauri::command]
pub async fn essper_request(
    app: tauri::AppHandle,
    tenant: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<EpResponse, String> {
    let url = tenant_url(&tenant, &path)?;
    let cookies = session_cookies(&app, &tenant)?;
    if cookies.is_empty() {
        return Err(
            "Not signed in to Essential Personnel yet. Sign in in the Essential Personnel window."
                .into(),
        );
    }

    let method = match method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        // No DELETE and no PUT: this tool adds certifications. Removing or
        // rewriting what is already on a member's record is not something it
        // should be able to do by accident, or be talked into doing.
        other => return Err(format!("{other} requests are not allowed.")),
    };

    let mut request = client()?
        .request(method, &url)
        .header("Cookie", cookies)
        .header("Accept", "application/json");

    if let Some(json) = body {
        request = request.header("Content-Type", "application/json").body(json);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Could not reach Essential Personnel: {e}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    Ok(EpResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body: text,
    })
}

/// Upload one certificate and return Essential Personnel's response.
///
/// The file is read here rather than in the web layer: it is already on disk,
/// and moving a hundred megabytes through the webview to post it straight back
/// out again would be pure waste.
#[tauri::command]
pub async fn essper_upload_file(
    app: tauri::AppHandle,
    tenant: String,
    directory: String,
    filename: String,
) -> Result<EpResponse, String> {
    let path = crate::export_file_path(&directory, &filename)?;
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("Could not read \"{filename}\": {e}"))?
        .len();
    if size > MAX_UPLOAD_BYTES {
        return Err(format!(
            "\"{filename}\" is {:.0} MB. Essential Personnel accepts files up to 100 MB.",
            size as f64 / (1024.0 * 1024.0)
        ));
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read \"{filename}\": {e}"))?;
    let cookies = session_cookies(&app, &tenant)?;
    if cookies.is_empty() {
        return Err(
            "Not signed in to Essential Personnel yet. Sign in in the Essential Personnel window."
                .into(),
        );
    }

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.clone())
        .mime_str("application/pdf")
        .map_err(|e| format!("Could not prepare \"{filename}\" for upload: {e}"))?;

    let response = client()?
        .post(tenant_url(&tenant, "/api/file/new")?)
        .header("Cookie", cookies)
        .header("Accept", "application/json")
        // No Content-Type header: reqwest sets it with the multipart boundary,
        // and setting it here would replace that with an unparseable one.
        .multipart(reqwest::multipart::Form::new().part("file", part))
        .send()
        .await
        .map_err(|e| format!("Could not upload \"{filename}\": {e}"))?;

    let status = response.status();
    Ok(EpResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body: response.text().await.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::{tenant_origin, tenant_url};

    #[test]
    fn accepts_a_plain_company_name_and_a_pasted_address() {
        assert_eq!(tenant_origin("lccfrs").unwrap(), "https://lccfrs.essper.com");
        assert_eq!(
            tenant_origin("https://lccfrs.essper.com/app/dashboard").unwrap(),
            "https://lccfrs.essper.com"
        );
    }

    #[test]
    fn refuses_a_company_name_that_is_really_another_host() {
        // Every one of these would send the member's session somewhere it does
        // not belong if the label were pasted into the URL unchecked.
        for hostile in [
            "evil.com/",
            "lccfrs@evil.com",
            "lccfrs:8080",
            "",
            "-lccfrs",
            "a b",
            "https://evil.example/",
            "https://lccfrs.essper.com.evil.example/",
            "https://a.b.essper.com/",
            "file:///etc/passwd",
        ] {
            assert!(
                tenant_origin(hostile).is_err(),
                "expected {hostile:?} to be refused"
            );
        }
    }

    #[test]
    fn only_allows_rooted_paths_on_the_tenant_host() {
        assert_eq!(
            tenant_url("lccfrs", "/api/user/me").unwrap(),
            "https://lccfrs.essper.com/api/user/me"
        );
        for hostile in [
            "//evil.example/api",
            "https://evil.example/api",
            "api/user/me",
            "/api\\..\\x",
        ] {
            assert!(
                tenant_url("lccfrs", hostile).is_err(),
                "expected {hostile:?} to be refused"
            );
        }
    }
}
