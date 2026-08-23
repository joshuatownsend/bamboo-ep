//! Tauri backend for the BambooHR training exporter.
//!
//! Four responsibilities live here rather than in the web layer:
//!
//! 1. **HTTP.** BambooHR sends no CORS headers, so the webview can never call
//!    it directly. `tauri-plugin-http` issues requests from Rust instead.
//! 2. **The API key.** It is held in the operating system's credential store,
//!    never in a config file and never in `localStorage`.
//! 3. **Writing the export.** Done here rather than through `tauri-plugin-fs`,
//!    whose scope is granted as a side effect of the folder dialog. That made
//!    writing work on the run where the user picked a folder and fail on every
//!    later run that reused the remembered path.
//! 4. **Calling the user's AI provider.** See `ai.rs`: the capability pin
//!    cannot express a base URL typed in at runtime, and the provider key is
//!    never handed to the webview at all.

mod ai;

use keyring::Entry;

/// One credential per BambooHR company, so a user with access to more than one
/// subdomain does not have them overwrite each other. AI provider keys share
/// the service but are namespaced `ai:` - see `ai.rs`.
pub(crate) const KEYRING_SERVICE: &str = "com.bambooep.desktop";

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
///
/// The separator and drive-letter checks come BEFORE `Path::components`, whose
/// meaning is host-specific: on Unix, `sub\dir.pdf` and `C:\Windows\evil.pdf`
/// are each one `Normal` component and would sail straight through. A name has
/// to be safe on every platform, not only the one that happened to write it.
fn safe_filename(filename: &str) -> Result<&str, String> {
    let unsafe_name = filename.is_empty()
        || filename == "."
        || filename == ".."
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains(':')
        || filename.contains('\0');
    if unsafe_name {
        return Err(format!("Refusing to write to an unsafe filename: {filename}"));
    }

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

/// The names already sitting in the export folder.
///
/// The filename allocator only knows the names THIS export generated, so it is
/// blind to a document that was already there. The caller reserves whatever
/// this returns, which is what stops a certificate quietly destroying an
/// unrelated file that happens to share its name.
#[tauri::command]
fn list_export_directory(directory: String) -> Result<Vec<String>, String> {
    let dir = std::path::PathBuf::from(&directory);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("Could not read the folder \"{directory}\": {e}"))?;

    Ok(entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect())
}

/// Read one file back out of the export folder, as text.
///
/// Used to identify a previous export before its contents may be replaced.
/// Returns `None` when the file is absent or is not valid UTF-8, both of which
/// simply mean "this is not a manifest we wrote".
#[tauri::command]
fn read_export_file(directory: String, filename: String) -> Result<Option<String>, String> {
    let name = safe_filename(&filename)?;
    let path = std::path::PathBuf::from(&directory).join(name);
    match std::fs::read(&path) {
        Ok(bytes) => Ok(String::from_utf8(bytes).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read \"{filename}\": {e}")),
    }
}

/// Remove one file from the export folder.
///
/// Used to clear away a previous export's outputs that the current one no
/// longer produces. Absence is success: the end state is what matters.
#[tauri::command]
fn delete_export_file(directory: String, filename: String) -> Result<(), String> {
    let name = safe_filename(&filename)?;
    let path = std::path::PathBuf::from(&directory).join(name);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not remove \"{filename}\": {e}")),
    }
}

