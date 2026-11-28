// The agent-launch tests need the read-only sandbox of macOS and Linux: Windows refuses that mode
// until its AppContainer backend supports it (see `src/acp/README.md`). There only the fail-closed
// test runs, and the helpers of the others would be dead code.
#![cfg_attr(
    not(any(target_os = "macos", target_os = "linux")),
    allow(dead_code, unused_imports)
)]

mod common;
use host_core::*;
use judge_orchestrator::{acp::*, policy::HostAuthority, TaskStateRepository};
use sandbox_runner::{ResourceLimits, SandboxRunner, TracingAuditSink};
use std::{
    sync::{
        mpsc::{self, Receiver},
        Arc,
    },
    time::Duration,
};

struct Text;
impl WorkspaceText for Text {
    fn text(&self, _path: &str) -> Result<String, String> {
        Ok("unsaved 🦀\r\n".into())
    }
    /// Stands in for the context engine's MCP server: answers with the method it was asked.
    fn query_local_mcp(&self, request: &str) -> Result<String, String> {
        let request: serde_json::Value =
            serde_json::from_str(request).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{"method":request["method"]}}).to_string())
    }
}
struct Fixture {
    _data: tempfile::TempDir,
    root: tempfile::TempDir,
    repository: Arc<TaskStateRepository>,
    gate: WorkspaceTrustGate,
    lease: judge_orchestrator::Lease,
    signed: judge_orchestrator::policy::SignedTaskSpec,
    authority: Arc<HostAuthority>,
}
const FAKE_AGENT_BINARY: &str = if cfg!(windows) {
    "fake-agent.exe"
} else {
    "fake-agent"
};

