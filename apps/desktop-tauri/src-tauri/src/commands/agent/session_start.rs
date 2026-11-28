//! Starting an agent session: the task checkpoint and worktree it runs in, the signed task and
//! lease, the workspace text it reads, and the sandboxed supervisor.
use super::{
    gate, login_pages, CPU_ALLOWANCE, FORBIDDEN_PATHS, MAX_LAUNCH_ARGS, MAX_LAUNCH_BYTES,
    SESSION_LIFETIME,
};
use crate::{bridge::DesktopBinaryEditorBridge, state::DesktopAppState};
use host_core::*;
use judge_orchestrator::{
    acp::*,
    policy::{HostAuthority, SignedTaskSpec},
    Lease, TaskStateRepository,
};
use sandbox_runner::{PathGuard, ResourceLimits, TracingAuditSink};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, Manager};

/// The workspace text the agent reads: the live Rope of an open document (unsaved edits
/// included), otherwise the file on disk. Reading never opens a document in the editor.
pub(super) struct HostText {
    pub(super) root: PathBuf,
    pub(super) bridge: Arc<Mutex<DesktopBinaryEditorBridge>>,
    pub(super) mcp: Mutex<Option<context_engine::LocalMcpServer>>,
    // Dropped last: the MCP server above closes its database before the task files are removed.
    pub(super) _task: Option<TaskFiles>,
}

/// The task worktree and context database of one session, removed when the session ends.
pub(super) struct TaskFiles {
    manager: CheckpointManager,
    task_id: String,
    worktree: PathBuf,
    context_db: PathBuf,
    _slot_lock: Option<std::fs::File>,
}

impl Drop for TaskFiles {
    fn drop(&mut self) {
        if let Err(error) = self.manager.release_worktree(&self.task_id) {
            tracing::warn!(%error, "ACP task worktree cleanup failed");
        }
        for suffix in ["", "-wal", "-shm"] {
            let mut path = self.context_db.clone().into_os_string();
            path.push(suffix);
            match std::fs::remove_file(&path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    tracing::warn!(%error, "ACP context database cleanup failed");
                }
                _ => {}
            }
        }
    }
}

impl HostText {
    fn open_document_text(&self, path: &Path) -> Result<Option<String>, String> {
        let bridge = self.bridge.lock().map_err(|_| "document lock poisoned")?;
        let Some(session) = bridge
            .document_service()
            .sessions()
            .filter(|s| s.disk_path() == Some(path))
            .max_by_key(|s| s.session_generation())
        else {
            return Ok(None);
        };
        if session.rope().len_bytes() > MAX_FILE_BYTES {
            return Err("file size limit".into());
        }
        Ok(Some(session.rope().to_string()))
    }
}

impl WorkspaceText for HostText {
    fn query_local_mcp(&self, request: &str) -> Result<String, String> {
        let mut guard = self.mcp.lock().map_err(|_| "MCP lock poisoned")?;
        if guard.is_none() {
            let files = self._task.as_ref().ok_or("Local MCP is unavailable")?;
            let engine = context_engine::SqliteWalContextEngine::open_or_rebuild_from_workspace(
                &files.context_db,
                &files.worktree,
                "acp-session",
            )
            .map_err(|e| e.to_string())?;
            *guard = Some(context_engine::LocalMcpServer::new(
                engine,
                context_engine::ContextBundleAssembler::new(vec![AuthorizedDestination::LocalOnly]),
            ));
        }
        let mcp = guard.as_mut().ok_or("Local MCP is unavailable")?;
        let bridge = self.bridge.lock().map_err(|_| "document lock poisoned")?;
        mcp.engine
            .overlay_mut()
            .sync_from_document_service(Some(&self.root), bridge.document_service());
        mcp.handle_line(request)
            .map(|value| value.to_string())
            .ok_or_else(|| "MCP notification has no response".into())
    }

    fn text(&self, relative: &str) -> Result<String, String> {
        let path = PathGuard::verify_within_worktree(&self.root, &self.root.join(relative))
            .map_err(|e| e.to_string())?;
        if let Some(text) = self.open_document_text(&path)? {
            return Ok(text);
        }
        let mut text = String::new();
        std::fs::File::open(&path)
            .map_err(|e| e.to_string())?
            .take(MAX_FILE_BYTES as u64 + 1)
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        if text.len() > MAX_FILE_BYTES {
            return Err("file size limit".into());
        }
        Ok(text)
    }
}

pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(super) fn check_launch(program: &str, args: &[String]) -> Result<(), String> {
    let bytes = program.len() + args.iter().map(String::len).sum::<usize>();
    if !Path::new(program).is_absolute() || args.len() > MAX_LAUNCH_ARGS || bytes > MAX_LAUNCH_BYTES
    {
        return Err("Invalid agent launch arguments".into());
    }
    Ok(())
}

pub(super) fn resolve_launch(
    state: &DesktopAppState,
    gate: &WorkspaceTrustGate,
    installed_agent_id: &str,
) -> Result<agent_registry::LaunchCommand, String> {
    gate.authorize(GatedCapability::WorkspaceLocalBinary)
        .map_err(|e| e.to_string())?;
    let launch = crate::commands::agent_registry::registry(state)?
        .launch_command(installed_agent_id)
        .map_err(|e| e.to_string())?;
    check_launch(&launch.program.to_string_lossy(), &launch.args)?;
    Ok(launch)
}

pub(super) fn task_spec(task_id: &str, workspace: &Path, base_snapshot_id: String) -> TaskSpec {
    TaskSpec {
        schema_version: CONTRACT_SCHEMA_VERSION,
        task_id: task_id.into(),
        objective: "ACP agent proposal session".into(),
        workspace_id: workspace.to_string_lossy().into_owned(),
        base_snapshot_id,
        target_env: TargetEnvironment::LocalWorktree,
        policy: ExecutionPolicy {
            autonomy_level: AutonomyLevel::BoundedAutoCorrect,
            network_allowed: false,
            allowed_paths: vec![".".into()],
            forbidden_paths: FORBIDDEN_PATHS.map(Into::into).to_vec(),
            max_auto_retries: 2,
            workspace_trusted: true,
        },
        budget_limits: BudgetLimits {
            max_tokens: 0,
            max_cost_usd_micros: 0,
            max_cpu_ms: 3_600_000,
            max_tool_calls: 512,
        },
        acceptance_criteria: vec![],
        state: TaskState::Created,
    }
}

/// A checkpoint of the workspace (unsaved buffers included) and the CoW task worktree made
/// from it, where the agent and its commands run.
pub(super) struct Provisioned {
    task_id: String,
    checkpoint: String,
    worktree: PathBuf,
    /// The user's dependency folders the worktree links to; the sandbox shares them read-only.
    shared_packages: Vec<PathBuf>,
    files: TaskFiles,
}

fn lock_worktree_slot(data_dir: &Path, slot: &str) -> Result<std::fs::File, String> {
    let directory = data_dir.join("agent-worktree-locks");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join(format!("{slot}.lock")))
        .map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|e| {
        if e.kind() == fs2::lock_contended_error().kind() {
            "An agent is already connected to this chat".into()
        } else {
            format!("Cannot lock the agent worktree: {e}")
        }
    })?;
    Ok(file)
}

fn provision_at(
    state: &DesktopAppState,
    root: &Path,
    id: u32,
    worktree_slot: Option<String>,
) -> Result<Provisioned, String> {
    let task_id = format!("acp-{}-{id}", now());
    let manager = CheckpointManager::open_or_shadow(root, &state.app_data_dir.join("shadow-repos"))
        .map_err(|e| e.to_string())?
        .with_worktrees_dir(&state.app_data_dir.join("agent-worktrees"))
        .map_err(|e| e.to_string())?;
    let buffers: Vec<_> = state
        .bridge
        .lock()
        .map_err(|_| "document lock poisoned")?
        .document_service()
        .sessions()
        .filter_map(|s| {
            let path = s.disk_path().filter(|p| p.starts_with(root))?;
            Some((path.to_path_buf(), s.rope().to_string()))
        })
        .collect();
    let buffers: Vec<_> = buffers
        .iter()
        .map(|(path, text)| UnsavedBuffer { path, text })
        .collect();
    let slot_lock = worktree_slot
        .as_deref()
        .map(|slot| lock_worktree_slot(&state.app_data_dir, slot))
        .transpose()?;
    let worktree_slot = worktree_slot.unwrap_or_else(|| task_id.clone());
    if slot_lock.is_some() {
        // The sandboxed process cannot outlive its owning host. Only a lock holder may clean
        // the previous snapshot, and the lock is retained through TaskFiles::drop.
        manager
            .release_worktree(&worktree_slot)
            .map_err(|e| e.to_string())?;
    }
    let checkpoint = manager
        .create_checkpoint(&task_id, CheckpointKind::BeforeAgent, &buffers)
        .map_err(|e| e.to_string())?;
    let task = manager
        .provision_worktree_slot(&task_id, &worktree_slot)
        .map_err(|e| e.to_string())?;
    let context_db = state.app_data_dir.join(format!("{task_id}-context.sqlite"));
    Ok(Provisioned {
        files: TaskFiles {
            manager,
            task_id: worktree_slot,
            worktree: task.workspace.clone(),
            context_db,
            _slot_lock: slot_lock,
        },
        task_id,
        checkpoint: checkpoint.commit,
        worktree: task.workspace,
        shared_packages: task
            .shared_package_stores
            .into_iter()
            .map(|store| store.source)
            .collect(),
    })
}

