use std::{
    collections::BTreeMap,
    fmt,
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::{
    model_operation::{ModelCancellation, ModelKind},
    project::GeneratedArtifactRole,
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationError {
    code: &'static str,
    message: String,
}

impl GenerationError {
    #[must_use]
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn code(&self) -> &'static str {
        self.code
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
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
        Self::new(
            "generation_project_failed",
            format!("{} ({})", error, error.code()),
        )
    }
}

impl From<std::io::Error> for GenerationError {
    fn from(error: std::io::Error) -> Self {
        Self::new("generation_project_failed", error.to_string())
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct GenerationCancellation(ModelCancellation);

impl GenerationCancellation {
    pub(crate) fn from_model(cancellation: &ModelCancellation) -> Self {
        Self(cancellation.clone())
    }

    #[cfg(test)]
    pub(crate) fn cancel(&self) {
        self.0.cancel();
    }

    pub(crate) fn check(&self) -> Result<(), GenerationError> {
        if self.0.is_cancelled() {
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

pub(crate) struct ResolvedGenerationModel {
    pub kind: ModelKind,
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
    pub model_output: serde_json::Value,
}

#[derive(Debug, Clone)]
pub(crate) struct ModelExecution {
    pub payloads: Vec<GeneratedPayload>,
    pub safe_request: serde_json::Value,
    pub safe_responses: Vec<serde_json::Value>,
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
pub(crate) enum PreparedHttpBody {
    Empty,
    Json(PreparedJsonBody),
    Multipart {
        fields: BTreeMap<String, String>,
        files: Vec<MultipartFile>,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedJsonBody {
    value: serde_json::Value,
    serialized: Vec<u8>,
}

impl PreparedJsonBody {
    pub(crate) fn serialized(&self) -> &[u8] {
        &self.serialized
    }

    pub(crate) fn into_serialized(self) -> Vec<u8> {
        self.serialized
    }
}

impl std::ops::Deref for PreparedJsonBody {
    type Target = serde_json::Value;

    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

impl TryFrom<HttpBody> for PreparedHttpBody {
    type Error = GenerationError;

    fn try_from(body: HttpBody) -> Result<Self, Self::Error> {
        Ok(match body {
            HttpBody::Empty => Self::Empty,
            HttpBody::Json(value) => {
                let serialized = serde_json::to_vec(&value).map_err(|error| {
                    GenerationError::new("model_request_invalid", error.to_string())
                })?;
                Self::Json(PreparedJsonBody { value, serialized })
            }
            HttpBody::Multipart { fields, files } => Self::Multipart { fields, files },
        })
    }
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
    pub body: PreparedHttpBody,
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
