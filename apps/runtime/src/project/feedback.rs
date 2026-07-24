//! Revisioned Canvas feedback document semantics.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{
    CanvasMediaKind, ProjectCapabilityFs, ProjectError, canvas_media_kind_from_path,
    normalize_project_relative_path, project_content_hash,
};

mod artifacts;

pub use artifacts::*;

pub const CANVAS_FEEDBACK_PROJECT_PATH: &str = ".debrute/reviews/canvas-feedback.json";
pub(super) const MAX_CANVAS_FEEDBACK_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_CANVAS_FEEDBACK_ENTRIES: usize = 1_000;
const MAX_CANVAS_FEEDBACK_ITEMS_PER_ENTRY: usize = 500;
const MAX_CANVAS_FEEDBACK_ITEMS: usize = 5_000;
const MAX_CANVAS_FEEDBACK_MOMENTS_PER_ENTRY: usize = 200;
const MAX_CANVAS_FEEDBACK_PATH_BYTES: usize = 1_024;
const MAX_CANVAS_FEEDBACK_ITEM_ID_BYTES: usize = 128;
const MAX_CANVAS_FEEDBACK_COMMENT_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasFeedbackMark {
    Like,
    Dislike,
    Check,
    Cross,
    Pending,
    Important,
    NeedsRevision,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum CanvasFeedbackGeometry {
    Point {
        x: f64,
        y: f64,
    },
    Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasFeedbackMomentRef {
    pub label: String,
    pub current_time_seconds: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasFeedbackItemKind {
    Comment,
    Pin,
    Region,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasFeedbackScope {
    File,
    Moment,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasFeedbackItem {
    pub id: String,
    pub kind: CanvasFeedbackItemKind,
    pub scope: CanvasFeedbackScope,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub label: Option<u64>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub geometry: Option<CanvasFeedbackGeometry>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub moment: Option<CanvasFeedbackMomentRef>,
    pub comment: String,
    pub created_at: String,
    pub updated_at: String,
}

impl CanvasFeedbackItem {
    #[must_use]
    pub fn is_spatial(&self) -> bool {
        matches!(
            self.kind,
            CanvasFeedbackItemKind::Pin | CanvasFeedbackItemKind::Region
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasFeedbackEntry {
    pub project_relative_path: String,
    pub marks: Vec<CanvasFeedbackMark>,
    pub next_moment_label: u64,
    pub next_spatial_label: u64,
    pub items: Vec<CanvasFeedbackItem>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasFeedbackDocument {
    pub updated_at: String,
    pub entries: BTreeMap<String, CanvasFeedbackEntry>,
}

impl CanvasFeedbackDocument {
    pub(crate) fn empty(updated_at: String) -> Result<Self, ProjectError> {
        validate_iso_timestamp(&updated_at)?;
        Ok(Self {
            updated_at,
            entries: BTreeMap::new(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewCanvasFeedbackItem {
    pub kind: CanvasFeedbackItemKind,
    pub scope: CanvasFeedbackScope,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub moment_time_seconds: Option<f64>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub geometry: Option<CanvasFeedbackGeometry>,
    pub comment: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case", deny_unknown_fields)]
pub enum UpdateCanvasFeedbackEntryInput {
    SetMarks {
        #[serde(rename = "projectRelativePath")]
        project_relative_path: String,
        marks: Vec<CanvasFeedbackMark>,
    },
    AddItem {
        #[serde(rename = "projectRelativePath")]
        project_relative_path: String,
        item: NewCanvasFeedbackItem,
    },
    UpdateItem {
        #[serde(rename = "projectRelativePath")]
        project_relative_path: String,
        #[serde(rename = "itemId")]
        item_id: String,
        #[serde(default, deserialize_with = "deserialize_optional_non_null")]
        geometry: Option<CanvasFeedbackGeometry>,
        #[serde(default, deserialize_with = "deserialize_optional_non_null")]
        comment: Option<String>,
    },
    DeleteItem {
        #[serde(rename = "projectRelativePath")]
        project_relative_path: String,
        #[serde(rename = "itemId")]
        item_id: String,
    },
}

impl UpdateCanvasFeedbackEntryInput {
    #[must_use]
    pub fn project_relative_path(&self) -> &str {
        match self {
            Self::SetMarks {
                project_relative_path,
                ..
            }
            | Self::AddItem {
                project_relative_path,
                ..
            }
            | Self::UpdateItem {
                project_relative_path,
                ..
            }
            | Self::DeleteItem {
                project_relative_path,
                ..
            } => project_relative_path,
        }
    }

    #[must_use]
    pub fn affects_rendered_artifact(&self) -> bool {
        match self {
            Self::SetMarks { .. } => false,
            Self::AddItem { item, .. } => {
                item.scope == CanvasFeedbackScope::Moment
                    || matches!(
                        item.kind,
                        CanvasFeedbackItemKind::Pin | CanvasFeedbackItemKind::Region
                    )
            }
            Self::UpdateItem { geometry, .. } => geometry.is_some(),
            Self::DeleteItem { .. } => true,
        }
    }
}

pub(crate) struct CanvasFeedbackState {
    pub document: CanvasFeedbackDocument,
    pub content_hash: Option<String>,
}

pub(crate) fn read_canvas_feedback_state(
    project_root: &Path,
    missing_timestamp: String,
) -> Result<CanvasFeedbackState, ProjectError> {
    let project = ProjectCapabilityFs::open(project_root)?;
    let content = match project.read_limited(
        CANVAS_FEEDBACK_PROJECT_PATH,
        MAX_CANVAS_FEEDBACK_DOCUMENT_BYTES,
    ) {
        Ok(content) => content,
        Err(ProjectError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CanvasFeedbackState {
                document: CanvasFeedbackDocument::empty(missing_timestamp)?,
                content_hash: None,
            });
        }
        Err(error) => return Err(error),
    };
    let content = String::from_utf8(content).map_err(|error| {
        ProjectError::Validation(format!("Canvas feedback document is not UTF-8: {error}"))
    })?;
    let document: CanvasFeedbackDocument = serde_json::from_str(&content)?;
    let document = normalize_canvas_feedback_document(document)?;
    Ok(CanvasFeedbackState {
        document,
        content_hash: Some(project_content_hash(content)),
    })
}

pub(crate) fn write_canvas_feedback_document(
    project_root: &Path,
    document: &CanvasFeedbackDocument,
    expected_hash: Option<&str>,
) -> Result<(), ProjectError> {
    validate_canvas_feedback_document(document)?;
    let project = ProjectCapabilityFs::open(project_root)?;
    let current_hash = match project.read_limited(
        CANVAS_FEEDBACK_PROJECT_PATH,
        MAX_CANVAS_FEEDBACK_DOCUMENT_BYTES,
    ) {
        Ok(content) => Some(project_content_hash(content)),
        Err(ProjectError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    if current_hash.as_deref() != expected_hash {
        return Err(ProjectError::service(
            "document_push_conflict",
            "Canvas feedback document changed on disk before push commit.",
        ));
    }
    let mut content = serde_json::to_string_pretty(document)?;
    content.push('\n');
    if content.len() > MAX_CANVAS_FEEDBACK_DOCUMENT_BYTES {
        return Err(ProjectError::service(
            "canvas_feedback_document_too_large",
            format!("Canvas feedback document exceeds {MAX_CANVAS_FEEDBACK_DOCUMENT_BYTES} bytes."),
        ));
    }
    project.atomic_write(CANVAS_FEEDBACK_PROJECT_PATH, content.as_bytes())
}

// The closed operation interpreter stays together so every variant shares one validation tail.
#[allow(clippy::too_many_lines)]
pub(crate) fn update_canvas_feedback_document(
    document: &CanvasFeedbackDocument,
    input: &UpdateCanvasFeedbackEntryInput,
    updated_at: String,
) -> Result<CanvasFeedbackDocument, ProjectError> {
    validate_canvas_feedback_document(document)?;
    validate_iso_timestamp(&updated_at)?;
    let project_relative_path = normalize_feedback_path(input.project_relative_path())?;
    let mut next = document.clone();
    let mut entry = next
        .entries
        .remove(&project_relative_path)
        .unwrap_or(CanvasFeedbackEntry {
            project_relative_path: project_relative_path.clone(),
            marks: Vec::new(),
            next_moment_label: 1,
            next_spatial_label: 1,
            items: Vec::new(),
            updated_at: updated_at.clone(),
        });
    match input {
        UpdateCanvasFeedbackEntryInput::SetMarks { marks, .. } => {
            entry.marks = normalized_marks(marks);
        }
        UpdateCanvasFeedbackEntryInput::AddItem { item, .. } => {
            let id = next_item_id(&entry.items, &updated_at);
            let comment = normalized_comment(&item.comment)?;
            let geometry = item
                .geometry
                .as_ref()
                .map(normalized_geometry)
                .transpose()?;
            let mut next_item = CanvasFeedbackItem {
                id,
                kind: item.kind,
                scope: item.scope,
                label: None,
                geometry,
                moment: None,
                comment,
                created_at: updated_at.clone(),
                updated_at: updated_at.clone(),
            };
            if item.scope == CanvasFeedbackScope::Moment {
                let time =
                    normalized_playback_time(item.moment_time_seconds.ok_or_else(|| {
                        ProjectError::Validation(
                            "Canvas feedback moment item requires momentTimeSeconds.".to_owned(),
                        )
                    })?)?;
                next_item.moment = Some(moment_ref_for_time(&mut entry, time));
            } else if item.moment_time_seconds.is_some() {
                return Err(ProjectError::Validation(
                    "Canvas feedback file item cannot include momentTimeSeconds.".to_owned(),
                ));
            }
            match item.kind {
                CanvasFeedbackItemKind::Comment => {
                    if item.geometry.is_some() {
                        return Err(ProjectError::Validation(
                            "Canvas feedback comment cannot include geometry.".to_owned(),
                        ));
                    }
                }
                CanvasFeedbackItemKind::Pin | CanvasFeedbackItemKind::Region => {
                    let geometry = next_item.geometry.as_ref().ok_or_else(|| {
                        ProjectError::Validation(
                            "Canvas feedback spatial item requires geometry.".to_owned(),
                        )
                    })?;
                    validate_spatial_geometry(item.kind, geometry)?;
                    next_item.label = Some(entry.next_spatial_label);
                    entry.next_spatial_label =
                        entry.next_spatial_label.checked_add(1).ok_or_else(|| {
                            ProjectError::Validation(
                                "Canvas feedback label is exhausted.".to_owned(),
                            )
                        })?;
                }
            }
            entry.items.push(next_item);
        }
        UpdateCanvasFeedbackEntryInput::UpdateItem {
            item_id,
            geometry,
            comment,
            ..
        } => {
            let item = entry
                .items
                .iter_mut()
                .find(|item| item.id == *item_id)
                .ok_or_else(|| {
                    ProjectError::Validation(format!("Canvas feedback item not found: {item_id}"))
                })?;
            if let Some(geometry) = geometry {
                if !item.is_spatial() {
                    return Err(ProjectError::Validation(format!(
                        "Canvas feedback item is not spatial: {item_id}"
                    )));
                }
                let geometry = normalized_geometry(geometry)?;
                validate_spatial_geometry(item.kind, &geometry)?;
                item.geometry = Some(geometry);
            }
            if let Some(comment) = comment {
                item.comment = normalized_comment(comment)?;
            }
            item.updated_at.clone_from(&updated_at);
        }
        UpdateCanvasFeedbackEntryInput::DeleteItem { item_id, .. } => {
            let before = entry.items.len();
            entry.items.retain(|item| item.id != *item_id);
            if before == entry.items.len() {
                return Err(ProjectError::Validation(format!(
                    "Canvas feedback item not found: {item_id}"
                )));
            }
        }
    }
    entry.updated_at.clone_from(&updated_at);
    if !entry.marks.is_empty() || !entry.items.is_empty() {
        next.entries.insert(project_relative_path, entry);
    }
    next.updated_at = updated_at;
    validate_canvas_feedback_document(&next)?;
    Ok(next)
}

pub(crate) fn validate_feedback_media_targets(
    document: &CanvasFeedbackDocument,
) -> Result<(), ProjectError> {
    for entry in document.entries.values() {
        let media_kind = canvas_media_kind_from_path(&entry.project_relative_path);
        for item in &entry.items {
            if item.is_spatial()
                && item.scope == CanvasFeedbackScope::File
                && media_kind != CanvasMediaKind::Image
            {
                return Err(ProjectError::Validation(format!(
                    "Canvas feedback file-scope spatial items require an image file: {}",
                    entry.project_relative_path
                )));
            }
            if item.scope == CanvasFeedbackScope::Moment && media_kind != CanvasMediaKind::Video {
                return Err(ProjectError::Validation(format!(
                    "Canvas feedback moment items require a video file: {}",
                    entry.project_relative_path
                )));
            }
        }
    }
    Ok(())
}

/// Validates the complete persisted Canvas feedback invariant set.
///
/// # Errors
/// Returns an error for non-canonical paths, timestamps, labels, items, or geometry.
pub fn validate_canvas_feedback_document(
    document: &CanvasFeedbackDocument,
) -> Result<(), ProjectError> {
    validate_iso_timestamp(&document.updated_at)?;
    if document.entries.len() > MAX_CANVAS_FEEDBACK_ENTRIES {
        return Err(ProjectError::Validation(format!(
            "Canvas feedback exceeds {MAX_CANVAS_FEEDBACK_ENTRIES} entries."
        )));
    }
    let mut total_items = 0_usize;
    for (path, entry) in &document.entries {
        total_items = total_items.saturating_add(entry.items.len());
        if total_items > MAX_CANVAS_FEEDBACK_ITEMS {
            return Err(ProjectError::Validation(format!(
                "Canvas feedback exceeds {MAX_CANVAS_FEEDBACK_ITEMS} items."
            )));
        }
        let normalized = normalize_feedback_path(path)?;
        if normalized != *path || entry.project_relative_path != *path {
            return Err(ProjectError::Validation(format!(
                "Canvas feedback entry key must match projectRelativePath: {path}"
            )));
        }
        validate_entry(entry)?;
        if entry.marks.is_empty() && entry.items.is_empty() {
            return Err(ProjectError::Validation(
                "Canvas feedback document cannot retain an empty entry.".to_owned(),
            ));
        }
    }
    Ok(())
}

fn normalize_canvas_feedback_document(
    mut document: CanvasFeedbackDocument,
) -> Result<CanvasFeedbackDocument, ProjectError> {
    validate_iso_timestamp(&document.updated_at)?;
    let mut entries = BTreeMap::new();
    for (key, mut entry) in document.entries {
        let key = normalize_feedback_path(&key)?;
        entry.project_relative_path = normalize_feedback_path(&entry.project_relative_path)?;
        if key != entry.project_relative_path {
            return Err(ProjectError::Validation(format!(
                "Canvas feedback entry key must match projectRelativePath: {key}"
            )));
        }
        entry.marks = normalized_marks(&entry.marks);
        for item in &mut entry.items {
            item.id = item.id.trim().to_owned();
            item.comment = normalized_comment(&item.comment)?;
            if let Some(geometry) = &item.geometry {
                item.geometry = Some(normalized_geometry(geometry)?);
            }
            if let Some(moment) = &mut item.moment {
                let label = moment_label_number(&moment.label)?;
                moment.label = format!("M{label}");
                moment.current_time_seconds =
                    normalized_playback_time(moment.current_time_seconds)?;
            }
        }
        validate_entry(&entry)?;
        if !entry.marks.is_empty() || !entry.items.is_empty() {
            entries.insert(key, entry);
        }
    }
    document.entries = entries;
    validate_canvas_feedback_document(&document)?;
    Ok(document)
}

fn validate_entry(entry: &CanvasFeedbackEntry) -> Result<(), ProjectError> {
    validate_iso_timestamp(&entry.updated_at)?;
    if entry.next_moment_label == 0 || entry.next_spatial_label == 0 {
        return Err(ProjectError::Validation(
            "Canvas feedback next labels must be positive.".to_owned(),
        ));
    }
    if normalized_marks(&entry.marks) != entry.marks {
        return Err(ProjectError::Validation(
            "Canvas feedback marks must be unique and ordered.".to_owned(),
        ));
    }
    if entry.items.len() > MAX_CANVAS_FEEDBACK_ITEMS_PER_ENTRY {
        return Err(ProjectError::Validation(format!(
            "Canvas feedback entry exceeds {MAX_CANVAS_FEEDBACK_ITEMS_PER_ENTRY} items."
        )));
    }
    let mut ids = BTreeSet::new();
    let mut spatial_labels = BTreeSet::new();
    let mut label_by_time = BTreeMap::<u64, String>::new();
    let mut time_by_label = BTreeMap::<String, u64>::new();
    let mut max_moment_label = 0;
    let mut max_spatial_label = 0;
    for item in &entry.items {
        validate_item(item)?;
        if !ids.insert(item.id.clone()) {
            return Err(ProjectError::Validation(
                "Canvas feedback item ids must be unique.".to_owned(),
            ));
        }
        if let Some(label) = item.label {
            max_spatial_label = max_spatial_label.max(label);
            if !spatial_labels.insert(label) {
                return Err(ProjectError::Validation(
                    "Canvas feedback spatial labels must be unique.".to_owned(),
                ));
            }
        }
        if let Some(moment) = &item.moment {
            let label = moment_label_number(&moment.label)?;
            max_moment_label = max_moment_label.max(label);
            let time_key = moment.current_time_seconds.to_bits();
            if label_by_time
                .insert(time_key, moment.label.clone())
                .is_some_and(|existing| existing != moment.label)
                || time_by_label
                    .insert(moment.label.clone(), time_key)
                    .is_some_and(|existing| existing != time_key)
            {
                return Err(ProjectError::Validation(
                    "Canvas feedback moments must map one label to one timestamp.".to_owned(),
                ));
            }
        }
    }
    if time_by_label.len() > MAX_CANVAS_FEEDBACK_MOMENTS_PER_ENTRY {
        return Err(ProjectError::Validation(format!(
            "Canvas feedback entry exceeds {MAX_CANVAS_FEEDBACK_MOMENTS_PER_ENTRY} moments."
        )));
    }
    if entry.next_moment_label <= max_moment_label || entry.next_spatial_label <= max_spatial_label
    {
        return Err(ProjectError::Validation(
            "Canvas feedback next labels must exceed existing labels.".to_owned(),
        ));
    }
    Ok(())
}

fn validate_item(item: &CanvasFeedbackItem) -> Result<(), ProjectError> {
    if item.id.trim().is_empty() || item.id != item.id.trim() {
        return Err(ProjectError::Validation(
            "Canvas feedback item id must be non-empty and trimmed.".to_owned(),
        ));
    }
    if item.id.len() > MAX_CANVAS_FEEDBACK_ITEM_ID_BYTES {
        return Err(ProjectError::Validation(format!(
            "Canvas feedback item id exceeds {MAX_CANVAS_FEEDBACK_ITEM_ID_BYTES} bytes."
        )));
    }
    normalized_comment(&item.comment)?;
    if item.comment != item.comment.trim() {
        return Err(ProjectError::Validation(
            "Canvas feedback comment must be trimmed.".to_owned(),
        ));
    }
    validate_iso_timestamp(&item.created_at)?;
    validate_iso_timestamp(&item.updated_at)?;
    match (item.kind, item.scope) {
        (CanvasFeedbackItemKind::Comment, CanvasFeedbackScope::File) => {
            if item.label.is_some() || item.geometry.is_some() || item.moment.is_some() {
                return Err(ProjectError::Validation(
                    "Canvas feedback file comment contains spatial or moment fields.".to_owned(),
                ));
            }
        }
        (CanvasFeedbackItemKind::Comment, CanvasFeedbackScope::Moment) => {
            if item.label.is_some() || item.geometry.is_some() || item.moment.is_none() {
                return Err(ProjectError::Validation(
                    "Canvas feedback moment comment has invalid fields.".to_owned(),
                ));
            }
        }
        (CanvasFeedbackItemKind::Pin | CanvasFeedbackItemKind::Region, scope) => {
            if item.label.is_none() || item.geometry.is_none() {
                return Err(ProjectError::Validation(
                    "Canvas feedback spatial item requires label and geometry.".to_owned(),
                ));
            }
            if (scope == CanvasFeedbackScope::Moment) != item.moment.is_some() {
                return Err(ProjectError::Validation(
                    "Canvas feedback spatial moment fields do not match scope.".to_owned(),
                ));
            }
            let geometry = item.geometry.as_ref().ok_or_else(|| {
                ProjectError::Validation(
                    "Canvas feedback spatial item requires geometry.".to_owned(),
                )
            })?;
            validate_spatial_geometry(item.kind, geometry)?;
        }
    }
    if let Some(moment) = &item.moment {
        moment_label_number(&moment.label)?;
        if normalized_playback_time(moment.current_time_seconds)?.to_bits()
            != moment.current_time_seconds.to_bits()
        {
            return Err(ProjectError::Validation(
                "Canvas feedback moment timestamp must use millisecond precision.".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_spatial_geometry(
    kind: CanvasFeedbackItemKind,
    geometry: &CanvasFeedbackGeometry,
) -> Result<(), ProjectError> {
    match (kind, geometry) {
        (CanvasFeedbackItemKind::Pin, CanvasFeedbackGeometry::Point { x, y }) => {
            validate_unit(*x, "Canvas feedback point x", false)?;
            validate_unit(*y, "Canvas feedback point y", false)
        }
        (
            CanvasFeedbackItemKind::Region,
            CanvasFeedbackGeometry::Rect {
                x,
                y,
                width,
                height,
            },
        ) => {
            validate_unit(*x, "Canvas feedback region x", false)?;
            validate_unit(*y, "Canvas feedback region y", false)?;
            validate_unit(*width, "Canvas feedback region width", true)?;
            validate_unit(*height, "Canvas feedback region height", true)?;
            if x + width > 1.0 || y + height > 1.0 {
                return Err(ProjectError::Validation(
                    "Canvas feedback region must remain inside the image.".to_owned(),
                ));
            }
            Ok(())
        }
        (CanvasFeedbackItemKind::Pin, _) => Err(ProjectError::Validation(
            "Canvas feedback pin geometry must be a point.".to_owned(),
        )),
        (CanvasFeedbackItemKind::Region, _) => Err(ProjectError::Validation(
            "Canvas feedback region geometry must be a rect.".to_owned(),
        )),
        (CanvasFeedbackItemKind::Comment, _) => Err(ProjectError::Validation(
            "Canvas feedback comment cannot include geometry.".to_owned(),
        )),
    }
}

fn normalize_feedback_path(path: &str) -> Result<String, ProjectError> {
    let normalized = path.replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    let normalized = normalize_project_relative_path(normalized)?;
    if normalized.len() > MAX_CANVAS_FEEDBACK_PATH_BYTES {
        return Err(ProjectError::Validation(format!(
            "Canvas feedback path exceeds {MAX_CANVAS_FEEDBACK_PATH_BYTES} bytes."
        )));
    }
    if normalized == ".debrute/reviews/rendered-feedback"
        || normalized.starts_with(".debrute/reviews/rendered-feedback/")
    {
        return Err(ProjectError::Validation(
            "Canvas feedback cannot target rendered feedback artifacts.".to_owned(),
        ));
    }
    Ok(normalized)
}

fn deserialize_optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn normalized_marks(marks: &[CanvasFeedbackMark]) -> Vec<CanvasFeedbackMark> {
    const ORDER: [CanvasFeedbackMark; 7] = [
        CanvasFeedbackMark::Like,
        CanvasFeedbackMark::Dislike,
        CanvasFeedbackMark::Check,
        CanvasFeedbackMark::Cross,
        CanvasFeedbackMark::Pending,
        CanvasFeedbackMark::Important,
        CanvasFeedbackMark::NeedsRevision,
    ];
    let selected = marks.iter().copied().collect::<BTreeSet<_>>();
    ORDER
        .into_iter()
        .filter(|mark| selected.contains(mark))
        .collect()
}

fn normalized_comment(comment: &str) -> Result<String, ProjectError> {
    let trimmed = comment.trim();
    if trimmed.is_empty() {
        Err(ProjectError::Validation(
            "Canvas feedback comment must be non-empty.".to_owned(),
        ))
    } else if trimmed.len() > MAX_CANVAS_FEEDBACK_COMMENT_BYTES {
        Err(ProjectError::Validation(format!(
            "Canvas feedback comment exceeds {MAX_CANVAS_FEEDBACK_COMMENT_BYTES} bytes."
        )))
    } else {
        Ok(trimmed.to_owned())
    }
}

fn next_item_id(items: &[CanvasFeedbackItem], updated_at: &str) -> String {
    let timestamp: String = updated_at.chars().filter(char::is_ascii_digit).collect();
    let prefix = format!("item-{timestamp}-");
    let max = items
        .iter()
        .filter_map(|item| item.id.strip_prefix(&prefix)?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    format!("{prefix}{}", max.saturating_add(1))
}

fn moment_ref_for_time(
    entry: &mut CanvasFeedbackEntry,
    current_time_seconds: f64,
) -> CanvasFeedbackMomentRef {
    if let Some(moment) = entry
        .items
        .iter()
        .filter_map(|item| item.moment.as_ref())
        .find(|moment| moment.current_time_seconds.to_bits() == current_time_seconds.to_bits())
    {
        return moment.clone();
    }
    let moment = CanvasFeedbackMomentRef {
        label: format!("M{}", entry.next_moment_label),
        current_time_seconds,
    };
    entry.next_moment_label = entry.next_moment_label.saturating_add(1);
    moment
}

fn moment_label_number(label: &str) -> Result<u64, ProjectError> {
    let number = label
        .strip_prefix('M')
        .filter(|value| !value.is_empty() && !value.starts_with('0'))
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| {
            ProjectError::Validation(format!("Invalid Canvas feedback moment label: {label}"))
        })?;
    Ok(number)
}

fn normalized_playback_time(value: f64) -> Result<f64, ProjectError> {
    if !value.is_finite() || value < 0.0 {
        return Err(ProjectError::Validation(
            "Canvas video playback time must be a non-negative finite number.".to_owned(),
        ));
    }
    let rounded = (value * 1000.0).round() / 1000.0;
    Ok(if rounded.abs().to_bits() == 0 {
        0.0
    } else {
        rounded
    })
}

fn normalized_geometry(
    geometry: &CanvasFeedbackGeometry,
) -> Result<CanvasFeedbackGeometry, ProjectError> {
    let canonical_zero = |value: f64| {
        if value.abs().to_bits() == 0 {
            0.0
        } else {
            value
        }
    };
    let geometry = match geometry {
        CanvasFeedbackGeometry::Point { x, y } => CanvasFeedbackGeometry::Point {
            x: canonical_zero(*x),
            y: canonical_zero(*y),
        },
        CanvasFeedbackGeometry::Rect {
            x,
            y,
            width,
            height,
        } => CanvasFeedbackGeometry::Rect {
            x: canonical_zero(*x),
            y: canonical_zero(*y),
            width: canonical_zero(*width),
            height: canonical_zero(*height),
        },
    };
    let kind = match geometry {
        CanvasFeedbackGeometry::Point { .. } => CanvasFeedbackItemKind::Pin,
        CanvasFeedbackGeometry::Rect { .. } => CanvasFeedbackItemKind::Region,
    };
    validate_spatial_geometry(kind, &geometry)?;
    Ok(geometry)
}

fn validate_unit(value: f64, label: &str, positive: bool) -> Result<(), ProjectError> {
    if !value.is_finite()
        || !(0.0..=1.0).contains(&value)
        || (positive && value.to_bits() == 0.0_f64.to_bits())
    {
        Err(ProjectError::Validation(format!(
            "{label} must be {}.",
            if positive {
                "greater than 0 and at most 1"
            } else {
                "between 0 and 1"
            }
        )))
    } else {
        Ok(())
    }
}

fn validate_iso_timestamp(value: &str) -> Result<(), ProjectError> {
    let bytes = value.as_bytes();
    let exact_shape = bytes.len() == 24
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes.get(19) == Some(&b'.')
        && bytes.get(23) == Some(&b'Z');
    if !exact_shape || OffsetDateTime::parse(value, &Rfc3339).is_err() {
        Err(ProjectError::Validation(
            "Canvas feedback timestamp must be an ISO date-time string with milliseconds."
                .to_owned(),
        ))
    } else {
        Ok(())
    }
}

#[must_use]
pub fn canvas_feedback_rendered_project_path(project_relative_path: &str) -> String {
    format!(".debrute/reviews/rendered-feedback/{project_relative_path}.annotated.png")
}

#[must_use]
pub fn canvas_feedback_rendered_moment_project_path(
    project_relative_path: &str,
    moment_label: &str,
) -> String {
    format!(
        ".debrute/reviews/rendered-feedback/{project_relative_path}.moment-{moment_label}.annotated.png"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: &str = "2026-07-15T01:02:03.004Z";
    const T1: &str = "2026-07-15T01:02:04.005Z";

    fn file_comment(id: impl Into<String>, comment: impl Into<String>) -> CanvasFeedbackItem {
        CanvasFeedbackItem {
            id: id.into(),
            kind: CanvasFeedbackItemKind::Comment,
            scope: CanvasFeedbackScope::File,
            label: None,
            geometry: None,
            moment: None,
            comment: comment.into(),
            created_at: T0.to_owned(),
            updated_at: T0.to_owned(),
        }
    }

    fn marked_entry(path: &str) -> CanvasFeedbackEntry {
        CanvasFeedbackEntry {
            project_relative_path: path.to_owned(),
            marks: vec![CanvasFeedbackMark::Like],
            next_moment_label: 1,
            next_spatial_label: 1,
            items: Vec::new(),
            updated_at: T0.to_owned(),
        }
    }

    #[test]
    fn closed_updates_normalize_marks_moments_and_remove_empty_entries() {
        let empty = CanvasFeedbackDocument::empty(T0.to_owned()).expect("valid fixture");
        let marked = update_canvas_feedback_document(
            &empty,
            &UpdateCanvasFeedbackEntryInput::SetMarks {
                project_relative_path: "images/a.png".to_owned(),
                marks: vec![CanvasFeedbackMark::Important, CanvasFeedbackMark::Like],
            },
            T1.to_owned(),
        )
        .expect("marks should update");
        assert_eq!(
            marked.entries["images/a.png"].marks,
            vec![CanvasFeedbackMark::Like, CanvasFeedbackMark::Important]
        );

        let with_item = update_canvas_feedback_document(
            &marked,
            &UpdateCanvasFeedbackEntryInput::AddItem {
                project_relative_path: "images/a.png".to_owned(),
                item: NewCanvasFeedbackItem {
                    kind: CanvasFeedbackItemKind::Pin,
                    scope: CanvasFeedbackScope::File,
                    moment_time_seconds: None,
                    geometry: Some(CanvasFeedbackGeometry::Point { x: 0.5, y: 0.25 }),
                    comment: "  Fix this  ".to_owned(),
                },
            },
            T1.to_owned(),
        )
        .expect("item should update");
        let item = &with_item.entries["images/a.png"].items[0];
        assert_eq!(item.label, Some(1));
        assert_eq!(item.comment, "Fix this");
        assert!(item.id.starts_with("item-20260715010204005-"));
    }

    #[test]
    fn document_validation_rejects_inconsistent_and_unsupported_targets() {
        let mut document = CanvasFeedbackDocument::empty(T0.to_owned()).expect("valid fixture");
        document.entries.insert(
            "notes/readme.md".to_owned(),
            CanvasFeedbackEntry {
                project_relative_path: "notes/readme.md".to_owned(),
                marks: Vec::new(),
                next_moment_label: 1,
                next_spatial_label: 2,
                items: vec![CanvasFeedbackItem {
                    id: "one".to_owned(),
                    kind: CanvasFeedbackItemKind::Pin,
                    scope: CanvasFeedbackScope::File,
                    label: Some(1),
                    geometry: Some(CanvasFeedbackGeometry::Point { x: 0.1, y: 0.2 }),
                    moment: None,
                    comment: "comment".to_owned(),
                    created_at: T0.to_owned(),
                    updated_at: T0.to_owned(),
                }],
                updated_at: T0.to_owned(),
            },
        );
        validate_canvas_feedback_document(&document).expect("shape should be valid");
        assert!(validate_feedback_media_targets(&document).is_err());
    }

    #[test]
    fn persisted_document_normalization_matches_the_canonical_feedback_shape() {
        let input = serde_json::json!({
            "updatedAt": T0,
            "entries": {
                ".\\images\\a.png": {
                    "projectRelativePath": "./images/a.png",
                    "marks": ["important", "like", "important"],
                    "nextMomentLabel": 1,
                    "nextSpatialLabel": 1,
                    "items": [],
                    "updatedAt": T0
                },
                "empty.png": {
                    "projectRelativePath": "empty.png",
                    "marks": [],
                    "nextMomentLabel": 1,
                    "nextSpatialLabel": 1,
                    "items": [],
                    "updatedAt": T0
                }
            }
        });
        let parsed: CanvasFeedbackDocument =
            serde_json::from_value(input).expect("shape should decode");
        let normalized =
            normalize_canvas_feedback_document(parsed).expect("document should normalize");
        assert_eq!(normalized.entries.len(), 1);
        assert_eq!(
            normalized.entries["images/a.png"].marks,
            vec![CanvasFeedbackMark::Like, CanvasFeedbackMark::Important]
        );

        let null_field = serde_json::json!({
            "id": "one",
            "kind": "comment",
            "scope": "file",
            "label": null,
            "comment": "comment",
            "createdAt": T0,
            "updatedAt": T0
        });
        assert!(serde_json::from_value::<CanvasFeedbackItem>(null_field).is_err());
    }

    #[test]
    fn document_validation_enforces_entry_item_and_string_bounds() {
        let mut document = CanvasFeedbackDocument::empty(T0.to_owned()).unwrap();
        let path = "images/a.png";
        let mut entry = marked_entry(path);
        entry.items = vec![file_comment(
            "x".repeat(MAX_CANVAS_FEEDBACK_ITEM_ID_BYTES + 1),
            "comment",
        )];
        document.entries.insert(path.to_owned(), entry);
        assert!(validate_canvas_feedback_document(&document).is_err());

        let mut entry = marked_entry(path);
        entry.items = vec![file_comment(
            "one",
            "x".repeat(MAX_CANVAS_FEEDBACK_COMMENT_BYTES + 1),
        )];
        document.entries.insert(path.to_owned(), entry);
        assert!(validate_canvas_feedback_document(&document).is_err());

        let mut entries = BTreeMap::new();
        for index in 0..=MAX_CANVAS_FEEDBACK_ENTRIES {
            let path = format!("images/{index}.png");
            entries.insert(path.clone(), marked_entry(&path));
        }
        document.entries = entries;
        assert!(validate_canvas_feedback_document(&document).is_err());
    }

    #[test]
    fn persisted_feedback_document_read_is_bounded() {
        let root =
            std::env::temp_dir().join(format!("debrute-feedback-limit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".debrute/reviews")).unwrap();
        std::fs::write(
            root.join(CANVAS_FEEDBACK_PROJECT_PATH),
            vec![b'x'; MAX_CANVAS_FEEDBACK_DOCUMENT_BYTES + 1],
        )
        .unwrap();

        let Err(error) = read_canvas_feedback_state(&root, T0.to_owned()) else {
            panic!("oversized feedback document should be rejected");
        };
        assert_eq!(error.code(), "project_document_too_large");

        std::fs::remove_dir_all(root).unwrap();
    }
}
