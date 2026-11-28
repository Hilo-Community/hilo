//! ACP Host entry points: the Tauri commands of the agent panel. Native dialogs provide the
//! human decision; signing stays in Rust. Starting a session lives in `session_start`, the
//! sign-in pages the Host opens in `login_pages`.
mod login_pages;
mod session_start;
#[cfg(all(test, target_os = "macos"))]
mod smoke_test;

use crate::state::DesktopAppState;
use host_core::*;
use judge_orchestrator::acp::*;
use session_start::start_session;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::Channel, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

/// How long one session may run: its lease, and the lifetime of the agent process.
const SESSION_LIFETIME: Duration = Duration::from_secs(3600);
/// CPU allowance of the agent process and of each command it runs.
const CPU_ALLOWANCE: Duration = Duration::from_secs(120);
const MAX_LAUNCH_ARGS: usize = 64;
const MAX_LAUNCH_BYTES: usize = 24 * 1024;
/// Never readable by the agent, whatever the task.
const FORBIDDEN_PATHS: [&str; 5] = [".git", ".env", ".ssh", ".aws", ".hilo-tmp"];

fn gate(
    state: &DesktopAppState,
    expected_workspace: Option<&str>,
) -> Result<WorkspaceTrustGate, String> {
    let root = expected_workspace
        .map(|path| {
            let path = std::path::Path::new(path);
            if !path.is_absolute() {
                return Err("The chat's workspace must be an absolute path");
            }
            path.canonicalize()
                .map_err(|_| "The chat's workspace is unavailable")
        })
        .transpose()?;
    // Workspace switches take these locks in the same order.
    let active = state.trust_gate.lock().map_err(|_| "trust lock poisoned")?;
    let gate = match root {
        None => active.clone(),
        Some(root) => match active.as_ref().filter(|gate| gate.workspace_root() == root) {
            Some(gate) => Some(gate.clone()),
            None => state
                .retained_gates
                .lock()
                .map_err(|_| "retained gates lock poisoned")?
                .get(&root)
                .cloned(),
        },
    }
    .ok_or("Open this chat's workspace before reconnecting the agent")?;
    gate.authorize(GatedCapability::WorkspaceLocalBinary)
        .map_err(|e| e.to_string())?;
    Ok(gate)
}

type Agent = Arc<Mutex<AcpSessionSupervisor>>;

pub(crate) fn session_start_now() -> u64 {
    session_start::now()
}

pub(crate) fn shared_sandbox_runner(
    state: &DesktopAppState,
) -> Result<Arc<dyn sandbox_runner::SandboxRunner>, String> {
    session_start::sandbox_runner(state)
}

/// Sends `text` to agent `id` as a new prompt (the Judge's feedback, the user's adjustment).
pub(crate) fn prompt_agent(state: &DesktopAppState, id: u32, text: String) -> Result<(), String> {
    agent(state, id)?
        .lock()
        .map_err(|_| "agent lock poisoned")?
        .prompt(text)
        .map_err(|e| e.to_string())
}

/// The session `id`, if the gate of the workspace it was STARTED in still allows it. That is its
/// own gate, not the active workspace's: after switching project, the old project's agent keeps
/// being driven under its own trust decision (and is refused once that one is revoked).
fn agent(state: &DesktopAppState, id: u32) -> Result<Agent, String> {
    let (gate, session) = {
        let agents = state.agents.lock().map_err(|_| "agents lock poisoned")?;
        let entry = agents.get(&id).ok_or("Agent session is closed")?;
        (entry.gate.clone(), Arc::clone(&entry.session))
    };
    gate.authorize(GatedCapability::WorkspaceLocalBinary)
        .map_err(|e| e.to_string())?;
    Ok(session)
}

/// Stops every session in parallel: each `stop()` can block for several seconds waiting for its
/// sandboxed process tree to actually exit before releasing its permissions, and this runs
/// synchronously on app exit — sequentially it would block the UI for that long times the number
/// of open sessions.
fn stop_all(sessions: Vec<Agent>) {
    std::thread::scope(|scope| {
        for agent in &sessions {
            scope.spawn(|| {
                if let Ok(mut agent) = agent.lock() {
                    agent.stop();
                }
            });
        }
    });
}

