//! Hilo desktop shell: wires the Rust host crates to the Tauri v2 window.

mod bridge;
mod commands;
mod state;

use std::sync::Arc;

use context_engine::ContextEngineStatus;
use host_core::HostHealthStatus;
use judge_orchestrator::JudgeHealthStatus;
use sandbox_runner::SandboxCapabilities;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

pub use bridge::DesktopBinaryEditorBridge;
use state::DesktopAppState;

/// Event carrying a `DocumentDiagnostics` batch to the UI.
pub(crate) const DOCUMENT_DIAGNOSTICS_EVENT: &str = "hilo-document-diagnostics";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // Hold the main window open until the UI has saved its state.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let held_back = window.label() == "main"
                    && window
                        .try_state::<DesktopAppState>()
                        .is_some_and(|state| state.close_needs_confirmation());
                if held_back {
                    api.prevent_close();
                    commands::window::request_close_confirmation(window.app_handle());
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                if let Some(settings) = window.app_handle().get_webview_window("settings") {
                    let _ = settings.close();
                }
            }
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let bridge = DesktopBinaryEditorBridge::with_journal(data_dir.join("documents.wal"))?;
            // Diagnostics reach the UI tagged with the revision they were computed for; the
            // editor discards the ones its text has moved past.
            let handle = app.handle().clone();
            let diagnostics_sink: host_core::DiagnosticsSink = std::sync::Arc::new(move |batch| {
                let _ = handle.emit(DOCUMENT_DIAGNOSTICS_EVENT, batch);
            });
            app.manage(DesktopAppState::new(bridge, data_dir, diagnostics_sink));
            // The Judge's verdicts, reviews and range states reach the UI as events (LOT-015).
            let handle = app.handle().clone();
            app.state::<DesktopAppState>()
                .judge
                .set_sink(Arc::new(move |event| {
                    let _ = handle.emit(commands::judge::JUDGE_EVENT, event);
                }));
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                commands::judge::reverify_loop(&handle.state::<DesktopAppState>());
            });

            // Group-commit: keystrokes write to the WAL without an immediate `fsync`
            // (`apply_binary_transaction_observed`); this durably flushes them shortly after,
            // off the keystroke path, bounding how much could be lost to a crash.
            let bridge_for_flush = Arc::clone(&app.state::<DesktopAppState>().bridge);
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    if let Ok(mut bridge) = bridge_for_flush.lock() {
                        let _ = bridge.flush_journal();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::judge::judge_reviews_command,
            commands::judge::judge_review_command,
            commands::judge::judge_accept_command,
            commands::judge::judge_reject_command,
            commands::judge::judge_adjust_command,
            commands::judge::judge_document_states_command,
            commands::agent::agent_start_command,
            commands::agent::agent_prompt_command,
            commands::agent::agent_cancel_command,
            commands::agent::agent_stop_command,
            commands::agent::agent_permission_command,
            commands::agent::agent_elicitation_command,
            commands::agent::agent_terminal_auth_start_command,
            commands::agent::agent_auth_choose_command,
            commands::agent::agent_option_command,
            commands::agent::agent_terminal_auth_open_command,
            commands::agent::agent_terminal_auth_input_command,
            commands::agent::agent_terminal_auth_resize_command,
            commands::agent_account::agent_account_status_command,
            commands::agent_account::agent_provider_key_command,
            commands::agent_account::agent_account_save_command,
            commands::agent_account::agent_account_sign_out_command,
            commands::agent_transcripts::agent_transcript_load_command,
            commands::agent_transcripts::agent_transcript_save_command,
            commands::agent_transcripts::agent_transcript_delete_command,
            commands::agent_registry::agent_registry_list_command,
            commands::agent_registry::agent_registry_install_command,
            commands::agent_registry::agent_registry_uninstall_command,
            commands::agent_registry::agent_registry_open_command,
            commands::documents::open_document_binary_command,
            commands::documents::apply_binary_transaction_command,
            commands::documents::save_document_binary_command,
            commands::workspace::load_workspace_command,
            commands::workspace::close_workspace_sessions_command,
            commands::workspace::read_workspace_file_command,
            commands::session_cache::load_session_cache_command,
            commands::session_cache::save_session_cache_command,
            commands::context_index::initialize_background_services_command,
            commands::search::search_workspace_command,
            commands::search::analyze_document_command,
            commands::migration::run_native_migration_command,
            commands::publish::publish_build_command,
            commands::publish::rollback_build_command,
            commands::debug::debug_start_command,
            commands::debug::debug_request_command,
            commands::debug::debug_set_breakpoints_command,
            commands::debug::debug_stop_command,
            commands::language::language_feature_command,
            commands::completion::inline_completion_command,
            commands::completion::native_chat_command,
            commands::completion::cancel_native_chat_command,
            commands::completion::inline_completion_status_command,
            commands::completion::set_inline_completion_settings_command,
            commands::terminal::terminal_open_command,
            commands::terminal::terminal_write_command,
            commands::terminal::terminal_resize_command,
            commands::terminal::terminal_close_command,
            commands::trust::workspace_trust_command,
            commands::trust::request_workspace_trust_command,
            commands::trust::revoke_workspace_trust_command,
            commands::window::open_settings_window_command,
            commands::window::report_unsaved_buffers_command,
            commands::window::register_close_handler_command,
            commands::window::confirm_exit_command
        ])
        .build(tauri::generate_context!())
        .expect("error while building Hilo");

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = handle.try_state::<DesktopAppState>() {
                commands::agent::close_all_agents(&state);
                // Durably flush any group-committed WAL entries before the process exits.
                if let Ok(mut bridge) = state.bridge.lock() {
                    let _ = bridge.flush_journal();
                }
            }
        }
        // Quitting (Cmd/Ctrl+Q, or the last window closing). An exit asked for
        // with a code (`app.exit`) is the one the user already confirmed.
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            let held_back = code.is_none()
                && handle
                    .try_state::<DesktopAppState>()
                    .is_some_and(|state| state.close_needs_confirmation());
            if held_back {
                api.prevent_exit();
                commands::window::request_close_confirmation(handle);
            }
        }
    });
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemDiagnosticsReport {
    pub host: HostHealthStatus,
    pub context: ContextEngineStatus,
    pub judge: JudgeHealthStatus,
    pub sandbox: SandboxCapabilities,
}

pub fn collect_system_diagnostics() -> SystemDiagnosticsReport {
    SystemDiagnosticsReport {
        host: host_core::healthcheck(),
        context: context_engine::healthcheck(),
        judge: judge_orchestrator::healthcheck(),
        sandbox: sandbox_runner::healthcheck(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_shell_aggregates_all_four_rust_crates() {
        let report = collect_system_diagnostics();
        assert!(report.host.ready);
        assert!(report.context.zero_mb_boot_ready);
        assert!(report.judge.deterministic_evidence_required);
        assert!(report.judge.policy_engine_operational);
        assert!(report.sandbox.fail_closed_enforced);
        assert!(!report.sandbox.execution_available);
    }
}
