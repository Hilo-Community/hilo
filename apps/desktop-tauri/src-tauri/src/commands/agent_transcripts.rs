//! Saved agent conversations: one JSON file per panel, in the app data directory.
//!
//! The Host stores the text the panel gives it and never interprets it. A conversation holds code
//! and command output, so the directory and its files are readable by the owner only, a file is
//! removed when the chat is deleted.

use crate::state::DesktopAppState;
use std::path::{Path, PathBuf};

const DIRECTORY: &str = "agent-transcripts";
/// The renderer caps the serialized JSON at 2.5 Mi UTF-16 code units. A UTF-16 unit
/// may account for up to three bytes in UTF-8, so leave room for the complete transcript.
const MAX_BYTES: usize = 8 * 1024 * 1024;

fn directory(root: &Path) -> PathBuf {
    root.join(DIRECTORY)
}

/// Panel ids look like `chat-12`; nothing else may name a file.
fn file(root: &Path, chat_id: &str) -> Result<PathBuf, String> {
    let valid = !chat_id.is_empty()
        && chat_id.len() <= 64
        && chat_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid {
        return Err("Invalid conversation id".into());
    }
    Ok(directory(root).join(format!("{chat_id}.json")))
}

fn private_directory(root: &Path) -> Result<PathBuf, String> {
    let dir = directory(root);
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create the conversations folder: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Failed to protect the conversations folder: {error}"))?;
    }
    Ok(dir)
}

pub(crate) fn load(root: &Path, chat_id: &str) -> Result<Option<String>, String> {
    let path = file(root, chat_id)?;
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to load the conversation: {error}")),
    }
}

pub(crate) fn save(root: &Path, chat_id: &str, payload: &str) -> Result<(), String> {
    let target = file(root, chat_id)?;
    if payload.len() > MAX_BYTES {
        return Err("The conversation is too large to save".into());
    }
    if serde_json::from_str::<serde::de::IgnoredAny>(payload).is_err() {
        return Err("The conversation is not valid JSON".into());
    }
    let dir = private_directory(root)?;
    let temporary = dir.join(format!(".{chat_id}.json.tmp"));
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut out = options
            .open(&temporary)
            .map_err(|error| format!("Failed to write the conversation: {error}"))?;
        out.write_all(payload.as_bytes())
            .and_then(|()| out.sync_data())
            .map_err(|error| format!("Failed to write the conversation: {error}"))?;
    }
    std::fs::rename(&temporary, &target)
        .map_err(|error| format!("Failed to save the conversation: {error}"))
}

pub(crate) fn remove(root: &Path, chat_id: &str) -> Result<(), String> {
    match std::fs::remove_file(file(root, chat_id)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to delete the conversation: {error}")),
    }
}

#[tauri::command]
pub fn agent_transcript_load_command(
    state: tauri::State<'_, DesktopAppState>,
    chat_id: String,
) -> Result<Option<String>, String> {
    load(&state.app_data_dir, &chat_id)
}

#[tauri::command]
pub fn agent_transcript_save_command(
    state: tauri::State<'_, DesktopAppState>,
    chat_id: String,
    payload: String,
) -> Result<(), String> {
    save(&state.app_data_dir, &chat_id, &payload)
}

#[tauri::command]
pub fn agent_transcript_delete_command(
    state: tauri::State<'_, DesktopAppState>,
    chat_id: String,
) -> Result<(), String> {
    remove(&state.app_data_dir, &chat_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_conversation_survives_a_restart_and_goes_with_its_panel() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(load(root.path(), "chat-1").unwrap(), None);
        save(root.path(), "chat-1", r#"{"version":1}"#).unwrap();
        assert_eq!(
            load(root.path(), "chat-1").unwrap().as_deref(),
            Some(r#"{"version":1}"#)
        );
        save(root.path(), "chat-1", r#"{"version":2}"#).unwrap();
        assert_eq!(
            load(root.path(), "chat-1").unwrap().as_deref(),
            Some(r#"{"version":2}"#)
        );
        remove(root.path(), "chat-1").unwrap();
        remove(root.path(), "chat-1").unwrap();
        assert_eq!(load(root.path(), "chat-1").unwrap(), None);
    }

    #[test]
    fn only_plain_panel_ids_name_a_file() {
        let root = tempfile::tempdir().unwrap();
        for bad in ["", "../x", "a/b", "a\\b", "a.b", "chat 1", &"x".repeat(65)] {
            assert!(save(root.path(), bad, "{}").is_err(), "{bad}");
            assert!(load(root.path(), bad).is_err(), "{bad}");
            assert!(remove(root.path(), bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn stores_transcripts_larger_in_utf8_than_in_the_renderer() {
        let root = tempfile::tempdir().unwrap();
        let payload = serde_json::json!({"messages": ["界".repeat(1_100_000), "🌍"]}).to_string();
        assert!(payload.len() > 3 * 1024 * 1024);
        assert!(payload.encode_utf16().count() < 2_500_000);
        save(root.path(), "unicode-thread", &payload).unwrap();
        assert_eq!(load(root.path(), "unicode-thread").unwrap(), Some(payload));
    }

    #[test]
    fn refuses_text_that_is_not_json_or_is_too_large() {
        let root = tempfile::tempdir().unwrap();
        assert!(save(root.path(), "chat-1", "not json").is_err());
        let large = format!("\"{}\"", "x".repeat(MAX_BYTES));
        assert!(save(root.path(), "chat-1", &large).is_err());
        assert_eq!(load(root.path(), "chat-1").unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn the_folder_and_its_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        save(root.path(), "chat-1", "{}").unwrap();
        let mode = |path: PathBuf| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(directory(root.path())), 0o700);
        assert_eq!(mode(file(root.path(), "chat-1").unwrap()), 0o600);
    }
}
