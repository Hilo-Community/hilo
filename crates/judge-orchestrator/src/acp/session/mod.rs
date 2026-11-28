//! One ACP agent session: the supervisor the Host drives, and the worker loop that speaks the
//! protocol. Signing in lives in `sign_in`, tool calls and permissions in `tools`.
mod connection;
mod launch;
mod sign_in;
mod tools;

use connection::{Connection, Incoming, IncomingPacket, SessionPacket, Transport};
use launch::{sandbox_spec, spawn_agent, LaunchExecutor};

use super::{
    auth::{self, AgentCredentials, AuthMethod, AuthenticationPlan},
    executor::{AgentToolExecutor, EventSink, WorkspaceText},
    mcp_relay::{self, McpRelay},
    options::{self, AgentOption},
    protocol::*,
};
use crate::{
    broker::{BrokerError, ExecutionError, ExecutionReport, ToolBroker, ToolExecutor},
    budget::BudgetUsage,
    policy::{approval_inputs, Decision, HostAuthority, PolicyEngine, SignedTaskSpec},
    IntentOutcome, Lease, Millis, TaskStateRepository,
};
use host_core::{
    Approval, ApprovalActionKind, GatedCapability, TaskSpec, TaskState, ToolArgValue, ToolCall,
    ToolCapability, ToolPrecondition, WorkspaceTrustGate, CONTRACT_SCHEMA_VERSION,
};
use sandbox_runner::{ChildInput, ResourceLimits, SandboxRunner, SandboxSpec, SandboxedChild};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    ffi::OsString,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::Ordering,
        mpsc::{self, Receiver, SyncSender, TryRecvError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Debug, Clone)]
pub enum AgentNetwork {
    Offline,
    ProviderOnly { destination: String },
    Proxy { address: std::net::SocketAddr },
}

pub struct AcpLaunch {
    pub identity: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Host-resolved installation files, never supplied by the webview.
    pub read_only_paths: Vec<PathBuf>,
    /// Explicit Host-built environment. Contains session tokens, never provider API keys.
    pub environment: BTreeMap<OsString, OsString>,
    pub writable_paths: Vec<PathBuf>,
    /// macOS preference domains the agent may read (from its reviewed profile).
    pub preference_domains: Vec<String>,
    /// macOS only, see `SandboxSpec::loopback_listen_ports`.
    pub loopback_listen_ports: Vec<u16>,
    pub credentials: AgentCredentials,
    pub network: AgentNetwork,
    pub limits: ResourceLimits,
}

pub struct AcpHost {
    /// Host-owned resources (egress listener, home lease) dropped when the session worker ends.
    pub session_resources: Vec<Box<dyn Send>>,
    pub gate: WorkspaceTrustGate,
    /// Host-provisioned task snapshot, separate from the workspace whose trust gate is held.
    pub worktree_root: PathBuf,
    pub repository: Arc<TaskStateRepository>,
    pub lease: Lease,
    pub signed: SignedTaskSpec,
    pub authority: Arc<HostAuthority>,
    pub runner: Arc<dyn SandboxRunner>,
    pub text: Arc<dyn WorkspaceText>,
    /// The user's dependency folders (`node_modules`) that the task snapshot links to. The agent
    /// and the commands it asks for may read them, never write: without this the links resolve
    /// outside the sandbox and a build or a test cannot find its packages.
    pub shared_read_only_paths: Vec<PathBuf>,
    pub clock: Arc<dyn Fn() -> Millis + Send + Sync>,
    pub events: EventSink,
    /// The Host's local MCP server as a standard HTTP MCP server, offered in `session/new` when
    /// the agent supports HTTP MCP. `None` when the session has no gateway the sandbox can reach.
    pub mcp_relay: Option<McpRelay>,
}

enum Control {
    TerminalResize(u16, u16),
    StartTerminalAuth,
    ChooseAuth(String),
    TerminalInput(String),
    SetOption(String, String),
    Prompt {
        text: String,
        previous_turns: Option<String>,
    },
    Permission(String, bool),
    PermissionOption(String, String),
    Elicitation(String, String),
    CancelTurn,
}

pub struct AcpSessionSupervisor {
    login_terminal: Arc<Mutex<Option<Box<dyn sandbox_runner::SandboxedTerminal>>>>,
    identity: String,
    controls: SyncSender<Control>,
    executor: Arc<AgentToolExecutor>,
    thread: Option<JoinHandle<()>>,
    permissions: Arc<Mutex<BTreeMap<String, String>>>,
    elicitation_urls: Arc<Mutex<BTreeMap<String, String>>>,
}

