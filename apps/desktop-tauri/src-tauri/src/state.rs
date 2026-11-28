use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use context_engine::SqliteWalContextEngine;
use host_core::{
    DiagnosticsSink, LanguageServices, LatestDiagnostics, WorkspaceTrustGate,
    WORKSPACE_TRUST_STORE_FILENAME,
};

use crate::bridge::DesktopBinaryEditorBridge;

/// An ACP session and the trust gate of the workspace it was started in. Panel commands are
/// authorized against this gate, not the active workspace's, so a session keeps working for its
/// own project while another one is shown.
pub(crate) struct AgentEntry {
    pub(crate) gate: WorkspaceTrustGate,
    pub(crate) session: Arc<Mutex<judge_orchestrator::acp::AcpSessionSupervisor>>,
}

/// A terminal and the root of the workspace it was opened in.
pub(crate) struct TerminalEntry {
    pub(crate) root: PathBuf,
    pub(crate) session: Arc<host_core::TerminalSession>,
}

/// State shared by every Tauri command.
pub(crate) struct DesktopAppState {
    pub(crate) bridge: Arc<Mutex<DesktopBinaryEditorBridge>>,
    pub(crate) agents: Mutex<HashMap<u32, AgentEntry>>,
    pub(crate) next_agent_id: AtomicU32,
    /// The sign-in page each agent's login printed, kept only when it is on a host reviewed for
    /// that agent. The webview never supplies the address that gets opened.
    pub(crate) login_urls: Mutex<HashMap<u32, String>>,
    /// The ACP agent registry of the Settings screen, opened on first use.
    pub(crate) agent_registry: Mutex<Option<Arc<agent_registry::AgentRegistry>>>,
    /// Verified OS sandbox runner, self-tested once on first use.
    pub(crate) sandbox_runner: Mutex<Option<Arc<dyn sandbox_runner::SandboxRunner>>>,
    /// Serializes account resets against session startup/home provisioning.
    pub(crate) agent_account_lock: Mutex<()>,
    pub(crate) workspace_root: Mutex<Option<PathBuf>>,
    /// Trust gate of the open workspace. `None` (no workspace, or a root whose decision cannot
    /// be recorded) means untrusted: nothing may be launched.
    pub(crate) trust_gate: Mutex<Option<WorkspaceTrustGate>>,
    /// Gates of workspaces that are not shown but still own an agent or a terminal, by canonical
    /// root. They stay open so those sessions keep working; switching back to the root reuses
    /// its gate (one gate, one trust state, per root), and a gate with no session left is closed.
    pub(crate) retained_gates: Mutex<HashMap<PathBuf, WorkspaceTrustGate>>,
    /// Language servers of the open workspace. They exist only for a workspace with a gate and
    /// run only once it is trusted; replacing or dropping them kills their processes.
    pub(crate) language_services: Mutex<Option<Arc<LanguageServices>>>,
    /// Where revision-tagged diagnostics go: recorded in `latest_diagnostics`, then sent to
    /// the UI (a Tauri event).
    pub(crate) diagnostics_sink: DiagnosticsSink,
    /// Each open document's diagnostics for its newest content, per tool: what the context
    /// MCP server publishes (`LocalMcpServer::publish_document_diagnostics`).
    pub(crate) latest_diagnostics: Arc<LatestDiagnostics>,
    /// Open terminals by id. Dropping one kills its shell and jobs.
    pub(crate) terminals: Mutex<HashMap<u32, TerminalEntry>>,
    pub(crate) next_terminal_id: AtomicU32,
    /// The loopback listener Claude Code's own status hooks call into, shared by every terminal
    /// session. Started lazily on first terminal open, not at app startup.
    pub(crate) agent_hook_server: Mutex<Option<Arc<host_core::AgentHookServer>>>,
    /// The program being debugged, if any (one at a time).
    pub(crate) debug_session: Mutex<Option<Arc<host_core::DebugSession>>>,
    pub(crate) app_data_dir: PathBuf,
    pub(crate) context_engine: Mutex<Option<SqliteWalContextEngine>>,
    /// Bumped (under the `context_engine` lock) each time a workspace is opened. An index built
    /// for an older workspace is discarded instead of being installed.
    pub(crate) workspace_generation: AtomicU64,
    /// Serializes index rebuilds: they all write the same SQLite file.
    pub(crate) index_build: Mutex<()>,
    /// Files with unsaved changes, as last reported by the UI (which also holds the edits of the
    /// projects that are not open in the editor). Closing the window asks first while it is > 0.
    pub(crate) unsaved_buffers: AtomicUsize,
    /// Set once the user has answered the close prompt, so the exit that follows goes through.
    pub(crate) exit_confirmed: AtomicBool,
    /// The main window can flush its session data before a normal exit.
    pub(crate) close_handler_ready: AtomicBool,
    /// Inline AI completion through the model gateway (strict local mode).
    pub(crate) completion: crate::commands::completion::CompletionState,
    /// The Judge: proposals being verified, reviews, planned accepts, stale ranges (`LOT-015`).
    pub(crate) judge: crate::commands::judge::JudgeState,
    /// `StaticPublishService` client (`LOT-017`): talks only to the Cloud Service's own
    /// `/v1/publish`/`/v1/rollback` endpoints, never to R2/Cloudflare/KMS directly. `None` until
    /// `HILO_CLOUD_SERVICE_URL` is configured — publishing then stays unavailable rather than
    /// falling back to anything local.
    pub(crate) publish_client: Mutex<Option<Arc<host_core::publish::PublishClient>>>,
}

