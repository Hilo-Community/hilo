//! Local runtime: a user-installed Ollama on a loopback port.
//!
//! The client ignores `HTTP(S)_PROXY` and follows no redirect, so a request for a local model
//! cannot be routed off the machine by the environment or by the server answering.
use crate::{
    gateway::{BackendOutput, BoxFuture, ChatRequest, CompletionRequest, ModelBackend},
    registry::ModelEntry,
};
use serde_json::{json, Value};
use std::time::Duration;

/// Keep the model loaded between keystrokes: reloading it costs seconds.
const KEEP_ALIVE: &str = "30m";
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

pub struct OllamaBackend {
    client: reqwest::Client,
}

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_millis(500))
        .timeout(timeout)
        .build()
        .expect("HTTP client without TLS always builds")
}

impl OllamaBackend {
    pub fn new(timeout: Duration) -> Self {
        Self {
            client: client(timeout),
        }
    }
    async fn request(
        &self,
        entry: &ModelEntry,
        path: &str,
        body: Value,
        text_pointer: &str,
    ) -> Result<BackendOutput, String> {
        let response = self
            .client
            .post(format!("{}{path}", entry.endpoint.trim_end_matches('/')))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|_| "Ollama is not running".to_string())?;
        let value = read_json(response).await?;
        let count = |key: &str| {
            value[key]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0)
        };
        Ok(BackendOutput {
            text: value
                .pointer(text_pointer)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            input_tokens: count("prompt_eval_count"),
            output_tokens: count("eval_count"),
        })
    }
}

impl Default for OllamaBackend {
    fn default() -> Self {
        Self::new(Duration::from_secs(20))
    }
}

async fn read_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Ollama closed the connection".to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("Ollama answer is too large".into());
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Ollama answer is not JSON".to_string())?;
    if !status.is_success() {
        let message = value["error"].as_str().unwrap_or("request failed");
        return Err(format!("Ollama: {message}"));
    }
    Ok(value)
}

impl ModelBackend for OllamaBackend {
    fn complete<'a>(
        &'a self,
        entry: &'a ModelEntry,
        request: &'a CompletionRequest,
    ) -> BoxFuture<'a, Result<BackendOutput, String>> {
        Box::pin(async move {
            // With `suffix`, Ollama applies the model's fill-in-the-middle template.
            let body = json!({
                "model": entry.model_name,
                "prompt": request.prefix,
                "suffix": request.suffix,
                "stream": false,
                "keep_alive": KEEP_ALIVE,
                "options": {
                    "num_predict": request.max_output_tokens,
                    "temperature": 0.2,
                    "top_p": 0.9,
                    "stop": request.stop,
                },
            });
            self.request(entry, "/api/generate", body, "/response")
                .await
        })
    }

    fn chat<'a>(
        &'a self,
        entry: &'a ModelEntry,
        request: &'a ChatRequest,
    ) -> BoxFuture<'a, Result<BackendOutput, String>> {
        Box::pin(async move {
            let body = json!({
                "model": entry.model_name,
                "messages": request.messages,
                "stream": false,
                "keep_alive": KEEP_ALIVE,
                "options": { "num_predict": request.max_output_tokens },
            });
            self.request(entry, "/api/chat", body, "/message/content")
                .await
        })
    }
}

/// What a local Ollama offers right now: `None` when it is not running.
pub async fn installed_models(endpoint: &str) -> Option<Vec<String>> {
    let response = client(Duration::from_secs(2))
        .get(format!("{}/api/tags", endpoint.trim_end_matches('/')))
        .send()
        .await
        .ok()?;
    let value = read_json(response).await.ok()?;
    Some(
        value["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|model| model["name"].as_str().map(str::to_owned))
            .collect(),
    )
}
