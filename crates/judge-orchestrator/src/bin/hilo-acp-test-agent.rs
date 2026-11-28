//! Deterministic stdio fixture for LOT-014 integration tests; no provider or credential support.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn emit(value: Value) {
    let mut output = io::stdout().lock();
    writeln!(output, "{value}").unwrap();
    output.flush().unwrap();
}
fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if std::env::args().any(|arg| arg == "--fixture-login") {
        use std::io::IsTerminal;
        assert!(io::stdin().is_terminal());
        assert!(io::stdout().is_terminal());
        println!("Enter fixture code:");
        let mut code = String::new();
        io::stdin().read_line(&mut code).unwrap();
        assert_eq!(code.trim(), "fixture-code");
        let home = std::env::var_os("HOME").unwrap();
        std::fs::write(
            std::path::Path::new(&home).join("fixture-login"),
            "authenticated",
        )
        .unwrap();
        return;
    }
    if mode.starts_with("auth-") {
        authentication_fixture(&mode);
        return;
    }
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let mut cwd = String::new();
    let mut mcp_servers = json!(null);
    // `mcp` speaks HTTP MCP and should be offered the Host relay; `mcp-plain` does not.
    let capabilities = match mode.as_str() {
        "mcp" => json!({"mcpCapabilities":{"http":true}}),
        "resume" | "recovery-fallback" => {
            json!({"sessionCapabilities":{"resume":{}}, "loadSession":true})
        }
        "load" | "foreign-replay" => json!({"loadSession":true}),
        _ => json!({}),
    };
    for (id, result) in [
        (
            0,
            json!({"protocolVersion":1,"agentCapabilities":capabilities}),
        ),
        (
            1,
            if mode == "options" {
                json!({"sessionId":"fake",
                    "modes":{"currentModeId":"default","availableModes":[
                        {"id":"default","name":"Default"},{"id":"plan","name":"Plan"}]},
                    "models":{"currentModelId":"deep","availableModels":[
                        {"modelId":"deep","name":"Deep"},{"modelId":"fast","name":"Fast"}]}})
            } else {
                json!({"sessionId":"fake"})
            },
        ),
    ] {
        let Some(Ok(line)) = lines.next() else {
            return;
        };
        if id == 1 {
            let request: Value = serde_json::from_str(&line).unwrap_or_default();
            if mode == "recovery-fallback" {
                let mut request = request;
                let cwd = request["params"]["cwd"].clone();
                for method in ["session/resume", "session/load"] {
                    assert_eq!(request["method"], method);
                    assert_eq!(request["params"]["sessionId"], "saved");
                    assert_eq!(request["params"]["cwd"], cwd);
                    emit(json!({"jsonrpc":"2.0","id":request["id"],
                        "error":{"code":-32002,"message":"unknown session"}}));
                    request = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
                }
                assert_eq!(request["method"], "session/new");
                assert_eq!(request["params"]["cwd"], cwd);
                emit(
                    json!({"jsonrpc":"2.0","id":request["id"],"result":{"sessionId":"replacement"}}),
                );
                let request: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
                assert_eq!(request["method"], "session/prompt");
                assert_eq!(request["params"]["sessionId"], "replacement");
                let prompt = request["params"]["prompt"].as_array().unwrap();
                assert_eq!(prompt.len(), 2);
                assert!(prompt[0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("saved user turn"));
                assert_eq!(prompt[1]["text"], "follow-up");
                emit(
                    json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),
                );
                return;
            }
            if mode == "foreign-replay" {
                assert_eq!(request["method"], "session/load");
                emit(json!({"jsonrpc":"2.0","method":"session/update","params":{
                    "sessionId":"another-chat","update":{"sessionUpdate":"agent_message_chunk",
                    "content":{"type":"text","text":"another chat's contents"}}
                }}));
                return;
            }
            if mode == "resume" || mode == "load" {
                assert_eq!(request["method"], format!("session/{mode}"));
                assert_eq!(request["params"]["sessionId"], "saved");
                if mode == "load" {
                    emit(json!({"jsonrpc":"2.0","method":"session/update","params":{
                        "sessionId":"saved","update":{"sessionUpdate":"user_message_chunk",
                        "content":{"type":"text","text":"already saved"}}
                    }}));
                }
                emit(json!({"jsonrpc":"2.0","id":id,"result":{}}));
                let request: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
                assert_eq!(request["method"], "session/prompt");
                assert_eq!(request["params"]["sessionId"], "saved");
                emit(
                    json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),
                );
                return;
            }
            cwd = request["params"]["cwd"].as_str().unwrap_or_default().into();
            mcp_servers = request["params"]["mcpServers"].clone();
        }
        emit(json!({"jsonrpc":"2.0","id":id,"result":result}));
    }
    // Every mode waits for the prompt, except the one that only answers option changes.
    if mode != "options" && lines.next().is_none() {
        return;
    }
    let request = |id, method, mut params: Value| {
        params["sessionId"] = json!("fake");
        emit(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
    };
    match mode.as_str() {
        "write" => request(
            10,
            "fs/write_text_file",
            json!({"path":"src/file.rs","content":"new 🦀\n"}),
        ),
        "read" => request(10, "fs/read_text_file", json!({"path":"src/file.rs"})),
        // What real agents send: absolute paths under the cwd of `session/new`.
        "absolute" => {
            request(
                10,
                "fs/read_text_file",
                json!({"path":format!("{cwd}/src/file.rs")}),
            );
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{"sessionUpdate":"tool_call","toolCallId":"t","title":"read","locations":[{"path":format!("{cwd}/src/file.rs"),"line":3}]}}}),
            );
        }
        "terminal-verbose" => request(
            10,
            "terminal/create",
            json!({"command":"/bin/sh","args":["-c","i=0; while [ $i -lt 4000 ]; do printf '\\033[31mline %s\\n' $i; i=$((i+1)); done"],"cwd":"."}),
        ),
        "paths" => {
            for (i, path) in [
                "../escape",
                "/etc/passwd",
                "C:/Windows/file",
                "src/../escape",
                "src/SECRETS/key",
                "src/sEcReTs/key",
                "src\\file.rs",
            ]
            .iter()
            .enumerate()
            {
                request(10 + i, "fs/read_text_file", json!({"path":path}));
            }
        }
        "unknown" => request(10, "execute_arbitrary_code", json!({})),
        "mcp" | "mcp-plain" => emit(
            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("mcp={mcp_servers}")}}}}),
        ),
        "oversized" => emit(
            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x".repeat(1_100_000)}}}}),
        ),
        "malformed" => {
            println!("{{broken}}");
            return;
        }
        "permission-choice" => request(
            10,
            "session/request_permission",
            json!({
                "toolCall":{"toolCallId":"tool"},
                "options":[
                    {"optionId":"once","name":"Once","kind":"allow_once"},
                    {"optionId":"remember","name":"Remember","kind":"allow_always"}
                ]
            }),
        ),
        "flood" => {
            for i in 0..34 {
                request(
                    10 + i,
                    "session/request_permission",
                    json!({"toolCall":{"toolCallId":"tool"},"options":[]}),
                );
            }
        }
        "terminal-complete" => request(
            10,
            "terminal/create",
            json!({"command":"/bin/sh","args":["-c","printf terminal-output"],"cwd":"."}),
        ),
        "terminal" => request(
            10,
            "terminal/create",
            json!({"command":"/bin/sh","args":["-c","sleep 60"],"cwd":"."}),
        ),
        "direct-read" => {
            let read = std::fs::read_to_string("src/file.rs").is_ok();
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("direct-read={read}")}}}}),
            );
        }
        "direct-secret" => {
            let leaked = std::fs::read_to_string("src/SECRETS/key")
                .is_ok_and(|text| text.contains("synthetic-secret"));
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("direct-secret={leaked}")}}}}),
            );
        }
        "edit-update" => {
            // An edit reported with absolute paths, as agents do; the cwd is the task snapshot.
            let path = std::env::current_dir().unwrap().join("src/a.rs");
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{"sessionUpdate":"tool_call","toolCallId":"edit-1","kind":"edit","title":"Edit","status":"completed","locations":[{"path":path}],"content":[{"type":"diff","path":path,"oldText":null,"newText":"fn a() {}"}]}}}),
            );
        }
        "direct-write" => {
            let wrote = std::fs::write("src/file.rs", "bypass").is_ok();
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("direct-write={wrote}")}}}}),
            );
        }
        "installation" => {
            let executable = std::env::current_exe().unwrap();
            let module = executable.parent().unwrap().join("module.txt");
            let read = std::fs::read_to_string(&module).unwrap_or_default();
            let wrote = std::fs::write(&module, "bypass").is_ok();
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("module={read}; write={wrote}")}}}}),
            );
        }
        "environment" => {
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":std::env::vars().map(|(k, _)|k).collect::<Vec<_>>().join(",")}}}}),
            );
        }
        _ => {}
    }
    for line in lines {
        let Ok(line) = line else {
            break;
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            break;
        };
        if value["method"] == "session/cancel" {
            break;
        }
        if mode == "permission-choice" && value["id"] == 10 {
            assert_eq!(
                value["result"]["outcome"],
                json!({"outcome":"selected","optionId":"remember"})
            );
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{
                    "sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"choice confirmed"}
                }}}),
            );
            return;
        }
        if mode == "options" {
            match value["method"].as_str() {
                // The fake agent refuses to leave `default` for `plan` once, to test a refusal.
                Some("session/set_mode") if value["params"]["modeId"] == "refused" => emit(
                    json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32602,"message":"no"}}),
                ),
                Some("session/set_mode" | "session/set_model") => {
                    emit(json!({"jsonrpc":"2.0","id":value["id"],"result":{}}));
                    emit(
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":value.to_string()}}}}),
                    );
                }
                _ => {}
            }
            continue;
        }
        emit(
            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fake","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":value.to_string()}}}}),
        );
        if mode == "terminal-verbose" && value["id"] == 10 {
            request(
                11,
                "terminal/output",
                json!({"terminalId":value["result"]["terminalId"]}),
            );
        }
        if mode == "terminal-complete" {
            let id = value["id"].as_u64().unwrap_or(0);
            let terminal = "10";
            match id {
                10 => request(
                    11,
                    "terminal/output",
                    json!({"terminalId":value["result"]["terminalId"]}),
                ),
                11 => request(12, "terminal/wait_for_exit", json!({"terminalId":terminal})),
                12 => request(13, "terminal/kill", json!({"terminalId":terminal})),
                13 => request(14, "terminal/release", json!({"terminalId":terminal})),
                14 => request(15, "terminal/output", json!({"terminalId":terminal})),
                _ => {}
            }
        }
    }
}

