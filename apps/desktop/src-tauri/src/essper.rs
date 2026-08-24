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
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
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

/// The only endpoints this tool has any business calling.
///
/// A generic "any rooted path" bridge was the earlier design, and refusing PUT
/// and DELETE was not enough of a limit: an authenticated POST to an arbitrary
/// endpoint is a large surface to leave open, and it contradicts what this
/// tool claims to be - something that adds certifications and reads only what
/// it needs to do that safely.
const ALLOWED_GET: &[&str] = &[
    "/api/user/me",
    "/api/template/certification/all",
    "/api/certifications/settings",
    "/api/user-certifications",
];
const ALLOWED_POST: &[&str] = &["/api/user-certifications"];

fn allowed(method: &reqwest::Method, path: &str) -> bool {
    // Compared against the path alone: `/api/user-certifications?userId=...`
    // is the same endpoint as `/api/user-certifications`, and a query string
    // cannot turn one endpoint into another.
    let endpoint = path.split('?').next().unwrap_or("");
    let list = if method == reqwest::Method::GET {
        ALLOWED_GET
    } else {
        ALLOWED_POST
    };
    list.contains(&endpoint)
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
        // The window has a fixed label, so a second call finds whatever was
        // opened first - which may be signed in to a DIFFERENT company if the
        // member corrected the name. Focusing it would show them a working
        // session while every request read cookies for the new host and failed
        // to authenticate, with the window in front of them insisting they are
        // already signed in.
        if shows_origin(&existing, &origin) {
            let _ = existing.set_focus();
            return Ok(());
        }
        existing
            .close()
            .map_err(|e| format!("Could not close the previous Essential Personnel window: {e}"))?;
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

/// Is this window showing the company we are about to use?
///
/// Compared by origin rather than by full URL: the member navigates around
/// while signing in, and any page on the right host is the right window.
fn shows_origin(window: &tauri::WebviewWindow, origin: &str) -> bool {
    window
        .url()
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_ascii_lowercase();
            Some(format!("{}://{}", url.scheme(), host) == origin)
        })
        .unwrap_or(false)
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
    // A window still showing another company has no session for this one.
    // Reporting "not signed in" is the truthful answer and sends the member to
    // sign in, which reopens the window at the right place.
    if !shows_origin(&window, &origin) {
        return Ok(String::new());
    }
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

/// The tenant's public application key, from the `config.js` that Essential
/// Personnel serves to every browser.
///
/// Their API expects an `X-ES-KEY` header identifying the application
/// alongside the session cookie. It is read at runtime rather than compiled
/// in, because it differs per tenant and can be rotated. It is not a secret
/// and grants nothing on its own - a request carrying it without a session is
/// still refused.
///
/// Cached for the life of the session. An upload is two requests per
/// certification, and fetching `config.js` before each one turned a batch of
/// forty into a hundred and twenty round trips - more latency, and more
/// chances for one of them to fail. It is dropped again when Essential
/// Personnel rejects a request, so a rotated key costs one retry rather than
/// a restart.
static APP_KEYS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn app_key_cache() -> &'static Mutex<HashMap<String, String>> {
    APP_KEYS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn forget_app_key(tenant: &str) {
    if let Ok(mut cache) = app_key_cache().lock() {
        cache.remove(tenant);
    }
}

async fn app_key(tenant: &str) -> Result<String, String> {
    if let Ok(cache) = app_key_cache().lock() {
        if let Some(key) = cache.get(tenant) {
            return Ok(key.clone());
        }
    }

    let key = fetch_app_key(tenant).await?;
    if let Ok(mut cache) = app_key_cache().lock() {
        cache.insert(tenant.to_string(), key.clone());
    }
    Ok(key)
}

async fn fetch_app_key(tenant: &str) -> Result<String, String> {
    let url = format!("{}/config.js", tenant_origin(tenant)?);
    let body = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Could not reach Essential Personnel: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Could not read the Essential Personnel settings: {e}"))?;

    parse_app_key(&body).ok_or_else(|| {
        format!("Could not find the application key at {url}. Check the company name.")
    })
}

fn parse_app_key(config_js: &str) -> Option<String> {
    let after_name = config_js.split_once("\"API_KEY\"")?.1;
    let after_colon = after_name.split_once(':')?.1;
    let start = after_colon.find('"')? + 1;
    let end = start + after_colon[start..].find('"')?;
    let key = &after_colon[start..end];
    (!key.is_empty()).then(|| key.to_string())
}

/// One client for the whole session.
///
/// `reqwest::Client` owns the connection pool, so building a new one per
/// request throws away every kept-alive connection and repeats the TLS
/// handshake. Cloning shares it - the type is a handle, not the machinery.
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> Result<reqwest::Client, String> {
    if let Some(existing) = HTTP.get() {
        return Ok(existing.clone());
    }
    let built = build_client()?;
    // A race here is harmless: whichever client wins, both are equivalent.
    let _ = HTTP.set(built.clone());
    Ok(built)
}

