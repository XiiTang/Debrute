use serde::{Deserialize, Serialize};

use super::feedback::CanvasFeedbackDocument;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DebruteProjectMetadata {
    pub project: DebruteProjectIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DebruteProjectIdentity {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn is_valid_stable_project_id(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectPathKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectPathEntry {
    pub project_relative_path: String,
    pub kind: ProjectPathKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextFile {
    pub project_relative_path: String,
    pub absolute_path: String,
    pub content: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub revision: String,
    pub language: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectDiagnosticSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiagnostic {
    pub id: String,
    pub severity: ProjectDiagnosticSeverity,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasNodeKind {
    Directory,
    File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasMediaKind {
    Image,
    Video,
    Audio,
    Text,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasVideoPlaybackState {
    pub current_time_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasTextViewportState {
    pub scroll_top: f64,
    pub scroll_left: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasNodeElement {
    pub project_relative_path: String,
    pub node_kind: CanvasNodeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_kind: Option<CanvasMediaKind>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_playback: Option<CanvasVideoPlaybackState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_viewport: Option<CanvasTextViewportState>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanvasAnnotation {
    pub id: String,
    pub text: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasPreferences {
    pub show_diagnostics: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasDocument {
    pub id: String,
    pub name: String,
    pub node_elements: Vec<CanvasNodeElement>,
    pub annotations: Vec<CanvasAnnotation>,
    pub preferences: CanvasPreferences,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum CanvasNodeAvailability {
    Available {
        size: u64,
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(rename = "fileUrl")]
        file_url: String,
        #[serde(
            rename = "canvasImagePreviewable",
            skip_serializing_if = "Option::is_none"
        )]
        canvas_image_previewable: Option<bool>,
        #[serde(
            rename = "canvasImagePreviewSourceWidth",
            skip_serializing_if = "Option::is_none"
        )]
        canvas_image_preview_source_width: Option<u64>,
        #[serde(rename = "mtimeMs", skip_serializing_if = "Option::is_none")]
        mtime_ms: Option<f64>,
        revision: String,
    },
    Missing {
        message: String,
    },
    Unreadable {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasVideoPresentationKind {
    Video,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasVideoTextTrackKind {
    Subtitles,
    Captions,
    Chapters,
    Metadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasVideoTextTrack {
    pub project_relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_url: Option<String>,
    pub revision: String,
    pub kind: CanvasVideoTextTrackKind,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub srclang: Option<String>,
    pub default: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasVideoPresentation {
    pub kind: CanvasVideoPresentationKind,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    pub text_tracks: Vec<CanvasVideoTextTrack>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedCanvasNode {
    #[serde(flatten)]
    pub node: CanvasNodeElement,
    pub availability: CanvasNodeAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_presentation: Option<CanvasVideoPresentation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasStructureEdgeProjection {
    pub id: String,
    pub source_project_relative_path: String,
    pub target_project_relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasProjection {
    pub canvas_id: String,
    pub nodes: Vec<ProjectedCanvasNode>,
    pub edges: Vec<CanvasStructureEdgeProjection>,
    pub diagnostics: Vec<ProjectDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum CanvasRegistryState {
    Ready {
        #[serde(rename = "canvasOrder")]
        canvas_order: Vec<String>,
    },
    Invalid {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiagnosticCounts {
    pub errors: usize,
    pub warnings: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHealthSummary {
    pub project_name: String,
    pub canvas_count: usize,
    pub diagnostic_counts: ProjectDiagnosticCounts,
    pub runtime_data_location: String,
    pub checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub project_root: String,
    pub metadata: DebruteProjectMetadata,
    pub files: Vec<ProjectPathEntry>,
    pub canvases: Vec<CanvasDocument>,
    pub projections: Vec<CanvasProjection>,
    pub diagnostics: Vec<ProjectDiagnostic>,
    pub canvas_registry: CanvasRegistryState,
    pub health: ProjectHealthSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSyncSnapshot {
    pub project_id: String,
    pub project_revision: u64,
    pub snapshot: ProjectSnapshot,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProjectChange {
    ProjectChanged(ProjectSnapshot),
    ProjectFileChanged {
        project_relative_path: String,
        snapshot: ProjectSnapshot,
    },
    CanvasChanged {
        canvas: CanvasDocument,
        projection: CanvasProjection,
    },
    CanvasFeedbackChanged {
        feedback: CanvasFeedbackDocument,
        affects_rendered_artifact: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectEvent {
    pub project_id: String,
    pub project_revision: u64,
    pub change: ProjectChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectPathOperationStatus {
    Ok,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPathBatchItemResult {
    pub source_project_relative_path: String,
    pub project_relative_path: String,
    pub kind: ProjectPathKind,
    pub status: ProjectPathOperationStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanvasRegistryDocument {
    #[serde(rename = "canvasOrder")]
    pub canvas_order: Vec<String>,
}
