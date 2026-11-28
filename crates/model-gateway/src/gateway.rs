//! The one door to a model: privacy policy, then budget, then exactly one backend call.
//!
//! There is no fallback by construction. A request names one model; the gateway resolves
//! that entry and nothing else. If its runtime is down, the answer is an error, and no other
//! entry of the registry (a cloud model, say) is ever tried.
use crate::registry::{ModelEntry, ModelRegistry};
use host_core::{AuthorizedDestination, ModelProviderKind, ModelUsageMetrics};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Instant,
};
use thiserror::Error;
pub use tokio_util::sync::CancellationToken;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Destinations a workspace allows its code to be sent to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivacyPolicy {
    allowed: Vec<AuthorizedDestination>,
}

impl PrivacyPolicy {
    /// Nothing leaves the machine. The default: it needs no account and no key.
    pub fn strict_local() -> Self {
        Self {
            allowed: vec![AuthorizedDestination::LocalOnly],
        }
    }
    pub fn allowing(allowed: Vec<AuthorizedDestination>) -> Self {
        Self { allowed }
    }
    pub fn allows(&self, destination: &AuthorizedDestination) -> bool {
        self.allowed.contains(destination)
    }
}

/// Text around the cursor, already cut to size by the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionRequest {
    pub prefix: String,
    pub suffix: String,
    pub max_output_tokens: u32,
    pub stop: Vec<String>,
}

impl CompletionRequest {
    /// Upper bound of the tokens the call can use, reserved before it starts. Roughly one
    /// token per 3 bytes of code is generous for the Qwen tokenizer.
    pub fn token_estimate(&self) -> u64 {
        self.input_estimate() + u64::from(self.max_output_tokens)
    }
    pub fn input_estimate(&self) -> u64 {
        ((self.prefix.len() + self.suffix.len()) as u64).div_ceil(3)
    }
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub max_output_tokens: u32,
}