impl Fixture {
    fn new() -> Self {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("src/file.rs"), "disk text").unwrap();
        let binary = root.path().join(FAKE_AGENT_BINARY);
        std::fs::copy(env!("CARGO_BIN_EXE_hilo-acp-test-agent"), &binary).unwrap();
        let mut spec = common::spec();
        spec.policy.allowed_paths = vec![".".into()];
        spec.budget_limits.max_cpu_ms = 1_000_000;
        spec.budget_limits.max_tool_calls = 100;
        let authority = Arc::new(HostAuthority::new().unwrap());
        let signed = authority.sign_task(spec.clone()).unwrap();
        let (repository, lease) = common::running(data.path(), spec);
        let gate = WorkspaceTrustGate::open(data.path().join("trust"), root.path()).unwrap();
        gate.grant().unwrap();
        Self {
            _data: data,
            root,
            repository: Arc::new(repository),
            gate,
            lease,
            signed,
            authority,
        }
    }
    fn host(&self, runner: Arc<dyn SandboxRunner>) -> (AcpHost, Receiver<AcpEvent>) {
        let (tx, rx) = mpsc::channel();
        (
            AcpHost {
                session_resources: vec![],
                gate: self.gate.clone(),
                worktree_root: self.root.path().canonicalize().unwrap(),
                repository: self.repository.clone(),
                lease: self.lease.clone(),
                signed: self.signed.clone(),
                authority: self.authority.clone(),
                runner,
                text: Arc::new(Text),
                shared_read_only_paths: vec![],
                clock: Arc::new(|| 2),
                events: Arc::new(move |event| {
                    let _ = tx.send(event);
                }),
                mcp_relay: None,
            },
            rx,
        )
    }
    fn launch(&self, mode: &str) -> AcpLaunch {
        AcpLaunch {
            identity: "fixture".into(),
            read_only_paths: vec![],
            writable_paths: vec![],
            preference_domains: vec![],
            loopback_listen_ports: vec![],
            environment: Default::default(),
            program: self.root.path().join(FAKE_AGENT_BINARY),
            args: vec![mode.into()],
            credentials: AgentCredentials::Unauthenticated,
            network: AgentNetwork::Offline,
            limits: ResourceLimits {
                wall_timeout: Duration::from_secs(10),
                max_cpu_time: Some(Duration::from_secs(2)),
                ..ResourceLimits::default()
            },
        }
    }
    fn start(&self, mode: &str) -> (AcpSessionSupervisor, Receiver<AcpEvent>) {
        let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink))
            .expect("native sandbox is a blocking requirement");
        let (host, rx) = self.host(Arc::from(runner));
        let session = AcpSessionSupervisor::start(host, self.launch(mode)).unwrap();
        match next(&rx) {
            AcpEvent::Ready { .. } => {}
            other => panic!("unexpected startup event: {other:?}"),
        }
        session.prompt("test".into()).unwrap();
        (session, rx)
    }
    fn disk(&self) -> String {
        std::fs::read_to_string(self.root.path().join("src/file.rs")).unwrap()
    }
}
fn next(rx: &Receiver<AcpEvent>) -> AcpEvent {
    loop {
        let event = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("ACP must not hang");
        if !matches!(event, AcpEvent::AuthMethods { .. }) {
            return event;
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn replacement_session_applies_available_preferences_before_ready() {
    let fixture = Fixture::new();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (host, rx) = fixture.host(Arc::from(runner));
    let _session = AcpSessionSupervisor::start_with_preferences(
        host,
        fixture.launch("options"),
        None,
        vec![
            AcpOptionPreference {
                id: "mode".into(),
                value: "unavailable".into(),
            },
            AcpOptionPreference {
                id: "model".into(),
                value: "fast".into(),
            },
            AcpOptionPreference {
                id: "mode".into(),
                value: "plan".into(),
            },
        ],
    )
    .unwrap();
    loop {
        match next(&rx) {
            AcpEvent::Ready { .. } => break,
            AcpEvent::Update { .. } => {}
            other => panic!("unexpected startup event: {other:?}"),
        }
    }
    let AcpEvent::Options { options } = next(&rx) else {
        panic!("missing options")
    };
    assert!(options
        .iter()
        .any(|option| option.id == "mode" && option.current == "plan"));
    assert!(options
        .iter()
        .any(|option| option.id == "model" && option.current == "fast"));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn failed_resume_and_load_continue_with_a_new_session_and_separate_history() {
    let fixture = Fixture::new();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (host, rx) = fixture.host(Arc::from(runner));
    let session = AcpSessionSupervisor::start_with_resume(
        host,
        fixture.launch("recovery-fallback"),
        Some("saved".into()),
    )
    .unwrap();
    assert!(matches!(next(&rx), AcpEvent::Ready { session_id } if session_id == "replacement"));
    session
        .prompt_with_history(
            "follow-up".into(),
            Some(r#"[{"role":"user","text":"saved user turn"}]"#.into()),
        )
        .unwrap();
    assert!(matches!(next(&rx), AcpEvent::Message { text, .. } if text == "follow-up"));
    assert!(matches!(next(&rx), AcpEvent::Update { update }
        if update["sessionUpdate"] == "turn_complete"));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn a_load_cannot_route_updates_to_a_different_chat() {
    let fixture = Fixture::new();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (host, rx) = fixture.host(Arc::from(runner));
    let _session = AcpSessionSupervisor::start_with_resume(
        host,
        fixture.launch("foreign-replay"),
        Some("saved".into()),
    )
    .unwrap();
    // A protocol failure is reported as one: the chat shows it instead of reconnecting silently.
    assert!(matches!(next(&rx), AcpEvent::Stopped { reason, failed: true }
        if reason.contains("wrong session for session/update")));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn an_inline_permission_returns_only_an_advertised_option_id() {
    let fixture = Fixture::new();
    let (session, rx) = fixture.start("permission-choice");
    assert!(matches!(next(&rx), AcpEvent::Message { .. }));
    let AcpEvent::Permission { id, .. } = next(&rx) else {
        panic!("expected the agent's permission request");
    };
    session
        .answer_permission_option(id.clone(), "unknown".into())
        .unwrap();
    session
        .answer_permission_option(id, "remember".into())
        .unwrap();
    assert!(matches!(next(&rx), AcpEvent::Update { update }
        if update["content"]["text"] == "choice confirmed"));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn restores_an_acp_session_and_suppresses_history_already_displayed_by_the_client() {
    for mode in ["resume", "load"] {
        let fixture = Fixture::new();
        let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
        let (host, rx) = fixture.host(Arc::from(runner));
        let mut session = AcpSessionSupervisor::start_with_resume(
            host,
            fixture.launch(mode),
            Some("saved".into()),
        )
        .unwrap();
        assert!(matches!(next(&rx), AcpEvent::Ready { session_id } if session_id == "saved"));
        session.prompt("follow-up".into()).unwrap();
        assert!(matches!(next(&rx), AcpEvent::Message { text, .. } if text == "follow-up"));
        // An ordinary end is not a failure: the chat reconnects on its next message.
        session.stop();
        loop {
            if let AcpEvent::Stopped { failed, .. } = next(&rx) {
                assert!(!failed, "{mode}: a requested stop is not a failure");
                break;
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn generic_gateway_authentication_precedes_session_creation_and_a_real_fixture_turn() {
    let f = Fixture::new();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (host, rx) = f.host(Arc::from(runner));
    let mut launch = f.launch("auth-gateway");
    launch.credentials = AgentCredentials::Gateway {
        protocol: "fixture".into(),
        base_url: "http://127.0.0.1:123/provider".into(),
        headers: std::collections::BTreeMap::from([(
            "x-hilo-session".into(),
            "session-token-only".into(),
        )]),
        provider_name: "Fixture".into(),
        environment_fallback: false,
    };
    let mut session = AcpSessionSupervisor::start(host, launch).unwrap();
    assert!(matches!(next(&rx), AcpEvent::Ready { .. }));
    session.prompt("test authenticated turn".into()).unwrap();
    loop {
        if let AcpEvent::Update { update } = next(&rx) {
            if update["sessionUpdate"] == "agent_message_chunk" {
                assert_eq!(update["content"]["text"], "authenticated fixture turn");
                break;
            }
        }
    }
    session.stop();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn url_elicitation_binds_to_authentication_waits_for_user_and_handles_completion() {
    let f = Fixture::new();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (host, rx) = f.host(Arc::from(runner));
    let mut launch = f.launch("auth-url");
    launch.credentials = AgentCredentials::Account {
        use_stored_credentials: false,
        method_id: Some("fixture-login".into()),
        preferred_methods: vec![],
        browser_hosts: vec!["auth.example.com".into()],
    };
    let mut session = AcpSessionSupervisor::start(host, launch).unwrap();
    let AcpEvent::Elicitation { id, url, message } = next(&rx) else {
        panic!("missing URL elicitation")
    };
    assert_eq!(url, "https://auth.example.com/verify");
    assert!(message.contains("1234"));
    assert_eq!(session.elicitation_url(&id).as_deref(), Some(url.as_str()));
    assert!(
        rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "the Host must wait for the user"
    );
    session
        .answer_elicitation(id.clone(), "accept".into())
        .unwrap();
    assert!(
        matches!(next(&rx), AcpEvent::ElicitationComplete { id: completed } if completed == id)
    );
    assert!(matches!(next(&rx), AcpEvent::Ready { .. }));
    assert!(session.elicitation_url(&id).is_none());
    session.stop();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn an_account_sign_in_waits_for_the_users_choice_of_method() {
    let f = Fixture::new();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (host, rx) = f.host(Arc::from(runner));
    let mut launch = f.launch("auth-url");
    launch.credentials = AgentCredentials::Account {
        use_stored_credentials: false,
        method_id: None,
        preferred_methods: vec!["fixture-login".into()],
        browser_hosts: vec!["auth.example.com".into()],
    };
    let mut session = AcpSessionSupervisor::start(host, launch).unwrap();
    let methods = loop {
        if let AcpEvent::AuthChoice { methods } = next(&rx) {
            break methods;
        }
    };
    assert!(methods.iter().any(|m| m.id == "fixture-login"));
    assert!(
        rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "nothing starts until the user chooses"
    );
    // A method the agent never offered is refused and changes nothing.
    session.choose_authentication("unknown".into()).unwrap();
    assert!(matches!(next(&rx), AcpEvent::Error { .. }));
    session
        .choose_authentication("fixture-login".into())
        .unwrap();
    assert!(matches!(next(&rx), AcpEvent::Elicitation { .. }));
    session.stop();
}

#[cfg(target_os = "macos")]
#[test]
fn terminal_login_uses_a_real_private_pty_and_reconnects_the_acp_transport() {
    let f = Fixture::new();
    let home = tempfile::tempdir().unwrap();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (host, rx) = f.host(Arc::from(runner));
    let mut launch = f.launch("auth-terminal");
    launch.credentials = AgentCredentials::Account {
        use_stored_credentials: false,
        method_id: Some("fixture-terminal".into()),
        preferred_methods: vec![],
        browser_hosts: vec![],
    };
    launch.environment.insert(
        "HOME".into(),
        home.path().canonicalize().unwrap().into_os_string(),
    );
    launch.writable_paths.push(home.path().to_path_buf());
    let mut session = AcpSessionSupervisor::start(host, launch).unwrap();
    assert!(matches!(next(&rx), AcpEvent::TerminalAuth { .. }));
    assert!(!home.path().join("fixture-login").exists());
    session.start_terminal_auth().unwrap();
    let mut output = String::new();
    loop {
        match next(&rx) {
            AcpEvent::TerminalAuthOutput { data } => {
                output.push_str(&String::from_utf8_lossy(&data))
            }
            event => panic!("unexpected event before login input: {event:?}"),
        }
        if output.contains("Enter fixture code:") {
            break;
        }
    }
    session
        .write_terminal_auth("fixture-code\r".into())
        .unwrap();
    let mut completed = false;
    loop {
        match next(&rx) {
            AcpEvent::TerminalAuthComplete { success } => {
                assert!(success);
                completed = true;
            }
            AcpEvent::TerminalAuthOutput { .. } => {}
            AcpEvent::Ready { session_id } => {
                assert!(completed);
                assert_eq!(session_id, "reconnected");
                break;
            }
            event => panic!("unexpected event during reconnect: {event:?}"),
        }
    }
    assert_eq!(
        std::fs::read_to_string(home.path().join("fixture-login")).unwrap(),
        "authenticated"
    );
    session.stop();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn unsafe_or_unbound_url_elicitation_never_reaches_the_host_ui() {
    for mode in ["auth-unsafe-url", "auth-wrong-scope"] {
        let f = Fixture::new();
        let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
        let (host, rx) = f.host(Arc::from(runner));
        let mut launch = f.launch(mode);
        launch.credentials = AgentCredentials::Account {
            use_stored_credentials: false,
            method_id: Some("fixture-login".into()),
            preferred_methods: vec![],
            browser_hosts: vec!["auth.example.com".into()],
        };
        let mut session = AcpSessionSupervisor::start(host, launch).unwrap();
        assert!(matches!(next(&rx), AcpEvent::Stopped { .. }));
        session.stop();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn the_files_of_an_edit_reach_the_ui_relative_to_the_worktree() {
    let f = Fixture::new();
    let (mut session, rx) = f.start("edit-update");
    let update = loop {
        if let AcpEvent::Update { update } = next(&rx) {
            if update["sessionUpdate"] == "tool_call" {
                break update;
            }
        }
    };
    session.stop();
    assert_eq!(update["content"][0]["path"], "src/a.rs");
    assert_eq!(update["locations"][0]["path"], "src/a.rs");
    assert_eq!(update["content"][0]["newText"], "fn a() {}");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn the_user_can_pick_a_mode_or_model_the_agent_offered_and_nothing_else() {
    let f = Fixture::new();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (host, rx) = f.host(Arc::from(runner));
    let mut session = AcpSessionSupervisor::start(host, f.launch("options")).unwrap();
    assert!(matches!(next(&rx), AcpEvent::Ready { .. }));
    let options = |rx: &Receiver<AcpEvent>| loop {
        if let AcpEvent::Options { options } = next(rx) {
            return options;
        }
    };
    let offered = options(&rx);
    let current = |options: &[judge_orchestrator::acp::AgentOption], id: &str| {
        options
            .iter()
            .find(|o| o.id == id)
            .map(|o| o.current.clone())
            .unwrap()
    };
    assert_eq!(current(&offered, "mode"), "default");
    assert_eq!(current(&offered, "model"), "deep");
    // A value the agent never offered is not sent; the panel is told what is in force.
    session
        .set_option("mode".into(), "bypassEverything".into())
        .unwrap();
    assert_eq!(current(&options(&rx), "mode"), "default");
    session.set_option("model".into(), "fast".into()).unwrap();
    let after = options(&rx);
    assert_eq!(current(&after, "model"), "fast");
    assert_eq!(current(&after, "mode"), "default");
    session.set_option("mode".into(), "plan".into()).unwrap();
    assert_eq!(current(&options(&rx), "mode"), "plan");
    session.stop();
}

/// The task snapshot links its `node_modules` to the user's installation: the agent must be able
/// to read through those links, and still never write to them.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn shared_dependency_folders_are_readable_but_never_writable_by_the_agent() {
    let f = Fixture::new();
    let shared = tempfile::tempdir().unwrap();
    let binary = shared.path().join("agent");
    std::fs::copy(env!("CARGO_BIN_EXE_hilo-acp-test-agent"), &binary).unwrap();
    let module = shared.path().join("module.txt");
    std::fs::write(&module, "shared package").unwrap();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (mut host, rx) = f.host(Arc::from(runner));
    host.shared_read_only_paths = vec![shared.path().to_path_buf()];
    let mut launch = f.launch("installation");
    launch.program = binary;
    assert!(launch.read_only_paths.is_empty());
    let mut session = AcpSessionSupervisor::start(host, launch).unwrap();
    assert!(matches!(next(&rx), AcpEvent::Ready { .. }));
    session.prompt("test".into()).unwrap();
    loop {
        if let AcpEvent::Update { update } = next(&rx) {
            assert_eq!(
                update["content"]["text"],
                "module=shared package; write=false"
            );
            break;
        }
    }
    session.stop();
    assert_eq!(std::fs::read_to_string(module).unwrap(), "shared package");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn installed_agent_modules_are_shared_read_only_through_the_launch_broker() {
    let f = Fixture::new();
    let installation = tempfile::tempdir().unwrap();
    let binary = installation.path().join("agent");
    std::fs::copy(env!("CARGO_BIN_EXE_hilo-acp-test-agent"), &binary).unwrap();
    let module = installation.path().join("module.txt");
    std::fs::write(&module, "installed code").unwrap();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (host, rx) = f.host(Arc::from(runner));
    let mut launch = f.launch("installation");
    launch.program = binary;
    launch.read_only_paths = vec![installation.path().to_path_buf()];
    let mut session = AcpSessionSupervisor::start(host, launch).unwrap();
    assert!(matches!(next(&rx), AcpEvent::Ready { .. }));
    session.prompt("test".into()).unwrap();
    loop {
        if let AcpEvent::Update { update } = next(&rx) {
            assert_eq!(
                update["content"]["text"],
                "module=installed code; write=false"
            );
            break;
        }
    }
    session.stop();
    assert_eq!(std::fs::read_to_string(module).unwrap(), "installed code");
    assert_eq!(
        f.repository
            .snapshot("task")
            .unwrap()
            .resolved_intents
            .len(),
        1
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn agent_write_is_one_proposal_with_live_rope_base_and_never_changes_disk() {
    let f = Fixture::new();
    let (mut session, rx) = f.start("write");
    let mut approved = false;
    let edit = loop {
        match next(&rx) {
            AcpEvent::Permission { id, .. } => {
                assert!(session.proposed_edits().is_empty());
                session.answer_permission(id, true).unwrap();
                approved = true;
            }
            AcpEvent::ProposedEdit { edit } => break edit,
            _ => {}
        }
    };
    assert_eq!(edit.old_text, "unsaved 🦀\r\n");
    assert!(approved, "a write requires Host consent");
    assert_eq!(edit.new_text, "new 🦀\n");
    assert_eq!(
        edit.base_content_hash,
        host_core::compute_rope_blake3_hex(&ropey::Rope::from_str(&edit.old_text))
    );
    session.stop();
    assert_eq!(session.proposed_edits().len(), 1);
    assert_eq!(f.disk(), "disk text");
    assert!(f
        .repository
        .snapshot("task")
        .unwrap()
        .pending_intents
        .is_empty());
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn denied_policy_and_host_rejection_execute_nothing() {
    let mut f = Fixture::new();
    f.signed = f
        .authority
        .sign_task({
            let mut spec = f.signed.spec.clone();
            spec.policy.autonomy_level = AutonomyLevel::ProposalOnly;
            spec
        })
        .unwrap();
    // This signed task cannot even authorize process launch, before any fake agent exists.
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (host, _) = f.host(Arc::from(runner));
    assert!(AcpSessionSupervisor::start(host, f.launch("write")).is_err());
    assert!(f
        .repository
        .snapshot("task")
        .unwrap()
        .resolved_intents
        .is_empty());
    let f = Fixture::new();
    let (mut session, rx) = f.start("write");
    loop {
        match next(&rx) {
            AcpEvent::Permission { id, .. } => session.answer_permission(id, false).unwrap(),
            AcpEvent::Update { update } if update.to_string().contains("Rejected by Host user") => {
                break
            }
            _ => {}
        }
    }
    session.stop();
    assert!(session.proposed_edits().is_empty());
    assert_eq!(f.disk(), "disk text");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn traversal_absolute_and_forbidden_paths_in_any_case_are_denied_to_agent() {
    let f = Fixture::new();
    let (mut session, rx) = f.start("paths");
    let mut refused = 0;
    while refused < 7 {
        if let AcpEvent::Update { update } = next(&rx) {
            if update["content"]["text"]
                .as_str()
                .is_some_and(|s| s.contains("\"error\""))
            {
                refused += 1;
            }
        }
    }
    session.stop();
    assert_eq!(
        f.repository
            .snapshot("task")
            .unwrap()
            .resolved_intents
            .len(),
        1,
        "only launch ran"
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn malformed_oversized_unknown_and_pending_overflow_do_not_hang() {
    for mode in ["malformed", "oversized", "unknown", "flood"] {
        let f = Fixture::new();
        let (mut session, rx) = f.start(mode);
        loop {
            match next(&rx) {
                AcpEvent::Stopped { .. } => break,
                AcpEvent::Update { update }
                    if mode == "unknown" && update.to_string().contains("Unknown ACP method") =>
                {
                    break
                }
                _ => {}
            }
        }
        session.stop();
        assert!(f
            .repository
            .snapshot("task")
            .unwrap()
            .pending_intents
            .is_empty());
        if mode != "unknown" {
            assert_eq!(
                f.repository.snapshot("task").unwrap().state,
                TaskState::Failed
            );
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn terminal_lifecycle_replays_brokered_output_without_executing_again() {
    let f = Fixture::new();
    let (mut session, rx) = f.start("terminal-complete");
    let mut output = false;
    loop {
        match next(&rx) {
            AcpEvent::Permission { id, .. } => session.answer_permission(id, true).unwrap(),
            AcpEvent::Update { update } => {
                let text = update["content"]["text"].as_str().unwrap_or("");
                if text.contains("terminal-output") {
                    output = true;
                }
                if text.contains("Unknown terminal") {
                    break;
                }
            }
            _ => {}
        }
    }
    session.stop();
    assert!(output);
    assert_eq!(
        f.repository
            .snapshot("task")
            .unwrap()
            .resolved_intents
            .len(),
        2
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn real_environment_is_empty_of_configured_secrets_and_direct_writes_are_blocked() {
    std::env::set_var("HILO_TEST_BYOK_SECRET", "never-pass-this");
    for mode in ["environment", "direct-write", "direct-read"] {
        let f = Fixture::new();
        let (mut session, rx) = f.start(mode);
        loop {
            if let AcpEvent::Update { update } = next(&rx) {
                let text = update["content"]["text"].as_str().unwrap();
                if mode == "environment" {
                    assert!(!text.contains("HILO_TEST_BYOK_SECRET"));
                    assert!(!text.contains("HOME"));
                } else if mode == "direct-read" {
                    assert_eq!(text, "direct-read=true");
                } else {
                    assert_eq!(text, format!("{mode}=false"));
                }
                break;
            }
        }
        session.stop();
        assert_eq!(f.disk(), "disk text");
    }
    std::env::remove_var("HILO_TEST_BYOK_SECRET");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn direct_snapshot_reads_still_enforce_signed_forbidden_paths_in_any_case() {
    let f = Fixture::new();
    std::fs::create_dir(f.root.path().join("src/SECRETS")).unwrap();
    std::fs::write(f.root.path().join("src/SECRETS/key"), "synthetic-secret").unwrap();
    let (mut session, rx) = f.start("direct-secret");
    loop {
        if let AcpEvent::Update { update } = next(&rx) {
            assert_eq!(update["content"]["text"], "direct-secret=false");
            break;
        }
    }
    session.stop();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn cancellation_kills_sandbox_tree_and_records_every_intent() {
    let f = Fixture::new();
    let (mut session, rx) = f.start("terminal");
    loop {
        if let AcpEvent::Permission { id, .. } = next(&rx) {
            session.answer_permission(id, true).unwrap();
            break;
        }
    }
    // Wait for a durable terminal intent, rather than racing process registration.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while session.process_ids().len() < 2 {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let started = std::time::Instant::now();
    let pids = session.process_ids();
    session.stop();
    for pid in pids {
        assert!(
            !std::process::Command::new("/bin/ps")
                .args(["-p", &pid.to_string()])
                .output()
                .unwrap()
                .status
                .success(),
            "child {pid} survived cancellation"
        );
    }
    assert!(started.elapsed() < Duration::from_secs(3));
    let snapshot = f.repository.snapshot("task").unwrap();
    assert!(
        snapshot.pending_intents.is_empty(),
        "{:?}",
        snapshot.pending_intents
    );
    assert_eq!(snapshot.state, TaskState::Cancelled);
    assert_eq!(snapshot.resolved_intents.len(), 2);
}

struct Unavailable;
impl SandboxRunner for Unavailable {
    fn capabilities(&self) -> sandbox_runner::EngineCapabilities {
        panic!("not needed")
    }
    fn run(
        &self,
        _: &sandbox_runner::SandboxSpec,
    ) -> Result<sandbox_runner::RunOutput, sandbox_runner::SandboxError> {
        panic!("never run")
    }
    fn spawn(
        &self,
        _: &sandbox_runner::SandboxSpec,
    ) -> Result<sandbox_runner::SandboxedChild, sandbox_runner::SandboxError> {
        Err(sandbox_runner::SandboxError::SandboxUnavailable {
            reason: "test unavailable".into(),
        })
    }
}
#[test]
fn unavailable_sandbox_untrusted_workspace_network_and_credentials_fail_closed() {
    let f = Fixture::new();
    let (host, _) = f.host(Arc::new(Unavailable));
    let error = AcpSessionSupervisor::start(host, f.launch("write"))
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("unavailable"), "{error}");
    let snapshot = f.repository.snapshot("task").unwrap();
    assert!(snapshot.pending_intents.is_empty());
    assert!(snapshot
        .resolved_intents
        .values()
        .all(|outcome| !outcome.succeeded));
    f.gate.revoke().unwrap();
    let (host, _) = f.host(Arc::new(Unavailable));
    assert!(AcpSessionSupervisor::start(host, f.launch("write"))
        .err()
        .unwrap()
        .to_string()
        .contains("trusted"));
    f.gate.grant().unwrap();
    for network in [false, true] {
        let (host, _) = f.host(Arc::new(Unavailable));
        let mut launch = f.launch("write");
        if network {
            launch.network = AgentNetwork::ProviderOnly {
                destination: "https://provider.example".into(),
            };
        } else {
            launch.credentials = AgentCredentials::HostMediated {
                description: "requires login".into(),
            };
        }
        let error = AcpSessionSupervisor::start(host, launch)
            .err()
            .unwrap()
            .to_string();
        assert!(
            error.contains(if network { "egress" } else { "authentication" }),
            "{error}"
        );
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn absolute_paths_inside_the_worktree_work_as_acp_specifies() {
    let f = Fixture::new();
    let (mut session, rx) = f.start("absolute");
    let (mut read, mut location) = (false, false);
    while !(read && location) {
        if let AcpEvent::Update { update } = next(&rx) {
            if update["sessionUpdate"] == "tool_call" {
                // The UI receives the worktree-relative path it can open.
                assert_eq!(update["locations"][0]["path"], "src/file.rs");
                location = true;
            } else if update["content"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("unsaved"))
            {
                read = true;
            }
        }
    }
    session.stop();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn a_verbose_command_keeps_the_end_of_its_output_and_the_session_alive() {
    let f = Fixture::new();
    let (mut session, rx) = f.start("terminal-verbose");
    let output = loop {
        match next(&rx) {
            AcpEvent::Permission { id, .. } => session.answer_permission(id, true).unwrap(),
            AcpEvent::Stopped { reason, .. } => panic!("the session ended: {reason}"),
            AcpEvent::Update { update } => {
                let text = update["content"]["text"].as_str().unwrap_or("");
                let echoed: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
                if echoed["id"] == 11 {
                    break echoed["result"].clone();
                }
            }
            _ => {}
        }
    };
    session.stop();
    assert_eq!(output["truncated"], true);
    assert_eq!(output["exitStatus"]["exitCode"], 0);
    let text = output["output"].as_str().unwrap();
    assert!(text.len() <= MAX_TERMINAL_OUTPUT_BYTES);
    assert!(text.ends_with("line 3999\n"), "the end is kept");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn cancelling_a_turn_stops_its_command_but_not_the_agent() {
    let f = Fixture::new();
    let (mut session, rx) = f.start("terminal");
    loop {
        if let AcpEvent::Permission { id, .. } = next(&rx) {
            session.answer_permission(id, true).unwrap();
            break;
        }
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while session.process_ids().len() < 2 {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let started = std::time::Instant::now();
    session.cancel().unwrap();
    // The agent, still alive, echoes the answer to its `sleep 60` command: it ended at once.
    loop {
        if let AcpEvent::Update { update } = next(&rx) {
            if update["content"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("terminalId"))
            {
                break;
            }
        }
    }
    assert!(started.elapsed() < Duration::from_secs(3));
    session.stop();
    assert!(f
        .repository
        .snapshot("task")
        .unwrap()
        .pending_intents
        .is_empty());
}

#[cfg(target_os = "windows")]
#[test]
fn windows_acp_session_enforces_read_only_worktree_forbidden_paths_and_absolute_paths() {
    for mode in ["direct-read", "direct-write", "direct-secret"] {
        let f = Fixture::new();
        if mode == "direct-secret" {
            std::fs::create_dir(f.root.path().join("src/SECRETS")).unwrap();
            std::fs::write(f.root.path().join("src/SECRETS/key"), "synthetic-secret").unwrap();
        }
        let (mut session, rx) = f.start(mode);
        loop {
            if let AcpEvent::Update { update } = next(&rx) {
                let text = update["content"]["text"].as_str().unwrap();
                let expected = if mode == "direct-read" {
                    "direct-read=true"
                } else {
                    &format!("{mode}=false")
                };
                assert_eq!(text, expected);
                break;
            }
        }
        session.stop();
        assert_eq!(f.disk(), "disk text");
    }

    let f = Fixture::new();
    let (mut session, rx) = f.start("absolute");
    let (mut read, mut location) = (false, false);
    while !(read && location) {
        if let AcpEvent::Update { update } = next(&rx) {
            if update["sessionUpdate"] == "tool_call" {
                assert_eq!(update["locations"][0]["path"], "src/file.rs");
                location = true;
            } else if update["content"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("unsaved"))
            {
                read = true;
            }
        }
    }
    session.stop();
}

/// A relay whose handler the test can call as the gateway would.
fn relay() -> (McpRelay, Arc<std::sync::Mutex<Option<McpHandler>>>) {
    let slot = Arc::new(std::sync::Mutex::new(None));
    let installed = slot.clone();
    let relay = McpRelay {
        url: "http://127.0.0.1:9/hilo-mcp".into(),
        authorization: "Bearer relay-token".into(),
        install: Box::new(move |handler| *installed.lock().unwrap() = Some(handler)),
    };
    (relay, slot)
}

fn offered_servers(rx: &Receiver<AcpEvent>) -> serde_json::Value {
    loop {
        if let AcpEvent::Update { update } = next(rx) {
            if let Some(text) = update["content"]["text"].as_str() {
                if let Some(servers) = text.strip_prefix("mcp=") {
                    return serde_json::from_str(servers).unwrap();
                }
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn the_mcp_relay_is_offered_only_to_agents_that_speak_http_mcp_and_goes_through_the_broker() {
    let f = Fixture::new();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (mut host, rx) = f.host(Arc::from(runner));
    let (relay, slot) = relay();
    host.mcp_relay = Some(relay);
    let mut session = AcpSessionSupervisor::start(host, f.launch("mcp")).unwrap();
    assert!(matches!(next(&rx), AcpEvent::Ready { .. }));
    session.prompt("test".into()).unwrap();
    assert_eq!(
        offered_servers(&rx),
        serde_json::json!([{"type":"http","name":"hilo","url":"http://127.0.0.1:9/hilo-mcp",
            "headers":[{"name":"Authorization","value":"Bearer relay-token"}]}])
    );
    let handler = slot.lock().unwrap().clone().expect("handler installed");
    // Notifications reach no tool; malformed or batched messages are refused.
    assert_eq!(
        handler(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#),
        Ok(None)
    );
    assert!(handler("[]").is_err());
    assert!(handler(r#"{"id":1,"method":"ping"}"#).is_err());
    assert!(handler(r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#).is_err());
    let answer: serde_json::Value = serde_json::from_str(
        &handler(r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"search"}}"#)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(answer["id"], 7);
    assert_eq!(answer["result"]["method"], "tools/call");
    // The call was recorded and shown like any brokered tool.
    let mut statuses = vec![];
    while statuses.len() < 2 {
        if let AcpEvent::Tool {
            id, kind, status, ..
        } = next(&rx)
        {
            assert_eq!((id.as_str(), kind.as_str()), ("mcp-0", "query_local_mcp"));
            statuses.push(status);
        }
    }
    assert_eq!(statuses, ["running", "done"]);
    let snapshot = f.repository.snapshot(f.lease.task_id()).unwrap();
    assert!(snapshot
        .resolved_intents
        .keys()
        .any(|key| key.starts_with("mcp:")));
    session.stop();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn an_agent_without_http_mcp_is_offered_no_servers() {
    let f = Fixture::new();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (mut host, rx) = f.host(Arc::from(runner));
    host.mcp_relay = Some(relay().0);
    let mut session = AcpSessionSupervisor::start(host, f.launch("mcp-plain")).unwrap();
    assert!(matches!(next(&rx), AcpEvent::Ready { .. }));
    session.prompt("test".into()).unwrap();
    assert_eq!(offered_servers(&rx), serde_json::json!([]));
    session.stop();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn an_untrusted_workspace_never_installs_the_relay() {
    let f = Fixture::new();
    f.gate.revoke().unwrap();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (mut host, _rx) = f.host(Arc::from(runner));
    let (relay, slot) = relay();
    host.mcp_relay = Some(relay);
    // An untrusted workspace cannot even launch the agent, so the relay is never installed.
    assert!(AcpSessionSupervisor::start(host, f.launch("mcp")).is_err());
    assert!(slot.lock().unwrap().is_none());
}
