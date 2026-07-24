use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
};

use super::{
    CanvasDocument, CanvasMediaKind, CanvasNodeAvailability, CanvasNodeElement, CanvasNodeKind,
    CanvasPreferences, CanvasProjection, CanvasStructureEdgeProjection, CanvasTextViewportState,
    CanvasVideoPlaybackState, ProjectDiagnostic, ProjectError, ProjectedCanvasNode,
    assert_project_tree_visible_path, project_text_file_type_for_path,
};

const HORIZONTAL_TREE_GAP: f64 = 100.0;
const VERTICAL_GAP: f64 = 80.0;
const HORIZONTAL_ROW_GAP: f64 = VERTICAL_GAP;

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasLayoutSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasResolvedLayout {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasDesiredNode {
    pub project_relative_path: String,
    pub node_kind: CanvasNodeKind,
    pub media_kind: Option<CanvasMediaKind>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasDesiredLayoutRow {
    pub parent_project_relative_path: String,
    pub member_project_relative_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasNodeLayoutUpdate {
    pub project_relative_path: String,
    pub x: f64,
    pub y: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasVideoPlaybackUpdate {
    pub project_relative_path: String,
    pub current_time_seconds: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasTextViewportUpdate {
    pub project_relative_path: String,
    pub scroll_top: f64,
    pub scroll_left: f64,
}

/// Validates a closed Canvas identifier.
///
/// # Errors
/// Returns a validation error when the identifier is outside the Canvas grammar.
pub fn validate_canvas_id(id: &str) -> Result<(), ProjectError> {
    let mut bytes = id.bytes();
    let Some(first) = bytes.next() else {
        return Err(ProjectError::Validation(format!(
            "Invalid canvas document id: {id}"
        )));
    };
    if !first.is_ascii_alphanumeric()
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(ProjectError::Validation(format!(
            "Invalid canvas document id: {id}"
        )));
    }
    Ok(())
}

/// Trims and validates a user-facing Canvas name.
///
/// # Errors
/// Returns a validation error when the name is empty or too long.
pub fn normalize_canvas_name(name: &str) -> Result<String, ProjectError> {
    let normalized = name.trim();
    if normalized.is_empty() {
        return Err(ProjectError::Validation(
            "Canvas document name must be a non-empty string.".to_owned(),
        ));
    }
    Ok(normalized.to_owned())
}

/// Creates an empty valid Canvas document.
///
/// # Errors
/// Returns a validation error when `id` is invalid.
pub fn create_canvas_document(id: &str) -> Result<CanvasDocument, ProjectError> {
    validate_canvas_id(id)?;
    Ok(CanvasDocument {
        id: id.to_owned(),
        name: id.to_owned(),
        node_elements: Vec::new(),
        annotations: Vec::new(),
        preferences: CanvasPreferences {
            show_diagnostics: true,
        },
    })
}

/// Validates a persisted Canvas document and its node identities.
///
/// # Errors
/// Returns a validation error for malformed or duplicate node state.
pub fn validate_canvas_document(canvas: &CanvasDocument) -> Result<(), ProjectError> {
    validate_canvas_id(&canvas.id)?;
    if canvas.name.is_empty() || canvas.name != canvas.name.trim() {
        return Err(ProjectError::Validation(format!(
            "Invalid canvas document: {}",
            canvas.id
        )));
    }
    let mut node_paths = HashSet::new();
    for node in &canvas.node_elements {
        if node.project_relative_path.is_empty() {
            if node.node_kind != CanvasNodeKind::Directory || node.media_kind.is_some() {
                return Err(ProjectError::Validation(format!(
                    "Invalid Canvas root node: {}",
                    canvas.id
                )));
            }
        } else {
            assert_project_tree_visible_path(&node.project_relative_path)?;
        }
        if ![node.x, node.y, node.width, node.height]
            .iter()
            .all(|value| value.is_finite())
            || node
                .layout_mode
                .as_deref()
                .is_some_and(|mode| mode != "manual")
            || node.video_playback.as_ref().is_some_and(|playback| {
                node.node_kind != CanvasNodeKind::File
                    || node.media_kind != Some(CanvasMediaKind::Video)
                    || !playback.current_time_seconds.is_finite()
                    || playback.current_time_seconds < 0.0
            })
            || node.text_viewport.as_ref().is_some_and(|viewport| {
                node.node_kind != CanvasNodeKind::File
                    || node.media_kind != Some(CanvasMediaKind::Text)
                    || !viewport.scroll_top.is_finite()
                    || viewport.scroll_top < 0.0
                    || !viewport.scroll_left.is_finite()
                    || viewport.scroll_left < 0.0
            })
        {
            return Err(ProjectError::Validation(format!(
                "Invalid canvas document: {}",
                canvas.id
            )));
        }
        if !node_paths.insert(node.project_relative_path.as_str()) {
            return Err(ProjectError::Validation(format!(
                "Canvas document contains a duplicate Project path: {}",
                node.project_relative_path
            )));
        }
    }
    Ok(())
}

pub fn project_canvas(
    canvas: &CanvasDocument,
    diagnostics: Vec<ProjectDiagnostic>,
    mut availability: impl FnMut(&CanvasNodeElement) -> CanvasNodeAvailability,
) -> CanvasProjection {
    let mut elements = canvas.node_elements.clone();
    elements.sort_by(compare_node_z);
    let existing: HashSet<_> = elements
        .iter()
        .map(|node| node.project_relative_path.as_str())
        .collect();
    let edges = elements
        .iter()
        .filter_map(|node| {
            let parent = canvas_parent_path(&node.project_relative_path)?;
            existing
                .contains(parent.as_str())
                .then(|| CanvasStructureEdgeProjection {
                    id: format!("{parent}--{}", node.project_relative_path),
                    source_project_relative_path: parent,
                    target_project_relative_path: node.project_relative_path.clone(),
                })
        })
        .collect();
    CanvasProjection {
        canvas_id: canvas.id.clone(),
        nodes: elements
            .into_iter()
            .map(|node| ProjectedCanvasNode {
                availability: availability(&node),
                node,
                video_presentation: None,
            })
            .collect(),
        edges,
        diagnostics,
    }
}

/// Reprojects a Canvas while retaining already inspected node availability.
///
/// # Errors
/// Returns an error when required availability or video presentation data is absent.
pub fn project_canvas_with_known_projection(
    canvas: &CanvasDocument,
    projection: &CanvasProjection,
) -> Result<CanvasProjection, ProjectError> {
    let by_path: HashMap<_, _> = projection
        .nodes
        .iter()
        .map(|node| (node.node.project_relative_path.as_str(), node))
        .collect();
    for node in &canvas.node_elements {
        if !by_path.contains_key(node.project_relative_path.as_str()) {
            return Err(ProjectError::Validation(format!(
                "Canvas node availability is not loaded: {}",
                node.project_relative_path
            )));
        }
    }
    let mut result = project_canvas(canvas, projection.diagnostics.clone(), |node| {
        by_path
            .get(node.project_relative_path.as_str())
            .map_or_else(
                || unreachable!("Canvas projection paths were validated"),
                |projected| projected.availability.clone(),
            )
    });
    for node in &mut result.nodes {
        if node.node.media_kind == Some(CanvasMediaKind::Video)
            && matches!(node.availability, CanvasNodeAvailability::Available { .. })
        {
            node.video_presentation = by_path
                .get(node.node.project_relative_path.as_str())
                .and_then(|projected| projected.video_presentation.clone());
            if node.video_presentation.is_none() {
                return Err(ProjectError::Validation(format!(
                    "Canvas video presentation is not loaded: {}",
                    node.node.project_relative_path
                )));
            }
        }
    }
    Ok(result)
}

/// Applies exact manual layout updates to current Canvas nodes.
///
/// # Errors
/// Returns a validation error for an empty batch, duplicate or missing targets,
/// or invalid geometry.
pub fn update_canvas_node_layouts(
    canvas: &CanvasDocument,
    updates: &[CanvasNodeLayoutUpdate],
) -> Result<CanvasDocument, ProjectError> {
    if updates.is_empty() {
        return Err(ProjectError::Validation(
            "Canvas layout update requires at least one node.".to_owned(),
        ));
    }
    let mut by_path = HashMap::new();
    for update in updates {
        if !update.x.is_finite()
            || !update.y.is_finite()
            || update
                .width
                .is_some_and(|width| !width.is_finite() || width <= 0.0)
            || update
                .height
                .is_some_and(|height| !height.is_finite() || height <= 0.0)
        {
            return Err(ProjectError::Validation(
                "Canvas layout geometry must contain finite positions and positive finite sizes."
                    .to_owned(),
            ));
        }
        if by_path
            .insert(update.project_relative_path.as_str(), update)
            .is_some()
        {
            return Err(ProjectError::Validation(format!(
                "Canvas layout update contains a duplicate target: {}",
                update.project_relative_path
            )));
        }
        if !canvas
            .node_elements
            .iter()
            .any(|node| node.project_relative_path == update.project_relative_path)
        {
            return Err(ProjectError::Validation(format!(
                "Canvas node not found: {}",
                update.project_relative_path
            )));
        }
    }
    let mut result = canvas.clone();
    for node in &mut result.node_elements {
        if let Some(update) = by_path.get(node.project_relative_path.as_str()) {
            node.x = update.x;
            node.y = update.y;
            node.width = update.width.unwrap_or(node.width);
            node.height = update.height.unwrap_or(node.height);
            node.layout_mode = Some("manual".to_owned());
        }
    }
    Ok(result)
}

#[must_use]
pub fn clear_canvas_manual_layouts(
    canvas: &CanvasDocument,
    paths: Option<&BTreeSet<String>>,
) -> (CanvasDocument, usize) {
    let mut result = canvas.clone();
    let mut count = 0;
    for node in &mut result.node_elements {
        if node.layout_mode.as_deref() == Some("manual")
            && paths.is_none_or(|paths| paths.contains(&node.project_relative_path))
        {
            node.layout_mode = None;
            count += 1;
        }
    }
    (result, count)
}

/// Applies video playback state only to matching video nodes.
///
/// # Errors
/// Returns a validation error when an update targets a non-video node.
pub fn update_canvas_video_playback(
    canvas: &CanvasDocument,
    updates: &[CanvasVideoPlaybackUpdate],
) -> Result<CanvasDocument, ProjectError> {
    if updates.is_empty() {
        return Err(ProjectError::Validation(
            "Canvas video playback update requires at least one target.".to_owned(),
        ));
    }
    let mut by_path = HashMap::new();
    for update in updates {
        if !update.current_time_seconds.is_finite() || update.current_time_seconds < 0.0 {
            return Err(ProjectError::Validation(
                "Canvas video playback time must be a non-negative finite number.".to_owned(),
            ));
        }
        if by_path
            .insert(
                update.project_relative_path.as_str(),
                (update.current_time_seconds * 1000.0).round() / 1000.0,
            )
            .is_some()
        {
            return Err(ProjectError::Validation(format!(
                "Canvas video playback update contains a duplicate target: {}",
                update.project_relative_path
            )));
        }
        let Some(node) = canvas
            .node_elements
            .iter()
            .find(|node| node.project_relative_path == update.project_relative_path)
        else {
            return Err(ProjectError::Validation(format!(
                "Canvas node not found: {}",
                update.project_relative_path
            )));
        };
        if node.node_kind != CanvasNodeKind::File || node.media_kind != Some(CanvasMediaKind::Video)
        {
            return Err(ProjectError::Validation(format!(
                "Canvas video playback target is not a video node: {}",
                update.project_relative_path
            )));
        }
    }
    let mut result = canvas.clone();
    for node in &mut result.node_elements {
        let Some(time) = by_path.get(node.project_relative_path.as_str()) else {
            continue;
        };
        node.video_playback = (*time != 0.0).then_some(CanvasVideoPlaybackState {
            current_time_seconds: *time,
        });
    }
    Ok(result)
}

/// Applies text viewport state only to matching text nodes.
///
/// # Errors
/// Returns a validation error when an update targets a non-text node.
pub fn update_canvas_text_viewports(
    canvas: &CanvasDocument,
    updates: &[CanvasTextViewportUpdate],
) -> Result<CanvasDocument, ProjectError> {
    if updates.is_empty() {
        return Err(ProjectError::Validation(
            "Canvas text viewport update requires at least one target.".to_owned(),
        ));
    }
    let mut by_path = HashMap::new();
    for update in updates {
        if !update.scroll_top.is_finite()
            || update.scroll_top < 0.0
            || !update.scroll_left.is_finite()
            || update.scroll_left < 0.0
        {
            return Err(ProjectError::Validation(
                "Canvas text viewport scroll values must be non-negative finite numbers."
                    .to_owned(),
            ));
        }
        if by_path
            .insert(update.project_relative_path.as_str(), update)
            .is_some()
        {
            return Err(ProjectError::Validation(format!(
                "Canvas text viewport update contains a duplicate target: {}",
                update.project_relative_path
            )));
        }
        let Some(node) = canvas
            .node_elements
            .iter()
            .find(|node| node.project_relative_path == update.project_relative_path)
        else {
            return Err(ProjectError::Validation(format!(
                "Canvas node not found: {}",
                update.project_relative_path
            )));
        };
        if node.node_kind != CanvasNodeKind::File || node.media_kind != Some(CanvasMediaKind::Text)
        {
            return Err(ProjectError::Validation(format!(
                "Canvas text viewport target is not a text node: {}",
                update.project_relative_path
            )));
        }
    }
    let mut result = canvas.clone();
    for node in &mut result.node_elements {
        let Some(update) = by_path.get(node.project_relative_path.as_str()) else {
            continue;
        };
        node.text_viewport = (update.scroll_top != 0.0 || update.scroll_left != 0.0).then_some(
            CanvasTextViewportState {
                scroll_top: update.scroll_top,
                scroll_left: update.scroll_left,
            },
        );
    }
    Ok(result)
}

/// Moves one existing Canvas node to the highest stack position.
///
/// # Errors
/// Returns a validation error when the target node does not exist.
pub fn bring_canvas_node_to_front(
    canvas: &CanvasDocument,
    project_relative_path: &str,
) -> Result<CanvasDocument, ProjectError> {
    let mut ordered = canvas.node_elements.clone();
    ordered.sort_by(compare_node_z);
    let Some(index) = ordered
        .iter()
        .position(|node| node.project_relative_path == project_relative_path)
    else {
        return Err(ProjectError::Validation(format!(
            "Canvas node not found: {project_relative_path}"
        )));
    };
    if index == ordered.len() - 1 {
        return Ok(canvas.clone());
    }
    let target = ordered.remove(index);
    ordered.push(target);
    let z_by_path: HashMap<_, _> = ordered
        .iter()
        .enumerate()
        .map(|(index, node)| {
            (
                node.project_relative_path.as_str(),
                i64::try_from(index).unwrap_or(i64::MAX),
            )
        })
        .collect();
    let mut result = canvas.clone();
    for node in &mut result.node_elements {
        node.z = z_by_path[&node.project_relative_path.as_str()];
    }
    Ok(result)
}

/// Reconciles persisted nodes with the desired Canvas Map projection and layout.
///
/// # Errors
/// Returns an error when a desired node cannot be sized or laid out safely.
pub fn reconcile_canvas_nodes(
    existing: &[CanvasNodeElement],
    desired: &[CanvasDesiredNode],
    rows: &[CanvasDesiredLayoutRow],
    size_for_node: impl Fn(&CanvasDesiredNode) -> Result<CanvasLayoutSize, ProjectError>,
) -> Result<Vec<CanvasNodeElement>, ProjectError> {
    let mut desired = desired.to_vec();
    desired.sort_by(|left, right| {
        natural_path_cmp(&left.project_relative_path, &right.project_relative_path)
    });
    let existing_by_path: HashMap<_, _> = existing
        .iter()
        .map(|node| (node.project_relative_path.as_str(), node))
        .collect();
    let manual: HashSet<_> = existing
        .iter()
        .filter(|node| node.layout_mode.as_deref() == Some("manual"))
        .map(|node| node.project_relative_path.clone())
        .collect();
    let layout = layout_canvas_desired_nodes(&desired, rows, &manual, &size_for_node)?;
    let desired_paths: HashSet<_> = desired
        .iter()
        .map(|node| node.project_relative_path.as_str())
        .collect();
    let mut used_z = HashSet::new();
    let mut preserved_z = HashMap::new();
    for node in existing {
        if desired_paths.contains(node.project_relative_path.as_str()) && used_z.insert(node.z) {
            preserved_z.insert(node.project_relative_path.as_str(), node.z);
        }
    }
    let mut next_z = 0_i64;
    let mut result = Vec::new();
    for desired_node in &desired {
        let z = preserved_z
            .get(desired_node.project_relative_path.as_str())
            .copied()
            .unwrap_or_else(|| {
                while used_z.contains(&next_z) {
                    next_z += 1;
                }
                let allocated = next_z;
                used_z.insert(allocated);
                next_z += 1;
                allocated
            });
        let previous = existing_by_path
            .get(desired_node.project_relative_path.as_str())
            .copied();
        let mut node = CanvasNodeElement {
            project_relative_path: desired_node.project_relative_path.clone(),
            node_kind: desired_node.node_kind,
            media_kind: desired_node.media_kind,
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
            z,
            layout_mode: None,
            video_playback: previous
                .filter(|_| {
                    desired_node.node_kind == CanvasNodeKind::File
                        && desired_node.media_kind == Some(CanvasMediaKind::Video)
                })
                .and_then(|node| node.video_playback.clone()),
            text_viewport: previous
                .filter(|_| {
                    desired_node.node_kind == CanvasNodeKind::File
                        && desired_node.media_kind == Some(CanvasMediaKind::Text)
                })
                .and_then(|node| node.text_viewport.clone()),
        };
        if let Some(previous) =
            previous.filter(|node| node.layout_mode.as_deref() == Some("manual"))
        {
            node.x = previous.x;
            node.y = previous.y;
            node.width = previous.width;
            node.height = previous.height;
            node.layout_mode = Some("manual".to_owned());
        } else {
            let placed = layout
                .get(&desired_node.project_relative_path)
                .ok_or_else(|| {
                    ProjectError::Validation(format!(
                        "Canvas node layout is missing: {}",
                        desired_node.project_relative_path
                    ))
                })?;
            node.x = placed.x;
            node.y = placed.y;
            node.width = placed.width;
            node.height = placed.height;
        }
        result.push(node);
    }
    Ok(result)
}

#[derive(Debug, Clone)]
struct LayoutTreeNode {
    node: CanvasDesiredNode,
    depth: usize,
    children: Vec<LayoutTreeNode>,
}

#[derive(Debug, Clone)]
struct LayoutRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

enum LayoutBlock<'a> {
    Node(&'a LayoutTreeNode),
    Row(Vec<&'a LayoutTreeNode>),
}

fn layout_canvas_desired_nodes(
    desired: &[CanvasDesiredNode],
    rows: &[CanvasDesiredLayoutRow],
    manual: &HashSet<String>,
    size_for_node: &impl Fn(&CanvasDesiredNode) -> Result<CanvasLayoutSize, ProjectError>,
) -> Result<BTreeMap<String, CanvasResolvedLayout>, ProjectError> {
    let roots = build_layout_tree(desired);
    let rows_by_parent = build_rows_by_parent(rows, &roots)?;
    let mut widths = Vec::new();
    for root in &roots {
        collect_column_widths(root, &rows_by_parent, manual, size_for_node, &mut widths)?;
    }
    let mut offsets = vec![0.0];
    for depth in 1..widths.len() {
        offsets.push(offsets[depth - 1] + widths[depth - 1] + HORIZONTAL_TREE_GAP);
    }
    let mut result = BTreeMap::new();
    let mut cursor_y = 0.0;
    for root in &roots {
        if let Some(rect) = layout_subtree(
            root,
            cursor_y,
            &rows_by_parent,
            &offsets,
            manual,
            size_for_node,
            &mut result,
        )? {
            cursor_y = rect.y + rect.height + VERTICAL_GAP;
        }
    }
    Ok(result)
}

fn build_layout_tree(desired: &[CanvasDesiredNode]) -> Vec<LayoutTreeNode> {
    let has_root = desired
        .iter()
        .any(|node| node.project_relative_path.is_empty());
    let paths: HashSet<_> = desired
        .iter()
        .map(|node| node.project_relative_path.as_str())
        .collect();
    let mut roots: Vec<_> = desired
        .iter()
        .filter(|node| {
            canvas_parent_path(&node.project_relative_path)
                .is_none_or(|parent| !paths.contains(parent.as_str()))
        })
        .map(|node| build_tree_node(node, desired, has_root))
        .collect();
    roots.sort_by(|left, right| compare_desired_sibling(&left.node, &right.node));
    roots
}

fn build_tree_node(
    node: &CanvasDesiredNode,
    desired: &[CanvasDesiredNode],
    has_root: bool,
) -> LayoutTreeNode {
    let mut children: Vec<_> = desired
        .iter()
        .filter(|candidate| {
            canvas_parent_path(&candidate.project_relative_path).as_deref()
                == Some(node.project_relative_path.as_str())
        })
        .map(|child| build_tree_node(child, desired, has_root))
        .collect();
    children.sort_by(|left, right| compare_desired_sibling(&left.node, &right.node));
    LayoutTreeNode {
        depth: if node.project_relative_path.is_empty() {
            0
        } else {
            node.project_relative_path.matches('/').count() + usize::from(has_root)
        },
        node: node.clone(),
        children,
    }
}

fn build_rows_by_parent(
    rows: &[CanvasDesiredLayoutRow],
    roots: &[LayoutTreeNode],
) -> Result<HashMap<String, Vec<Vec<String>>>, ProjectError> {
    let mut nodes = HashMap::new();
    for root in roots {
        index_tree(root, &mut nodes);
    }
    let mut result: HashMap<String, Vec<Vec<String>>> = HashMap::new();
    let mut used = HashSet::new();
    for row in rows {
        let mut members = Vec::new();
        for path in &row.member_project_relative_paths {
            let node = nodes.get(path.as_str()).ok_or_else(|| {
                ProjectError::Validation(format!("Canvas layout row member is missing: {path}"))
            })?;
            if node.node.node_kind != CanvasNodeKind::File {
                return Err(ProjectError::Validation(format!(
                    "Canvas layout row member must be a file: {path}"
                )));
            }
            if canvas_parent_path(path).as_deref()
                != Some(row.parent_project_relative_path.as_str())
            {
                return Err(ProjectError::Validation(format!(
                    "Canvas layout row member is not a direct child of its row parent: {path}"
                )));
            }
            if !used.insert(path.clone()) {
                return Err(ProjectError::Validation(format!(
                    "Canvas layout row member is controlled by more than one row: {path}"
                )));
            }
            members.push(path.clone());
        }
        members.sort_by(|left, right| natural_path_cmp(left, right));
        if !members.is_empty() {
            result
                .entry(row.parent_project_relative_path.clone())
                .or_default()
                .push(members);
        }
    }
    Ok(result)
}

fn index_tree<'a>(node: &'a LayoutTreeNode, result: &mut HashMap<&'a str, &'a LayoutTreeNode>) {
    result.insert(node.node.project_relative_path.as_str(), node);
    for child in &node.children {
        index_tree(child, result);
    }
}

fn child_blocks<'a>(
    node: &'a LayoutTreeNode,
    rows: &HashMap<String, Vec<Vec<String>>>,
    manual: &HashSet<String>,
) -> Vec<LayoutBlock<'a>> {
    let row_paths: HashSet<_> = rows
        .get(&node.node.project_relative_path)
        .into_iter()
        .flatten()
        .flatten()
        .map(String::as_str)
        .collect();
    let by_path: HashMap<_, _> = node
        .children
        .iter()
        .map(|child| (child.node.project_relative_path.as_str(), child))
        .collect();
    let mut blocks = Vec::new();
    if let Some(parent_rows) = rows.get(&node.node.project_relative_path) {
        for row in parent_rows {
            blocks.push(LayoutBlock::Row(
                row.iter()
                    .filter_map(|path| by_path.get(path.as_str()).copied())
                    .collect(),
            ));
        }
    }
    let mut children: Vec<_> = node
        .children
        .iter()
        .filter(|child| !row_paths.contains(child.node.project_relative_path.as_str()))
        .filter(|child| {
            !manual.contains(&child.node.project_relative_path) || !child.children.is_empty()
        })
        .collect();
    children.sort_by(|left, right| {
        natural_path_cmp(
            &left.node.project_relative_path,
            &right.node.project_relative_path,
        )
    });
    blocks.extend(children.into_iter().map(LayoutBlock::Node));
    blocks
}

fn collect_column_widths(
    node: &LayoutTreeNode,
    rows: &HashMap<String, Vec<Vec<String>>>,
    manual: &HashSet<String>,
    size_for_node: &impl Fn(&CanvasDesiredNode) -> Result<CanvasLayoutSize, ProjectError>,
    widths: &mut Vec<f64>,
) -> Result<(), ProjectError> {
    if !manual.contains(&node.node.project_relative_path) {
        let size = size_for_node(&node.node)?;
        if widths.len() <= node.depth {
            widths.resize(node.depth + 1, 0.0);
        }
        widths[node.depth] = widths[node.depth].max(size.width);
    }
    for block in child_blocks(node, rows, manual) {
        match block {
            LayoutBlock::Row(members) => {
                for member in members {
                    let size = size_for_node(&member.node)?;
                    if widths.len() <= member.depth {
                        widths.resize(member.depth + 1, 0.0);
                    }
                    widths[member.depth] = widths[member.depth].max(size.width);
                }
            }
            LayoutBlock::Node(child) => {
                collect_column_widths(child, rows, manual, size_for_node, widths)?;
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn layout_subtree(
    node: &LayoutTreeNode,
    top: f64,
    rows: &HashMap<String, Vec<Vec<String>>>,
    offsets: &[f64],
    manual: &HashSet<String>,
    size_for_node: &impl Fn(&CanvasDesiredNode) -> Result<CanvasLayoutSize, ProjectError>,
    result: &mut BTreeMap<String, CanvasResolvedLayout>,
) -> Result<Option<LayoutRect>, ProjectError> {
    let mut cursor_y = top;
    let mut placed_children = Vec::new();
    for block in child_blocks(node, rows, manual) {
        let placed = match block {
            LayoutBlock::Node(child) => layout_subtree(
                child,
                cursor_y,
                rows,
                offsets,
                manual,
                size_for_node,
                result,
            )?,
            LayoutBlock::Row(members) => {
                layout_row(&members, cursor_y, offsets, size_for_node, result)?
            }
        };
        if let Some(rect) = placed {
            cursor_y = rect.y + rect.height + VERTICAL_GAP;
            placed_children.push(rect);
        }
    }
    if manual.contains(&node.node.project_relative_path) {
        return Ok(union_rects(&placed_children));
    }
    let size = size_for_node(&node.node)?;
    let x = offsets.get(node.depth).copied().unwrap_or_default();
    let y = if placed_children.is_empty() {
        top
    } else {
        let first = &placed_children[0];
        let last = &placed_children[placed_children.len() - 1];
        (first.y + last.y + last.height) / 2.0 - size.height / 2.0
    };
    result.insert(
        node.node.project_relative_path.clone(),
        CanvasResolvedLayout {
            x,
            y,
            width: size.width,
            height: size.height,
        },
    );
    let mut rects = vec![LayoutRect {
        x,
        y,
        width: size.width,
        height: size.height,
    }];
    rects.extend(placed_children);
    Ok(union_rects(&rects))
}

fn layout_row(
    members: &[&LayoutTreeNode],
    top: f64,
    offsets: &[f64],
    size_for_node: &impl Fn(&CanvasDesiredNode) -> Result<CanvasLayoutSize, ProjectError>,
    result: &mut BTreeMap<String, CanvasResolvedLayout>,
) -> Result<Option<LayoutRect>, ProjectError> {
    if members.is_empty() {
        return Ok(None);
    }
    let sizes = members
        .iter()
        .map(|member| size_for_node(&member.node))
        .collect::<Result<Vec<_>, _>>()?;
    let row_height = sizes.iter().map(|size| size.height).fold(0.0, f64::max);
    let left = offsets.get(members[0].depth).copied().unwrap_or_default();
    let mut cursor = left;
    let mut right = left;
    for (member, size) in members.iter().zip(sizes) {
        result.insert(
            member.node.project_relative_path.clone(),
            CanvasResolvedLayout {
                x: cursor,
                y: top + (row_height - size.height) / 2.0,
                width: size.width,
                height: size.height,
            },
        );
        right = cursor + size.width;
        cursor = right + HORIZONTAL_ROW_GAP;
    }
    Ok(Some(LayoutRect {
        x: left,
        y: top,
        width: right - left,
        height: row_height,
    }))
}

fn union_rects(rects: &[LayoutRect]) -> Option<LayoutRect> {
    let first = rects.first()?;
    let left = rects.iter().map(|rect| rect.x).fold(first.x, f64::min);
    let top = rects.iter().map(|rect| rect.y).fold(first.y, f64::min);
    let right = rects
        .iter()
        .map(|rect| rect.x + rect.width)
        .fold(first.x + first.width, f64::max);
    let bottom = rects
        .iter()
        .map(|rect| rect.y + rect.height)
        .fold(first.y + first.height, f64::max);
    Some(LayoutRect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}

#[must_use]
pub fn canvas_media_kind_from_path(path: &str) -> CanvasMediaKind {
    let path = path.to_ascii_lowercase();
    if [
        ".png", ".jpg", ".jpeg", ".jpe", ".jfif", ".webp", ".avif", ".tif", ".tiff", ".svg",
        ".svgz",
    ]
    .iter()
    .any(|extension| path.ends_with(extension))
    {
        CanvasMediaKind::Image
    } else if [".mp4", ".webm", ".mov", ".m4v"]
        .iter()
        .any(|extension| path.ends_with(extension))
    {
        CanvasMediaKind::Video
    } else if [
        ".mp3", ".wav", ".wave", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".flac", ".weba",
    ]
    .iter()
    .any(|extension| path.ends_with(extension))
    {
        CanvasMediaKind::Audio
    } else if project_text_file_type_for_path(&path, None).is_some() {
        CanvasMediaKind::Text
    } else {
        CanvasMediaKind::Unknown
    }
}

fn compare_node_z(left: &CanvasNodeElement, right: &CanvasNodeElement) -> Ordering {
    left.z
        .cmp(&right.z)
        .then_with(|| left.project_relative_path.cmp(&right.project_relative_path))
}

fn compare_desired_sibling(left: &CanvasDesiredNode, right: &CanvasDesiredNode) -> Ordering {
    match (left.node_kind, right.node_kind) {
        (CanvasNodeKind::Directory, CanvasNodeKind::File) => Ordering::Less,
        (CanvasNodeKind::File, CanvasNodeKind::Directory) => Ordering::Greater,
        _ => natural_cmp(
            canvas_basename(&left.project_relative_path),
            canvas_basename(&right.project_relative_path),
        ),
    }
}

fn natural_path_cmp(left: &str, right: &str) -> Ordering {
    let left_parts: Vec<_> = left.split('/').collect();
    let right_parts: Vec<_> = right.split('/').collect();
    for (left, right) in left_parts.iter().zip(&right_parts) {
        let order = natural_cmp(left, right);
        if order != Ordering::Equal {
            return order;
        }
    }
    left_parts.len().cmp(&right_parts.len())
}

fn natural_cmp(left: &str, right: &str) -> Ordering {
    let mut left = left.chars().peekable();
    let mut right = right.chars().peekable();
    loop {
        match (left.peek(), right.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b)) if a.is_ascii_digit() && b.is_ascii_digit() => {
                let a: String = std::iter::from_fn(|| left.next_if(char::is_ascii_digit)).collect();
                let b: String =
                    std::iter::from_fn(|| right.next_if(char::is_ascii_digit)).collect();
                let order = a
                    .trim_start_matches('0')
                    .len()
                    .cmp(&b.trim_start_matches('0').len())
                    .then_with(|| a.trim_start_matches('0').cmp(b.trim_start_matches('0')))
                    .then_with(|| a.len().cmp(&b.len()));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(_), Some(_)) => {
                let a = left.next().unwrap_or_default().to_ascii_lowercase();
                let b = right.next().unwrap_or_default().to_ascii_lowercase();
                let order = a.cmp(&b);
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

fn canvas_basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn canvas_parent_path(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    Some(
        path.rsplit_once('/')
            .map_or_else(String::new, |(parent, _)| parent.to_owned()),
    )
}
