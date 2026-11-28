//! Host-owned model gateway (LOT-014): a versioned registry, workspace privacy routing with no
//! silent fallback, a token budget reserved before every call, cancellation, and the local
//! Ollama runtime. Keys for BYOK providers stay in the OS keyring (`agent-gateway`).
mod gateway;
pub mod memory;
pub mod ollama;
pub mod registry;
pub mod window;

pub use gateway::{
    BackendOutput, BoxFuture, CancellationToken, ChatMessage, ChatRequest, ChatRole, Completion,
    CompletionRequest, GatewayError, ModelBackend, ModelGateway, PrivacyPolicy, TokenBudget,
};
pub use registry::{ModelEntry, ModelRegistry, RegistryError, OLLAMA_DEFAULT_ENDPOINT};
