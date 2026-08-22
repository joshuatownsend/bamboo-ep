//! Tauri backend for the BambooHR training exporter.
//!
//! Two responsibilities live here rather than in the web layer:
//!
//! 1. **HTTP.** BambooHR sends no CORS headers, so the webview can never call
//!    it directly. `tauri-plugin-http` issues requests from Rust instead.
//! 2. **The API key.** It is held in the operating system's credential store,
//!    never in a config file and never in `localStorage`.

use keyring::Entry;

/// One credential per BambooHR company, so a user with access to more than one
/// subdomain does not have them overwrite each other.
const KEYRING_SERVICE: &str = "com.bambooep.desktop";

fn entry(subdomain: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, subdomain).map_err(|e| format!("Credential store unavailable: {e}"))
}

#[tauri::command]
fn save_api_key(subdomain: String, api_key: String) -> Result<(), String> {
    entry(&subdomain)?
        .set_password(&api_key)
        .map_err(|e| format!("Could not save the API key: {e}"))
}

/// Returns `None` rather than an error when nothing is stored, so first run is
/// an ordinary state instead of a failure the UI has to special-case.
#[tauri::command]
fn load_api_key(subdomain: String) -> Result<Option<String>, String> {
    match entry(&subdomain)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read the stored API key: {e}")),
    }
}

#[tauri::command]
fn delete_api_key(subdomain: String) -> Result<(), String> {
    match entry(&subdomain)?.delete_credential() {
        Ok(()) => Ok(()),
        // Already absent is the desired end state, not a problem.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove the stored API key: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            load_api_key,
            delete_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
