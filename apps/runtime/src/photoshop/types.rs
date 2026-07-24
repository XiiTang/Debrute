use serde::{Deserialize, Serialize};

use super::PhotoshopBridgeErrorCode;

pub const PHOTOSHOP_BRIDGE_PROTOCOL_VERSION: u32 = 1;
pub const PHOTOSHOP_DISCOVERY_PORT: u16 = 32_124;
pub const PHOTOSHOP_UXP_ORIGIN: &str = "uxp://com.debrute.photoshop.bridge";
pub const PHOTOSHOP_CEP_FILE_ORIGIN: &str = "file://";
pub const PHOTOSHOP_BRIDGE_MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const PHOTOSHOP_BRIDGE_MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PhotoshopClientRuntime {
    Uxp,
    Cep,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopBridgeSettingsView {
    pub enabled: bool,
    pub discovery_status: PhotoshopDiscoveryStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PhotoshopDiscoveryStatus {
    Available,
    Disabled,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopPairingCreated {
    pub pairing_id: String,
    pub code: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedPhotoshopPluginView {
    pub plugin_instance_id: String,
    pub client_runtime: PhotoshopClientRuntime,
    pub created_at: String,
    pub connected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopClientView {
    pub plugin_instance_id: String,
    pub host_app: &'static str,
    pub host_version: String,
    pub client_runtime: PhotoshopClientRuntime,
    pub display_name: String,
    pub document_count: u32,
    pub active_document_title: Option<String>,
    pub connected_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopProjectDirectoryView {
    pub project_relative_path: String,
    pub name: String,
    pub depth: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopProjectView {
    pub project_id: String,
    pub project_name: String,
    pub project_revision: u64,
    pub directories: Vec<PhotoshopProjectDirectoryView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopProjectLinkView {
    pub link_id: String,
    pub project_id: String,
    pub plugin_instance_id: String,
    pub created_at: String,
    pub status: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PhotoshopTransferDirection {
    PhotoshopToDebrute,
    DebruteToPhotoshop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PhotoshopTransferStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
}

impl PhotoshopTransferStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopTransferView {
    pub transfer_id: String,
    pub direction: PhotoshopTransferDirection,
    pub project_id: String,
    pub plugin_instance_id: String,
    pub project_relative_path: Option<String>,
    pub status: PhotoshopTransferStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<PhotoshopBridgeErrorCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopBridgeStateView {
    pub settings: PhotoshopBridgeSettingsView,
    pub paired_plugins: Vec<PairedPhotoshopPluginView>,
    pub clients: Vec<PhotoshopClientView>,
    pub projects: Vec<PhotoshopProjectView>,
    pub links: Vec<PhotoshopProjectLinkView>,
    pub transfers: Vec<PhotoshopTransferView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopDiscoveryPayload {
    pub product: &'static str,
    pub product_version: String,
    pub bridge_version: u32,
    pub runtime_instance_id: String,
    pub enabled: bool,
    pub workbench_origin: String,
    pub api_base_url: String,
    pub ws_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum RuntimePhotoshopMessage {
    #[serde(rename = "bridge.challenge")]
    BridgeChallenge {
        bridge_version: u32,
        product_version: String,
        runtime_instance_id: String,
        challenge: String,
    },
    #[serde(rename = "bridge.ready")]
    BridgeReady {
        plugin_session_id: String,
        bearer: String,
        state: PhotoshopBridgeStateView,
    },
    #[serde(rename = "bridge.state")]
    BridgeState { state: PhotoshopBridgeStateView },
    #[serde(rename = "transfer.import.request")]
    TransferImportRequest {
        transfer_id: String,
        project_id: String,
        project_relative_path: String,
        file_name: String,
        mime_type: String,
        byte_length: u64,
        download_url: String,
    },
    #[serde(rename = "runtime_replacing")]
    RuntimeReplacing {
        runtime_instance_id: String,
        deadline: String,
    },
    #[serde(rename = "bridge.error")]
    BridgeError {
        code: PhotoshopBridgeErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub enum PhotoshopHelloMessageType {
    #[serde(rename = "hello")]
    Hello,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopHelloMessage {
    #[serde(rename = "type")]
    pub message_type: PhotoshopHelloMessageType,
    pub plugin_instance_id: String,
    pub host_app: String,
    pub host_version: String,
    pub client_runtime: PhotoshopClientRuntime,
    pub document_count: u32,
    pub active_document_title: Option<String>,
    pub signature: String,
    pub public_key: Option<String>,
    pub pairing_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum PhotoshopRuntimeMessage {
    #[serde(rename = "photoshop.status")]
    PhotoshopStatus {
        document_count: u32,
        active_document_title: Option<String>,
    },
    #[serde(rename = "transfer.import.result")]
    TransferImportResult {
        transfer_id: String,
        ok: bool,
        error_code: Option<PhotoshopBridgeErrorCode>,
        message: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhotoshopHandshakeChallenge {
    pub challenge_id: String,
    pub message: RuntimePhotoshopMessage,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhotoshopSessionAdmission {
    pub grant: PhotoshopPluginSessionGrant,
    pub replaced_session_id: Option<String>,
}

#[derive(Debug)]
pub struct PhotoshopDownloadPlan {
    pub file: std::fs::File,
    pub byte_length: u64,
    pub mime_type: &'static str,
    pub file_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhotoshopImportDispatch {
    pub plugin_session_id: String,
    pub message: RuntimePhotoshopMessage,
    pub transfer: PhotoshopTransferView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopUploadResult {
    pub transfer_id: String,
    pub project_id: String,
    pub project_revision: u64,
    pub project_relative_path: String,
    pub kind: &'static str,
}

#[cfg(test)]
mod protocol_shape_tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn websocket_message_names_and_fields_match_the_closed_protocol() {
        let challenge = RuntimePhotoshopMessage::BridgeChallenge {
            bridge_version: 1,
            product_version: "1.2.3".to_owned(),
            runtime_instance_id: "runtime-1".to_owned(),
            challenge: "proof".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(challenge).unwrap(),
            json!({
                "type": "bridge.challenge",
                "bridgeVersion": 1,
                "productVersion": "1.2.3",
                "runtimeInstanceId": "runtime-1",
                "challenge": "proof"
            })
        );
        let message: PhotoshopRuntimeMessage = serde_json::from_value(json!({
            "type": "transfer.import.result",
            "transferId": "transfer-1",
            "ok": false,
            "errorCode": "photoshop_place_failed",
            "message": "Placement failed."
        }))
        .unwrap();
        assert!(matches!(
            message,
            PhotoshopRuntimeMessage::TransferImportResult {
                transfer_id,
                error_code: Some(PhotoshopBridgeErrorCode::PhotoshopPlaceFailed),
                ..
            } if transfer_id == "transfer-1"
        ));
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhotoshopPluginSessionGrant {
    pub plugin_session_id: String,
    pub plugin_instance_id: String,
    pub bearer: String,
    pub state: PhotoshopBridgeStateView,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn bridge_messages_use_closed_camel_case_fields() {
        let serialized = serde_json::to_value(RuntimePhotoshopMessage::BridgeChallenge {
            bridge_version: 1,
            product_version: "1.2.3".to_owned(),
            runtime_instance_id: "runtime-1".to_owned(),
            challenge: "proof".to_owned(),
        })
        .unwrap();
        assert_eq!(serialized["type"], "bridge.challenge");
        assert_eq!(serialized["bridgeVersion"], 1);
        assert_eq!(serialized["runtimeInstanceId"], "runtime-1");
        assert!(serialized.get("bridge_version").is_none());

        let parsed: PhotoshopRuntimeMessage = serde_json::from_value(json!({
            "type": "photoshop.status",
            "documentCount": 2,
            "activeDocumentTitle": "Poster.psd"
        }))
        .unwrap();
        assert!(matches!(
            parsed,
            PhotoshopRuntimeMessage::PhotoshopStatus {
                document_count: 2,
                active_document_title: Some(title),
            } if title == "Poster.psd"
        ));
        assert!(
            serde_json::from_value::<PhotoshopRuntimeMessage>(json!({
                "type": "heartbeat"
            }))
            .is_err()
        );
        let hello: PhotoshopHelloMessage = serde_json::from_value(json!({
            "type": "hello",
            "pluginInstanceId": "plugin-1",
            "hostApp": "photoshop",
            "hostVersion": "27.0",
            "clientRuntime": "uxp",
            "documentCount": 0,
            "activeDocumentTitle": null,
            "signature": "proof",
            "publicKey": null,
            "pairingCode": null
        }))
        .unwrap();
        assert_eq!(hello.message_type, PhotoshopHelloMessageType::Hello);
        assert!(
            serde_json::from_value::<PhotoshopHelloMessage>(json!({
                "type": "reconnect",
                "pluginInstanceId": "plugin-1",
                "hostApp": "photoshop",
                "hostVersion": "27.0",
                "clientRuntime": "uxp",
                "documentCount": 0,
                "activeDocumentTitle": null,
                "signature": "proof",
                "publicKey": null,
                "pairingCode": null
            }))
            .is_err()
        );
    }
}
