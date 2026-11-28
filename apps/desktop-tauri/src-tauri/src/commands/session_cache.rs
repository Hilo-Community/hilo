//! The UI session cache (`workspace_session_cache.bin`), written atomically.

use crate::state::DesktopAppState;
use std::io::Write;

#[tauri::command]
pub fn load_session_cache_command(
    state: tauri::State<'_, DesktopAppState>,
) -> Result<Option<Vec<u8>>, String> {
    let path = state.app_data_dir.join("workspace_session_cache.bin");
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Failed to load the workspace session cache: {error}"
        )),
    }
}

#[tauri::command]
pub fn save_session_cache_command(
    state: tauri::State<'_, DesktopAppState>,
    payload: Vec<u8>,
) -> Result<(), String> {
    let target = state.app_data_dir.join("workspace_session_cache.bin");
    let temporary = state.app_data_dir.join(".workspace_session_cache.bin.tmp");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("Failed to open the workspace session cache: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|error| {
                    format!("Failed to protect the workspace session cache: {error}")
                })?;
        }
        file.write_all(&payload)
            .map_err(|error| format!("Failed to write the workspace session cache: {error}"))?;
    }
    std::fs::rename(&temporary, &target)
        .map_err(|error| format!("Failed to commit the workspace session cache: {error}"))
}
