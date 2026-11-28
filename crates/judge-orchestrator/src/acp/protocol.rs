use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, Read, Write};
use thiserror::Error;

/// One JSON-RPC line. Large enough for a file of [`MAX_FILE_BYTES`] even if every byte had to be
/// escaped (`\u00XX`, six bytes), so a permitted file always fits in a message.
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_PENDING_REQUESTS: usize = 32;
/// A prompt typed by the user.
pub const MAX_TEXT_BYTES: usize = 24 * 1024;
/// A file the agent reads or proposes, or a local MCP answer. The broker journals it whole, so
/// it must fit in a journaled summary: a larger file is refused, never silently cut.
pub const MAX_FILE_BYTES: usize = crate::broker::MAX_SUMMARY_BYTES;
/// The output kept of one terminal command: its end, as ACP specifies (`truncated` is then set).
pub const MAX_TERMINAL_OUTPUT_BYTES: usize = 16 * 1024;
pub const MAX_SESSION_ITEMS: usize = 512;
const _: () = assert!(MAX_FILE_BYTES * 6 + 4096 <= MAX_MESSAGE_BYTES);

/// Count raw bytes, including JSON whitespace, before buffering or deserializing them.
pub(crate) struct OutputBudget<R> {
    input: R,
    remaining: u64,
}
impl<R: Read> OutputBudget<R> {
    pub(crate) fn new(input: R, limit: u64) -> Self {
        Self {
            input,
            remaining: limit,
        }
    }
}
impl<R: Read> Read for OutputBudget<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut extra = [0];
            return if self.input.read(&mut extra)? == 0 {
                Ok(0)
            } else {
                Err(io::Error::other("session output limit"))
            };
        }
        let count = buffer
            .len()
            .min(usize::try_from(self.remaining).unwrap_or(usize::MAX));
        let read = self.input.read(&mut buffer[..count])?;
        self.remaining -= read as u64;
        Ok(read)
    }
}

#[derive(Debug, Error)]
pub enum AcpError {
    #[error("ACP protocol refused: {0}")]
    Protocol(String),
    #[error("ACP launch refused: {0}")]
    Launch(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedEdit {
    pub id: String,
    pub path: String,
    pub base_content_hash: String,
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AcpEvent {
    TerminalAuth {
        name: String,
        args: Vec<String>,
        env: std::collections::BTreeMap<String, String>,
    },
    TerminalAuthOutput {
        data: Vec<u8>,
    },
    TerminalAuthComplete {
        success: bool,
    },
    AuthMethods {
        methods: Vec<super::auth::AuthMethod>,
    },
    /// The agent needs the user to sign in and the Host waits for a choice among these methods.
    AuthChoice {
        methods: Vec<super::auth::AuthMethod>,
    },
    /// An account sign-in succeeded; the next session may start without asking again.
    Authenticated,
    Elicitation {
        id: String,
        url: String,
        message: String,
    },
    ElicitationComplete {
        id: String,
    },
    Ready {
        session_id: String,
    },
    /// What the agent lets the user choose for this session (model, mode, effort). Sent again
    /// whenever one changes, and also when a change was refused, so the panel shows the truth.
    Options {
        options: Vec<super::options::AgentOption>,
    },
    Update {
        update: Value,
    },
    ProposedEdit {
        edit: ProposedEdit,
    },
    Permission {
        id: String,
        reason: String,
        options: Value,
    },
    Tool {
        id: String,
        kind: String,
        status: String,
        locations: Value,
        reason: Option<String>,
    },
    Message {
        role: String,
        text: String,
    },
    Stopped {
        reason: String,
        /// `false` for an ordinary end (the agent exited, the lease ran out, the user stopped
        /// it): the chat stays as it is and reconnects on the next message. `true` for a failure
        /// the user should see.
        failed: bool,
    },
    Error {
        reason: String,
    },
}

/// Read at most limit + one delimiter; never allocate an unbounded line for hostile stdout.
pub(crate) fn read_message(input: &mut impl BufRead) -> Result<Option<Value>, AcpError> {
    let mut bytes = Vec::new();
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(bad("unterminated message"))
            };
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |n| n + 1);
        if bytes.len() + count > MAX_MESSAGE_BYTES {
            return Err(bad("message size limit"));
        }
        bytes.extend_from_slice(&available[..count]);
        input.consume(count);
        if bytes.last() == Some(&b'\n') {
            break;
        }
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    if !value.is_object() || value["jsonrpc"] != "2.0" {
        return Err(bad("invalid envelope"));
    }
    if let Some(id) = value.get("id") {
        if !(id.is_string() || id.as_u64().is_some()) {
            return Err(bad("invalid id"));
        }
    }
    if value.get("method").is_some() {
        if !value["method"].is_string()
            || value.get("result").is_some()
            || value.get("error").is_some()
        {
            return Err(bad("invalid request"));
        }
    } else if value.get("id").is_none()
        || value.get("result").is_some() == value.get("error").is_some()
    {
        return Err(bad("invalid response"));
    }
    Ok(Some(value))
}

pub(crate) fn send(output: &mut impl Write, value: &Value) -> Result<(), AcpError> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() + 1 > MAX_MESSAGE_BYTES {
        return Err(bad("outgoing message size limit"));
    }
    output.write_all(&bytes)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

pub(crate) fn bad(reason: &str) -> AcpError {
    AcpError::Protocol(reason.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_envelopes_and_oversized_lines_are_refused() {
        for input in [
            b"{broken}\n".as_slice(),
            b"[]\n",
            b"{\"jsonrpc\":\"1.0\",\"id\":1,\"result\":{}}\n",
            b"{\"jsonrpc\":\"2.0\",\"id\":null,\"result\":{}}\n",
        ] {
            assert!(read_message(&mut std::io::Cursor::new(input)).is_err());
        }
        let value = serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{"text":"x".repeat(MAX_MESSAGE_BYTES)}});
        let line = format!("{value}\n");
        assert!(read_message(&mut std::io::Cursor::new(line))
            .unwrap_err()
            .to_string()
            .contains("size"));
        let line = b"      {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n";
        let mut limited = std::io::BufReader::new(OutputBudget::new(line.as_slice(), 8));
        assert!(read_message(&mut limited)
            .unwrap_err()
            .to_string()
            .contains("output limit"));
    }
}
