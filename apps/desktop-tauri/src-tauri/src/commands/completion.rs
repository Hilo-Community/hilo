//! Inline AI completion through the model gateway (LOT-014): strict local mode by default, no
//! account, no key. The text around the cursor is read from the Host's rope, never from the
//! webview, and every keystroke the Host receives cancels the call in flight.
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use host_core::{utf16_to_char_idx, Utf16CodeUnitOffset};
use model_gateway::{
    memory::{self, Recommendation},
    ollama::{self, OllamaBackend},
    window::{context_bounds, MAX_OUTPUT_TOKENS},
    CancellationToken, ChatMessage, ChatRequest, ChatRole, CompletionRequest, GatewayError,
    ModelGateway, ModelRegistry, PrivacyPolicy, TokenBudget, OLLAMA_DEFAULT_ENDPOINT,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::state::DesktopAppState;

const MAX_LINES: usize = 8;
/// Tokens a session of the app may spend on completions; generous for a local model, it
/// bounds a runaway loop rather than normal typing.
const SESSION_TOKEN_BUDGET: u64 = 50_000_000;
const SETTINGS_FILE: &str = "inline-completion.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionSettings {
    pub enabled: bool,
    /// `None`: the largest local model that fits in memory.
    pub model_id: Option<String>,
}

impl Default for CompletionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            model_id: None,
        }
    }
}

pub(crate) struct CompletionState {
    gateway: Arc<ModelGateway>,
    chat_gateway: ModelGateway,
    budget: Arc<TokenBudget>,
    settings: Mutex<CompletionSettings>,
    settings_path: PathBuf,
    /// The call in flight and its request number (at most one: a new one cancels the last).
    inflight: Mutex<Option<(u64, CancellationToken)>>,
    next_request: AtomicU64,
    native_chats: Mutex<BTreeMap<String, CancellationToken>>,
}

impl CompletionState {
    pub(crate) fn new(app_data_dir: &std::path::Path) -> Self {
        let settings_path = app_data_dir.join(SETTINGS_FILE);
        let settings = std::fs::read(&settings_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            gateway: Arc::new(ModelGateway::new(ModelRegistry::builtin()).with_backend(
                host_core::ModelProviderKind::LocalOllama,
                Arc::new(OllamaBackend::new(Duration::from_secs(20))),
            )),
            chat_gateway: ModelGateway::new(ModelRegistry::local_chat()).with_backend(
                host_core::ModelProviderKind::LocalOllama,
                Arc::new(OllamaBackend::new(Duration::from_secs(90))),
            ),
            budget: Arc::new(TokenBudget::new(SESSION_TOKEN_BUDGET)),
            settings: Mutex::new(settings),
            settings_path,
            inflight: Mutex::new(None),
            next_request: AtomicU64::new(0),
            native_chats: Mutex::new(BTreeMap::new()),
        }
    }

    /// Called for every transaction the editor sends: the text the call was about is gone.
    pub(crate) fn cancel_inflight(&self) {
        if let Some((_, token)) = self.inflight.lock().ok().and_then(|mut slot| slot.take()) {
            token.cancel();
        }
    }

    fn settings(&self) -> CompletionSettings {
        self.settings
            .lock()
            .map(|settings| settings.clone())
            .unwrap_or_default()
    }

    /// The configured model, or the largest local one this machine can load now.
    fn model_id(&self, settings: &CompletionSettings) -> Option<String> {
        settings.model_id.clone().or_else(|| {
            match memory::recommend(self.gateway.registry(), memory::available_memory()) {
                Recommendation::Local { model_id } => Some(model_id),
                Recommendation::NotEnoughMemory { .. } => None,
            }
        })
    }
}

