//! Launching the agent process: its sandbox, the governed launch through the broker, and the
//! threads that read what it writes.
use super::*;

pub(super) fn forbidden_read_paths(
    root: &Path,
    forbidden: &[String],
) -> Result<Vec<PathBuf>, AcpError> {
    let mut denied = Vec::new();
    for relative in forbidden {
        let normalized = crate::policy::paths::normalize(relative)
            .ok_or_else(|| bad("invalid forbidden read scope"))?;
        if normalized.is_empty() {
            return Err(bad("the entire worktree is forbidden"));
        }
        // This runner-owned directory did not exist in the snapshot. It holds only this
        // run's private scratch, which is an explicit runtime write allowance.
        if normalized == sandbox_runner::TMP_DIR_NAME {
            continue;
        }
        let mut candidates = vec![root.to_path_buf()];
        for component in normalized.split('/') {
            let mut next = Vec::new();
            for parent in candidates {
                if !parent.is_dir() {
                    continue;
                }
                for entry in std::fs::read_dir(parent)? {
                    let entry = entry?;
                    if entry.file_name().to_string_lossy().to_lowercase()
                        == component.to_lowercase()
                    {
                        next.push(
                            sandbox_runner::PathGuard::verify_within_worktree(root, &entry.path())
                                .map_err(|e| AcpError::Launch(e.to_string()))?,
                        );
                    }
                }
            }
            candidates = next;
        }
        denied.extend(candidates);
    }
    denied.sort();
    denied.dedup();
    Ok(denied)
}

/// Runs the agent process (or its login terminal) as one governed tool call of the broker.
pub(super) struct LaunchExecutor {
    pub(super) interactive: bool,
    pub(super) terminal: Mutex<Option<Box<dyn sandbox_runner::SandboxedTerminal>>>,
    pub(super) spec: SandboxSpec,
    pub(super) runner: Arc<dyn SandboxRunner>,
    pub(super) child: Mutex<Option<SandboxedChild>>,
}
impl ToolExecutor for LaunchExecutor {
    fn estimate(&self, _spec: &TaskSpec, _call: &ToolCall) -> Result<BudgetUsage, ExecutionError> {
        Ok(BudgetUsage {
            tool_calls: 1,
            cpu_ms: self
                .spec
                .limits
                .max_cpu_time
                .ok_or_else(|| ExecutionError::NotStarted("Host must supply a CPU ceiling".into()))?
                .as_secs()
                .saturating_add(1)
                .saturating_mul(1000),
            ..BudgetUsage::default()
        })
    }
    fn execute(
        &self,
        spec: &TaskSpec,
        call: &ToolCall,
        _reserved: BudgetUsage,
    ) -> Result<ExecutionReport, ExecutionError> {
        if self.interactive {
            let terminal = self
                .runner
                .spawn_terminal(&self.spec)
                .map_err(crate::acp::executor::spawn_error)?;
            *self.terminal.lock().expect("terminal launch lock") = Some(terminal);
        } else {
            let child = self
                .runner
                .spawn(&self.spec)
                .map_err(crate::acp::executor::spawn_error)?;
            *self.child.lock().expect("launch lock") = Some(child);
        }
        Ok(ExecutionReport {
            outcome: IntentOutcome {
                succeeded: true,
                summary: "Sandboxed ACP process started".into(),
            },
            actual: self.estimate(spec, call)?,
            failure_signature: None,
        })
    }
}

/// The sandbox the agent runs in: the task snapshot read-only, its forbidden paths unreadable,
/// the Host's private home writable, and the network the Host chose.
pub(super) fn sandbox_spec(
    host: &AcpHost,
    launch: &AcpLaunch,
    root: PathBuf,
    program: &Path,
) -> Result<SandboxSpec, AcpError> {
    let mut spec = SandboxSpec::new(root, program);
    spec.worktree_read_only = true;
    // Installed agents execute their own read tools against the disposable task snapshot.
    // Kernel-enforced read-only access keeps every direct write a refused operation.
    spec.mediate_worktree_reads = false;
    if !host
        .signed
        .spec
        .policy
        .allowed_paths
        .iter()
        .any(|path| crate::policy::paths::normalize(path).as_deref() == Some(""))
    {
        return Err(AcpError::Launch(
            "Direct agent reads require an explicitly authorized whole-worktree scope".into(),
        ));
    }
    spec.denied_read_paths = forbidden_read_paths(
        &spec.worktree_root,
        &host.signed.spec.policy.forbidden_paths,
    )?;
    spec.args = launch.args.iter().map(Into::into).collect();
    spec.read_only_paths = launch.read_only_paths.clone();
    spec.read_only_paths
        .extend(host.shared_read_only_paths.iter().cloned());
    spec.writable_paths = launch.writable_paths.clone();
    spec.preference_domains = launch.preference_domains.clone();
    spec.loopback_listen_ports = launch.loopback_listen_ports.clone();
    spec.env = launch.environment.clone();
    if let AgentNetwork::Proxy { address } = launch.network {
        spec.network = sandbox_runner::NetworkPolicy::LocalProxyOnly(address);
    }
    spec.limits = launch.limits;
    Ok(spec)
}