/// Stops every agent, whatever its workspace (the app is exiting).
pub(crate) fn close_all_agents(state: &DesktopAppState) {
    let sessions = state
        .agents
        .lock()
        .map(|mut agents| agents.drain().map(|(_, entry)| entry.session).collect())
        .unwrap_or_default();
    stop_all(sessions);
}

/// Stops the agents started in the workspace at `root`; the others keep running.
pub(crate) fn close_agents_of(state: &DesktopAppState, root: &std::path::Path) {
    let sessions = state
        .agents
        .lock()
        .map(|mut agents| {
            let ids: Vec<u32> = agents
                .iter()
                .filter(|(_, entry)| entry.gate.workspace_root() == root)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| agents.remove(&id))
                .map(|entry| entry.session)
                .collect()
        })
        .unwrap_or_default();
    stop_all(sessions);
}

#[tauri::command]
pub async fn agent_start_command(
    app: tauri::AppHandle,
    installed_agent_id: String,
    conversation_id: Option<String>,
    resume_session_id: Option<String>,
    expected_workspace: Option<String>,
    preferred_options: Option<Vec<AcpOptionPreference>>,
    events: Channel<AcpEvent>,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        start_session(
            &app,
            installed_agent_id,
            conversation_id,
            resume_session_id,
            expected_workspace,
            preferred_options.unwrap_or_default(),
            events,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn agent_prompt_command(
    state: tauri::State<'_, DesktopAppState>,
    id: u32,
    text: String,
    previous_turns: Option<String>,
) -> Result<(), String> {
    agent(&state, id)?
        .lock()
        .map_err(|_| "agent lock poisoned")?
        .prompt_with_history(text, previous_turns)
        .map_err(|e| e.to_string())
}

/// Cancels the current turn; the session stays open for the next prompt.
#[tauri::command]
pub fn agent_cancel_command(
    state: tauri::State<'_, DesktopAppState>,
    id: u32,
) -> Result<(), String> {
    agent(&state, id)?
        .lock()
        .map_err(|_| "agent lock poisoned")?
        .cancel()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_stop_command(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopAppState>();
        if let Ok(mut urls) = state.login_urls.lock() {
            urls.remove(&id);
        }
        let agent = state
            .agents
            .lock()
            .map_err(|_| "agents lock poisoned")?
            .remove(&id);
        if let Some(entry) = agent {
            entry
                .session
                .lock()
                .map_err(|_| "agent lock poisoned")?
                .stop();
        }
        crate::commands::judge::forget_agent(&state, id);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens only a URL retained from this agent's pending, allowlisted elicitation. The request
/// carries an opaque request ID, never a URL supplied by the webview. `accept` opens the page
/// and answers the agent; `open` only opens it again while the agent still waits.
#[tauri::command]
pub async fn agent_elicitation_command(
    app: tauri::AppHandle,
    id: u32,
    request_id: String,
    action: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let agent = agent(&app.state::<DesktopAppState>(), id)?;
    let agent = agent.lock().map_err(|_| "agent lock poisoned")?;
    if action == "accept" || action == "open" {
        let url = agent
            .elicitation_url(&request_id)
            .ok_or("Authentication request is no longer pending")?;
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "Could not open the authentication URL")?;
    }
    if action == "open" {
        return Ok(());
    }
    agent
        .answer_elicitation(request_id, action)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_terminal_auth_start_command(
    state: tauri::State<'_, DesktopAppState>,
    id: u32,
) -> Result<(), String> {
    agent(&state, id)?
        .lock()
        .map_err(|_| "agent lock poisoned")?
        .start_terminal_auth()
        .map_err(|e| e.to_string())
}
/// The user's pick among the sign-in methods the agent offered.
#[tauri::command]
pub fn agent_auth_choose_command(
    state: tauri::State<'_, DesktopAppState>,
    id: u32,
    method_id: String,
) -> Result<(), String> {
    agent(&state, id)?
        .lock()
        .map_err(|_| "agent lock poisoned")?
        .choose_authentication(method_id)
        .map_err(|e| e.to_string())
}
/// The user's pick for a model, mode or effort the agent offered. The session only sends it
/// if the value is one the agent itself advertised.
#[tauri::command]
pub fn agent_option_command(
    state: tauri::State<'_, DesktopAppState>,
    id: u32,
    option_id: String,
    value: String,
) -> Result<(), String> {
    agent(&state, id)?
        .lock()
        .map_err(|_| "agent lock poisoned")?
        .set_option(option_id, value)
        .map_err(|e| e.to_string())
}
/// Opens again the sign-in page the login printed, when the browser did not open or was
/// closed. Only the address the Host kept is opened, never one the webview supplies.
#[tauri::command]
pub fn agent_terminal_auth_open_command(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    login_pages::open_again(&app, id)
}
#[tauri::command]
pub fn agent_terminal_auth_input_command(
    state: tauri::State<'_, DesktopAppState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    agent(&state, id)?
        .lock()
        .map_err(|_| "agent lock poisoned")?
        .write_terminal_auth(data)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn agent_terminal_auth_resize_command(
    state: tauri::State<'_, DesktopAppState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    agent(&state, id)?
        .lock()
        .map_err(|_| "agent lock poisoned")?
        .resize_terminal_auth(cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_permission_command(
    app: tauri::AppHandle,
    id: u32,
    request_id: String,
    allow: Option<bool>,
    option_id: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let agent = agent(&app.state::<DesktopAppState>(), id)?;
        if let Some(option) = option_id {
            return agent
                .lock()
                .map_err(|_| "agent lock poisoned")?
                .answer_permission_option(request_id, option)
                .map_err(|e| e.to_string());
        }
        let description = agent
            .lock()
            .map_err(|_| "agent lock poisoned")?
            .permission_description(&request_id)
            .ok_or("Permission request is no longer pending")?;
        // The webview requests a decision; only this native dialog confirms consent.
        let approved = allow.unwrap_or(false)
            && app
                .dialog()
                .message(format!(
                    "Allow this exact ACP operation once?\n\n{description}"
                ))
                .title("ACP permission")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Allow once".into(),
                    "Reject".into(),
                ))
                .blocking_show();
        let result = agent
            .lock()
            .map_err(|_| "agent lock poisoned")?
            .answer_permission(request_id, approved)
            .map_err(|e| e.to_string());
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::session_start::*;
    use super::*;
    use crate::bridge::DesktopBinaryEditorBridge;
    use std::path::Path;

    fn host_text(root: &Path, bridge: DesktopBinaryEditorBridge) -> HostText {
        HostText {
            root: root.canonicalize().unwrap(),
            bridge: Arc::new(Mutex::new(bridge)),
            mcp: Mutex::new(None),
            _task: None,
        }
    }

    #[test]
    fn untrusted_host_cannot_access_agents() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let state = crate::state::test_state(data.path());
        crate::commands::workspace::load_workspace(&state, root.path().to_str().unwrap()).unwrap();
        assert!(gate(&state, None).is_err());
        assert!(agent(&state, 1).is_err());
        assert!(gate(&state, None)
            .and_then(|gate| resolve_launch(&state, &gate, "codex"))
            .is_err());
    }

    #[test]
    fn a_chat_uses_its_retained_trusted_workspace_only() {
        let data = tempfile::tempdir().unwrap();
        let active = tempfile::tempdir().unwrap();
        let background = tempfile::tempdir().unwrap();
        let unknown = tempfile::tempdir().unwrap();
        let state = crate::state::test_state(data.path());
        crate::commands::workspace::load_workspace(&state, active.path().to_str().unwrap())
            .unwrap();
        let retained =
            WorkspaceTrustGate::open(state.trust_store_path(), background.path()).unwrap();
        retained.grant().unwrap();
        state
            .retained_gates
            .lock()
            .unwrap()
            .insert(retained.workspace_root().to_owned(), retained.clone());

        let expected = background.path().to_str().unwrap();
        let selected = gate(&state, Some(expected)).unwrap();
        assert_eq!(selected.workspace_root(), retained.workspace_root());
        assert!(gate(&state, unknown.path().to_str()).is_err());
        assert!(gate(&state, Some("relative")).is_err());

        retained.close();
        assert!(gate(&state, Some(expected)).is_err());
    }

    #[test]
    fn installed_ids_are_resolved_by_the_host_after_the_trust_gate() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let state = crate::state::test_state(data.path());
        crate::commands::workspace::load_workspace(&state, root.path().to_str().unwrap()).unwrap();
        state
            .trust_gate
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .grant()
            .unwrap();
        let workspace_gate = gate(&state, None).unwrap();
        assert!(resolve_launch(&state, &workspace_gate, "missing")
            .unwrap_err()
            .contains("no installation"));
        assert!(resolve_launch(&state, &workspace_gate, "goose")
            .unwrap_err()
            .contains("blocked"));
        let location = data.path().join("agent-registry/packages/codex/1.0");
        std::fs::create_dir_all(&location).unwrap();
        let installation = agent_registry::Installation {
            id: "codex@1.0".into(),
            agent_id: "codex".into(),
            name: "Codex".into(),
            version: "1.0".into(),
            distribution: "binary".into(),
            installed_at_ms: 0,
            location: location.clone(),
            launch: agent_registry::Launch::Executable {
                path: "agent".into(),
                args: vec!["--acp".into()],
            },
        };
        std::fs::write(
            data.path().join("agent-registry/installations.json"),
            serde_json::to_vec(&vec![installation]).unwrap(),
        )
        .unwrap();
        let launch = resolve_launch(&state, &workspace_gate, "codex").unwrap();
        assert_eq!(launch.program, location.join("agent"));
        assert_eq!(launch.args, ["--acp"]);
        assert_eq!(launch.read_only_paths, [location]);
        assert_eq!(
            (launch.name.as_str(), launch.version.as_str()),
            ("Codex", "1.0")
        );
        state
            .trust_gate
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .revoke()
            .unwrap();
        assert!(gate(&state, None)
            .and_then(|gate| resolve_launch(&state, &gate, "codex"))
            .is_err());
    }

    #[test]
    fn proposal_base_reads_unsaved_rope() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("file.rs");
        std::fs::write(&path, "disk").unwrap();
        let mut bridge = DesktopBinaryEditorBridge::new_in_memory();
        bridge
            .documents_mut()
            .open_document_with_editor_text(
                "file.rs",
                1,
                path.canonicalize().unwrap(),
                "unsaved 🦀",
            )
            .unwrap();
        assert_eq!(
            host_text(root.path(), bridge).text("file.rs").unwrap(),
            "unsaved 🦀"
        );
    }

    #[test]
    fn reading_a_closed_file_takes_the_disk_and_opens_no_document() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("closed.rs"), "on disk").unwrap();
        std::fs::write(root.path().join("big.rs"), "x".repeat(MAX_FILE_BYTES + 1)).unwrap();
        let text = host_text(root.path(), DesktopBinaryEditorBridge::new_in_memory());
        assert_eq!(text.text("closed.rs").unwrap(), "on disk");
        assert!(text.text("big.rs").unwrap_err().contains("size"));
        let bridge = text.bridge.lock().unwrap();
        assert_eq!(bridge.document_service().sessions().count(), 0);
    }

    #[test]
    fn launch_arguments_are_bounded() {
        // Absolute on every OS: `/bin/agent` has no drive on Windows.
        let program = if cfg!(windows) {
            r"C:\agent.exe"
        } else {
            "/bin/agent"
        };
        assert!(check_launch(program, &[]).is_ok());
        assert!(check_launch("agent", &[]).is_err());
        assert!(check_launch(program, &vec![String::new(); MAX_LAUNCH_ARGS + 1]).is_err());
        assert!(check_launch(program, &["x".repeat(MAX_LAUNCH_BYTES)]).is_err());
    }
}
