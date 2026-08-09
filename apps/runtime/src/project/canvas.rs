use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Deserializer};

use super::{
    CanvasManualLayout, CanvasMediaKind, CanvasNodeState, CanvasState, CanvasTextViewportState,
    CanvasVideoPlaybackState, ProjectDirectoryPath, ProjectError, ProjectTreeEntry,
    assert_project_tree_visible_path, project_content_type, project_media_kind_from_content_type,
    project_text_file_type_for_path, rewrite_project_path,
};

pub const CANVAS_VIDEO_TIME_MAX_MS: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Default)]
pub enum CanvasPatchField<T> {
    #[default]
    Unchanged,
    Delete,
    Set(T),
}

impl<'de, T> Deserialize<'de> for CanvasPatchField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(|value| value.map_or(Self::Delete, Self::Set))
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasNodeStateUpdate {
    pub project_relative_path: String,
    #[serde(default)]
    pub manual_layout: CanvasPatchField<CanvasManualLayout>,
    #[serde(default)]
    pub video_playback: CanvasPatchField<CanvasVideoPlaybackState>,
    #[serde(default)]
    pub text_viewport: CanvasPatchField<CanvasTextViewportState>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasStatePatch {
    #[serde(default)]
    pub expanded_directories: Option<Vec<String>>,
    #[serde(default)]
    pub node_state_updates: Option<Vec<CanvasNodeStateUpdate>>,
    #[serde(default)]
    pub occlusion_order: Option<Vec<String>>,
}

/// Validates sparse Canvas state without deriving presentation geometry.
///
/// # Errors
/// Returns a validation error for malformed paths, geometry, media state, or ordering.
pub(super) fn validate_canvas_state(state: &CanvasState) -> Result<(), ProjectError> {
    let mut expanded = HashSet::new();
    for path in &state.expanded_directories {
        if path.is_empty() {
            return Err(ProjectError::Validation(
                "Canvas expandedDirectories must not contain the Project root.".to_owned(),
            ));
        }
        validate_canvas_path(path)?;
        if !expanded.insert(path) {
            return Err(ProjectError::Validation(format!(
                "Canvas expandedDirectories contains a duplicate path: {path}"
            )));
        }
    }
    for (path, node) in &state.node_states {
        validate_canvas_path(path)?;
        validate_node_state(path, node)?;
    }
    let mut occlusion = HashSet::new();
    for path in &state.occlusion_order {
        validate_canvas_path(path)?;
        if !occlusion.insert(path) {
            return Err(ProjectError::Validation(format!(
                "Canvas occlusionOrder contains a duplicate path: {path}"
            )));
        }
    }
    Ok(())
}

/// Applies one generic Canvas state patch.
///
/// # Errors
/// Returns a validation error when the patch or resulting state is malformed.
pub(super) fn apply_canvas_state_patch(
    state: &CanvasState,
    patch: &CanvasStatePatch,
) -> Result<CanvasState, ProjectError> {
    if patch
        .node_state_updates
        .as_ref()
        .is_some_and(|updates| updates.iter().any(CanvasNodeStateUpdate::is_empty))
        || (patch.expanded_directories.is_none()
            && patch.occlusion_order.is_none()
            && patch.node_state_updates.as_ref().is_none_or(Vec::is_empty))
    {
        return Err(ProjectError::Validation(
            "Canvas patch must contain an explicit state change.".to_owned(),
        ));
    }
    let mut next = state.clone();
    if let Some(expanded) = &patch.expanded_directories {
        next.expanded_directories.clone_from(expanded);
    }
    if let Some(updates) = &patch.node_state_updates {
        let mut seen = HashSet::new();
        for update in updates {
            validate_canvas_path(&update.project_relative_path)?;
            if !seen.insert(update.project_relative_path.as_str()) {
                return Err(ProjectError::Validation(format!(
                    "Canvas nodeStateUpdates contains a duplicate path: {}",
                    update.project_relative_path
                )));
            }
            let node = next
                .node_states
                .entry(update.project_relative_path.clone())
                .or_default();
            apply_patch_field(&mut node.manual_layout, &update.manual_layout);
            apply_patch_field(&mut node.video_playback, &update.video_playback);
            apply_patch_field(&mut node.text_viewport, &update.text_viewport);
        }
    }
    if let Some(order) = &patch.occlusion_order {
        next.occlusion_order.clone_from(order);
    }
    validate_canvas_state(&next)?;
    Ok(normalize_canvas_state(next))
}

impl CanvasNodeStateUpdate {
    fn is_empty(&self) -> bool {
        self.manual_layout == CanvasPatchField::Unchanged
            && self.video_playback == CanvasPatchField::Unchanged
            && self.text_viewport == CanvasPatchField::Unchanged
    }
}

#[must_use]
fn normalize_canvas_state(mut state: CanvasState) -> CanvasState {
    state.expanded_directories.sort();
    state.expanded_directories.dedup();
    for node in state.node_states.values_mut() {
        if node
            .video_playback
            .as_ref()
            .is_some_and(|playback| playback.current_time_ms == 0)
        {
            node.video_playback = None;
        }
        if node
            .text_viewport
            .as_ref()
            .is_some_and(|viewport| viewport.scroll_top == 0.0 && viewport.scroll_left == 0.0)
        {
            node.text_viewport = None;
        }
    }
    state
        .node_states
        .retain(|_, node| !canvas_node_state_is_empty(node));
    let mut seen = HashSet::new();
    state
        .occlusion_order
        .retain(|path| seen.insert(path.clone()));
    state
}

#[must_use]
pub(super) fn visible_canvas_entries(
    entries: &[ProjectTreeEntry],
    state: &CanvasState,
) -> Vec<ProjectTreeEntry> {
    let expanded = state
        .expanded_directories
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    entries
        .iter()
        .filter(|entry| {
            canvas_path_ancestors_are_expanded(&entry.project_relative_path, |ancestor| {
                expanded.contains(ancestor)
            })
        })
        .cloned()
        .collect()
}

#[must_use]
pub(super) fn canvas_path_is_visible(path: &str, state: &CanvasState) -> bool {
    canvas_path_ancestors_are_expanded(path, |ancestor| {
        state
            .expanded_directories
            .binary_search_by(|expanded| expanded.as_str().cmp(ancestor))
            .is_ok()
    })
}

#[must_use]
pub(super) fn rewrite_canvas_state_path(
    state: &CanvasState,
    source: &str,
    target: &str,
) -> CanvasState {
    let rewrite = |path: &str| rewrite_project_path(path, source, target);
    let mut next = CanvasState {
        expanded_directories: state
            .expanded_directories
            .iter()
            .map(|path| rewrite(path))
            .collect(),
        node_states: BTreeMap::new(),
        occlusion_order: state
            .occlusion_order
            .iter()
            .map(|path| rewrite(path))
            .collect(),
    };
    for (path, node) in &state.node_states {
        next.node_states.insert(rewrite(path), node.clone());
    }
    normalize_canvas_state(next)
}

#[must_use]
pub(super) fn prune_canvas_state_path(state: &CanvasState, removed: &str) -> CanvasState {
    let retained = |path: &str| path != removed && !path.starts_with(&format!("{removed}/"));
    let mut next = state.clone();
    next.expanded_directories.retain(|path| retained(path));
    next.node_states.retain(|path, _| retained(path));
    next.occlusion_order.retain(|path| retained(path));
    normalize_canvas_state(next)
}

#[must_use]
pub(super) fn canvas_media_kind_from_path(path: &str) -> CanvasMediaKind {
    let media_kind = project_media_kind_from_content_type(project_content_type(path));
    if media_kind != CanvasMediaKind::Unknown {
        return media_kind;
    }
    project_text_file_type_for_path(path, None)
        .map_or(CanvasMediaKind::Unknown, |_| CanvasMediaKind::Text)
}

fn apply_patch_field<T: Clone>(target: &mut Option<T>, patch: &CanvasPatchField<T>) {
    match patch {
        CanvasPatchField::Unchanged => {}
        CanvasPatchField::Delete => *target = None,
        CanvasPatchField::Set(value) => *target = Some(value.clone()),
    }
}

fn validate_canvas_path(path: &str) -> Result<(), ProjectError> {
    if path.is_empty() {
        return Ok(());
    }
    let normalized = ProjectDirectoryPath::parse(path)?;
    if normalized != path {
        return Err(ProjectError::Validation(format!(
            "Canvas path is not normalized: {path}"
        )));
    }
    assert_project_tree_visible_path(path).map(|_| ())
}

fn validate_node_state(path: &str, node: &CanvasNodeState) -> Result<(), ProjectError> {
    if let Some(layout) = &node.manual_layout
        && (!layout.x.is_finite()
            || !layout.y.is_finite()
            || !layout.width.is_finite()
            || layout.width <= 0.0
            || !layout.height.is_finite()
            || layout.height <= 0.0)
    {
        return Err(ProjectError::Validation(format!(
            "Invalid Canvas manual layout: {path}"
        )));
    }
    if node
        .video_playback
        .as_ref()
        .is_some_and(|playback| playback.current_time_ms > CANVAS_VIDEO_TIME_MAX_MS)
        || node.text_viewport.as_ref().is_some_and(|viewport| {
            !viewport.scroll_top.is_finite()
                || viewport.scroll_top < 0.0
                || !viewport.scroll_left.is_finite()
                || viewport.scroll_left < 0.0
        })
    {
        return Err(ProjectError::Validation(format!(
            "Invalid Canvas node state: {path}"
        )));
    }
    Ok(())
}

fn canvas_node_state_is_empty(node: &CanvasNodeState) -> bool {
    node.manual_layout.is_none() && node.video_playback.is_none() && node.text_viewport.is_none()
}

fn canvas_path_ancestors_are_expanded(path: &str, mut contains: impl FnMut(&str) -> bool) -> bool {
    path.match_indices('/')
        .all(|(separator, _)| contains(&path[..separator]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{ProjectDirectoryState, ProjectPathKind};

    #[test]
    fn default_canvas_keeps_root_structural() {
        assert!(CanvasState::default().expanded_directories.is_empty());
    }

    #[test]
    fn structural_root_keeps_top_level_resources_visible() {
        let entries = vec![
            tree_entry("", ProjectPathKind::Directory),
            tree_entry("file.txt", ProjectPathKind::File),
        ];
        let state = CanvasState::default();
        assert_eq!(
            visible_canvas_entries(&entries, &state)
                .into_iter()
                .map(|entry| entry.project_relative_path)
                .collect::<Vec<_>>(),
            vec!["", "file.txt"]
        );
    }

    #[test]
    fn generic_patch_distinguishes_omitted_null_and_value() {
        let state = CanvasState::default();
        let with_layout = apply_canvas_state_patch(
            &state,
            &serde_json::from_value(serde_json::json!({
                "nodeStateUpdates": [{
                    "projectRelativePath": "",
                    "manualLayout": {"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0}
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(with_layout.node_states[""].manual_layout.is_some());

        let deleted = apply_canvas_state_patch(
            &with_layout,
            &serde_json::from_value(serde_json::json!({
                "nodeStateUpdates": [{"projectRelativePath": "", "manualLayout": null}]
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(!deleted.node_states.contains_key(""));
    }

    #[test]
    fn generic_patch_rejects_duplicate_ordered_set_entries() {
        let state = CanvasState::default();
        let duplicate_disclosure = serde_json::from_value(serde_json::json!({
            "expandedDirectories": ["assets", "assets"]
        }))
        .unwrap();
        assert_eq!(
            apply_canvas_state_patch(&state, &duplicate_disclosure)
                .unwrap_err()
                .to_string(),
            "Canvas expandedDirectories contains a duplicate path: assets"
        );

        let duplicate_occlusion = serde_json::from_value(serde_json::json!({
            "occlusionOrder": ["cover.png", "cover.png"]
        }))
        .unwrap();
        assert_eq!(
            apply_canvas_state_patch(&state, &duplicate_occlusion)
                .unwrap_err()
                .to_string(),
            "Canvas occlusionOrder contains a duplicate path: cover.png"
        );
    }

    #[test]
    fn generic_patch_requires_an_explicit_change() {
        let state = CanvasState::default();
        for value in [
            serde_json::json!({}),
            serde_json::json!({"nodeStateUpdates": []}),
            serde_json::json!({
                "nodeStateUpdates": [{"projectRelativePath": "note.txt"}]
            }),
        ] {
            let patch = serde_json::from_value(value).unwrap();
            assert_eq!(
                apply_canvas_state_patch(&state, &patch)
                    .unwrap_err()
                    .to_string(),
                "Canvas patch must contain an explicit state change."
            );
        }
    }

    #[test]
    fn generic_patch_accepts_explicit_empty_collections() {
        let state = CanvasState {
            expanded_directories: vec!["assets".to_owned()],
            node_states: BTreeMap::new(),
            occlusion_order: vec!["cover.png".to_owned()],
        };
        let patch = serde_json::from_value(serde_json::json!({
            "expandedDirectories": [],
            "occlusionOrder": []
        }))
        .unwrap();
        assert_eq!(
            apply_canvas_state_patch(&state, &patch).unwrap(),
            CanvasState::default()
        );
    }

    fn tree_entry(path: &str, kind: ProjectPathKind) -> ProjectTreeEntry {
        ProjectTreeEntry {
            project_relative_path: path.to_owned(),
            kind,
            size_bytes: (kind == ProjectPathKind::File).then_some(1),
            directory_state: (kind == ProjectPathKind::Directory)
                .then_some(ProjectDirectoryState::Loaded),
            directory_error: None,
        }
    }
}
