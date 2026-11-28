//! Signing the agent in: the choice of method, the interactive terminal login and the
//! reconnection after it, and URL elicitations (a page the user opens in the browser).
use super::*;

impl Session {
    pub(super) fn stop_terminal(&mut self) {
        self.login_input.take();
        if let Some(mut terminal) = self
            .login_terminal
            .lock()
            .expect("login terminal lock")
            .take()
        {
            terminal.kill();
        }
    }

    pub(super) fn start_terminal(&mut self) -> Result<(), AcpError> {
        self.login_attempted = true;
        let method = self
            .login_method
            .take()
            .ok_or_else(|| bad("no terminal login is pending"))?;
        let spec = auth::terminal_spec(&self.base_spec, &method)?;
        let launch = Arc::new(LaunchExecutor {
            spec: spec.clone(),
            runner: self.host.runner.clone(),
            child: Mutex::new(None),
            interactive: true,
            terminal: Mutex::new(None),
        });
        let broker = ToolBroker::new(
            self.host.repository.clone(),
            PolicyEngine::new(self.host.authority.clone()),
            launch.clone(),
            self.host.clock.clone(),
        );
        let call = tool_call(
            &self.host,
            "interactive-login",
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
            .execute(
                &self.host.lease,
                &self.host.signed,
                &call,
                &[],
                (self.host.clock)(),
            )
            .map_err(|e| AcpError::Launch(e.to_string()))?;
        let mut terminal = launch
            .terminal
            .lock()
            .expect("terminal launch lock")
            .take()
            .ok_or_else(|| bad("login launch replay refused"))?;
        if let Some((cols, rows)) = self.login_size {
            terminal.resize(cols, rows)?;
        }
        self.login_input = Some(
            terminal
                .take_stdin()
                .ok_or_else(|| bad("login stdin unavailable"))?,
        );
        let mut output = terminal
            .take_stdout()
            .ok_or_else(|| bad("login stdout unavailable"))?;
        *self.login_terminal.lock().expect("login terminal lock") = Some(terminal);
        let terminal = self.login_terminal.clone();
        let events = self.host.events.clone();
        let limit = self.base_spec.limits.max_output_bytes;
        self.restart_readers.push(thread::spawn(move || {
            let mut bytes = 0u64;
            let mut buffer = [0u8; 4096];
            while let Ok(count) = output.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                bytes = bytes.saturating_add(count as u64);
                if bytes > limit {
                    if let Some(terminal) = terminal.lock().expect("login terminal lock").as_mut() {
                        terminal.kill();
                    }
                    break;
                }
                events(AcpEvent::TerminalAuthOutput {
                    data: buffer[..count].to_vec(),
                });
            }
        }));
        Ok(())
    }

    pub(super) fn reconnect(&mut self) -> Result<(), AcpError> {
        if let Some(previous) = self.executor.agent.lock().expect("agent lock").take() {
            previous.lock().expect("child lock").kill();
        }
        let spawned = spawn_agent(&self.host, &self.base_spec, "launch-after-login")?;
        self.connection = spawned.connection;
        *self.executor.agent.lock().expect("agent lock") = Some(spawned.child);
        self.restart_readers.extend(spawned.readers);
        self.seen.clear();
        Ok(())
    }

    /// The user picked a sign-in method: it must be one the agent advertised, and not a Host
    /// gateway method, which only the Host's own key setup may use.
    pub(super) fn choose_method(&mut self, id: &str) -> Result<(), AcpError> {
        let offered = self
            .auth_methods
            .iter()
            .any(|m| m.id == id && m.meta["gateway"].is_null() && self.login_method.is_none());
        let waiting = matches!(
            &self.credentials,
            AgentCredentials::Account {
                method_id: None,
                ..
            }
        ) && self.session_id.is_none();
        if !offered || !waiting {
            (self.host.events)(AcpEvent::Error {
                reason: "That sign-in method is not available".into(),
            });
            return Ok(());
        }
        if let AgentCredentials::Account { method_id, .. } = &mut self.credentials {
            *method_id = Some(id.into());
        }
        self.choose_authentication()
    }

    pub(super) fn choose_authentication(&mut self) -> Result<(), AcpError> {
        // An account sign-in with no method fixed in Settings is the user's to choose.
        if matches!(
            &self.credentials,
            AgentCredentials::Account {
                method_id: None,
                ..
            }
        ) {
            let methods: Vec<AuthMethod> = self
                .auth_methods
                .iter()
                .filter(|m| m.meta["gateway"].is_null())
                .cloned()
                .collect();
            if methods.is_empty() {
                return Err(bad("agent does not advertise an account login"));
            }
            (self.host.events)(AcpEvent::AuthChoice { methods });
            return Ok(());
        }
        match auth::authentication(&self.credentials, &self.auth_methods)? {
            AuthenticationPlan::Skip => self.new_session(),
            AuthenticationPlan::Request(params) => self.request("authenticate", params),
            AuthenticationPlan::Terminal(method) => {
                if !self.host.runner.supports_terminal() {
                    return Err(bad(
                        "interactive sandboxed login is unavailable on this engine",
                    ));
                }
                auth::terminal_spec(&self.base_spec, &method)?;
                (self.host.events)(AcpEvent::TerminalAuth {
                    name: method.name.clone(),
                    args: method.args.clone(),
                    env: method.env.clone(),
                });
                self.login_method = Some(method);
                Ok(())
            }
        }
    }

    pub(super) fn elicit(&mut self, message: Value) -> Result<(), AcpError> {
        if message.get("id").is_none() {
            return Err(bad("elicitation must be a request"));
        }
        let key = message["id"].to_string();
        if self.seen.len() >= MAX_SESSION_ITEMS
            || !self.seen.insert(key.clone())
            || self.elicitations.len() >= MAX_PENDING_REQUESTS
        {
            return Err(bad("elicitation request limit or duplicate id"));
        }
        let params = &message["params"];
        if params["mode"] != "url" {
            return self.reply(&message, Err("Unsupported elicitation mode".into()));
        }
        let url = params["url"]
            .as_str()
            .filter(|url| url.len() <= 8192)
            .ok_or_else(|| bad("invalid elicitation URL"))?
            .to_owned();
        auth::browser_url(&self.credentials, &url)?;
        let elicitation_id = params["elicitationId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .ok_or_else(|| bad("invalid elicitation id"))?
            .to_owned();
        if self
            .elicitations
            .values()
            .any(|e| e.elicitation_id == elicitation_id)
        {
            return Err(bad("duplicate elicitation id"));
        }
        let text = params["message"]
            .as_str()
            .filter(|text| text.len() <= MAX_TEXT_BYTES)
            .ok_or_else(|| bad("invalid elicitation message"))?
            .to_owned();
        self.connection.bind_elicitation(&elicitation_id)?;
        self.elicitation_urls
            .lock()
            .expect("elicitation lock")
            .insert(key.clone(), url.clone());
        self.elicitations.insert(
            key.clone(),
            UrlElicitation {
                request: message,
                elicitation_id,
                answered: false,
            },
        );
        (self.host.events)(AcpEvent::Elicitation {
            id: key,
            url,
            message: text,
        });
        Ok(())
    }
}