enum ModelRequest<'a> {
    Completion(&'a CompletionRequest),
    Chat(&'a ChatRequest),
}

impl ModelRequest<'_> {
    fn budget(&self) -> (u64, u64) {
        match self {
            Self::Completion(request) => (request.input_estimate(), request.token_estimate()),
            Self::Chat(request) => {
                let input = request
                    .messages
                    .iter()
                    .map(|message| (message.content.len() as u64).div_ceil(3) + 8)
                    .sum::<u64>();
                (input, input + u64::from(request.max_output_tokens))
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendOutput {
    pub text: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    pub model_id: String,
    pub text: String,
    pub usage: ModelUsageMetrics,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum GatewayError {
    #[error("unknown model {0}")]
    UnknownModel(String),
    #[error("the workspace privacy policy does not allow sending code to {0:?}")]
    PrivacyDenied(AuthorizedDestination),
    #[error("model budget exhausted: {used} of {limit} tokens used")]
    BudgetExhausted { used: u64, limit: u64 },
    #[error("no runtime is configured for {0:?}")]
    NoBackend(ModelProviderKind),
    #[error("{model_id} is unavailable: {reason}")]
    ProviderUnavailable { model_id: String, reason: String },
    #[error("cancelled")]
    Cancelled,
}

/// A model runtime. Implementations talk to exactly the entry's endpoint.
pub trait ModelBackend: Send + Sync {
    fn complete<'a>(
        &'a self,
        entry: &'a ModelEntry,
        request: &'a CompletionRequest,
    ) -> BoxFuture<'a, Result<BackendOutput, String>>;
    fn chat<'a>(
        &'a self,
        _entry: &'a ModelEntry,
        _request: &'a ChatRequest,
    ) -> BoxFuture<'a, Result<BackendOutput, String>> {
        Box::pin(async { Err("This runtime does not support chat".into()) })
    }
}

/// Token budget shared by every call of a session, reserved before each call.
#[derive(Debug)]
pub struct TokenBudget {
    limit: u64,
    used: Mutex<u64>,
}

impl TokenBudget {
    pub fn new(limit: u64) -> Self {
        Self {
            limit,
            used: Mutex::new(0),
        }
    }
    pub fn used(&self) -> u64 {
        *self.used.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn reserve(&self, estimate: u64) -> Result<u64, GatewayError> {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        if used.saturating_add(estimate) > self.limit {
            return Err(GatewayError::BudgetExhausted {
                used: *used,
                limit: self.limit,
            });
        }
        *used += estimate;
        Ok(estimate)
    }
    /// Replaces a reservation by what the call really used (never more than reserved).
    fn settle(&self, reserved: u64, actual: u64) {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        *used = used.saturating_sub(reserved) + actual.min(reserved);
    }
}

pub struct ModelGateway {
    registry: ModelRegistry,
    backends: BTreeMap<String, Arc<dyn ModelBackend>>,
}

fn kind_key(kind: ModelProviderKind) -> String {
    format!("{kind:?}")
}

impl ModelGateway {
    pub fn new(registry: ModelRegistry) -> Self {
        Self {
            registry,
            backends: BTreeMap::new(),
        }
    }
    pub fn with_backend(mut self, kind: ModelProviderKind, backend: Arc<dyn ModelBackend>) -> Self {
        self.backends.insert(kind_key(kind), backend);
        self
    }
    pub fn registry(&self) -> &ModelRegistry {
        &self.registry
    }

    /// Runs one completion on `model_id` and on nothing else.
    pub async fn complete(
        &self,
        model_id: &str,
        policy: &PrivacyPolicy,
        budget: &TokenBudget,
        request: &CompletionRequest,
        cancel: &CancellationToken,
    ) -> Result<Completion, GatewayError> {
        self.run(
            model_id,
            policy,
            budget,
            ModelRequest::Completion(request),
            cancel,
        )
        .await
    }

    pub async fn chat(
        &self,
        model_id: &str,
        policy: &PrivacyPolicy,
        budget: &TokenBudget,
        request: &ChatRequest,
        cancel: &CancellationToken,
    ) -> Result<Completion, GatewayError> {
        self.run(
            model_id,
            policy,
            budget,
            ModelRequest::Chat(request),
            cancel,
        )
        .await
    }

    async fn run(
        &self,
        model_id: &str,
        policy: &PrivacyPolicy,
        budget: &TokenBudget,
        request: ModelRequest<'_>,
        cancel: &CancellationToken,
    ) -> Result<Completion, GatewayError> {
        let entry = self
            .registry
            .get(model_id)
            .ok_or_else(|| GatewayError::UnknownModel(model_id.into()))?;
        if !policy.allows(&entry.destination) {
            return Err(GatewayError::PrivacyDenied(entry.destination.clone()));
        }
        let backend = self
            .backends
            .get(&kind_key(entry.kind))
            .ok_or(GatewayError::NoBackend(entry.kind))?;
        if cancel.is_cancelled() {
            return Err(GatewayError::Cancelled);
        }
        let (input, estimate) = request.budget();
        let reserved = budget.reserve(estimate)?;
        let run = match request {
            ModelRequest::Completion(request) => backend.complete(entry, request),
            ModelRequest::Chat(request) => backend.chat(entry, request),
        };
        let started = Instant::now();
        let outcome = tokio::select! {
            biased;
            () = cancel.cancelled() => Err(GatewayError::Cancelled),
            result = run => result.map_err(|reason| {
                GatewayError::ProviderUnavailable { model_id: entry.id.clone(), reason }
            }),
        };
        match outcome {
            Ok(output) => {
                let actual = u64::from(output.input_tokens) + u64::from(output.output_tokens);
                budget.settle(reserved, actual);
                Ok(Completion {
                    model_id: entry.id.clone(),
                    text: output.text,
                    usage: ModelUsageMetrics {
                        input_tokens: output.input_tokens,
                        output_tokens: output.output_tokens,
                        cached_input_tokens: 0,
                        latency_ms: u32::try_from(started.elapsed().as_millis())
                            .unwrap_or(u32::MAX),
                        cost_usd_micros: 0,
                    },
                })
            }
            // A cancelled or failed call may already have read its prompt: that part stays
            // spent, so a flood of cancelled keystrokes still counts against the budget.
            Err(error) => {
                budget.settle(reserved, input);
                Err(error)
            }
        }
    }
}
