use std::{
    collections::BTreeMap,
    fmt,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::project::GeneratedArtifactRole;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GenerationKind {
    Image,
    Video,
    Tts,
    Music,
    SoundEffect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationRequest {
    pub model: String,
    pub arguments: serde_json::Map<String, serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationArtifact {
    pub artifact_id: String,
    pub title: String,
    pub project_relative_path: String,
    pub mime_type: String,
    pub role: GeneratedArtifactRole,
    pub artifact_index: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationSuccess {
    pub kind: GenerationKind,
    pub model: String,
    pub content: String,
    pub artifacts: Vec<GenerationArtifact>,
    pub logs: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    logs: Vec<serde_json::Value>,
}

impl GenerationError {
    #[must_use]
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
            logs: Vec::new(),
        }
    }

    #[must_use]
    pub(crate) fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    #[must_use]
    pub fn with_logs(mut self, logs: Vec<serde_json::Value>) -> Self {
        self.logs = logs;
        self
    }

    #[must_use]
    pub fn code(&self) -> &'static str {
        self.code
    }

    #[must_use]
    pub fn details(&self) -> Option<&serde_json::Value> {
        self.details.as_ref()
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    #[must_use]
    pub fn logs(&self) -> &[serde_json::Value] {
        &self.logs
    }
}

impl fmt::Display for GenerationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for GenerationError {}

impl From<crate::project::ProjectError> for GenerationError {
    fn from(error: crate::project::ProjectError) -> Self {
        Self::new("generation_project_failed", error.to_string())
            .with_details(serde_json::json!({"projectCode": error.code()}))
    }
}

#[derive(Debug, Clone, Default)]
pub struct GenerationCancellation(Arc<std::sync::atomic::AtomicBool>);

impl GenerationCancellation {
    pub fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }

    pub(crate) fn check(&self) -> Result<(), GenerationError> {
        if self.0.load(std::sync::atomic::Ordering::Acquire) {
            Err(GenerationError::new(
                "generation_cancelled",
                "Generation was cancelled.",
            ))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct GenerationDeadline(Instant);

impl GenerationDeadline {
    pub(crate) fn after(timeout: Duration) -> Result<Self, GenerationError> {
        if timeout.is_zero() {
            return Err(GenerationError::new(
                "generation_timeout_invalid",
                "Generation timeout must be a positive integer of milliseconds.",
            ));
        }
        Instant::now()
            .checked_add(timeout)
            .map(Self)
            .ok_or_else(|| {
                GenerationError::new(
                    "generation_timeout_invalid",
                    "Generation timeout is outside the supported monotonic clock range.",
                )
            })
    }

    pub(crate) fn instant(self) -> Instant {
        self.0
    }

    pub(crate) fn remaining(
        self,
        cancellation: &GenerationCancellation,
    ) -> Result<Duration, GenerationError> {
        cancellation.check()?;
        self.0
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| {
                GenerationError::new("generation_timeout", "Generation exceeded its timeout.")
            })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedGenerationModel {
    pub kind: GenerationKind,
    pub model_id: String,
    pub request_model_id: String,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Debug, Clone)]
pub(crate) struct GeneratedPayload {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub role: GeneratedArtifactRole,
    pub suggested_extension: &'static str,
    pub model_output: serde_json::Value,
}

#[derive(Debug, Clone)]
pub(crate) struct ModelExecution {
    pub payloads: Vec<GeneratedPayload>,
    pub safe_request: serde_json::Value,
    pub safe_responses: Vec<serde_json::Value>,
    pub logs: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HttpMethod {
    Get,
    Post,
}

#[derive(Debug, Clone)]
pub(crate) enum HttpBody {
    Empty,
    Json(serde_json::Value),
    Multipart {
        fields: BTreeMap<String, String>,
        files: Vec<MultipartFile>,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct MultipartFile {
    pub name: String,
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HttpTargetPolicy {
    ModelEndpoint,
    PublicMedia,
}

#[derive(Debug, Clone)]
pub(crate) struct ModelHttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: HttpBody,
    pub maximum_response_bytes: usize,
    pub target_policy: HttpTargetPolicy,
}

#[derive(Debug, Clone)]
pub(crate) struct ModelHttpResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

pub(crate) trait ModelHttpTransport: Send + Sync {
    fn execute(
        &self,
        request: ModelHttpRequest,
        cancellation: &GenerationCancellation,
        deadline: GenerationDeadline,
    ) -> Result<ModelHttpResponse, GenerationError>;
}
