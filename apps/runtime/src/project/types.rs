use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{ProjectError, ProjectRelativePath, feedback::CanvasFeedbackDocument};

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
pub struct ProjectPathRef {
    pub project_relative_path: String,
    pub kind: ProjectPathKind,
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
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProjectPathInspection {
    File {
        #[serde(rename = "projectRelativePath")]
        project_relative_path: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
        #[serde(rename = "createdAtMs", skip_serializing_if = "Option::is_none")]
        created_at_ms: Option<f64>,
        #[serde(rename = "modifiedAtMs", skip_serializing_if = "Option::is_none")]
        modified_at_ms: Option<f64>,
        media: ProjectPathInspectionMedia,
    },
    Directory {
        #[serde(rename = "projectRelativePath")]
        project_relative_path: String,
        #[serde(rename = "createdAtMs", skip_serializing_if = "Option::is_none")]
        created_at_ms: Option<f64>,
        #[serde(rename = "modifiedAtMs", skip_serializing_if = "Option::is_none")]
        modified_at_ms: Option<f64>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProjectPathInspectionMedia {
    Image {
        #[serde(skip_serializing_if = "Option::is_none")]
        dimensions: Option<ProjectImageDimensions>,
    },
    Video {
        #[serde(rename = "sourceToken")]
        source_token: String,
    },
    Audio {
        #[serde(rename = "sourceToken")]
        source_token: String,
    },
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImageDimensions {
    pub width: u64,
    pub height: u64,
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
#[serde(rename_all = "camelCase")]
pub struct CanvasNodeStateChange {
    pub project_relative_path: String,
    pub state: Option<CanvasNodeState>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasStateChange {
    pub node_states: Vec<CanvasNodeStateChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occlusion_order: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum CanvasNodeAvailability {
    Resolving {
        size: u64,
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(rename = "sourceToken")]
        source_token: String,
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
    },
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectFileSourceTarget {
    pub project_relative_path: ProjectRelativePath,
    pub source_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectResolvedFileSource {
    pub project_relative_path: String,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasResolvedSource {
    pub source_token: String,
    pub project_relative_path: String,
    pub availability: CanvasNodeAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_text_tracks: Option<Vec<CanvasVideoTextTrack>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSourceResolutionView {
    pub sources: Vec<CanvasResolvedSource>,
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
        feedback_video_resources: CanvasResourceView,
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
    CanvasStateChanged {
        change: CanvasStateChange,
    },
    CanvasFeedbackChanged {
        feedback: CanvasFeedbackDocument,
        affects_rendered_artifact: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum CanvasStatePatchOutcome {
    Unchanged,
    StateChanged(CanvasStateChange),
    ProjectChanged(Box<ProjectSnapshot>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectEvent {
    pub project_revision: u64,
    pub change: ProjectChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ProjectPathBatchItemResult {
    Ok {
        source_project_relative_path: String,
        project_relative_path: String,
        kind: ProjectPathKind,
    },
    Skipped {
        source_project_relative_path: String,
        project_relative_path: String,
        kind: ProjectPathKind,
    },
    Failed {
        source_project_relative_path: String,
        project_relative_path: String,
        kind: ProjectPathKind,
        error: String,
    },
}

impl ProjectPathBatchItemResult {
    #[must_use]
    pub fn ok(source: String, target: String, kind: ProjectPathKind) -> Self {
        Self::Ok {
            source_project_relative_path: source,
            project_relative_path: target,
            kind,
        }
    }

    #[must_use]
    pub fn skipped(path: String, kind: ProjectPathKind) -> Self {
        Self::Skipped {
            source_project_relative_path: path.clone(),
            project_relative_path: path,
            kind,
        }
    }

    #[must_use]
    pub fn failed(path: String, kind: ProjectPathKind, error: String) -> Self {
        Self::Failed {
            source_project_relative_path: path.clone(),
            project_relative_path: path,
            kind,
            error,
        }
    }

    #[must_use]
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }

    #[must_use]
    pub fn source_project_relative_path(&self) -> &str {
        match self {
            Self::Ok {
                source_project_relative_path,
                ..
            }
            | Self::Skipped {
                source_project_relative_path,
                ..
            }
            | Self::Failed {
                source_project_relative_path,
                ..
            } => source_project_relative_path,
        }
    }

    #[must_use]
    pub fn project_relative_path(&self) -> &str {
        match self {
            Self::Ok {
                project_relative_path,
                ..
            }
            | Self::Skipped {
                project_relative_path,
                ..
            }
            | Self::Failed {
                project_relative_path,
                ..
            } => project_relative_path,
        }
    }

    #[must_use]
    pub fn kind(&self) -> ProjectPathKind {
        match self {
            Self::Ok { kind, .. } | Self::Skipped { kind, .. } | Self::Failed { kind, .. } => *kind,
        }
    }
}