#[derive(serde::Deserialize)]
pub struct AcpOptionPreference {
    pub id: String,
    pub value: String,
}

impl AcpSessionSupervisor {
    pub fn start(host: AcpHost, launch: AcpLaunch) -> Result<Self, AcpError> {
        Self::start_with_resume(host, launch, None)
    }

    pub fn start_with_resume(
        host: AcpHost,
        launch: AcpLaunch,
        resume_session_id: Option<String>,
    ) -> Result<Self, AcpError> {
        Self::start_with_preferences(host, launch, resume_session_id, Vec::new())
    }

    pub fn start_with_preferences(
        mut host: AcpHost,
        launch: AcpLaunch,
        resume_session_id: Option<String>,
        preferred_options: Vec<AcpOptionPreference>,
    ) -> Result<Self, AcpError> {
        host.gate
            .authorize(GatedCapability::WorkspaceLocalBinary)
            .map_err(|e| AcpError::Launch(e.to_string()))?;
        if matches!(launch.credentials, AgentCredentials::HostMediated { .. }) {
            return Err(AcpError::Launch(
                "Host-mediated authentication requires a session proxy".into(),
            ));
        }
        if let AgentNetwork::ProviderOnly { destination } = launch.network {
            return Err(AcpError::Launch(format!("provider-only egress to {destination} cannot be enforced: sandbox-runner accepts only Denied or LocalProxyOnly; a Host destination-filtering proxy is missing")));
        }
        let root = host
            .worktree_root
            .canonicalize()
            .map_err(|e| AcpError::Launch(e.to_string()))?;
        // The agent sees this exact path (its cwd and the prefix of the absolute paths it sends).
        host.worktree_root.clone_from(&root);
        let executor = Arc::new(AgentToolExecutor::new(
            root.clone(),
            host.text.clone(),
            host.runner.clone(),
            launch.limits,
            host.shared_read_only_paths.clone(),
            host.events.clone(),
        ));
        let program = launch
            .program
            .canonicalize()
            .map_err(|e| AcpError::Launch(e.to_string()))?;
        let base_spec = sandbox_spec(&host, &launch, root, &program)?;
        let spawned = spawn_agent(&host, &base_spec, "launch")?;
        *executor.agent.lock().expect("agent lock") = Some(spawned.child.clone());
        let (controls, control_rx) = mpsc::sync_channel(MAX_PENDING_REQUESTS);
        let permissions = Arc::new(Mutex::new(BTreeMap::new()));
        let worker_permissions = permissions.clone();
        let elicitation_urls = Arc::new(Mutex::new(BTreeMap::new()));
        let worker_urls = elicitation_urls.clone();
        let worker_executor = executor.clone();
        let identity = launch.identity;
        let login_terminal = Arc::new(Mutex::new(None));
        let worker_terminal = login_terminal.clone();
        let thread = thread::spawn(move || {
            let mut session = Session::new(
                host,
                worker_executor,
                spawned.connection,
                SessionUi {
                    permissions: worker_permissions,
                    elicitation_urls: worker_urls,
                    login_terminal: worker_terminal,
                },
                launch.credentials,
                base_spec,
            );
            session.resume_session_id = resume_session_id;
            session.preferred_options = preferred_options.into_iter().take(8).collect();
            let result = session.run(control_rx);
            session.finish(result);
            for reader in spawned.readers {
                let _ = reader.join();
            }
        });
        Ok(Self {
            login_terminal,
            identity,
            controls,
            executor,
            thread: Some(thread),
            permissions,
            elicitation_urls,
        })
    }

    pub fn prompt(&self, text: String) -> Result<(), AcpError> {
        self.prompt_with_history(text, None)
    }

