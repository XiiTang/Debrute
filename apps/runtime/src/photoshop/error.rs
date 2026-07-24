use std::{error::Error, fmt, io};

use serde::{Deserialize, Serialize};

use crate::project::ProjectError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhotoshopBridgeErrorCode {
    AdobeBridgeDisabled,
    AdobeDiscoveryUnavailable,
    AdobeClientOffline,
    ProjectOffline,
    ProjectNotLinked,
    PairingNotFound,
    PairingExpired,
    PairingCodeInvalid,
    PairingAttemptsExceeded,
    PairingKeyInvalid,
    PairingSignatureInvalid,
    PairingRegistryInvalid,
    PairingCapacityReached,
    PluginSessionInvalid,
    PluginSessionReplaced,
    TargetDirectoryMissing,
    TargetDirectoryNotVisible,
    UnsupportedFileType,
    NoActiveDocument,
    PhotoshopPlaceFailed,
    UploadTooLarge,
    InvalidTransferPayload,
    TransferCapacityReached,
    TransferUrlExpired,
    TransferTimeout,
    StatePoisoned,
    PersistenceFailed,
}

impl PhotoshopBridgeErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AdobeBridgeDisabled => "adobe_bridge_disabled",
            Self::AdobeDiscoveryUnavailable => "adobe_discovery_unavailable",
            Self::AdobeClientOffline => "adobe_client_offline",
            Self::ProjectOffline => "project_offline",
            Self::ProjectNotLinked => "project_not_linked",
            Self::PairingNotFound => "pairing_not_found",
            Self::PairingExpired => "pairing_expired",
            Self::PairingCodeInvalid => "pairing_code_invalid",
            Self::PairingAttemptsExceeded => "pairing_attempts_exceeded",
            Self::PairingKeyInvalid => "pairing_key_invalid",
            Self::PairingSignatureInvalid => "pairing_signature_invalid",
            Self::PairingRegistryInvalid => "pairing_registry_invalid",
            Self::PairingCapacityReached => "pairing_capacity_reached",
            Self::PluginSessionInvalid => "plugin_session_invalid",
            Self::PluginSessionReplaced => "plugin_session_replaced",
            Self::TargetDirectoryMissing => "target_directory_missing",
            Self::TargetDirectoryNotVisible => "target_directory_not_visible",
            Self::UnsupportedFileType => "unsupported_file_type",
            Self::NoActiveDocument => "no_active_document",
            Self::PhotoshopPlaceFailed => "photoshop_place_failed",
            Self::UploadTooLarge => "upload_too_large",
            Self::InvalidTransferPayload => "invalid_transfer_payload",
            Self::TransferCapacityReached => "transfer_capacity_reached",
            Self::TransferUrlExpired => "transfer_url_expired",
            Self::TransferTimeout => "transfer_timeout",
            Self::StatePoisoned => "state_poisoned",
            Self::PersistenceFailed => "persistence_failed",
        }
    }
}

#[derive(Debug)]
pub struct PhotoshopBridgeError {
    code: PhotoshopBridgeErrorCode,
    message: String,
    fields: serde_json::Map<String, serde_json::Value>,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl PhotoshopBridgeError {
    #[must_use]
    pub fn new(code: PhotoshopBridgeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            fields: serde_json::Map::new(),
            source: None,
        }
    }

    #[must_use]
    pub fn with_field(
        mut self,
        key: impl Into<String>,
        value: impl Into<serde_json::Value>,
    ) -> Self {
        self.fields.insert(key.into(), value.into());
        self
    }

    #[must_use]
    pub fn code(&self) -> PhotoshopBridgeErrorCode {
        self.code
    }

    #[must_use]
    pub fn fields(&self) -> &serde_json::Map<String, serde_json::Value> {
        &self.fields
    }
}

impl fmt::Display for PhotoshopBridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for PhotoshopBridgeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source.as_deref().map(|source| source as _)
    }
}

impl From<ProjectError> for PhotoshopBridgeError {
    fn from(error: ProjectError) -> Self {
        let code = match error.code() {
            "project_not_open" | "project_not_found" => PhotoshopBridgeErrorCode::ProjectOffline,
            _ => PhotoshopBridgeErrorCode::PersistenceFailed,
        };
        Self {
            code,
            message: error.to_string(),
            fields: serde_json::Map::from_iter([(
                "projectCode".to_owned(),
                serde_json::Value::String(error.code().to_owned()),
            )]),
            source: Some(Box::new(error)),
        }
    }
}

impl From<io::Error> for PhotoshopBridgeError {
    fn from(error: io::Error) -> Self {
        Self {
            code: PhotoshopBridgeErrorCode::PersistenceFailed,
            message: error.to_string(),
            fields: serde_json::Map::new(),
            source: Some(Box::new(error)),
        }
    }
}

impl From<serde_json::Error> for PhotoshopBridgeError {
    fn from(error: serde_json::Error) -> Self {
        Self {
            code: PhotoshopBridgeErrorCode::PairingRegistryInvalid,
            message: error.to_string(),
            fields: serde_json::Map::new(),
            source: Some(Box::new(error)),
        }
    }
}