fn authentication_fixture(mode: &str) {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let mut next = || -> Value { serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap() };
    let initialize = next();
    assert_eq!(initialize["method"], "initialize");
    assert_eq!(
        initialize["params"]["clientCapabilities"]["auth"]["_meta"]["gateway"],
        true
    );
    assert!(initialize["params"]["clientCapabilities"]["elicitation"]["url"].is_object());
    if mode == "auth-terminal" {
        assert_eq!(
            initialize["params"]["clientCapabilities"]["auth"]["terminal"],
            true
        );
        emit(
            json!({"jsonrpc":"2.0","id":initialize["id"],"result":{"protocolVersion":1,"authMethods":[{"id":"fixture-terminal","name":"Fixture account","type":"terminal","args":["--fixture-login"]}]}}),
        );
        let home = std::env::var_os("HOME").unwrap();
        if !std::path::Path::new(&home).join("fixture-login").exists() {
            // The original transport must be killed and replaced after terminal success.
            let _ = next();
            panic!("the first ACP connection was reused instead of reconnected");
        }
        let session = next();
        assert_eq!(session["method"], "session/new");
        emit(json!({"jsonrpc":"2.0","id":session["id"],"result":{"sessionId":"reconnected"}}));
        for line in lines {
            let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
            if request["method"] == "session/cancel" {
                break;
            }
        }
        return;
    }
    emit(
        json!({"jsonrpc":"2.0","id":initialize["id"],"result":{"protocolVersion":1,"authMethods":[
            {"id":"fixture-gateway","name":"Gateway","_meta":{"gateway":{"protocol":"fixture"}}},
            {"id":"fixture-login","name":"Account"}
        ]}}),
    );
    let authenticate = next();
    assert_eq!(authenticate["method"], "authenticate");
    if mode == "auth-gateway" {
        assert_eq!(authenticate["params"]["methodId"], "fixture-gateway");
        assert_eq!(
            authenticate["params"]["_meta"]["gateway"]["headers"]["x-hilo-session"],
            "session-token-only"
        );
        assert!(std::env::var_os("PROVIDER_REAL_KEY").is_none());
    } else {
        assert_eq!(authenticate["params"]["methodId"], "fixture-login");
        emit(
            json!({"jsonrpc":"2.0","method":"elicitation/complete","params":{"elicitationId":"unknown-completion"}}),
        );
        let request_id = if mode == "auth-wrong-scope" {
            json!(999)
        } else {
            authenticate["id"].clone()
        };
        let url = if mode == "auth-unsafe-url" {
            "https://evil.example.com/verify"
        } else {
            "https://auth.example.com/verify"
        };
        emit(
            json!({"jsonrpc":"2.0","id":"url-request","method":"elicitation/create","params":{"requestId":request_id,"mode":"url","elicitationId":"login-1","url":url,"message":"Sign in and enter code 1234"}}),
        );
        let answer = next();
        assert_eq!(answer["id"], "url-request");
        if answer["result"]["action"] != "accept" {
            emit(
                json!({"jsonrpc":"2.0","id":authenticate["id"],"error":{"code":-32000,"message":"Login declined"}}),
            );
            // Stay alive until the Host consumes the final message and stops us.
            let _ = next();
            return;
        }
        emit(
            json!({"jsonrpc":"2.0","method":"elicitation/complete","params":{"elicitationId":"login-1"}}),
        );
    }
    emit(json!({"jsonrpc":"2.0","id":authenticate["id"],"result":{}}));
    let session = next();
    assert_eq!(session["method"], "session/new");
    emit(json!({"jsonrpc":"2.0","id":session["id"],"result":{"sessionId":"authenticated"}}));
    while let Some(Ok(line)) = lines.next() {
        let request: Value = serde_json::from_str(&line).unwrap();
        if request["method"] == "session/cancel" {
            break;
        }
        if request["method"] == "session/prompt" {
            emit(
                json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"authenticated","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"authenticated fixture turn"}}}}),
            );
            emit(json!({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}));
        }
    }
}
