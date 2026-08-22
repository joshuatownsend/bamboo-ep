//! Tauri backend for the BambooHR training exporter.
//!
//! Two responsibilities live here rather than in the web layer:
//!
//! 1. **HTTP.** BambooHR sends no CORS headers, so the webview can never call
//!    it directly. `tauri-plugin-http` issues requests from Rust instead.
//! 2. **The API key.** It is held in the operating system's credential store,
//!    never in a config file and never in `localStorage`.
//! 3. **Writing the export.** Done here rather than through `tauri-plugin-fs`,
//!    whose scope is granted as a side effect of the folder dialog. That made
//!    writing work on the run where the user picked a folder and fail on every
//!    later run that reused the remembered path.

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

/// Reject anything that is not a single, plain filename. The directory comes
/// from the user's own folder picker, but the filename is built from BambooHR
/// data, so it must never be able to escape that directory.
fn safe_filename(filename: &str) -> Result<&str, String> {
    let mut components = std::path::Path::new(filename).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(_)), None) => Ok(filename),
        _ => Err(format!("Refusing to write to an unsafe filename: {filename}")),
    }
}

#[tauri::command]
fn ensure_export_directory(directory: String) -> Result<(), String> {
    std::fs::create_dir_all(&directory)
        .map_err(|e| format!("Could not create the folder \"{directory}\": {e}"))
}

#[tauri::command]
fn write_export_file(
    directory: String,
    filename: String,
    contents: Vec<u8>,
) -> Result<(), String> {
    let name = safe_filename(&filename)?;
    let dir = std::path::PathBuf::from(&directory);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create the folder \"{directory}\": {e}"))?;
    std::fs::write(dir.join(name), contents)
        .map_err(|e| format!("Could not write \"{filename}\": {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            load_api_key,
            delete_api_key,
            ensure_export_directory,
            write_export_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::safe_filename;

    #[test]
    fn accepts_ordinary_certificate_names() {
        assert!(safe_filename("CPR - BLS Provider - 2025-06-01.pdf").is_ok());
        assert!(safe_filename("Fire Officer 2 (2).pdf").is_ok());
    }

    #[test]
    fn rejects_anything_that_could_escape_the_chosen_folder() {
        assert!(safe_filename("../secrets.pdf").is_err());
        assert!(safe_filename("sub/dir.pdf").is_err());
        assert!(safe_filename(r"sub\dir.pdf").is_err());
        assert!(safe_filename(r"C:\Windows\evil.pdf").is_err());
        assert!(safe_filename("").is_err());
        assert!(safe_filename("..").is_err());
    }
}