fn build_client() -> Result<reqwest::Client, String> {
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
    if !allowed(&method, &path) {
        return Err(format!(
            "{method} {path} is not one of the endpoints this app uses."
        ));
    }

    let mut request = client()?
        .request(method, &url)
        .header("Cookie", cookies)
        .header("X-ES-KEY", app_key(&tenant).await?)
        .header("Accept", "application/json");

    if let Some(json) = body {
        request = request.header("Content-Type", "application/json").body(json);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Could not reach Essential Personnel: {e}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        // Either the session ended or the application key was rotated. The
        // key is the part this app caches, so it is the part to let go of.
        forget_app_key(&tenant);
    }
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
    // `content_type` is what BambooHR said this file was, carried through from
    // the manifest. Preferred over anything inferred here: BambooHR served the
    // bytes and named the type, while this end has only a filename - one this
    // app generated - to reason from.
    content_type: Option<String>,
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
        .mime_str(&declared_type(content_type.as_deref(), &filename))
        .map_err(|e| format!("Could not prepare \"{filename}\" for upload: {e}"))?;

    let response = client()?
        .post(tenant_url(&tenant, "/api/file/new")?)
        .header("Cookie", cookies)
        .header("X-ES-KEY", app_key(&tenant).await?)
        .header("Accept", "application/json")
        // No Content-Type header: reqwest sets it with the multipart boundary,
        // and setting it here would replace that with an unparseable one.
        .multipart(reqwest::multipart::Form::new().part("file", part))
        .send()
        .await
        .map_err(|e| format!("Could not upload \"{filename}\": {e}"))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        forget_app_key(&tenant);
    }
    Ok(EpResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body: response.text().await.unwrap_or_default(),
    })
}

/// What kind of file this is, from its name.
///
/// Not every certificate is a PDF: BambooHR holds photographed and scanned
/// cards, and Part 1 saves whatever it was given under its original extension.
/// Declaring a JPEG as `application/pdf` invites Essential Personnel to reject
/// it, or to serve it back later as something it is not.
/// What to tell Essential Personnel this file is.
///
/// The manifest's own record wins when it is present and usable. It comes from
/// BambooHR, which served the bytes; the extension is a guess made from a name
/// this app itself generated.
fn declared_type(from_manifest: Option<&str>, filename: &str) -> String {
    from_manifest
        .map(str::trim)
        .filter(|declared| {
            // Only a plain `type/subtype`. The value crosses from the web layer
            // into a header, and a value carrying its own parameters or line
            // breaks has no business being copied there unexamined.
            !declared.is_empty()
                && declared.parse::<reqwest::header::HeaderValue>().is_ok()
                && declared.split('/').count() == 2
                && !declared.contains(';')
                && declared.chars().all(|c| !c.is_whitespace())
        })
        .map(str::to_string)
        .unwrap_or_else(|| content_type(filename).to_string())
}

fn content_type(filename: &str) -> &'static str {
    let extension = filename
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "pdf" => "application/pdf",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "tif" | "tiff" => "image/tiff",
        // Deliberately generic rather than a guess. An honest unknown is
        // handled routinely; a confident wrong type is not.
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::{allowed, content_type, declared_type, parse_app_key, tenant_origin, tenant_url};

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

    #[test]
    fn only_the_endpoints_this_app_actually_uses() {
        assert!(allowed(&reqwest::Method::GET, "/api/user/me"));
        assert!(allowed(
            &reqwest::Method::GET,
            "/api/user-certifications?userId=abc&skip=0"
        ));
        assert!(allowed(&reqwest::Method::POST, "/api/user-certifications"));

        // Being allowed to read something is not a licence to write it, and
        // neither is a licence to call anything else.
        assert!(!allowed(&reqwest::Method::POST, "/api/user/me"));
        assert!(!allowed(&reqwest::Method::GET, "/api/user/all"));
        assert!(!allowed(&reqwest::Method::POST, "/api/profile-update"));
    }

    #[test]
    fn declares_the_kind_of_file_it_is_actually_sending() {
        assert_eq!(content_type("cert.pdf"), "application/pdf");
        assert_eq!(content_type("CERT.PDF"), "application/pdf");
        assert_eq!(content_type("scan.JPEG"), "image/jpeg");
        assert_eq!(content_type("card.png"), "image/png");
        assert_eq!(content_type("no-extension"), "application/octet-stream");
        assert_eq!(content_type("thing.docx"), "application/octet-stream");
    }

    #[test]
    fn reads_the_application_key_out_of_config_js() {
        let config = r#"window.__EP_CONFIG__ = {
            "API_URL": "https://lccfrs.essper.com/api",
            "API_KEY_HEADER": "X-ES-KEY",
            "API_KEY": "abc123",
            "IS_CJIS": false
        };"#;
        assert_eq!(parse_app_key(config).as_deref(), Some("abc123"));
        assert_eq!(parse_app_key("window.__EP_CONFIG__ = {};"), None);
        assert_eq!(parse_app_key(r#"{"API_KEY": ""}"#), None);
    }

    #[test]
    fn prefers_what_bamboohr_said_the_file_was() {
        // BambooHR served the bytes and named the type; the extension is a
        // guess about a filename this app generated itself.
        assert_eq!(declared_type(Some("image/bmp"), "cert"), "image/bmp");
        assert_eq!(declared_type(Some("application/pdf"), "cert.jpg"), "application/pdf");
    }

    #[test]
    fn falls_back_to_the_extension_when_the_manifest_says_nothing_usable() {
        assert_eq!(declared_type(None, "cert.pdf"), "application/pdf");
        assert_eq!(declared_type(Some(""), "cert.pdf"), "application/pdf");
        assert_eq!(declared_type(Some("   "), "scan.png"), "image/png");
        // Not a type at all, and nothing that could smuggle a second header
        // value or extra parameters into the request.
        assert_eq!(declared_type(Some("nonsense"), "cert.pdf"), "application/pdf");
        assert_eq!(
            declared_type(Some("text/html\r\nX-Evil: 1"), "cert.pdf"),
            "application/pdf"
        );
        assert_eq!(
            declared_type(Some("application/pdf; charset=utf-8"), "scan.png"),
            "image/png"
        );
    }
}