/// A Running task signed by a fresh Host authority, under a lease held for the session.
pub(super) fn start_task(
    state: &DesktopAppState,
    spec: TaskSpec,
) -> Result<
    (
        Arc<TaskStateRepository>,
        Lease,
        SignedTaskSpec,
        Arc<HostAuthority>,
    ),
    String,
> {
    let repository = TaskStateRepository::open(state.app_data_dir.join("agent-tasks"))
        .map_err(|e| e.to_string())?;
    let authority = Arc::new(HostAuthority::new().map_err(|e| e.to_string())?);
    let signed = authority
        .sign_task(spec.clone())
        .map_err(|e| e.to_string())?;
    let task_id = spec.task_id.clone();
    repository
        .create_task(spec, now())
        .map_err(|e| e.to_string())?;
    let lease = repository
        .acquire_lease(&task_id, "acp-host", SESSION_LIFETIME, now())
        .map_err(|e| e.to_string())?;
    for next in [
        TaskState::ContextReady,
        TaskState::Planned,
        TaskState::Running,
    ] {
        repository
            .transition(&lease, next, "Host started ACP session", now())
            .map_err(|e| e.to_string())?;
    }
    Ok((Arc::new(repository), lease, signed, authority))
}

pub(super) fn sandbox_runner(
    state: &DesktopAppState,
) -> Result<Arc<dyn sandbox_runner::SandboxRunner>, String> {
    let mut cached = state
        .sandbox_runner
        .lock()
        .map_err(|_| "sandbox runner lock poisoned")?;
    if let Some(runner) = cached.as_ref() {
        return Ok(Arc::clone(runner));
    }
    let runner: Arc<dyn sandbox_runner::SandboxRunner> = Arc::from(
        sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).map_err(|e| e.to_string())?,
    );
    *cached = Some(Arc::clone(&runner));
    Ok(runner)
}