    pub fn prompt_with_history(
        &self,
        text: String,
        previous_turns: Option<String>,
    ) -> Result<(), AcpError> {
        if text.is_empty()
            || text.len() > MAX_TEXT_BYTES
            || previous_turns
                .as_ref()
                .is_some_and(|history| history.len() > 24 * 1024)
        {
            return Err(bad("prompt size limit"));
        }
        self.controls
            .try_send(Control::Prompt {
                text,
                previous_turns,
            })
            .map_err(|_| bad("session closed or pending request limit"))
    }
    /// Trusted Host UI entry point: the user's pick for one of the options the agent offered.
    pub fn set_option(&self, option_id: String, value: String) -> Result<(), AcpError> {
        if option_id.is_empty() || option_id.len() > 256 || value.is_empty() || value.len() > 256 {
            return Err(bad("option size limit"));
        }
        self.controls
            .try_send(Control::SetOption(option_id, value))
            .map_err(|_| bad("session closed or pending request limit"))
    }
    pub fn identity(&self) -> &str {
        &self.identity
    }
    pub fn start_terminal_auth(&self) -> Result<(), AcpError> {
        self.controls
            .try_send(Control::StartTerminalAuth)
            .map_err(|_| bad("session closed or pending request limit"))
    }
    /// Trusted Host UI entry point: the user's pick among the methods offered by `AuthChoice`.
    pub fn choose_authentication(&self, method_id: String) -> Result<(), AcpError> {
        self.controls
            .try_send(Control::ChooseAuth(method_id))
            .map_err(|_| bad("session closed or pending request limit"))
    }
    pub fn resize_terminal_auth(&self, cols: u16, rows: u16) -> Result<(), AcpError> {
        if !(2..=500).contains(&cols) || !(1..=200).contains(&rows) {
            return Err(bad("terminal size limit"));
        }
        self.controls
            .try_send(Control::TerminalResize(cols, rows))
            .map_err(|_| bad("session closed or pending request limit"))
    }
    pub fn write_terminal_auth(&self, text: String) -> Result<(), AcpError> {
        if text.is_empty() || text.len() > 8192 {
            return Err(bad("terminal input size limit"));
        }
        self.controls
            .try_send(Control::TerminalInput(text))
            .map_err(|_| bad("session closed or pending request limit"))
    }
    /// Trusted Host UI entry point only. The agent transport cannot call it or sign approvals.
    pub fn answer_permission(&self, id: String, allow: bool) -> Result<(), AcpError> {
        self.controls
            .try_send(Control::Permission(id, allow))
            .map_err(|_| bad("session closed or pending request limit"))
    }
    pub fn answer_permission_option(&self, id: String, option: String) -> Result<(), AcpError> {
        if option.is_empty() || option.len() > 256 {
            return Err(bad("invalid permission option"));
        }
        self.controls
            .try_send(Control::PermissionOption(id, option))
            .map_err(|_| bad("session closed or pending request limit"))
    }
    pub fn elicitation_url(&self, id: &str) -> Option<String> {
        self.elicitation_urls
            .lock()
            .expect("elicitation lock")
            .get(id)
            .cloned()
    }
    pub fn answer_elicitation(&self, id: String, action: String) -> Result<(), AcpError> {
        if !matches!(action.as_str(), "accept" | "decline" | "cancel") {
            return Err(bad("invalid elicitation action"));
        }
        self.controls
            .try_send(Control::Elicitation(id, action))
            .map_err(|_| bad("session closed or pending request limit"))
    }
    /// Cancels the current turn (ACP `session/cancel`): running commands are killed and pending
    /// requests answered as cancelled. The agent keeps running and the session stays open.
    pub fn cancel(&self) -> Result<(), AcpError> {
        self.executor.kill_commands();
        self.controls
            .try_send(Control::CancelTurn)
            .map_err(|_| bad("session closed or pending request limit"))
    }
    /// Ends the session: the agent and every command are killed.
    pub fn stop(&mut self) {
        if let Some(terminal) = self
            .login_terminal
            .lock()
            .expect("login terminal lock")
            .as_mut()
        {
            terminal.kill();
        }
        self.executor.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
    pub fn proposed_edits(&self) -> Vec<ProposedEdit> {
        self.executor.proposed_edits()
    }
    pub fn permission_description(&self, id: &str) -> Option<String> {
        self.permissions
            .lock()
            .expect("permissions lock")
            .get(id)
            .cloned()
    }
    pub fn process_ids(&self) -> Vec<u32> {
        self.executor.process_ids()
    }
}
impl Drop for AcpSessionSupervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Pending {
    request: Value,
    call: Option<ToolCall>,
    options: Value,
}
struct UrlElicitation {
    request: Value,
    elicitation_id: String,
    answered: bool,
}
struct SessionUi {
    permissions: Arc<Mutex<BTreeMap<String, String>>>,
    elicitation_urls: Arc<Mutex<BTreeMap<String, String>>>,
    login_terminal: Arc<Mutex<Option<Box<dyn sandbox_runner::SandboxedTerminal>>>>,
}
struct Session {
    auth_methods: Vec<AuthMethod>,
    login_attempted: bool,
    /// An account `authenticate` just succeeded: reported once the session is ready.
    signed_in: bool,
    base_spec: SandboxSpec,
    login_method: Option<AuthMethod>,
    login_size: Option<(u16, u16)>,
    login_terminal: Arc<Mutex<Option<Box<dyn sandbox_runner::SandboxedTerminal>>>>,
    login_input: Option<ChildInput>,
    restart_readers: Vec<JoinHandle<()>>,
    terminal_authenticated: bool,
    host: AcpHost,
    executor: Arc<AgentToolExecutor>,
    broker: Arc<ToolBroker>,
    /// `mcpServers` entry for the relay, sent only if the agent said it speaks HTTP MCP.
    mcp_entry: Option<Value>,
    mcp_http: bool,
    connection: Connection,
    session_id: Option<String>,
    resume_session_id: Option<String>,
    session_resume: bool,
    session_load: bool,
    /// What the agent offers for this session, and the picks sent but not yet answered.
    options: Vec<AgentOption>,
    pending_options: VecDeque<(String, String)>,
    preferred_options: VecDeque<AcpOptionPreference>,
    preparing_session: bool,
    seen: BTreeSet<String>,
    pending: BTreeMap<String, Pending>,
    terminals: BTreeMap<String, (Value, ToolCall, Vec<crate::policy::SignedApproval>)>,
    prompt_active: bool,
    permissions: Arc<Mutex<BTreeMap<String, String>>>,
    elicitation_urls: Arc<Mutex<BTreeMap<String, String>>>,
    elicitations: BTreeMap<String, UrlElicitation>,
    credentials: AgentCredentials,
}
impl Session {
    fn new(
        mut host: AcpHost,
        executor: Arc<AgentToolExecutor>,
        connection: Connection,
        ui: SessionUi,
        credentials: AgentCredentials,
        base_spec: SandboxSpec,
    ) -> Self {
        let broker = Arc::new(ToolBroker::new(
            host.repository.clone(),
            PolicyEngine::new(host.authority.clone()),
            executor.clone(),
            host.clock.clone(),
        ));
        let mcp_entry = host.mcp_relay.take().map(|relay| {
            let entry = relay.server_entry();
            (relay.install)(mcp_relay::handler(mcp_relay::RelayContext {
                broker: broker.clone(),
                lease: host.lease.clone(),
                signed: host.signed.clone(),
                clock: host.clock.clone(),
                events: host.events.clone(),
            }));
            entry
        });
        Self {
            auth_methods: vec![],
            login_attempted: false,
            signed_in: false,
            base_spec,
            login_method: None,
            login_size: None,
            login_terminal: ui.login_terminal,
            login_input: None,
            restart_readers: vec![],
            terminal_authenticated: matches!(
                &credentials,
                AgentCredentials::Account {
                    use_stored_credentials: true,
                    ..
                }
            ),
            host,
            executor,
            broker,
            mcp_entry,
            mcp_http: false,
            connection,
            session_id: None,
            resume_session_id: None,
            session_resume: false,
            session_load: false,
            options: Vec::new(),
            pending_options: VecDeque::new(),
            preferred_options: VecDeque::new(),
            preparing_session: false,
            seen: BTreeSet::new(),
            pending: BTreeMap::new(),
            terminals: BTreeMap::new(),
            prompt_active: false,
            permissions: ui.permissions,
            elicitation_urls: ui.elicitation_urls,
            elicitations: BTreeMap::new(),
            credentials,
        }
    }
    /// Ends the session after its loop returned: stops what is still running, then records how
    /// the task ended and tells the panel.
    fn finish(mut self, result: Result<(), AcpError>) {
        self.cancel_pending();
        let cancelled = self.executor.cancelled.load(Ordering::SeqCst);
        self.executor.stop();
        self.stop_terminal();
        for reader in self.restart_readers.drain(..) {
            let _ = reader.join();
        }
        // Every intent was recorded by the broker. Unknown outcomes stay recorded for
        // reconciliation; we never invent a success when cancellation interrupts a tool.
        let snapshot = self.host.repository.snapshot(self.host.lease.task_id());
        let target = if snapshot
            .as_ref()
            .is_some_and(|s| !s.pending_intents.is_empty())
        {
            TaskState::NeedsReconciliation
        } else if cancelled {
            TaskState::Cancelled
        } else if result.is_err() {
            TaskState::Failed
        } else {
            TaskState::Cancelled
        };
        // Ending between turns is ordinary (the chat reconnects on its next message); ending in
        // the middle of one, or with an error, is a failure the user must see.
        let interrupted = self.prompt_active && !cancelled;
        let failed = result.is_err() || interrupted;
        let reason = result.err().map_or_else(
            || {
                if cancelled {
                    "Session stopped".into()
                } else if interrupted {
                    "The agent exited during the turn".into()
                } else {
                    "Agent exited".into()
                }
            },
            |e| e.to_string(),
        );
        if let Err(error) =
            self.host
                .repository
                .transition(&self.host.lease, target, &reason, (self.host.clock)())
        {
            (self.host.events)(AcpEvent::Error {
                reason: format!("Lifecycle requires recovery: {error}"),
            });
        }
        (self.host.events)(AcpEvent::Stopped { reason, failed });
    }
    fn request(&mut self, method: &str, params: Value) -> Result<(), AcpError> {
        self.connection.request(method, params)
    }

