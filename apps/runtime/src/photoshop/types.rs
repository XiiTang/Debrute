use serde::{Deserialize, Deserializer, Serialize, de::Error as _};

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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PhotoshopIntegrationStatus {
    #[default]
    Off,
    Waiting,
    Connected,
    Unavailable,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopStateView {
    pub status: PhotoshopIntegrationStatus,
    pub transfer_active: bool,
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
        base_project_revision: u64,
        directories: Vec<String>,
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
#[serde(from = "PhotoshopExportResultWire")]
pub enum PhotoshopExportResult {
    Committed { item_id: String, file_name: String },
    Failed { item_id: String },
}

impl PhotoshopExportResult {
    #[must_use]
    pub fn item_id(&self) -> &str {
        match self {
            Self::Committed { item_id, .. } | Self::Failed { item_id } => item_id,
        }
    }

    #[must_use]
    pub fn committed_file_name(&self) -> Option<&str> {
        match self {
            Self::Committed { file_name, .. } => Some(file_name),
            Self::Failed { .. } => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PhotoshopExportResultWire {
    Committed(PhotoshopCommittedExportResultWire),
    Failed(PhotoshopFailedExportResultWire),
}

impl From<PhotoshopExportResultWire> for PhotoshopExportResult {
    fn from(value: PhotoshopExportResultWire) -> Self {
        match value {
            PhotoshopExportResultWire::Committed(value) => Self::Committed {
                item_id: value.item_id,
                file_name: value.file_name,
            },
            PhotoshopExportResultWire::Failed(value) => Self::Failed {
                item_id: value.item_id,
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PhotoshopCommittedExportResultWire {
    item_id: String,
    #[serde(rename = "ok", deserialize_with = "deserialize_true")]
    _ok: (),
    file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PhotoshopFailedExportResultWire {
    item_id: String,
    #[serde(rename = "ok", deserialize_with = "deserialize_false")]
    _ok: (),
}

fn deserialize_true<'de, D>(deserializer: D) -> Result<(), D::Error>
where
    D: Deserializer<'de>,
{
    if bool::deserialize(deserializer)? {
        Ok(())
    } else {
        Err(D::Error::custom("expected true"))
    }
}

fn deserialize_false<'de, D>(deserializer: D) -> Result<(), D::Error>
where
    D: Deserializer<'de>,
{
    if bool::deserialize(deserializer)? {
        Err(D::Error::custom("expected false"))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoshopProjectDirectoriesResult {
    pub request_id: String,
    pub canonical_root: String,
    pub base_project_revision: u64,
    pub project_revision: u64,
    #[serde(flatten)]
    pub outcome: PhotoshopProjectDirectoriesOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum PhotoshopProjectDirectoriesOutcome {
    Loaded {
        pages: Vec<PhotoshopProjectDirectoryPage>,
    },
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum PhotoshopProjectDirectoryPage {
    Loaded {
        directory: String,
        child_directories: Vec<String>,
    },
    Missing {
        directory: String,
    },
    Error {
        directory: String,
        message: String,
    },
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
    #[serde(rename = "photoshop.projectDirectories.result")]
    ProjectDirectoriesResult(PhotoshopProjectDirectoriesResult),
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

    #[test]
    fn export_finish_results_are_one_closed_success_or_failure_union() {
        for message in [
            json!({
                "type": "photoshop.export.finish",
                "commandId": "export-1",
                "items": [{"itemId": "one", "ok": true, "fileName": "Layer.png"}]
            }),
            json!({
                "type": "photoshop.export.finish",
                "commandId": "export-1",
                "items": [{"itemId": "one", "ok": false}]
            }),
        ] {
            assert!(serde_json::from_value::<PluginPhotoshopMessage>(message).is_ok());
        }

        for message in [
            json!({
                "type": "photoshop.export.finish",
                "commandId": "export-1",
                "items": [{
                    "itemId": "one",
                    "ok": false,
                    "errorCode": "photoshop_export_failed"
                }]
            }),
            json!({
                "type": "photoshop.export.finish",
                "commandId": "export-1",
                "items": [{"itemId": "one", "ok": false, "message": "Failed."}]
            }),
            json!({
                "type": "photoshop.export.finish",
                "commandId": "export-1",
                "items": [{"itemId": "one", "ok": false, "fileName": null}]
            }),
            json!({
                "type": "photoshop.export.finish",
                "commandId": "export-1",
                "items": [{"itemId": "one", "ok": true}]
            }),
            json!({
                "type": "photoshop.export.finish",
                "commandId": "export-1",
                "items": [{
                    "itemId": "one",
                    "ok": true,
                    "fileName": "Layer.png",
                    "message": "Saved."
                }]
            }),
        ] {
            assert!(serde_json::from_value::<PluginPhotoshopMessage>(message).is_err());
        }
    }

    #[test]
    fn directory_pages_use_one_exact_batch_request_and_result_contract() {
        let request: PluginPhotoshopMessage = serde_json::from_value(json!({
            "type": "photoshop.projectDirectories.request",
            "requestId": "directories-1",
            "canonicalRoot": "C:/projects/project-1",
            "baseProjectRevision": 4,
            "directories": ["", "exports"]
        }))
        .unwrap();
        assert_eq!(
            request,
            PluginPhotoshopMessage::ProjectDirectoriesRequest {
                request_id: "directories-1".to_owned(),
                canonical_root: "C:/projects/project-1".to_owned(),
                base_project_revision: 4,
                directories: vec![String::new(), "exports".to_owned()],
            }
        );
        assert!(
            serde_json::from_value::<PluginPhotoshopMessage>(json!({
                "type": "photoshop.projectDirectories.request",
                "requestId": "directories-1",
                "canonicalRoot": "C:/projects/project-1",
                "revision": 4
            }))
            .is_err()
        );

        assert_eq!(
            serde_json::to_value(RuntimePhotoshopMessage::ProjectDirectoriesResult(
                PhotoshopProjectDirectoriesResult {
                    request_id: "directories-1".to_owned(),
                    canonical_root: "C:/projects/project-1".to_owned(),
                    base_project_revision: 4,
                    project_revision: 5,
                    outcome: PhotoshopProjectDirectoriesOutcome::Loaded {
                        pages: vec![
                            PhotoshopProjectDirectoryPage::Loaded {
                                directory: String::new(),
                                child_directories: vec!["exports".to_owned()],
                            },
                            PhotoshopProjectDirectoryPage::Missing {
                                directory: "removed".to_owned(),
                            },
                            PhotoshopProjectDirectoryPage::Error {
                                directory: "unreadable".to_owned(),
                                message: "Access denied.".to_owned(),
                            },
                        ],
                    },
                },
            ))
            .unwrap(),
            json!({
                "type": "photoshop.projectDirectories.result",
                "requestId": "directories-1",
                "canonicalRoot": "C:/projects/project-1",
                "baseProjectRevision": 4,
                "projectRevision": 5,
                "outcome": "loaded",
                "pages": [
                    {"directory": "", "outcome": "loaded", "childDirectories": ["exports"]},
                    {"directory": "removed", "outcome": "missing"},
                    {"directory": "unreadable", "outcome": "error", "message": "Access denied."}
                ]
            })
        );
    }
}
