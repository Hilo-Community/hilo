//! Bounded ACP v1 stdio client. Only trusted Host code constructs configuration and approvals.
mod auth;
mod executor;
mod mcp_relay;
mod options;
mod protocol;
mod session;

pub use auth::{AgentCredentials, AuthMethod};
pub use executor::{AgentToolExecutor, WorkspaceText};
pub use mcp_relay::{McpHandler, McpRelay};
pub use options::{AgentChoice, AgentOption};
pub use protocol::{
    AcpError, AcpEvent, ProposedEdit, MAX_FILE_BYTES, MAX_MESSAGE_BYTES, MAX_PENDING_REQUESTS,
    MAX_TERMINAL_OUTPUT_BYTES,
};
pub use session::{AcpHost, AcpLaunch, AcpOptionPreference, AcpSessionSupervisor, AgentNetwork};