pub(super) fn start_session(
    app: &tauri::AppHandle,
    installed_agent_id: String,
    conversation_id: Option<String>,
    resume_session_id: Option<String>,
    expected_workspace: Option<String>,
    preferred_options: Vec<AcpOptionPreference>,
    events: Channel<AcpEvent>,
) -> Result<u32, String> {
    let state = app.state::<DesktopAppState>();
    // Held for the whole function: no account mutation (sign-out, preference change, re-auth)
    // may race a session start, from resolving the launch through inserting the running session.
    let _account_lock = state
        .agent_account_lock
        .lock()
        .map_err(|_| "account lock poisoned")?;
    let gate = gate(&state, expected_workspace.as_deref())?;
    let (launch, registry, runtime) = {
        // The program comes from the registry by id, never from the webview, and the user already
        // confirmed it when installing; it still runs only in the read-only sandbox.
        let mut launch = resolve_launch(&state, &gate, &installed_agent_id)?;
        let registry = crate::commands::agent_registry::registry(&state)?;
        let account = registry
            .account(&launch.installation_id)
            .map_err(|e| e.to_string())?;
        let mut runtime = crate::commands::agent_account::runtime(
            &state.app_data_dir,
            &installed_agent_id,
            &launch,
            &account.preferences,
            account.terminal_authenticated,
        )?;
        if let Some(prepared) = registry
            .prepare_runtime(&installed_agent_id)
            .map_err(|error| error.to_string())?
        {
            runtime
                .environment
                .insert(prepared.variable, prepared.program.into_os_string());
            launch.read_only_paths.push(prepared.read_only_path);
        }
        (launch, registry, runtime)
    };
    let installation_id = launch.installation_id.clone();
    // Only the reviewed account hosts of this agent's providers may be opened for its sign-in.
    let login_hosts = login_pages::hosts(&installed_agent_id);
    let open_url_file = runtime.open_url_file.clone();
    gate.authorize(GatedCapability::WorkspaceLocalBinary)
        .map_err(|e| e.to_string())?;
    let id = state.next_agent_id.fetch_add(1, Ordering::SeqCst);
    let root = gate.workspace_root().to_path_buf();
    // Keep the path stable for ACP session recovery. Each launch still gets a fresh snapshot
    // and a fresh policy task and lease. No path supplied by the webview is used.
    let worktree_slot = conversation_id
        .filter(|chat| {
            !chat.is_empty()
                && chat.len() <= 64
                && chat
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .map(|chat| {
            let mut hash = blake3::Hasher::new();
            hash.update(root.as_os_str().as_encoded_bytes());
            hash.update(b"\0");
            hash.update(installation_id.as_bytes());
            hash.update(b"\0");
            hash.update(chat.as_bytes());
            let prefix = if installed_agent_id == "github-copilot-cli" {
                "copilot"
            } else {
                "acp-chat"
            };
            format!("{prefix}-{}", &hash.finalize().to_hex().as_str()[..48])
        });
    let resume_session_id =
        resume_session_id.filter(|id| worktree_slot.is_some() && !id.is_empty() && id.len() < 256);
    let task = provision_at(&state, &root, id, worktree_slot)?;
    // A program inside the workspace runs from the task snapshot, not from the live workspace.
    let program = launch.program;
    let program = program
        .strip_prefix(&root)
        .map_or_else(|_| program.clone(), |p| task.worktree.join(p));
    let mut spec = task_spec(&task.task_id, &root, task.checkpoint);
    spec.policy.network_allowed = matches!(runtime.network, AgentNetwork::Proxy { .. });
    let (repository, lease, signed, authority) = start_task(&state, spec)?;
    let runner = sandbox_runner(&state)?;
    let text = workspace_text(&state, root, task.files)?;
    // The agent can reach only the gateway's loopback port, so the local MCP server is served
    // there, behind its own token; every request still goes through the session's broker.
    let mcp_relay = runtime.gateway.as_ref().map(|gateway| {
        let slot = gateway.mcp_relay();
        McpRelay {
            url: slot.url().to_owned(),
            authorization: slot.authorization(),
            install: Box::new(move |handler| slot.install(handler)),
        }
    });
    let host = AcpHost {
        session_resources: runtime
            .gateway
            .into_iter()
            .map(|gateway| Box::new(gateway) as Box<dyn Send>)
            .collect(),
        gate: gate.clone(),
        worktree_root: task.worktree,
        repository,
        lease,
        signed,
        authority,
        runner,
        text: Arc::new(text),
        shared_read_only_paths: task.shared_packages,
        clock: Arc::new(now),
        events: Arc::new(event_sink(
            app.clone(),
            id,
            gate.clone(),
            registry,
            installation_id,
            login_hosts.clone(),
            events,
        )),
        mcp_relay,
    };
    let home_dir = runtime.home.clone();
    let launch = AcpLaunch {
        identity: launch.installation_id,
        program,
        args: launch.args,
        read_only_paths: launch.read_only_paths,
        writable_paths: vec![runtime.home],
        preference_domains: runtime.preference_domains,
        loopback_listen_ports: runtime.loopback_listen_ports,
        environment: runtime.environment,
        credentials: runtime.credentials,
        network: runtime.network,
        limits: ResourceLimits {
            wall_timeout: SESSION_LIFETIME,
            max_cpu_time: Some(CPU_ALLOWANCE),
            ..ResourceLimits::default()
        },
    };
    let supervisor = AcpSessionSupervisor::start_with_preferences(
        host,
        launch,
        resume_session_id,
        preferred_options,
    )
    .map_err(|e| e.to_string())?;
    if !home_dir.is_dir() {
        return Err("Agent account was signed out while starting".into());
    }
    // Revocations (and a switch away from a workspace that has no session yet) close this same
    // gate. Recheck while holding the map, so cleanup either sees this session or this insertion
    // observes the closed gate.
    let mut agents = state.agents.lock().map_err(|_| "agents lock poisoned")?;
    gate.authorize(GatedCapability::WorkspaceLocalBinary)
        .map_err(|e| e.to_string())?;
    agents.insert(
        id,
        crate::state::AgentEntry {
            gate: gate.clone(),
            session: Arc::new(Mutex::new(supervisor)),
        },
    );
    drop(agents);
    drop(_account_lock);
    if let Some(file) = open_url_file {
        login_pages::watch_shim_reports(app.clone(), id, file, login_hosts, SESSION_LIFETIME);
    }
    Ok(id)
}

/// What the agent reads of the workspace: open documents (unsaved edits included) and files of
/// the task worktree, and a local MCP server over the task's own context database (initialized
/// lazily on first query so session startup is not blocked by full workspace indexing).
fn workspace_text(
    state: &DesktopAppState,
    root: PathBuf,
    files: TaskFiles,
) -> Result<HostText, String> {
    Ok(HostText {
        root,
        bridge: state.bridge.clone(),
        mcp: Mutex::new(None),
        _task: Some(files),
    })
}

/// Where the session's events go: to the panel, after the Host acts on the few it must: it opens
/// the sign-in page a login terminal prints, records sign-in results and advertised methods for
/// the next session, and hands proposals to the Judge, which verifies them when the turn ends.
fn event_sink(
    app: tauri::AppHandle,
    id: u32,
    gate: WorkspaceTrustGate,
    registry: Arc<agent_registry::AgentRegistry>,
    installation_id: String,
    login_hosts: Vec<String>,
    events: Channel<AcpEvent>,
) -> impl Fn(AcpEvent) + Send + Sync + 'static {
    let login_watch = Mutex::new(login_pages::TerminalWatch::default());
    move |event| {
        match &event {
            AcpEvent::TerminalAuthOutput { data } => {
                // A sandboxed login cannot open a browser: the Host opens the page it prints.
                let found = login_watch
                    .lock()
                    .ok()
                    .and_then(|mut watch| watch.feed(data, &login_hosts));
                if let Some(url) = found {
                    login_pages::open(&app, id, url);
                }
            }
            AcpEvent::Authenticated => {
                if let Err(error) = registry.record_terminal_authentication(&installation_id, true)
                {
                    tracing::warn!(%error, "could not save account authentication state");
                }
            }
            AcpEvent::TerminalAuthComplete { success } => {
                if let Err(error) =
                    registry.record_terminal_authentication(&installation_id, *success)
                {
                    tracing::warn!(%error, "could not save terminal authentication state");
                }
            }
            AcpEvent::AuthMethods { methods } => {
                match methods
                    .iter()
                    .map(serde_json::to_value)
                    .collect::<Result<Vec<_>, _>>()
                {
                    Ok(methods) => {
                        if let Err(error) = registry.record_auth_methods(&installation_id, methods)
                        {
                            tracing::warn!(%error, "could not save agent authentication methods");
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%error, "could not serialize agent authentication methods")
                    }
                }
            }
            AcpEvent::ProposedEdit { edit } => {
                crate::commands::judge::record_proposal(&app.state::<DesktopAppState>(), id, edit);
            }
            AcpEvent::Update { update }
                if update["sessionUpdate"] == "turn_complete"
                    && update["stopReason"] != "cancelled" =>
            {
                let state = app.state::<DesktopAppState>();
                if crate::commands::judge::take_pending_turn(&state, id) {
                    let app = app.clone();
                    let gate = gate.clone();
                    std::thread::spawn(move || {
                        let state = app.state::<DesktopAppState>();
                        crate::commands::judge::evaluate_turn(&state, id, &gate, &|text| {
                            super::prompt_agent(&state, id, text)
                        });
                    });
                }
            }
            _ => {}
        }
        let _ = events.send(event);
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    #[test]
    fn a_live_worktree_cannot_be_reclaimed_but_an_abandoned_one_can() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let state = crate::state::test_state(data.path());
        let slot = "acp-test-slot";
        let managed = provision_at(&state, &root, 1, Some(slot.into())).unwrap();
        assert!(provision_at(&state, &root, 2, Some(slot.into())).is_err());
        let original_path = managed.worktree.clone();
        let original_task = managed.task_id.clone();
        drop(managed);

        let manager = CheckpointManager::open_or_shadow(&root, &data.path().join("shadow-repos"))
            .unwrap()
            .with_worktrees_dir(&data.path().join("agent-worktrees"))
            .unwrap();
        let lock = lock_worktree_slot(data.path(), slot).unwrap();
        manager
            .provision_worktree_slot(&original_task, slot)
            .unwrap();
        assert!(original_path.exists());
        drop(lock); // Simulate the OS releasing ownership on process exit.

        let restored = provision_at(&state, &root, 3, Some(slot.into())).unwrap();
        assert_ne!(restored.task_id, original_task);
        assert_eq!(restored.worktree, original_path);
        assert!(restored.worktree.exists());
    }
}
