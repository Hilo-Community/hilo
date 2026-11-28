//! What the agent asks the Host to do: translating its tool calls, running them through the
//! broker, and the user's answers to permission requests.
use super::*;
pub(super) use path_util::plain_path;

impl Session {
    pub(super) fn translate(&self, message: &Value, key: &str) -> Result<ToolCall, String> {
        let params = &message["params"];
        let text = |key: &str| {
            params[key]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("Missing {key}"))
        };
        let arg = |key: &str| text(key).map(ToolArgValue::Text);
        let path = |key: &str| text(key).map(|p| ToolArgValue::Text(self.relative(&p)));
        let (name, cap, args, approval) = match message["method"].as_str().unwrap_or("") {
            "fs/read_text_file" => (
                "read_workspace",
                ToolCapability::ReadWorkspace,
                BTreeMap::from([("path".into(), path("path")?)]),
                false,
            ),
            "fs/write_text_file" => (
                "write_worktree",
                ToolCapability::WriteWorktree,
                BTreeMap::from([
                    ("path".into(), path("path")?),
                    ("content".into(), arg("content")?),
                ]),
                true,
            ),
            "terminal/create" => {
                if params
                    .get("env")
                    .and_then(Value::as_array)
                    .is_some_and(|v| !v.is_empty())
                {
                    return Err("Agent environment variables are not accepted".into());
                }
                let args: Vec<String> =
                    serde_json::from_value(params.get("args").cloned().unwrap_or(json!([])))
                        .map_err(|_| "Invalid args")?;
                (
                    "run_sandbox_command",
                    ToolCapability::RunSandboxCommand,
                    BTreeMap::from([
                        ("program".into(), arg("command")?),
                        (
                            "cwd".into(),
                            ToolArgValue::Text(
                                self.relative(params["cwd"].as_str().unwrap_or(".")),
                            ),
                        ),
                        ("args".into(), ToolArgValue::StringList(args)),
                    ]),
                    true,
                )
            }
            "_hilo/query_local_mcp" => (
                "query_local_mcp",
                ToolCapability::QueryLocalMcp,
                BTreeMap::from([("request".into(), arg("request")?)]),
                false,
            ),
            _ => return Err("Unknown ACP method".into()),
        };
        Ok(tool_call(&self.host, key, name, cap, args, approval))
    }

    /// ACP paths are absolute. One inside the worktree becomes the relative path the policy
    /// checks; any other path is passed on unchanged, for the policy to refuse.
    pub(super) fn relative(&self, path: &str) -> String {
        let candidate = plain_path(std::path::Path::new(path));
        let root = plain_path(&self.host.worktree_root);
        match candidate.strip_prefix(&root) {
            Ok(rest) if rest.as_os_str().is_empty() => ".".into(),
            Ok(rest) => rest.to_string_lossy().replace('\\', "/"),
            Err(_) => {
                if cfg!(windows) {
                    let mut cand_comps = candidate.components();
                    let mut matched = true;
                    for root_comp in root.components() {
                        let Some(cand_comp) = cand_comps.next() else {
                            matched = false;
                            break;
                        };
                        if !cand_comp
                            .as_os_str()
                            .to_string_lossy()
                            .eq_ignore_ascii_case(&root_comp.as_os_str().to_string_lossy())
                        {
                            matched = false;
                            break;
                        }
                    }
                    if matched {
                        let rest = cand_comps.as_path();
                        if rest.as_os_str().is_empty() {
                            return ".".into();
                        }
                        return rest.to_string_lossy().replace('\\', "/");
                    }
                }
                path.into()
            }
        }
    }

    pub(super) fn execute(
        &mut self,
        request: Value,
        call: ToolCall,
        approvals: &[crate::policy::SignedApproval],
    ) -> Result<(), AcpError> {
        let id = request["id"].to_string();
        let locations = call
            .validated_args
            .get("path")
            .and_then(|v| {
                if let ToolArgValue::Text(p) = v {
                    Some(json!([{"path":p,"line":1}]))
                } else {
                    None
                }
            })
            .unwrap_or(json!([]));
        (self.host.events)(AcpEvent::Tool {
            id: id.clone(),
            kind: call.tool_name.clone(),
            status: "running".into(),
            locations: locations.clone(),
            reason: None,
        });
        match self.broker.execute(
            &self.host.lease,
            &self.host.signed,
            &call,
            approvals,
            (self.host.clock)(),
        ) {
            Err(BrokerError::Policy(Decision::RequiresApproval(_, reason))) => {
                let reason = format!(
                    "{reason}\nTool: {}\nArguments: {:?}",
                    call.tool_name, call.validated_args
                );
                self.permissions
                    .lock()
                    .expect("permissions lock")
                    .insert(id.clone(), reason.clone());
                let options = json!([{"optionId":"allow","name":"Allow once","kind":"allow_once","hostConfirmation":true},{"optionId":"reject","name":"Reject","kind":"reject_once","hostConfirmation":true}]);
                (self.host.events)(AcpEvent::Permission {
                    id: id.clone(),
                    reason,
                    options: options.clone(),
                });
                (self.host.events)(AcpEvent::Tool {
                    id: id.clone(),
                    kind: call.tool_name.clone(),
                    status: "pending".into(),
                    locations,
                    reason: None,
                });
                self.pending.insert(
                    id,
                    Pending {
                        request,
                        call: Some(call),
                        options,
                    },
                );
                Ok(())
            }
            Err(error) => {
                let reason = error.to_string();
                (self.host.events)(AcpEvent::Tool {
                    id,
                    kind: call.tool_name,
                    status: "denied".into(),
                    locations,
                    reason: Some(reason.clone()),
                });
                self.reply(&request, Err(reason))
            }
            Ok(outcome) => {
                let result = if !outcome.succeeded {
                    Err(outcome.summary)
                } else {
                    match call.tool_name.as_str() {
                        "read_workspace" => {
                            let line = request["params"]["line"]
                                .as_u64()
                                .unwrap_or(1)
                                .saturating_sub(1) as usize;
                            let limit = request["params"]["limit"]
                                .as_u64()
                                .unwrap_or(u64::MAX)
                                .min(MAX_TEXT_BYTES as u64)
                                as usize;
                            let content = if line == 0 && request["params"].get("limit").is_none() {
                                outcome.summary
                            } else {
                                outcome
                                    .summary
                                    .split_inclusive('\n')
                                    .skip(line)
                                    .take(limit)
                                    .collect::<String>()
                            };
                            Ok(json!({"content":content}))
                        }
                        "run_sandbox_command" => {
                            let output = serde_json::from_str(&outcome.summary)?;
                            self.terminals
                                .insert(id.clone(), (output, call.clone(), approvals.to_vec()));
                            Ok(json!({"terminalId":id}))
                        }
                        "query_local_mcp" => Ok(json!({"content":outcome.summary})),
                        _ => Ok(json!({})),
                    }
                };
                (self.host.events)(AcpEvent::Tool {
                    id,
                    kind: call.tool_name,
                    status: if result.is_ok() { "done" } else { "failed" }.into(),
                    locations,
                    reason: result.as_ref().err().cloned(),
                });
                self.reply(&request, result)
            }
        }
    }

    pub(super) fn permission(&mut self, id: &str, allow: bool) -> Result<(), AcpError> {
        self.permissions
            .lock()
            .expect("permissions lock")
            .remove(id);
        let Some(item) = self.pending.remove(id) else {
            return Ok(());
        };
        if let Some(call) = item.call {
            if !allow {
                (self.host.events)(AcpEvent::Tool {
                    id: id.into(),
                    kind: call.tool_name,
                    status: "denied".into(),
                    locations: json!([]),
                    reason: Some("Rejected by Host user".into()),
                });
                return self.reply(&item.request, Err("Rejected by Host user".into()));
            }
            let (call_hash, plan_hash) =
                approval_inputs(&self.host.signed, &call).map_err(|e| bad(&e.to_string()))?;
            let kind = ApprovalActionKind::ExecuteToolCall;
            let approval = Approval {
                schema_version: CONTRACT_SCHEMA_VERSION,
                approval_id: format!("acp:{id}"),
                actor_identity: "Host user".into(),
                target_env: self.host.signed.spec.target_env.clone(),
                action_kind: kind,
                approved_digest: Approval::compute_action_digest(
                    &call_hash,
                    &plan_hash,
                    &self.host.signed.spec.target_env,
                    &kind,
                ),
                expires_at: (self.host.clock)()
                    .saturating_add(60_000)
                    .min(self.host.lease.expires_at()),
            };
            let signed = self
                .host
                .authority
                .sign_approval(approval)
                .map_err(|e| bad(&e.to_string()))?;
            self.execute(item.request, call, &[signed])
        } else {
            let kind = if allow { "allow_once" } else { "reject_once" };
            let option = item
                .options
                .as_array()
                .and_then(|v| v.iter().find(|o| o["kind"] == kind))
                .and_then(|o| o["optionId"].as_str());
            let outcome = option.map_or(
                json!({"outcome":"cancelled"}),
                |id| json!({"outcome":"selected","optionId":id}),
            );
            self.reply(&item.request, Ok(json!({"outcome":outcome})))
        }
    }

    pub(super) fn permission_option(&mut self, id: &str, option: &str) -> Result<(), AcpError> {
        let Some(item) = self.pending.get(id) else {
            return Ok(());
        };
        // Agent choices can never satisfy the Host's signed tool-approval flow.
        if item.call.is_some()
            || !item.options.as_array().is_some_and(|options| {
                options
                    .iter()
                    .any(|entry| entry["optionId"].as_str() == Some(option))
            })
        {
            return Ok(());
        }
        let Some(item) = self.pending.remove(id) else {
            return Ok(());
        };
        self.permissions
            .lock()
            .expect("permissions lock")
            .remove(id);
        self.reply(
            &item.request,
            Ok(json!({"outcome":{"outcome":"selected","optionId":option}})),
        )
    }

    /// The agent asks the user's permission: the panel shows it, the answer comes back through
    /// `permission`.
    pub(super) fn permission_request(
        &mut self,
        key: String,
        message: Value,
    ) -> Result<(), AcpError> {
        let options = message["params"]["options"].clone();
        if !options.is_array() || options.as_array().is_some_and(|v| v.len() > 16) {
            return Err(bad("invalid permission options"));
        }
        self.permissions
            .lock()
            .expect("permissions lock")
            .insert(key.clone(), message["params"].to_string());
        (self.host.events)(AcpEvent::Permission {
            id: key.clone(),
            reason: format!(
                "Agent requests permission: {}",
                message["params"]["toolCall"]
            ),
            options: options.clone(),
        });
        self.pending.insert(
            key,
            Pending {
                request: message,
                call: None,
                options,
            },
        );
        Ok(())
    }

    /// The agent asks about a terminal it created: each answer goes through the broker again.
    pub(super) fn terminal_request(
        &mut self,
        method: &str,
        message: Value,
    ) -> Result<(), AcpError> {
        let id = message["params"]["terminalId"].as_str().unwrap_or("");
        let result = match self.terminals.get(id).cloned() {
            Some((output, call, approvals)) => {
                if let Err(error) = self.broker.execute(
                    &self.host.lease,
                    &self.host.signed,
                    &call,
                    &approvals,
                    (self.host.clock)(),
                ) {
                    return self.reply(&message, Err(error.to_string()));
                }
                match method {
                    "terminal/output" => Ok(output),
                    "terminal/wait_for_exit" => Ok(output["exitStatus"].clone()),
                    "terminal/kill" => Ok(json!({})), // run-to-completion: already exited
                    "terminal/release" => {
                        self.terminals.remove(id);
                        Ok(json!({}))
                    }
                    _ => Err("Unknown ACP method".into()),
                }
            }
            None => Err("Unknown terminal".into()),
        };
        self.reply(&message, result)
    }
}