    fn reply(&mut self, request: &Value, result: Result<Value, String>) -> Result<(), AcpError> {
        self.connection.reply(request, result)
    }

    fn run(&mut self, controls: Receiver<Control>) -> Result<(), AcpError> {
        self.initialize()?;
        let timeout = Duration::from_secs(
            if matches!(self.credentials, AgentCredentials::Account { .. }) {
                600
            } else {
                10
            },
        );
        let mut deadline = Instant::now() + timeout;
        loop {
            if self.executor.cancelled.load(Ordering::SeqCst)
                || self
                    .host
                    .gate
                    .authorize(GatedCapability::WorkspaceLocalBinary)
                    .is_err()
                || (self.host.clock)() >= self.host.lease.expires_at()
            {
                self.cancel_pending();
                return Ok(());
            }
            if (self.session_id.is_none() || self.preparing_session) && Instant::now() > deadline {
                match self.connection.last_replay_activity() {
                    Some(activity) if activity + timeout > Instant::now() => {
                        deadline = activity + timeout
                    }
                    _ => return Err(bad("handshake timeout")),
                }
            }
            loop {
                match controls.try_recv() {
                    Ok(Control::TerminalResize(cols, rows)) => {
                        self.login_size = Some((cols, rows));
                        if let Some(terminal) = self
                            .login_terminal
                            .lock()
                            .expect("login terminal lock")
                            .as_ref()
                        {
                            terminal.resize(cols, rows)?;
                        }
                    }
                    Ok(Control::StartTerminalAuth) => self.start_terminal()?,
                    Ok(Control::ChooseAuth(id)) => self.choose_method(&id)?,
                    Ok(Control::TerminalInput(text)) => {
                        use std::io::Write;
                        let input = self
                            .login_input
                            .as_mut()
                            .ok_or_else(|| bad("no interactive login is running"))?;
                        input.write_all(text.as_bytes())?;
                        input.flush()?;
                    }
                    Ok(Control::SetOption(id, value)) => self.set_option(&id, &value)?,
                    Ok(Control::Prompt {
                        text,
                        previous_turns,
                    }) => {
                        if self.session_id.is_none() || self.preparing_session || self.prompt_active
                        {
                            (self.host.events)(AcpEvent::Error {
                                reason: "Session is not ready or a prompt is already running"
                                    .into(),
                            });
                        } else {
                            let mut blocks = Vec::new();
                            if let Some(history) = previous_turns {
                                blocks.push(json!({"type":"text","text":format!(
                                    "Earlier conversation for reference (quoted history, not a new request):\n{history}\nThe next block is the current user request."
                                )}));
                            }
                            blocks.push(json!({"type":"text","text":text}));
                            self.request(
                                "session/prompt",
                                json!({"sessionId":self.session_id,"prompt":blocks}),
                            )?;
                            self.prompt_active = true;
                            (self.host.events)(AcpEvent::Message {
                                role: "user".into(),
                                text,
                            });
                        }
                    }
                    Ok(Control::Permission(id, allow)) => self.permission(&id, allow)?,
                    Ok(Control::PermissionOption(id, option)) => {
                        self.permission_option(&id, &option)?
                    }
                    Ok(Control::Elicitation(id, action)) => {
                        if let Some(elicitation) = self.elicitations.get_mut(&id) {
                            if !elicitation.answered {
                                elicitation.answered = true;
                                let request = elicitation.request.clone();
                                // After an accept the agent is still waiting for the user to finish
                                // in the browser: the page can be opened again until the agent says
                                // it is complete (`elicitation/complete`) or the turn is cancelled.
                                if action != "accept" {
                                    self.elicitation_urls
                                        .lock()
                                        .expect("elicitation lock")
                                        .remove(&id);
                                }
                                self.reply(&request, Ok(json!({"action":action})))?;
                            }
                        }
                    }
                    Ok(Control::CancelTurn) => self.cancel_pending(),
                    Err(TryRecvError::Disconnected) => return Ok(()),
                    Err(TryRecvError::Empty) => break,
                }
            }
            let terminal_status = self
                .login_terminal
                .lock()
                .expect("login terminal lock")
                .as_mut()
                .map(|terminal| terminal.try_wait())
                .transpose()?
                .flatten();
            if let Some(status) = terminal_status {
                self.stop_terminal();
                (self.host.events)(AcpEvent::TerminalAuthComplete {
                    success: status.success,
                });
                if !status.success {
                    return Err(bad("interactive account login exited without success"));
                }
                self.terminal_authenticated = true;
                self.reconnect()?;
                self.initialize()?;
                deadline = Instant::now() + timeout;
            }
            match self.connection.receive(Duration::from_millis(10))? {
                Incoming::Packet(packet) => {
                    self.message(packet)?;
                    deadline = Instant::now() + timeout;
                }
                Incoming::Closed => return Ok(()),
                Incoming::Idle => {}
            }
        }
    }
    fn initialize(&mut self) -> Result<(), AcpError> {
        self.request("initialize", json!({"protocolVersion":1,"clientInfo":{"name":"Hilo","version":"0.1.0"},"clientCapabilities":{"auth":{"terminal":self.host.runner.supports_terminal(),"_meta":{"gateway":true}},"elicitation":{"url":{}},"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true,"_meta":{"writesAreProposals":true}}}))
    }
    fn publish_options(&self) {
        (self.host.events)(AcpEvent::Options {
            options: self.options.clone(),
        });
    }
    /// Sends the user's pick to the agent, but only a value the agent itself offered, and only
    /// between turns. Anything else leaves the panel showing what is really in force.
    fn set_option(&mut self, id: &str, value: &str) -> Result<(), AcpError> {
        let request = match (&self.session_id, self.prompt_active) {
            (Some(session), false) => self
                .options
                .iter()
                .find(|option| option.id == id)
                .filter(|option| option.choices.iter().any(|choice| choice.value == value))
                .map(|option| options::change_request(option, session, value)),
            _ => None,
        };
        let Some((method, params)) = request else {
            self.publish_options();
            return Ok(());
        };
        self.request(method, params)?;
        self.pending_options.push_back((id.into(), value.into()));
        Ok(())
    }
    fn advance_session_start(&mut self) -> Result<(), AcpError> {
        while let Some(preference) = self.preferred_options.pop_front() {
            if self.options.iter().any(|option| {
                option.id == preference.id
                    && matches!(option.category.as_str(), "model" | "mode")
                    && option.current != preference.value
                    && option
                        .choices
                        .iter()
                        .any(|choice| choice.value == preference.value)
            }) {
                return self.set_option(&preference.id, &preference.value);
            }
        }
        self.preparing_session = false;
        let id = self
            .session_id
            .clone()
            .ok_or_else(|| bad("missing session id"))?;
        (self.host.events)(AcpEvent::Ready { session_id: id });
        if !self.options.is_empty() {
            self.publish_options();
        }
        if std::mem::take(&mut self.signed_in) {
            (self.host.events)(AcpEvent::Authenticated);
        }
        Ok(())
    }

    fn new_session(&mut self) -> Result<(), AcpError> {
        let cwd = super::session::tools::plain_path(&self.host.worktree_root);
        let servers = match (&self.mcp_entry, self.mcp_http) {
            (Some(entry), true) => json!([entry]),
            _ => json!([]),
        };
        if let Some(id) = &self.resume_session_id {
            let method = if self.session_resume {
                Some("session/resume")
            } else if self.session_load {
                Some("session/load")
            } else {
                None
            };
            if let Some(method) = method {
                return self.request(
                    method,
                    json!({"sessionId":id,"cwd":cwd,"mcpServers":servers}),
                );
            }
        }
        self.request("session/new", json!({"cwd":cwd,"mcpServers":servers}))
    }
    fn cancel_pending(&mut self) {
        self.elicitation_urls
            .lock()
            .expect("elicitation lock")
            .clear();
        for (id, elicitation) in std::mem::take(&mut self.elicitations) {
            self.connection
                .forget_elicitation(&elicitation.elicitation_id);
            if !elicitation.answered {
                let _ = self.reply(&elicitation.request, Ok(json!({"action":"cancel"})));
            }
            (self.host.events)(AcpEvent::ElicitationComplete { id });
        }
        self.permissions.lock().expect("permissions lock").clear();
        let pending = std::mem::take(&mut self.pending);
        for (id, item) in pending {
            let result = if item.call.is_none() {
                Ok(json!({"outcome":{"outcome":"cancelled"}}))
            } else {
                Err("Session cancelled before authorization".into())
            };
            let _ = self.reply(&item.request, result);
            (self.host.events)(AcpEvent::Tool {
                id,
                kind: "permission".into(),
                status: "denied".into(),
                locations: json!([]),
                reason: Some("Session cancelled".into()),
            });
        }
        let _ = self
            .connection
            .notify("session/cancel", json!({"sessionId":self.session_id}));
    }
    /// One message from the agent: a response to a request of ours, a notification, or a
    /// request the Host must answer.
    fn message(
        &mut self,
        IncomingPacket { kind, message }: IncomingPacket,
    ) -> Result<(), AcpError> {
        let method = message["method"].as_str().unwrap_or_default().to_owned();
        match kind {
            SessionPacket::Response => self.response(message),
            SessionPacket::Elicitation => self.elicit(message),
            SessionPacket::Notification => self.notification(&method, message),
            SessionPacket::Request => self.agent_request(&method, message),
            SessionPacket::HistoryReplay => Ok(()),
        }
    }

    /// The agent answered `initialize`, `authenticate`, `session/new` or `session/prompt`.
    fn response(&mut self, message: Value) -> Result<(), AcpError> {
        let method = self.connection.take_response(&message)?;
        if let Some(error) = message.get("error") {
            // A refused model or mode change is not a broken session: show what is in force.
            if method.starts_with("session/set_") {
                self.pending_options.pop_front();
                if self.preparing_session {
                    return self.advance_session_start();
                }
                self.publish_options();
                return Ok(());
            }
            if method == "session/resume" && self.session_load {
                self.session_resume = false;
                return self.new_session();
            }
            if method == "session/resume" || method == "session/load" {
                // A saved session may have been removed by the agent. Fall back once.
                self.resume_session_id = None;
                return self.new_session();
            }
            // A saved successful terminal login is only a hint. An expired/revoked login
            // must go through the agent's advertised flow again, once, without a fallback.
            if method == "session/new"
                && self.terminal_authenticated
                && !self.login_attempted
                && error["code"] == -32000
            {
                self.terminal_authenticated = false;
                return self.choose_authentication();
            }
            return Err(AcpError::Protocol(format!("{method}: {error}")));
        }
        match method.as_str() {
            "initialize" => {
                if message["result"]["protocolVersion"] != 1 {
                    return Err(bad("unsupported protocol version"));
                }
                let methods = auth::methods(&message["result"]["authMethods"])?;
                let capabilities = &message["result"]["agentCapabilities"];
                self.session_resume = capabilities["sessionCapabilities"]["resume"].is_object();
                self.session_load = capabilities["loadSession"] == json!(true);
                self.mcp_http = message["result"]["agentCapabilities"]["mcpCapabilities"]["http"]
                    == json!(true);
                (self.host.events)(AcpEvent::AuthMethods {
                    methods: methods.clone(),
                });
                self.auth_methods = methods;
                if self.terminal_authenticated {
                    self.new_session()?;
                } else {
                    self.choose_authentication()?;
                }
            }
            "authenticate" => {
                self.signed_in = matches!(self.credentials, AgentCredentials::Account { .. });
                self.new_session()?
            }
            "session/new" | "session/resume" | "session/load" => {
                let resume_id = self.resume_session_id.take();
                let id = if method == "session/new" {
                    message["result"]["sessionId"]
                        .as_str()
                        .filter(|s| !s.is_empty() && s.len() < 256)
                        .ok_or_else(|| bad("invalid session id"))?
                        .to_string()
                } else {
                    resume_id.ok_or_else(|| bad("missing resuming session id"))?
                };
                self.connection.bind_session(&id)?;
                self.session_id = Some(id);
                self.options = options::parse(&message["result"]);
                self.pending_options.clear();
                if method != "session/new" {
                    self.preferred_options.clear();
                }
                self.preparing_session = true;
                self.advance_session_start()?;
            }
            "session/set_config_option" | "session/set_mode" | "session/set_model" => {
                if let Some((id, value)) = self.pending_options.pop_front() {
                    // A config change answers with the whole list: it can move other options.
                    let all = options::parse(
                        &json!({"configOptions":message["result"]["configOptions"]}),
                    );
                    if method == "session/set_config_option" && !all.is_empty() {
                        self.options = all;
                    } else {
                        options::select(&mut self.options, &id, &value);
                    }
                }
                if self.preparing_session {
                    return self.advance_session_start();
                }
                self.publish_options();
            }
            "session/prompt" => {
                self.prompt_active = false;
                (self.host.events)(AcpEvent::Update {
                    update: json!({"sessionUpdate":"turn_complete","stopReason":message["result"]["stopReason"]}),
                });
            }
            _ => return Err(bad("unexpected response")),
        }
        Ok(())
    }

    /// A notification from the agent (no answer expected).
    fn notification(&mut self, method: &str, message: Value) -> Result<(), AcpError> {
        // ACP extension notifications are optional. They may describe connection-level
        // state before session/new; ignoring an unknown one never grants a capability.
        if method.starts_with('_') || method == "auth/status_update" {
            return Ok(());
        }
        if method == "elicitation/complete" {
            let elicitation_id = message["params"]["elicitationId"]
                .as_str()
                .unwrap_or_default();
            let key = self
                .elicitations
                .iter()
                .find(|(_, e)| e.elicitation_id == elicitation_id)
                .map(|(id, _)| id.clone());
            if let Some(id) = key {
                self.connection.forget_elicitation(elicitation_id);
                self.elicitations.remove(&id);
                self.elicitation_urls
                    .lock()
                    .expect("elicitation lock")
                    .remove(&id);
                (self.host.events)(AcpEvent::ElicitationComplete { id });
            }
            return Ok(());
        }
        if method != "session/update" {
            return Err(bad("unknown notification"));
        }
        let mut update = message["params"]["update"].clone();
        if !update.is_object() {
            return Err(bad("invalid session update"));
        }
        // Agents report the absolute paths ACP uses; the Host UI opens worktree-relative ones.
        if let Some(locations) = update.get_mut("locations").and_then(Value::as_array_mut) {
            for location in locations {
                if let Some(path) = location["path"].as_str() {
                    location["path"] = json!(self.relative(path));
                }
            }
        }
        // The same for the files of an edit: the card shows `src/a.ts`, not the snapshot's folder.
        if let Some(blocks) = update.get_mut("content").and_then(Value::as_array_mut) {
            for block in blocks {
                if block["type"] == "diff" {
                    if let Some(path) = block["path"].as_str() {
                        block["path"] = json!(self.relative(path));
                    }
                }
            }
        }
        // The agent changed its own mode or options (it can, for instance, leave plan mode).
        match update["sessionUpdate"].as_str() {
            Some("current_mode_update") => {
                if let Some(mode) = update["currentModeId"].as_str() {
                    if options::select(&mut self.options, "mode", mode) {
                        self.publish_options();
                    }
                }
            }
            Some("config_option_update") => {
                let all = options::parse(&json!({"configOptions":update["configOptions"]}));
                if !all.is_empty() {
                    self.options = all;
                    self.publish_options();
                }
            }
            _ => {}
        }
        (self.host.events)(AcpEvent::Update { update });
        Ok(())
    }

    /// A request from the agent in this session: a permission, one of its terminals, or a tool
    /// call the broker must authorize.
    fn agent_request(&mut self, method: &str, message: Value) -> Result<(), AcpError> {
        let key = message["id"].to_string();
        if self.seen.len() >= MAX_SESSION_ITEMS || !self.seen.insert(key.clone()) {
            return Err(bad("request count limit or duplicate id"));
        }
        if self.pending.len() >= MAX_PENDING_REQUESTS {
            return Err(bad("pending request limit"));
        }
        if method == "session/request_permission" {
            return self.permission_request(key, message);
        }
        if method.starts_with("terminal/") && method != "terminal/create" {
            return self.terminal_request(method, message);
        }
        match self.translate(&message, &key) {
            Ok(call) => self.execute(message, call, &[]),
            Err(reason) => self.reply(&message, Err(reason)),
        }
    }
}

fn tool_call(
    host: &AcpHost,
    id: &str,
    name: &str,
    cap: ToolCapability,
    args: BTreeMap<String, ToolArgValue>,
    approval: bool,
) -> ToolCall {
    ToolCall {
        schema_version: CONTRACT_SCHEMA_VERSION,
        call_id: id.into(),
        task_id: host.lease.task_id().into(),
        tool_name: name.into(),
        validated_args: args,
        required_capabilities: vec![cap],
        preconditions: if approval {
            vec![ToolPrecondition {
                description: "Host consent for one exact ACP call".into(),
                required_snapshot_hash: None,
                requires_human_approval: true,
            }]
        } else {
            vec![]
        },
        idempotency_key: format!("acp:{}:{id}", host.lease.generation()),
    }
}
