//! Opt-in check of a real installed agent in the real sandbox (macOS).
use super::session_start::*;
use super::*;
use sandbox_runner::{ResourceLimits, TracingAuditSink};
use std::path::PathBuf;

/// Opt-in transport diagnostic using a deliberately invalid key. This does not satisfy
/// the real-provider acceptance turn; it detects home, gateway, TLS and adapter failures
/// without accessing any user credential or project.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires installed ACP packages and provider network; uses a synthetic invalid key"]
fn installed_gateway_transport_smoke() {
    let registry_path = std::env::var_os("HILO_SMOKE_REGISTRY").expect("set HILO_SMOKE_REGISTRY");
    let agent_id = std::env::var("HILO_SMOKE_AGENT").expect("set HILO_SMOKE_AGENT");
    // `account`: the agent's own login through the CONNECT allowlist; the test stops at the
    // verification request and never completes a sign-in.
    let account_mode = std::env::var("HILO_SMOKE_MODE").as_deref() == Ok("account");
    let registry = agent_registry::AgentRegistry::open(registry_path).unwrap();
    let mut launch = registry.launch_command(&agent_id).unwrap();
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let root = work.path().canonicalize().unwrap();
    std::fs::write(
        root.join("README.md"),
        "Disposable authentication transport fixture.\n",
    )
    .unwrap();
    let mut runtime = crate::commands::agent_account::runtime_with_key_reader(
        data.path(),
        &agent_id,
        &launch,
        &agent_registry::accounts::AccountPreferences {
            mode: if account_mode {
                agent_registry::accounts::AccountMode::Account
            } else {
                agent_registry::accounts::AccountMode::ApiKey
            },
            // `HILO_SMOKE_METHOD=chat-gpt`: the browser sign-in, which reports its page
            // through the agent's `open` shim instead of an elicitation.
            method_id: std::env::var("HILO_SMOKE_METHOD").ok(),
            ..Default::default()
        },
        false,
        |_| {
            Ok(Some(zeroize::Zeroizing::new(
                "hilo-synthetic-invalid-key".into(),
            )))
        },
    )
    .unwrap();
    if let (Ok(variable), Some(path)) = (
        std::env::var("HILO_SMOKE_OVERRIDE_NAME"),
        std::env::var_os("HILO_SMOKE_OVERRIDE_PATH"),
    ) {
        let path = PathBuf::from(path).canonicalize().unwrap();
        runtime
            .environment
            .insert(variable.into(), path.clone().into_os_string());
        launch
            .read_only_paths
            .push(path.parent().unwrap().to_path_buf());
    }
    let state = crate::state::test_state(data.path());
    let metrics = runtime.gateway.as_ref().unwrap().metrics();
    let mut spec = task_spec("installed-smoke", &root, "fixture".into());
    spec.policy.network_allowed = true;
    let (repository, lease, signed, authority) = start_task(&state, spec).unwrap();
    let gate = WorkspaceTrustGate::open(data.path().join("trust"), &root).unwrap();
    gate.grant().unwrap();
    let runner = sandbox_runner::native_sandbox(Arc::new(TracingAuditSink)).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let host = AcpHost {
        session_resources: runtime
            .gateway
            .into_iter()
            .map(|gateway| Box::new(gateway) as Box<dyn Send>)
            .collect(),
        gate,
        worktree_root: root.clone(),
        repository,
        lease,
        signed,
        authority,
        runner: Arc::from(runner),
        text: Arc::new(HostText {
            root,
            bridge: state.bridge.clone(),
            mcp: Mutex::new(None),
            _task: None,
        }),
        shared_read_only_paths: vec![],
        clock: Arc::new(now),
        events: Arc::new(move |event| {
            let _ = tx.send(event);
        }),
        // The smoke test checks the launch only: it has no task store for the local MCP server.
        mcp_relay: None,
    };
    let mut session = AcpSessionSupervisor::start(
        host,
        AcpLaunch {
            identity: launch.installation_id,
            program: launch.program,
            args: launch.args,
            read_only_paths: launch.read_only_paths,
            environment: runtime.environment,
            writable_paths: vec![runtime.home],
            preference_domains: runtime.preference_domains,
            loopback_listen_ports: runtime.loopback_listen_ports,
            credentials: runtime.credentials,
            network: runtime.network,
            limits: ResourceLimits {
                wall_timeout: Duration::from_secs(90),
                max_cpu_time: Some(CPU_ALLOWANCE),
                ..Default::default()
            },
        },
    )
    .unwrap();
    let mut ready = false;
    let open_file = runtime.open_url_file.clone();
    let mut idle = 0;
    loop {
        let event = match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(event) => event,
            Err(_) => {
                idle += 1;
                assert!(idle < 45, "installed agent stalled");
                if let Some(file) = open_file.as_ref().filter(|file| file.exists()) {
                    let text = std::fs::read_to_string(file).unwrap_or_default();
                    let host = login_pages::login_url(&text, &["auth.openai.com".to_string()])
                        .and_then(|url| tauri::Url::parse(&url).ok())
                        .and_then(|url| url.host_str().map(str::to_string));
                    eprintln!("{agent_id}: the open shim reported a page on {host:?}");
                    assert!(host.is_some());
                    break;
                }
                continue;
            }
        };
        match event {
            AcpEvent::Ready { .. } => {
                ready = true;
                eprintln!("{agent_id}: gateway-authenticated session ready");
                session
                    .prompt("Reply with the single word READY. Do not use tools.".into())
                    .unwrap();
            }
            AcpEvent::Stopped { reason, .. } => {
                eprintln!("{agent_id}: {reason}");
                let traffic = metrics.snapshot();
                eprintln!("{agent_id}: gateway evidence: {traffic:?}");
                let reason = reason.to_lowercase();
                assert!(
                    reason.contains("401")
                        || reason.contains("unauthorized")
                        || reason.contains("invalid_api_key")
                        || (ready && traffic.last_status == Some(401)),
                    "unexpected transport failure"
                );
                break;
            }
            AcpEvent::Update { update } if update["sessionUpdate"] == "turn_complete" => {
                let traffic = metrics.snapshot();
                eprintln!(
                    "{agent_id}: turn completed; session-ready={ready}; gateway={traffic:?}; stopReason={}",
                    update["stopReason"]
                );
                assert!(ready);
                assert!(
                    traffic.responses > 0,
                    "agent did not reach the Host gateway"
                );
                assert_eq!(traffic.last_status, Some(401));
                break;
            }
            AcpEvent::AuthMethods { methods } => {
                eprintln!("{agent_id}: {} advertised auth methods", methods.len())
            }
            AcpEvent::Elicitation { url, message, .. } if account_mode => {
                let host = url
                    .strip_prefix("https://")
                    .and_then(|rest| rest.split(['/', '?', '#']).next())
                    .filter(|host| !host.is_empty());
                eprintln!("{agent_id}: login verification requested on {host:?}");
                // The shape of the message, with the one-time code masked.
                let shape: String = match message.split_once("code:") {
                    Some((head, code)) => format!(
                        "{head}code:{}",
                        code.chars()
                            .map(|c| if c.is_ascii_alphanumeric() { 'X' } else { c })
                            .collect::<String>()
                    ),
                    None => message.clone(),
                };
                eprintln!("{agent_id}: message shape: {shape:?}");
                assert!(host.is_some());
                break;
            }
            AcpEvent::Error { reason } => eprintln!("{agent_id}: {reason}"),
            _ => {}
        }
    }
    session.stop();
}
