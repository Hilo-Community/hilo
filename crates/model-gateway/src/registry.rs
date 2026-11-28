//! Versioned model registry: which models exist, where each one runs and where its input goes.
use host_core::{AuthorizedDestination, ModelCapabilities, ModelProviderKind};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use thiserror::Error;
use url::Url;

pub const REGISTRY_SCHEMA_VERSION: u16 = 1;
/// Ollama's default address. Only loopback is accepted for a local model.
pub const OLLAMA_DEFAULT_ENDPOINT: &str = "http://127.0.0.1:11434";
const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelEntry {
    /// Stable Hilo identifier, e.g. `ollama/qwen2.5-coder:1.5b-base`.
    pub id: String,
    pub display_name: String,
    pub kind: ModelProviderKind,
    /// The name the runtime knows the model by.
    pub model_name: String,
    /// Where the prompt goes. The privacy policy is checked against this, never the endpoint.
    pub destination: AuthorizedDestination,
    pub endpoint: String,
    /// Free memory needed to load the model without swapping.
    pub min_free_memory_bytes: u64,
    pub capabilities: ModelCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRegistry {
    pub schema_version: u16,
    entries: Vec<ModelEntry>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RegistryError {
    #[error("unsupported registry schema version {0}")]
    SchemaVersion(u16),
    #[error("duplicate model id {0}")]
    Duplicate(String),
    #[error("model {id}: {reason}")]
    Invalid { id: String, reason: String },
}

fn ollama(id_tag: &str, name: &str, memory: u64, context: u32) -> ModelEntry {
    ModelEntry {
        id: format!("ollama/{id_tag}"),
        display_name: name.into(),
        kind: ModelProviderKind::LocalOllama,
        model_name: id_tag.into(),
        destination: AuthorizedDestination::LocalOnly,
        endpoint: OLLAMA_DEFAULT_ENDPOINT.into(),
        min_free_memory_bytes: memory,
        capabilities: ModelCapabilities {
            supports_streaming: true,
            supports_structured_tool_calls: false,
            supports_prompt_caching: false,
            max_context_tokens: context,
            max_output_tokens: 256,
        },
    }
}

impl ModelRegistry {
    pub fn new(entries: Vec<ModelEntry>) -> Result<Self, RegistryError> {
        let registry = Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            entries,
        };
        registry.validate()?;
        Ok(registry)
    }

    /// The models Hilo knows out of the box: local Qwen2.5-Coder base models (they support
    /// fill-in-the-middle, which inline completion needs).
    pub fn builtin() -> Self {
        Self::new(vec![
            ollama(
                "qwen2.5-coder:1.5b-base",
                "Qwen2.5-Coder 1.5B (local)",
                2 * GIB,
                32_768,
            ),
            ollama(
                "qwen2.5-coder:7b-base",
                "Qwen2.5-Coder 7B (local)",
                6 * GIB,
                32_768,
            ),
        ])
        .expect("built-in registry is valid")
    }

    pub fn local_chat() -> Self {
        let mut entry = ollama(
            "qwen2.5-coder:1.5b",
            "Qwen2.5-Coder 1.5B (local chat)",
            2 * GIB,
            32_768,
        );
        entry.capabilities.max_output_tokens = 2_048;
        Self::new(vec![entry]).expect("built-in chat registry is valid")
    }

    pub fn entries(&self) -> &[ModelEntry] {
        &self.entries
    }

    pub fn get(&self, id: &str) -> Option<&ModelEntry> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    pub fn validate(&self) -> Result<(), RegistryError> {
        if self.schema_version != REGISTRY_SCHEMA_VERSION {
            return Err(RegistryError::SchemaVersion(self.schema_version));
        }
        for (index, entry) in self.entries.iter().enumerate() {
            if self.entries[..index]
                .iter()
                .any(|other| other.id == entry.id)
            {
                return Err(RegistryError::Duplicate(entry.id.clone()));
            }
            check_entry(entry).map_err(|reason| RegistryError::Invalid {
                id: entry.id.clone(),
                reason,
            })?;
        }
        Ok(())
    }
}

/// A model that claims to be local must really run on this machine: its endpoint is a
/// loopback IP literal (a host name could resolve anywhere), over plain HTTP, with no path
/// tricks. A local kind must also declare `LocalOnly`, so the policy sees the truth.
fn check_entry(entry: &ModelEntry) -> Result<(), String> {
    if entry.id.is_empty() || entry.model_name.is_empty() || entry.id.len() > 256 {
        return Err("empty or oversized id".into());
    }
    let local_kind = matches!(
        entry.kind,
        ModelProviderKind::LocalOllama | ModelProviderKind::LocalLlamaCpp
    );
    let local_destination = entry.destination == AuthorizedDestination::LocalOnly;
    if local_kind != local_destination {
        return Err("local runtimes, and only they, have the LocalOnly destination".into());
    }
    let url = Url::parse(&entry.endpoint).map_err(|_| "endpoint is not a URL".to_string())?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
        return Err("endpoint must not carry credentials or a query".into());
    }
    if local_destination {
        let loopback = match url.host() {
            Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
            Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
            _ => false,
        };
        if url.scheme() != "http" || !loopback {
            return Err("a local model endpoint must be http:// on a loopback IP".into());
        }
    } else if url.scheme() != "https" {
        return Err("a remote model endpoint must use https".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_models_are_local_only() {
        let registry = ModelRegistry::builtin();
        assert!(registry
            .entries()
            .iter()
            .all(|entry| entry.destination == AuthorizedDestination::LocalOnly));
        assert!(registry.get("ollama/qwen2.5-coder:1.5b-base").is_some());
    }

    #[test]
    fn a_local_model_cannot_point_off_the_machine() {
        for endpoint in [
            "http://192.168.1.10:11434",
            "http://localhost:11434",
            "https://127.0.0.1:11434",
            "http://user:pw@127.0.0.1:11434",
            "http://127.0.0.1:11434/?x=1",
        ] {
            let mut entry = ModelRegistry::builtin().entries()[0].clone();
            entry.endpoint = endpoint.into();
            assert!(ModelRegistry::new(vec![entry]).is_err(), "{endpoint}");
        }
        let mut entry = ModelRegistry::builtin().entries()[0].clone();
        entry.endpoint = "http://[::1]:11434".into();
        assert!(ModelRegistry::new(vec![entry]).is_ok());
    }

    #[test]
    fn destinations_cannot_lie_about_locality() {
        let mut entry = ModelRegistry::builtin().entries()[0].clone();
        entry.destination = AuthorizedDestination::ManagedCloudEu;
        assert!(ModelRegistry::new(vec![entry.clone()]).is_err());
        entry.kind = ModelProviderKind::ByokCloud;
        entry.destination = AuthorizedDestination::LocalOnly;
        assert!(ModelRegistry::new(vec![entry.clone()]).is_err());
        entry.destination = AuthorizedDestination::ByokProvider {
            provider_id: "x".into(),
        };
        entry.endpoint = "http://api.example.com".into();
        assert!(ModelRegistry::new(vec![entry.clone()]).is_err());
        entry.endpoint = "https://api.example.com".into();
        assert!(ModelRegistry::new(vec![entry]).is_ok());
    }

    #[test]
    fn duplicate_ids_are_refused() {
        let entry = ModelRegistry::builtin().entries()[0].clone();
        assert_eq!(
            ModelRegistry::new(vec![entry.clone(), entry.clone()]),
            Err(RegistryError::Duplicate(entry.id))
        );
    }
}