/// A running agent process: its stdin, the protocol messages it writes, and the two threads that
/// read its output (each kills the process when its output ends, is invalid or too large).
pub(super) struct Spawned {
    pub(super) child: Arc<Mutex<SandboxedChild>>,
    pub(super) connection: Connection,
    pub(super) readers: [JoinHandle<()>; 2],
}

/// Starts the agent described by `spec` through the broker, as tool call `call_id`: the policy
/// engine authorizes it and the task journal records it, like any command the agent runs.
pub(super) fn spawn_agent(
    host: &AcpHost,
    spec: &SandboxSpec,
    call_id: &str,
) -> Result<Spawned, AcpError> {
    let launch = Arc::new(LaunchExecutor {
        interactive: false,
        terminal: Mutex::new(None),
        spec: spec.clone(),
        runner: host.runner.clone(),
        child: Mutex::new(None),
    });
    let broker = ToolBroker::new(
        host.repository.clone(),
        PolicyEngine::new(host.authority.clone()),
        launch.clone(),
        host.clock.clone(),
    );
    let call = tool_call(
        host,
        call_id,
        "run_sandbox_command",
        ToolCapability::RunSandboxCommand,
        BTreeMap::from([
            (
                "program".into(),
                ToolArgValue::Text(spec.program.to_string_lossy().into_owned()),
            ),
            ("cwd".into(), ToolArgValue::Text(".".into())),
            (
                "args".into(),
                ToolArgValue::StringList(
                    spec.args
                        .iter()
                        .map(|arg| arg.to_string_lossy().into_owned())
                        .collect(),
                ),
            ),
        ]),
        false,
    );
    broker
        .execute(&host.lease, &host.signed, &call, &[], (host.clock)())
        .map_err(|e| AcpError::Launch(e.to_string()))?;
    let mut child = launch
        .child
        .lock()
        .expect("launch lock")
        .take()
        .ok_or_else(|| AcpError::Launch(format!("{call_id} replay refused: no new process")))?;
    let input = child.take_stdin().ok_or_else(|| bad("stdin unavailable"))?;
    let output = child
        .take_stdout()
        .ok_or_else(|| bad("stdout unavailable"))?;
    let mut errors = child
        .take_stderr()
        .ok_or_else(|| bad("stderr unavailable"))?;
    let child = Arc::new(Mutex::new(child));
    let limit = spec.limits.max_output_bytes;
    let transport = Transport::new(input);
    let owner = host.lease.task_id().to_owned();
    let connection = Connection::attach(transport.clone(), &owner)?;
    let output_child = child.clone();
    let output_reader = thread::spawn(move || {
        let mut input = BufReader::new(OutputBudget::new(output, limit));
        let error = loop {
            match read_message(&mut input) {
                Ok(Some(message)) => {
                    let result = transport
                        .lock()
                        .map_err(|_| bad("agent transport lock poisoned"))
                        .and_then(|mut state| state.dispatch(&owner, message));
                    if let Err(error) = result {
                        break Some(error);
                    }
                }
                Ok(None) => break None,
                Err(error) => break Some(error),
            }
        };
        // Stop first so a blocked writer cannot delay queue disconnection.
        output_child.lock().expect("child lock").kill();
        if let Ok(mut state) = transport.lock() {
            state.finish_reading(error);
        }
    });
    let error_child = child.clone();
    let error_reader = thread::spawn(move || {
        let mut bytes = 0u64;
        let mut buffer = [0u8; 4096];
        while let Ok(count) = errors.read(&mut buffer) {
            if count == 0 {
                break;
            }
            bytes = bytes.saturating_add(count as u64);
            if bytes > limit {
                error_child.lock().expect("child lock").kill();
                break;
            }
        }
    });
    Ok(Spawned {
        child,
        connection,
        readers: [output_reader, error_reader],
    })
}