#[tauri::command]
pub async fn native_chat_command(
    app: tauri::AppHandle,
    request_id: String,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    if request_id.is_empty()
        || request_id.len() > 64
        || messages.len() > 64
        || messages
            .iter()
            .map(|message| message.content.len())
            .sum::<usize>()
            > 256 * 1024
        || !messages.last().is_some_and(|message| {
            message.role == ChatRole::User && !message.content.trim().is_empty()
        })
    {
        return Err("Invalid native chat request".into());
    }
    let state = app.state::<DesktopAppState>();
    let model = &state.completion;
    let Recommendation::Local { model_id } =
        memory::recommend(model.chat_gateway.registry(), memory::available_memory())
    else {
        return Err("Not enough memory for the local chat model".into());
    };
    let cancel = CancellationToken::new();
    {
        let mut calls = model
            .native_chats
            .lock()
            .map_err(|_| "native chat lock poisoned")?;
        if calls.len() >= 16 || calls.contains_key(&request_id) {
            return Err("Native chat request already running or queue is full".into());
        }
        calls.insert(request_id.clone(), cancel.clone());
    }
    let request = ChatRequest {
        messages,
        max_output_tokens: 2_048,
    };
    let reply = model
        .chat_gateway
        .chat(
            &model_id,
            &PrivacyPolicy::strict_local(),
            &model.budget,
            &request,
            &cancel,
        )
        .await;
    model
        .native_chats
        .lock()
        .map_err(|_| "native chat lock poisoned")?
        .remove(&request_id);
    reply
        .map(|completion| completion.text)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_native_chat_command(
    state: tauri::State<'_, DesktopAppState>,
    request_id: String,
) -> Result<(), String> {
    if let Some(token) = state
        .completion
        .native_chats
        .lock()
        .map_err(|_| "native chat lock poisoned")?
        .get(&request_id)
    {
        token.cancel();
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct InlineCompletionRequest {
    pub document_id: String,
    pub session_generation: u32,
    pub revision: u32,
    pub position_utf16: Utf16CodeUnitOffset,
}

#[derive(Debug, Serialize)]
pub struct InlineCompletionResponse {
    pub document_id: String,
    pub session_generation: u32,
    pub base_revision: u32,
    pub position_utf16: Utf16CodeUnitOffset,
    pub text: String,
    pub model_id: String,
    pub latency_ms: u32,
}

/// The editor may ask right after its last keystroke, whose transaction is still on its way.
const CATCH_UP_ATTEMPTS: u32 = 10;
const CATCH_UP_DELAY: Duration = Duration::from_millis(10);

enum Context {
    Ready(String, String),
    Behind,
    Gone,
}

/// The text around the cursor at exactly `revision`: `Behind` while the Host has not reached
/// it yet, `Gone` once it has moved past it.
fn context(state: &DesktopAppState, request: &InlineCompletionRequest) -> Result<Context, String> {
    let bridge = state
        .bridge
        .lock()
        .map_err(|_| "desktop document bridge lock poisoned".to_string())?;
    let session = bridge
        .document_service()
        .session(&request.document_id, request.session_generation)
        .map_err(|error| error.to_string())?;
    let revision = session.interactive_revision();
    if revision < request.revision {
        return Ok(Context::Behind);
    }
    if revision > request.revision {
        return Ok(Context::Gone);
    }
    let rope = session.rope();
    let cursor =
        utf16_to_char_idx(rope, request.position_utf16).map_err(|error| error.to_string())?;
    // Anchored window: the start does not move while typing, so Ollama reuses the prompt.
    let (start, end) = context_bounds(cursor, rope.len_chars());
    Ok(Context::Ready(
        rope.slice(start..cursor).to_string(),
        rope.slice(cursor..end).to_string(),
    ))
}

/// Keeps what reads as one suggestion: at most a few lines, no trailing blank space.
fn tidy(text: &str) -> String {
    let lines: Vec<&str> = text.split_inclusive('\n').take(MAX_LINES).collect();
    lines.concat().trim_end().to_owned()
}

#[tauri::command]
pub async fn inline_completion_command(
    app: tauri::AppHandle,
    request: InlineCompletionRequest,
) -> Result<Option<InlineCompletionResponse>, String> {
    let state = app.state::<DesktopAppState>();
    let completion = &state.completion;
    let settings = completion.settings();
    if !settings.enabled {
        return Ok(None);
    }
    let Some(model_id) = completion.model_id(&settings) else {
        return Ok(None);
    };
    let mut attempt = 0;
    let (prefix, suffix) = loop {
        match context(&state, &request)? {
            Context::Ready(prefix, suffix) => break (prefix, suffix),
            Context::Behind if attempt + 1 < CATCH_UP_ATTEMPTS => {
                attempt += 1;
                tokio::time::sleep(CATCH_UP_DELAY).await;
            }
            Context::Behind | Context::Gone => return Ok(None),
        }
    };
    let token = CancellationToken::new();
    let number = completion.next_request.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut slot) = completion.inflight.lock() {
        if let Some((_, previous)) = slot.replace((number, token.clone())) {
            previous.cancel();
        }
    }
    let asked = CompletionRequest {
        prefix,
        suffix,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        stop: vec!["\n\n\n".into()],
    };
    // Only local runtimes are registered for completion, and the policy says so too: code
    // typed in the editor never leaves the machine through this path.
    let result = completion
        .gateway
        .complete(
            &model_id,
            &PrivacyPolicy::strict_local(),
            &completion.budget,
            &asked,
            &token,
        )
        .await;
    if let Ok(mut slot) = completion.inflight.lock() {
        // Clear only our own entry: a newer request may already have replaced it.
        if slot.as_ref().is_some_and(|(current, _)| *current == number) {
            slot.take();
        }
    }
    match result {
        Ok(done) => {
            let text = tidy(&done.text);
            Ok((!text.is_empty()).then_some(InlineCompletionResponse {
                document_id: request.document_id,
                session_generation: request.session_generation,
                base_revision: request.revision,
                position_utf16: request.position_utf16,
                text,
                model_id: done.model_id,
                latency_ms: done.usage.latency_ms,
            }))
        }
        Err(GatewayError::Cancelled) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    id: String,
    name: String,
    installed: bool,
    fits_in_memory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineCompletionStatus {
    settings: CompletionSettings,
    /// The model completions use now, if any.
    active_model: Option<String>,
    ollama_running: bool,
    models: Vec<ModelOption>,
    available_memory_bytes: u64,
    /// The command that installs the active model, when it is missing.
    install_hint: Option<String>,
}

#[tauri::command]
pub async fn inline_completion_status_command(
    app: tauri::AppHandle,
) -> Result<InlineCompletionStatus, String> {
    let state = app.state::<DesktopAppState>();
    let completion = &state.completion;
    let settings = completion.settings();
    let available = tauri::async_runtime::spawn_blocking(memory::available_memory)
        .await
        .map_err(|error| error.to_string())?;
    let installed = ollama::installed_models(OLLAMA_DEFAULT_ENDPOINT).await;
    let registry = completion.gateway.registry();
    let active = completion.model_id(&settings);
    let entry = active.as_deref().and_then(|id| registry.get(id));
    let is_installed = |name: &str| {
        installed
            .as_ref()
            .is_some_and(|models| models.iter().any(|model| model == name))
    };
    Ok(InlineCompletionStatus {
        install_hint: entry
            .filter(|entry| !is_installed(&entry.model_name))
            .map(|entry| format!("ollama pull {}", entry.model_name)),
        models: registry
            .entries()
            .iter()
            .map(|entry| ModelOption {
                id: entry.id.clone(),
                name: entry.display_name.clone(),
                installed: is_installed(&entry.model_name),
                fits_in_memory: entry.min_free_memory_bytes <= available,
            })
            .collect(),
        ollama_running: installed.is_some(),
        active_model: active,
        available_memory_bytes: available,
        settings,
    })
}

#[tauri::command]
pub async fn set_inline_completion_settings_command(
    app: tauri::AppHandle,
    settings: CompletionSettings,
) -> Result<(), String> {
    let state = app.state::<DesktopAppState>();
    let completion = &state.completion;
    if let Some(id) = &settings.model_id {
        if completion.gateway.registry().get(id).is_none() {
            return Err(format!("Unknown model {id}"));
        }
    }
    if !settings.enabled {
        completion.cancel_inflight();
    }
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    std::fs::write(&completion.settings_path, bytes).map_err(|error| error.to_string())?;
    *completion
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())? = settings;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_suggestion_is_a_few_lines_without_trailing_space() {
        assert_eq!(tidy("a + b\n\n  "), "a + b");
        assert_eq!(tidy(&"x\n".repeat(20)).lines().count(), MAX_LINES);
        assert_eq!(tidy("   \n"), "");
    }

    #[test]
    fn a_keystroke_cancels_the_call_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let state = CompletionState::new(dir.path());
        let token = CancellationToken::new();
        *state.inflight.lock().unwrap() = Some((0, token.clone()));
        state.cancel_inflight();
        assert!(token.is_cancelled());
        assert!(state.inflight.lock().unwrap().is_none());
    }

    #[test]
    fn settings_default_to_strict_local_completion_with_an_automatic_model() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            CompletionState::new(dir.path()).settings(),
            CompletionSettings {
                enabled: true,
                model_id: None
            }
        );
    }
}