impl DesktopAppState {
    pub(crate) fn new(
        bridge: DesktopBinaryEditorBridge,
        app_data_dir: PathBuf,
        diagnostics_sink: DiagnosticsSink,
    ) -> Self {
        let latest_diagnostics = Arc::new(LatestDiagnostics::new());
        let completion = crate::commands::completion::CompletionState::new(&app_data_dir);
        Self {
            bridge: Arc::new(Mutex::new(bridge)),
            agents: Mutex::new(HashMap::new()),
            next_agent_id: AtomicU32::new(1),
            login_urls: Mutex::new(HashMap::new()),
            agent_registry: Mutex::new(None),
            sandbox_runner: Mutex::new(None),
            agent_account_lock: Mutex::new(()),
            workspace_root: Mutex::new(None),
            trust_gate: Mutex::new(None),
            retained_gates: Mutex::new(HashMap::new()),
            language_services: Mutex::new(None),
            diagnostics_sink: {
                let latest = Arc::clone(&latest_diagnostics);
                Arc::new(move |batch| {
                    latest.record(batch.clone());
                    diagnostics_sink(batch);
                })
            },
            latest_diagnostics,
            terminals: Mutex::new(HashMap::new()),
            next_terminal_id: AtomicU32::new(1),
            agent_hook_server: Mutex::new(None),
            debug_session: Mutex::new(None),
            app_data_dir,
            context_engine: Mutex::new(None),
            workspace_generation: AtomicU64::new(0),
            index_build: Mutex::new(()),
            unsaved_buffers: AtomicUsize::new(0),
            exit_confirmed: AtomicBool::new(false),
            close_handler_ready: AtomicBool::new(false),
            completion,
            judge: crate::commands::judge::JudgeState::new(),
            publish_client: Mutex::new(None),
        }
    }

    /// Where the user's trust decisions are kept (survives restarts).
    pub(crate) fn trust_store_path(&self) -> PathBuf {
        self.app_data_dir.join(WORKSPACE_TRUST_STORE_FILENAME)
    }

    /// The shared local listener Claude Code's own status hooks call into, started on first use.
    /// `None` only if binding the loopback port itself failed — every terminal then just keeps
    /// using screen-based busy/idle detection, as if hooks did not exist.
    pub(crate) fn agent_hook_server(&self) -> Option<Arc<host_core::AgentHookServer>> {
        let mut guard = self.agent_hook_server.lock().ok()?;
        if guard.is_none() {
            match host_core::AgentHookServer::start() {
                Ok(server) => *guard = Some(Arc::new(server)),
                Err(error) => {
                    tracing::warn!(%error, "failed to start the agent hook listener");
                    return None;
                }
            }
        }
        guard.clone()
    }

    /// Whether an agent or a terminal of the workspace at `root` is still registered.
    pub(crate) fn owns_sessions(&self, root: &Path) -> bool {
        let agents = self
            .agents
            .lock()
            .map(|agents| {
                agents
                    .values()
                    .any(|entry| entry.gate.workspace_root() == root)
            })
            .unwrap_or(false);
        agents
            || self
                .terminals
                .lock()
                .map(|terminals| terminals.values().any(|entry| entry.root == root))
                .unwrap_or(false)
    }

    pub(crate) fn language_services(&self) -> Option<Arc<LanguageServices>> {
        self.language_services
            .lock()
            .ok()
            .and_then(|services| services.clone())
    }

    /// Whether closing the window or quitting must first ask the UI what to do with unsaved edits.
    pub(crate) fn close_needs_confirmation(&self) -> bool {
        !self.exit_confirmed.load(Ordering::SeqCst)
            && (self.close_handler_ready.load(Ordering::SeqCst)
                || self.unsaved_buffers.load(Ordering::SeqCst) > 0)
    }
}

#[cfg(test)]
pub(crate) fn test_state(data_dir: &std::path::Path) -> DesktopAppState {
    DesktopAppState::new(
        DesktopBinaryEditorBridge::with_journal(data_dir.join("documents.wal")).unwrap(),
        data_dir.to_path_buf(),
        Arc::new(|_| {}),
    )
}

/// Like `test_state`, collecting the diagnostics that would be sent to the UI. Only the Unix-only
/// language-server test uses it.
#[cfg(all(test, unix))]
pub(crate) fn test_state_collecting_diagnostics(
    data_dir: &std::path::Path,
) -> (
    DesktopAppState,
    std::sync::mpsc::Receiver<host_core::DocumentDiagnostics>,
) {
    let (sender, receiver) = std::sync::mpsc::channel();
    let sender = Mutex::new(sender);
    let state = DesktopAppState::new(
        DesktopBinaryEditorBridge::with_journal(data_dir.join("documents.wal")).unwrap(),
        data_dir.to_path_buf(),
        Arc::new(move |batch| {
            if let Ok(sender) = sender.lock() {
                let _ = sender.send(batch);
            }
        }),
    );
    (state, receiver)
}
