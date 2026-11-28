//! Closing the window or quitting the app after the UI has saved its state.
//!
//! The UI reports how many files have unsaved changes (it also holds the edits of projects that
//! are not open in the editor). Closing the window, or quitting with Cmd/Ctrl+Q, is then held back
//! and the UI is asked what to do; once it answers, it calls `confirm_exit_command`.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::state::DesktopAppState;

/// Event sent to the UI when a close or quit is waiting for it to save its state.
pub(crate) const CLOSE_REQUESTED_EVENT: &str = "hilo-close-requested";

#[tauri::command]
pub fn report_unsaved_buffers_command(state: State<'_, DesktopAppState>, count: usize) {
    state.unsaved_buffers.store(count, Ordering::SeqCst);
}

#[tauri::command]
pub fn register_close_handler_command(state: State<'_, DesktopAppState>) {
    state.close_handler_ready.store(true, Ordering::SeqCst);
}

/// The UI has finished saving state: let the exit through.
#[tauri::command]
pub fn confirm_exit_command(app: AppHandle, state: State<'_, DesktopAppState>) {
    state.exit_confirmed.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// One independent Settings window. Reopening focuses the existing window.
#[tauri::command]
pub async fn open_settings_window_command(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        app.emit_to("settings", "settings-open-external-agents", ())
            .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App("index.html?view=settings".into()),
    )
    .title("Settings — Hilo")
    .inner_size(1060.0, 760.0)
    .min_inner_size(640.0, 480.0)
    .resizable(true)
    .center()
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Asks the UI to confirm a close that has just been held back.
pub(crate) fn request_close_confirmation(app: &AppHandle) {
    let _ = app.emit_to("main", CLOSE_REQUESTED_EVENT, ());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::test_state;

    #[test]
    fn closing_before_the_handler_registers_is_held_back_for_unsaved_changes() {
        let data = tempfile::tempdir().unwrap();
        let state = test_state(data.path());
        // Nothing unsaved (also the state before the UI has reported anything): close freely.
        assert!(!state.close_needs_confirmation());

        state.unsaved_buffers.store(2, Ordering::SeqCst);
        assert!(state.close_needs_confirmation());

        // Saved or discarded meanwhile: the UI reports 0 and nothing is held back.
        state.unsaved_buffers.store(0, Ordering::SeqCst);
        assert!(!state.close_needs_confirmation());
    }

    #[test]
    fn closing_waits_for_the_registered_handler_even_with_no_unsaved_files() {
        let data = tempfile::tempdir().unwrap();
        let state = test_state(data.path());
        state.close_handler_ready.store(true, Ordering::SeqCst);
        assert!(state.close_needs_confirmation());
        state.exit_confirmed.store(true, Ordering::SeqCst);
        assert!(!state.close_needs_confirmation());
    }

    #[test]
    fn once_the_user_has_answered_the_exit_goes_through() {
        let data = tempfile::tempdir().unwrap();
        let state = test_state(data.path());
        state.unsaved_buffers.store(3, Ordering::SeqCst);
        assert!(state.close_needs_confirmation());

        // "Don't save": the UI confirms the exit, which must not be held back again.
        state.exit_confirmed.store(true, Ordering::SeqCst);
        assert!(!state.close_needs_confirmation());
    }
}