/// Write one file into the export folder.
///
/// `overwrite` is false for a folder this app has not written before, and the
/// write then uses `create_new`, which fails rather than replacing anything
/// already present. That closes two holes at once: a certificate silently
/// destroying an unrelated document of the same name, and a pre-existing
/// symlink redirecting remote bytes outside the folder the user chose —
/// `create_new` refuses an existing symlink instead of writing through it.
///
/// When the folder IS a previous export of ours, replacing is the intent, so
/// the old entry is REMOVED first rather than written over. Removing unlinks a
/// symlink; truncating would follow it.
#[tauri::command]
fn write_export_file(
    directory: String,
    filename: String,
    contents: Vec<u8>,
    overwrite: bool,
) -> Result<(), String> {
    use std::io::Write;

    let name = safe_filename(&filename)?;
    let dir = std::path::PathBuf::from(&directory);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create the folder \"{directory}\": {e}"))?;

    let path = dir.join(name);
    if !overwrite {
        // Nothing here can be lost - `create_new` refuses if anything already
        // holds the name, including a symlink - so the bytes go straight down.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::AlreadyExists => format!(
                    "\"{filename}\" already exists in that folder and was left untouched. \
                     Choose an empty folder, or one this app exported to before."
                ),
                _ => format!("Could not write \"{filename}\": {e}"),
            })?;
        return file
            .write_all(&contents)
            .map_err(|e| format!("Could not write \"{filename}\": {e}"));
    }

    // Replacing a file we wrote before. Deleting first and then writing would
    // destroy a good copy before knowing a replacement can be produced: a full
    // disk or a permission change mid-write would leave the user with neither
    // the old file nor a complete new one. So the new contents are written
    // beside it in full, and only then take its place.
    // Claimed with `create_new` rather than cleared first. The reservation
    // logic protects the user's FINAL filenames, and cannot reach a scratch
    // path derived from one - so a file of theirs that happened to sit at this
    // name would have been deleted by a blind remove. Trying a few suffixes
    // costs nothing and cannot destroy anything.
    let (temp, mut file) = (0..16)
        .find_map(|attempt| {
            let candidate = dir.join(format!("{name}.bamboo-ep-part{attempt}"));
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
                .ok()
                .map(|file| (candidate, file))
        })
        .ok_or_else(|| {
            format!("Could not write \"{filename}\": no free temporary name in that folder.")
        })?;

    let written = file
        .write_all(&contents)
        // Flushed to the device before the old copy is touched, so a crash
        // between the two leaves the previous export intact rather than a
        // half-written file wearing its name.
        .and_then(|()| file.sync_all());
    drop(file);

    if let Err(e) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Could not write \"{filename}\": {e}"));
    }

    // `rename` refuses an existing destination on Windows, so the old entry is
    // unlinked first. The window that leaves is between two metadata
    // operations, with the replacement already complete on disk.
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(format!("Could not replace \"{filename}\": {e}"));
        }
    }

    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Could not write \"{filename}\": {e}")
    })
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
            list_export_directory,
            read_export_file,
            delete_export_file,
            write_export_file,
            ai::save_ai_key,
            ai::has_ai_key,
            ai::delete_ai_key,
            ai::ai_extract
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{safe_filename, write_export_file};

    /// Exercises the replace path against a real filesystem, because the whole
    /// point of it is what survives when a write goes wrong - which no amount
    /// of pure-function testing can observe.
    #[test]
    fn replacing_a_prior_export_leaves_no_partial_file() {
        let dir = std::env::temp_dir().join("bamboo-ep-write-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let directory = dir.to_str().unwrap().to_string();

        // First write into a fresh folder: nothing to replace.
        write_export_file(directory.clone(), "cert.pdf".into(), b"first".to_vec(), false).unwrap();
        assert_eq!(std::fs::read(dir.join("cert.pdf")).unwrap(), b"first");

        // Writing again without permission to replace must leave it alone.
        let refused =
            write_export_file(directory.clone(), "cert.pdf".into(), b"second".to_vec(), false);
        assert!(refused.is_err());
        assert_eq!(std::fs::read(dir.join("cert.pdf")).unwrap(), b"first");

        // With permission, the replacement lands whole and leaves no scratch
        // file behind.
        // A file of the user's sitting on the derived scratch name must survive
        // the replacement rather than being cleared out of the way.
        std::fs::write(dir.join("cert.pdf.bamboo-ep-part0"), b"theirs").unwrap();

        write_export_file(directory.clone(), "cert.pdf".into(), b"second".to_vec(), true).unwrap();
        assert_eq!(std::fs::read(dir.join("cert.pdf")).unwrap(), b"second");
        assert_eq!(
            std::fs::read(dir.join("cert.pdf.bamboo-ep-part0")).unwrap(),
            b"theirs"
        );
        assert!(!dir.join("cert.pdf.bamboo-ep-part1").exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn accepts_ordinary_certificate_names() {
        assert!(safe_filename("CPR - BLS Provider - 2025-06-01.pdf").is_ok());
        assert!(safe_filename("Fire Officer 2 (2).pdf").is_ok());
    }

    // Every one of these must be rejected on EVERY platform, not only the one
    // whose path rules happen to catch it: a backslash name and a drive letter
    // are each a single Normal component on Unix.
    #[test]
    fn rejects_anything_that_could_escape_the_chosen_folder() {
        assert!(safe_filename("../secrets.pdf").is_err());
        assert!(safe_filename("sub/dir.pdf").is_err());
        assert!(safe_filename(r"sub\dir.pdf").is_err());
        assert!(safe_filename(r"C:\Windows\evil.pdf").is_err());
        assert!(safe_filename("C:evil.pdf").is_err());
        assert!(safe_filename("").is_err());
        assert!(safe_filename(".").is_err());
        assert!(safe_filename("..").is_err());
    }
}
