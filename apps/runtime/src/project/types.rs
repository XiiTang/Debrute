use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{ProjectError, feedback::CanvasFeedbackDocument};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasWorkspaceDocument {
    pub canonical_root: String,
    #[serde(flatten)]
    pub state: CanvasState,
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
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectDirectoryState {
    Unloaded,
    Loaded,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectTreeEntry {
    pub project_relative_path: String,
    pub kind: ProjectPathKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub directory_state: Option<ProjectDirectoryState>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub directory_error: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasVideoPlaybackState {
    pub current_time_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasTextViewportState {
    pub scroll_top: f64,
    pub scroll_left: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasManualLayout {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasNodeState {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub manual_layout: Option<CanvasManualLayout>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub video_playback: Option<CanvasVideoPlaybackState>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text_viewport: Option<CanvasTextViewportState>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasState {
    pub expanded_directories: Vec<String>,
    pub node_states: BTreeMap<String, CanvasNodeState>,
    pub occlusion_order: Vec<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasImageDimensions {
    pub width: u64,
    pub height: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "nodeKind", rename_all = "lowercase")]
pub enum CanvasResource {
    Directory {
        #[serde(rename = "projectRelativePath")]
        project_relative_path: String,
    },
    File {
        #[serde(rename = "projectRelativePath")]
        project_relative_path: String,
        #[serde(rename = "mediaKind")]
        media_kind: CanvasMediaKind,
        availability: Box<CanvasNodeAvailability>,
        #[serde(rename = "imageDimensions", skip_serializing_if = "Option::is_none")]
        image_dimensions: Option<CanvasImageDimensions>,
        #[serde(rename = "textLanguage", skip_serializing_if = "Option::is_none")]
        text_language: Option<String>,
        #[serde(rename = "videoPresentation", skip_serializing_if = "Option::is_none")]
        video_presentation: Option<CanvasVideoPresentation>,
    },
}

impl CanvasResource {
    #[must_use]
    pub fn project_relative_path(&self) -> &str {
        match self {
            Self::Directory {
                project_relative_path,
            }
            | Self::File {
                project_relative_path,
                ..
            } => project_relative_path,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasResourceView {
    pub resources: Vec<CanvasResource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasWorkspaceUnavailableCode {
    CanvasWorkspaceInvalid,
    CanvasWorkspaceUnreadable,
    CanvasWorkspaceRootMismatch,
    CanvasWorkspacePersistenceFailed,
}

impl CanvasWorkspaceUnavailableCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CanvasWorkspaceInvalid => "canvas_workspace_invalid",
            Self::CanvasWorkspaceUnreadable => "canvas_workspace_unreadable",
            Self::CanvasWorkspaceRootMismatch => "canvas_workspace_root_mismatch",
            Self::CanvasWorkspacePersistenceFailed => "canvas_workspace_persistence_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasWorkspaceUnavailable {
    pub code: CanvasWorkspaceUnavailableCode,
    pub message: String,
}

impl CanvasWorkspaceUnavailable {
    #[must_use]
    pub fn new(code: CanvasWorkspaceUnavailableCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn to_error(&self) -> ProjectError {
        ProjectError::service(self.code.as_str(), self.message.clone())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CanvasWorkspaceSnapshot {
    Available {
        workspace: CanvasWorkspaceDocument,
        canvas_resources: CanvasResourceView,
    },
    Unavailable {
        code: CanvasWorkspaceUnavailableCode,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiagnosticCounts {
    pub errors: usize,
    pub warnings: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectHealthSummary {
    pub project_name: String,
    pub diagnostic_counts: ProjectDiagnosticCounts,
    pub checked_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectSnapshot {
    pub canonical_root: String,
    pub project_tree: Vec<ProjectTreeEntry>,
    pub canvas_workspace: CanvasWorkspaceSnapshot,
    pub diagnostics: Vec<ProjectDiagnostic>,
    pub health: ProjectHealthSummary,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectSyncSnapshot {
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
    CanvasFeedbackChanged {
        feedback: CanvasFeedbackDocument,
        affects_rendered_artifact: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectEvent {
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
