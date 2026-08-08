//! Revisioned Canvas feedback document semantics.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{
    ProjectCapabilityFs, ProjectDirectoryPath, ProjectError, ProjectRelativePath,
    project_content_hash,
};

mod artifacts;

pub use artifacts::*;

pub const CANVAS_FEEDBACK_PROJECT_PATH: &str = ".debrute/feedback/feedback.json";
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
    Node,
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
    pub id: String,
    pub created_at: String,
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
pub enum UpdateCanvasFeedbackInput {
    SetMark {
        #[serde(rename = "projectRelativePaths")]
        project_relative_paths: Vec<String>,
        mark: CanvasFeedbackMark,
        selected: bool,
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

impl UpdateCanvasFeedbackInput {
    #[must_use]
    pub fn target_project_relative_paths(&self) -> Vec<&str> {
        match self {
            Self::SetMark {
                project_relative_paths,
                ..
            } => project_relative_paths.iter().map(String::as_str).collect(),
            Self::AddItem {
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
            } => vec![project_relative_path],
        }
    }

    #[must_use]
    pub fn requires_file_target(&self) -> bool {
        match self {
            Self::AddItem { item, .. } => {
                item.scope == CanvasFeedbackScope::Moment
                    || matches!(
                        item.kind,
                        CanvasFeedbackItemKind::Pin | CanvasFeedbackItemKind::Region
                    )
            }
            Self::UpdateItem {
                geometry: Some(_), ..
            } => true,
            Self::SetMark { .. }
            | Self::UpdateItem { geometry: None, .. }
            | Self::DeleteItem { .. } => false,
        }
    }

    #[must_use]
    pub fn rendered_artifact_source_path(&self) -> Option<&str> {
        match self {
            Self::AddItem {
                project_relative_path,
                item,
            } if item.scope == CanvasFeedbackScope::Moment
                || matches!(
                    item.kind,
                    CanvasFeedbackItemKind::Pin | CanvasFeedbackItemKind::Region
                ) =>
            {
                Some(project_relative_path)
            }
            Self::UpdateItem {
                project_relative_path,
                geometry: Some(_),
                ..
            }
            | Self::DeleteItem {
                project_relative_path,
                ..
            } => Some(project_relative_path),
            _ => None,
        }
    }

    #[must_use]
    pub fn affects_rendered_artifact(&self) -> bool {
        match self {
            Self::SetMark { .. } => false,
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
    let document_path = ProjectRelativePath::parse(CANVAS_FEEDBACK_PROJECT_PATH)
        .expect("Canvas feedback document path must remain valid");
    let content = match project.read_limited(&document_path, MAX_CANVAS_FEEDBACK_DOCUMENT_BYTES) {
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
    validate_canvas_feedback_document(&document)?;
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
    let document_path = ProjectRelativePath::parse(CANVAS_FEEDBACK_PROJECT_PATH)
        .expect("Canvas feedback document path must remain valid");
    let current_hash =
        match project.read_limited(&document_path, MAX_CANVAS_FEEDBACK_DOCUMENT_BYTES) {
            Ok(content) => Some(project_content_hash(content)),
            Err(ProjectError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
    if current_hash.as_deref() != expected_hash {
        return Err(ProjectError::service(
            "document_transaction_conflict",
            "Canvas feedback document changed on disk before transaction commit.",
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
    project.atomic_write(&document_path, content.as_bytes())
}

// The closed operation interpreter stays together so every variant shares one validation tail.
pub(crate) fn update_canvas_feedback_document(
    document: &CanvasFeedbackDocument,
    input: &UpdateCanvasFeedbackInput,
    updated_at: String,
) -> Result<CanvasFeedbackDocument, ProjectError> {
    validate_canvas_feedback_document(document)?;
    validate_iso_timestamp(&updated_at)?;
    if let UpdateCanvasFeedbackInput::SetMark {
        project_relative_paths,
        mark,
        selected,
    } = input
    {
        return update_canvas_feedback_marks(
            document,
            project_relative_paths,
            *mark,
            *selected,
            updated_at,
        );
    }
    let project_relative_path = normalize_feedback_path(
        input
            .target_project_relative_paths()
            .into_iter()
            .next()
            .expect("non-Mark Canvas feedback operations have exactly one target"),
    )?;
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
        UpdateCanvasFeedbackInput::SetMark { .. } => {
            unreachable!("set-mark returns before the single-entry interpreter")
        }
        UpdateCanvasFeedbackInput::AddItem { item, .. } => {
            let id = item.id.trim().to_owned();
            if id.is_empty() || id != item.id || id.len() > MAX_CANVAS_FEEDBACK_ITEM_ID_BYTES {
                return Err(ProjectError::Validation(
                    "Canvas feedback item id must be non-empty, trimmed, and within the byte limit."
                        .to_owned(),
                ));
            }
            if document
                .entries
                .values()
                .flat_map(|existing_entry| &existing_entry.items)
                .any(|existing| existing.id == id)
            {
                return Err(ProjectError::Validation(format!(
                    "Canvas feedback item id already exists: {id}"
                )));
            }
            validate_iso_timestamp(&item.created_at)?;
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
                created_at: item.created_at.clone(),
                updated_at: updated_at.clone(),
            };
            if item.scope == CanvasFeedbackScope::Moment {
                let time =
                    normalized_playback_time(item.moment_time_seconds.ok_or_else(|| {
                        ProjectError::Validation(
                            "Canvas feedback moment item requires momentTimeSeconds.".to_owned(),
                        )
                    })?)?;
                next_item.moment = Some(moment_ref_for_time(&mut entry, time)?);
            } else if item.moment_time_seconds.is_some() {
                return Err(ProjectError::Validation(
                    "Canvas feedback node item cannot include momentTimeSeconds.".to_owned(),
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
            entry.items.sort_by(|left, right| {
                left.created_at
                    .cmp(&right.created_at)
                    .then_with(|| left.id.cmp(&right.id))
            });
        }
        UpdateCanvasFeedbackInput::UpdateItem {
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
        UpdateCanvasFeedbackInput::DeleteItem { item_id, .. } => {
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

fn update_canvas_feedback_marks(
    document: &CanvasFeedbackDocument,
    project_relative_paths: &[String],
    mark: CanvasFeedbackMark,
    selected: bool,
    updated_at: String,
) -> Result<CanvasFeedbackDocument, ProjectError> {
    if project_relative_paths.is_empty() {
        return Err(ProjectError::Validation(
            "Canvas feedback set-mark requires at least one Project Path.".to_owned(),
        ));
    }
    let mut normalized_paths = BTreeSet::new();
    for path in project_relative_paths {
        let normalized = normalize_feedback_path(path)?;
        if !normalized_paths.insert(normalized.clone()) {
            return Err(ProjectError::Validation(format!(
                "Canvas feedback set-mark paths must be unique after normalization: {normalized}"
            )));
        }
    }

    let mut next = document.clone();
    let mut changed = false;
    for project_relative_path in normalized_paths {
        let existing = next.entries.remove(&project_relative_path);
        let mut entry = existing.unwrap_or(CanvasFeedbackEntry {
            project_relative_path: project_relative_path.clone(),
            marks: Vec::new(),
            next_moment_label: 1,
            next_spatial_label: 1,
            items: Vec::new(),
            updated_at: updated_at.clone(),
        });
        let already_selected = entry.marks.contains(&mark);
        if already_selected == selected {
            if !entry.marks.is_empty() || !entry.items.is_empty() {
                next.entries.insert(project_relative_path, entry);
            }
            continue;
        }
        changed = true;
        if selected {
            entry.marks.push(mark);
            entry.marks = normalized_marks(&entry.marks);
        } else {
            entry.marks.retain(|existing_mark| *existing_mark != mark);
        }
        entry.updated_at.clone_from(&updated_at);
        if !entry.marks.is_empty() || !entry.items.is_empty() {
            next.entries.insert(project_relative_path, entry);
        }
    }

    if !changed {
        return Ok(document.clone());
    }
    next.updated_at = updated_at;
    validate_canvas_feedback_document(&next)?;
    Ok(next)
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
    let mut document_item_ids = BTreeSet::new();
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
        for item in &entry.items {
            if !document_item_ids.insert(item.id.clone()) {
                return Err(ProjectError::Validation(
                    "Canvas feedback item ids must be unique across the document.".to_owned(),
                ));
            }
        }
        if entry.marks.is_empty() && entry.items.is_empty() {
            return Err(ProjectError::Validation(
                "Canvas feedback document cannot retain an empty entry.".to_owned(),
            ));
        }
    }
    Ok(())
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
    validate_iso_timestamp(&item.created_at)?;
    validate_iso_timestamp(&item.updated_at)?;
    match (item.kind, item.scope) {
        (CanvasFeedbackItemKind::Comment, CanvasFeedbackScope::Node) => {
            if item.label.is_some() || item.geometry.is_some() || item.moment.is_some() {
                return Err(ProjectError::Validation(
                    "Canvas feedback node comment contains spatial or moment fields.".to_owned(),
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

pub(crate) fn validate_spatial_geometry(
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

pub(crate) fn normalize_feedback_path(path: &str) -> Result<String, ProjectError> {
    let normalized = ProjectDirectoryPath::parse(path)?;
    if normalized.len() > MAX_CANVAS_FEEDBACK_PATH_BYTES {
        return Err(ProjectError::Validation(format!(
            "Canvas feedback path exceeds {MAX_CANVAS_FEEDBACK_PATH_BYTES} bytes."
        )));
    }
    if normalized == ".debrute" || normalized.starts_with(".debrute/") {
        return Err(ProjectError::Validation(
            "Canvas feedback cannot target the .debrute namespace.".to_owned(),
        ));
    }
    Ok(normalized.into_string())
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
    } else if comment.len() > MAX_CANVAS_FEEDBACK_COMMENT_BYTES {
        Err(ProjectError::Validation(format!(
            "Canvas feedback comment exceeds {MAX_CANVAS_FEEDBACK_COMMENT_BYTES} bytes."
        )))
    } else {
        Ok(comment.to_owned())
    }
}

fn moment_ref_for_time(
    entry: &mut CanvasFeedbackEntry,
    current_time_seconds: f64,
) -> Result<CanvasFeedbackMomentRef, ProjectError> {
    if let Some(moment) = entry
        .items
        .iter()
        .filter_map(|item| item.moment.as_ref())
        .find(|moment| moment.current_time_seconds.to_bits() == current_time_seconds.to_bits())
    {
        return Ok(moment.clone());
    }
    let next_moment_label = entry.next_moment_label.checked_add(1).ok_or_else(|| {
        ProjectError::Validation("Canvas feedback moment label is exhausted.".to_owned())
    })?;
    let moment = CanvasFeedbackMomentRef {
        label: format!("M{}", entry.next_moment_label),
        current_time_seconds,
    };
    entry.next_moment_label = next_moment_label;
    Ok(moment)
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

pub(crate) fn normalized_geometry(
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
    format!(".debrute/feedback/artifacts/{project_relative_path}.annotated.png")
}

#[must_use]
pub fn canvas_feedback_rendered_moment_project_path(
    project_relative_path: &str,
    moment_label: &str,
) -> String {
    format!(
        ".debrute/feedback/artifacts/{project_relative_path}.moment-{moment_label}.annotated.png"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: &str = "2026-07-15T01:02:03.004Z";
    const T1: &str = "2026-07-15T01:02:04.005Z";
    const T2: &str = "2026-07-15T01:02:05.006Z";

    fn node_comment(id: impl Into<String>, comment: impl Into<String>) -> CanvasFeedbackItem {
        CanvasFeedbackItem {
            id: id.into(),
            kind: CanvasFeedbackItemKind::Comment,
            scope: CanvasFeedbackScope::Node,
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
    fn set_mark_updates_only_changed_entries_removes_empty_entries_and_preserves_no_ops() {
        let mut document = CanvasFeedbackDocument::empty(T0.to_owned()).expect("valid fixture");
        document.entries.insert(
            "images/already.png".to_owned(),
            marked_entry("images/already.png"),
        );
        document.entries.insert(
            "images/mixed.png".to_owned(),
            CanvasFeedbackEntry {
                project_relative_path: "images/mixed.png".to_owned(),
                marks: vec![CanvasFeedbackMark::Important],
                next_moment_label: 1,
                next_spatial_label: 1,
                items: Vec::new(),
                updated_at: T0.to_owned(),
            },
        );

        let selected = update_canvas_feedback_document(
            &document,
            &UpdateCanvasFeedbackInput::SetMark {
                project_relative_paths: vec![
                    "images/already.png".to_owned(),
                    "images/mixed.png".to_owned(),
                    "images/new.png".to_owned(),
                ],
                mark: CanvasFeedbackMark::Like,
                selected: true,
            },
            T1.to_owned(),
        )
        .expect("the batch should update");

        assert_eq!(selected.entries["images/already.png"].updated_at, T0);
        assert_eq!(
            selected.entries["images/mixed.png"].marks,
            vec![CanvasFeedbackMark::Like, CanvasFeedbackMark::Important]
        );
        assert_eq!(selected.entries["images/mixed.png"].updated_at, T1);
        assert_eq!(
            selected.entries["images/new.png"].marks,
            vec![CanvasFeedbackMark::Like]
        );

        let cleared = update_canvas_feedback_document(
            &selected,
            &UpdateCanvasFeedbackInput::SetMark {
                project_relative_paths: vec![
                    "images/already.png".to_owned(),
                    "images/mixed.png".to_owned(),
                    "images/new.png".to_owned(),
                ],
                mark: CanvasFeedbackMark::Like,
                selected: false,
            },
            T2.to_owned(),
        )
        .expect("the batch should clear");

        assert!(!cleared.entries.contains_key("images/already.png"));
        assert!(!cleared.entries.contains_key("images/new.png"));
        assert_eq!(
            cleared.entries["images/mixed.png"].marks,
            vec![CanvasFeedbackMark::Important]
        );

        let no_op = update_canvas_feedback_document(
            &cleared,
            &UpdateCanvasFeedbackInput::SetMark {
                project_relative_paths: vec!["images/mixed.png".to_owned()],
                mark: CanvasFeedbackMark::Important,
                selected: true,
            },
            "2026-07-15T01:02:06.007Z".to_owned(),
        )
        .expect("an already-satisfied batch should succeed");
        assert_eq!(no_op, cleared);
    }

    #[test]
    fn moment_label_exhaustion_rejects_the_update_without_wrapping() {
        let mut document = CanvasFeedbackDocument::empty(T0.to_owned()).expect("valid fixture");
        let mut entry = marked_entry("video/clip.mp4");
        entry.next_moment_label = u64::MAX;
        document
            .entries
            .insert(entry.project_relative_path.clone(), entry);

        let error = update_canvas_feedback_document(
            &document,
            &UpdateCanvasFeedbackInput::AddItem {
                project_relative_path: "video/clip.mp4".to_owned(),
                item: NewCanvasFeedbackItem {
                    id: "final-moment".to_owned(),
                    created_at: T0.to_owned(),
                    kind: CanvasFeedbackItemKind::Comment,
                    scope: CanvasFeedbackScope::Moment,
                    moment_time_seconds: Some(1.0),
                    geometry: None,
                    comment: "exhausted".to_owned(),
                },
            },
            T1.to_owned(),
        )
        .expect_err("an exhausted persisted label must reject the update");

        assert_eq!(error.code(), "project_invalid");
        assert!(error.to_string().contains("moment label is exhausted"));
        assert_eq!(
            document.entries["video/clip.mp4"].next_moment_label,
            u64::MAX
        );
    }

    #[test]
    fn closed_updates_normalize_marks_moments_and_remove_empty_entries() {
        let empty = CanvasFeedbackDocument::empty(T0.to_owned()).expect("valid fixture");
        let marked = update_canvas_feedback_document(
            &empty,
            &UpdateCanvasFeedbackInput::SetMark {
                project_relative_paths: vec!["images/a.png".to_owned()],
                mark: CanvasFeedbackMark::Important,
                selected: true,
            },
            T1.to_owned(),
        )
        .expect("marks should update");
        let marked = update_canvas_feedback_document(
            &marked,
            &UpdateCanvasFeedbackInput::SetMark {
                project_relative_paths: vec!["images/a.png".to_owned()],
                mark: CanvasFeedbackMark::Like,
                selected: true,
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
            &UpdateCanvasFeedbackInput::AddItem {
                project_relative_path: "images/a.png".to_owned(),
                item: NewCanvasFeedbackItem {
                    id: "feedback-a".to_owned(),
                    created_at: T0.to_owned(),
                    kind: CanvasFeedbackItemKind::Pin,
                    scope: CanvasFeedbackScope::Node,
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
        assert_eq!(item.comment, "  Fix this  ");
        assert_eq!(item.id, "feedback-a");
        assert_eq!(item.created_at, T0);
    }

    #[test]
    fn add_item_persists_user_creation_order_instead_of_mutation_arrival_order() {
        let empty = CanvasFeedbackDocument::empty(T0.to_owned()).expect("valid fixture");
        let later_created = update_canvas_feedback_document(
            &empty,
            &UpdateCanvasFeedbackInput::AddItem {
                project_relative_path: "images/a.png".to_owned(),
                item: NewCanvasFeedbackItem {
                    id: "feedback-later".to_owned(),
                    created_at: T1.to_owned(),
                    kind: CanvasFeedbackItemKind::Comment,
                    scope: CanvasFeedbackScope::Node,
                    moment_time_seconds: None,
                    geometry: None,
                    comment: "Later".to_owned(),
                },
            },
            T1.to_owned(),
        )
        .expect("later item should update");
        let reordered = update_canvas_feedback_document(
            &later_created,
            &UpdateCanvasFeedbackInput::AddItem {
                project_relative_path: "images/a.png".to_owned(),
                item: NewCanvasFeedbackItem {
                    id: "feedback-earlier".to_owned(),
                    created_at: T0.to_owned(),
                    kind: CanvasFeedbackItemKind::Comment,
                    scope: CanvasFeedbackScope::Node,
                    moment_time_seconds: None,
                    geometry: None,
                    comment: "Earlier".to_owned(),
                },
            },
            T1.to_owned(),
        )
        .expect("earlier item should update");

        assert_eq!(
            reordered.entries["images/a.png"]
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["feedback-earlier", "feedback-later"]
        );
    }

    #[test]
    fn persisted_document_rejects_noncanonical_paths_and_repairable_values() {
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
        assert!(validate_canvas_feedback_document(&parsed).is_err());

        let null_field = serde_json::json!({
            "id": "one",
            "kind": "comment",
            "scope": "node",
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
        entry.items = vec![node_comment(
            "x".repeat(MAX_CANVAS_FEEDBACK_ITEM_ID_BYTES + 1),
            "comment",
        )];
        document.entries.insert(path.to_owned(), entry);
        assert!(validate_canvas_feedback_document(&document).is_err());

        let mut entry = marked_entry(path);
        entry.items = vec![node_comment(
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
        std::fs::create_dir_all(root.join(".debrute/feedback")).unwrap();
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
