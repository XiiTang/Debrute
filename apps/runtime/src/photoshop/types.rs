use serde::{Deserialize, Serialize};

pub const PHOTOSHOP_WEBSOCKET_SUBPROTOCOL: &str = "debrute.photoshop.v1";
pub const PHOTOSHOP_UXP_ORIGIN: &str = "file://";
pub const PHOTOSHOP_GATEWAY_PORTS: std::ops::RangeInclusive<u16> = 32_124..=32_131;
pub const PHOTOSHOP_MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const PHOTOSHOP_MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
pub const PHOTOSHOP_MAX_BATCH_BYTES: u64 = 1024 * 1024 * 1024;
pub const PHOTOSHOP_MAX_BATCH_ITEMS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PhotoshopMimeType {
    #[serde(rename = "image/png")]
    Png,
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/webp")]
    Webp,
    #[serde(rename = "image/vnd.adobe.photoshop")]
    Psd,
    #[serde(rename = "image/avif")]
    Avif,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopDocumentView {
    pub document_id: u64,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopSessionView {
    pub plugin_session_id: String,
    pub host_version: String,
    pub placement_mime_types: Vec<PhotoshopMimeType>,
    pub documents: Vec<PhotoshopDocumentView>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopStateView {
    pub sessions: Vec<PhotoshopSessionView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopProjectView {
    pub canonical_root: String,
    pub name: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum PluginPhotoshopMessage {
    #[serde(rename = "photoshop.session.start", rename_all = "camelCase")]
    SessionStart {
        host_version: String,
        placement_mime_types: Vec<PhotoshopMimeType>,
        documents: Vec<PhotoshopDocumentView>,
    },
    #[serde(rename = "photoshop.documents.snapshot", rename_all = "camelCase")]
    DocumentsSnapshot {
        documents: Vec<PhotoshopDocumentView>,
    },
    #[serde(
        rename = "photoshop.projectDirectories.request",
        rename_all = "camelCase"
    )]
    ProjectDirectoriesRequest {
        request_id: String,
        canonical_root: String,
        revision: u64,
    },
    #[serde(rename = "photoshop.export.start", rename_all = "camelCase")]
    ExportStart {
        command_id: String,
        canonical_root: String,
        project_revision: u64,
        directory: String,
        items: Vec<PhotoshopExportItem>,
    },
    #[serde(rename = "photoshop.export.finish", rename_all = "camelCase")]
    ExportFinish {
        command_id: String,
        items: Vec<PhotoshopExportResult>,
    },
    #[serde(rename = "photoshop.place.result", rename_all = "camelCase")]
    PlaceResult {
        command_id: String,
        ok: bool,
        error_code: Option<String>,
        message: Option<String>,
    },
}

impl PluginPhotoshopMessage {
    #[must_use]
    pub fn session_start(
        self,
    ) -> Option<(String, Vec<PhotoshopMimeType>, Vec<PhotoshopDocumentView>)> {
        match self {
            Self::SessionStart {
                host_version,
                placement_mime_types,
                documents,
            } => Some((host_version, placement_mime_types, documents)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopExportItem {
    pub item_id: String,
    pub source_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopExportResult {
    pub item_id: String,
    pub ok: bool,
    pub file_name: Option<String>,
    pub error_code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type")]
pub enum RuntimePhotoshopMessage {
    #[serde(rename = "photoshop.session.ready", rename_all = "camelCase")]
    SessionReady {
        runtime_instance_id: String,
        plugin_session_id: String,
        bearer: String,
    },
    #[serde(rename = "photoshop.projects.snapshot", rename_all = "camelCase")]
    ProjectsSnapshot { projects: Vec<PhotoshopProjectView> },
    #[serde(
        rename = "photoshop.projectDirectories.snapshot",
        rename_all = "camelCase"
    )]
    ProjectDirectoriesSnapshot {
        request_id: String,
        canonical_root: String,
        revision: u64,
        directories: Vec<String>,
    },
    #[serde(rename = "photoshop.export.ready", rename_all = "camelCase")]
    ExportReady { command_id: String },
    #[serde(rename = "photoshop.place.request", rename_all = "camelCase")]
    PlaceRequest {
        command_id: String,
        document_id: u64,
        file_name: String,
        mime_type: PhotoshopMimeType,
        byte_length: u64,
    },
    #[serde(rename = "runtime.replacing", rename_all = "camelCase")]
    RuntimeReplacing { runtime_instance_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopUploadResult {
    pub file_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopSendResult {
    pub command_id: String,
    pub document_title: String,
    pub file_name: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn v1_protocol_is_closed_and_uses_exact_names() {
        let start: PluginPhotoshopMessage = serde_json::from_value(json!({
            "type": "photoshop.session.start",
            "hostVersion": "27.0",
            "placementMimeTypes": [
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/vnd.adobe.photoshop",
                "image/avif"
            ],
            "documents": [{"documentId": 7, "title": "A.psd"}]
        }))
        .unwrap();
        assert!(matches!(start, PluginPhotoshopMessage::SessionStart { .. }));
        assert!(
            serde_json::from_value::<PluginPhotoshopMessage>(json!({
                "type": "photoshop.session.start",
                "hostVersion": "27.0",
                "placementMimeTypes": ["image/png"],
                "documents": [],
                "extra": true
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<PluginPhotoshopMessage>(json!({
                "type": "photoshop.session.start",
                "hostVersion": "27.0",
                "documents": []
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<PluginPhotoshopMessage>(json!({
                "type": "photoshop.session.start",
                "hostVersion": "27.0",
                "placementMimeTypes": ["image/gif"],
                "documents": []
            }))
            .is_err()
        );
        assert_eq!(
            serde_json::to_value(RuntimePhotoshopMessage::ExportReady {
                command_id: "command-1".to_owned()
            })
            .unwrap(),
            json!({"type": "photoshop.export.ready", "commandId": "command-1"})
        );
    }
}
