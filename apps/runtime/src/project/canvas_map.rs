use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet},
};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use super::{CanvasNodeKind, ProjectError, ProjectPathEntry, ProjectPathKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasMapRuleKind {
    ExactFile,
    RecursiveDirectory,
    FileGlob,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasMapRule {
    pub raw: String,
    pub pattern: String,
    pub kind: CanvasMapRuleKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasMapRowRule {
    pub raw: String,
    pub pattern: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasMapDocument {
    pub canvas_id: String,
    pub source_path: String,
    pub paths: Vec<CanvasMapRule>,
    pub layout_rows: Vec<CanvasMapRowRule>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CanvasMapPathRuleSet {
    pub paths: Vec<String>,
    pub globs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasMapNodeProjection {
    pub project_relative_path: String,
    pub node_kind: CanvasNodeKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpandedCanvasMapLayoutRow {
    pub parent_project_relative_path: String,
    pub member_project_relative_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpandedCanvasMap {
    pub canvas_id: String,
    pub source_path: String,
    pub nodes: Vec<CanvasMapNodeProjection>,
    pub layout_rows: Vec<ExpandedCanvasMapLayoutRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
enum CanvasMapPathSource {
    Literal(String),
    Glob(CanvasMapGlobSource),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CanvasMapGlobSource {
    glob: String,
}

/// Validates a Canvas Map identifier.
///
/// # Errors
/// Returns a validation error when the identifier is outside the map grammar.
pub fn validate_canvas_map_id(id: &str) -> Result<(), ProjectError> {
    if matches!(id, "." | "..") {
        return Err(canvas_map_error(
            "canvas_map_invalid_canvas_id",
            "Canvas Map canvas id must be a valid id.",
        ));
    }
    let mut bytes = id.bytes();
    let Some(first) = bytes.next() else {
        return Err(canvas_map_error(
            "canvas_map_invalid_canvas_id",
            "Canvas Map canvas id must be a valid id.",
        ));
    };
    if !first.is_ascii_alphanumeric()
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(canvas_map_error(
            "canvas_map_invalid_canvas_id",
            "Canvas Map canvas id must be a valid id.",
        ));
    }
    Ok(())
}

/// Returns the registered source path for a Canvas Map.
///
/// # Errors
/// Returns a validation error when `canvas_id` is invalid.
pub fn canvas_map_path(canvas_id: &str) -> Result<String, ProjectError> {
    validate_canvas_map_id(canvas_id)?;
    Ok(format!(".debrute/canvas-maps/{canvas_id}.yaml"))
}

/// Parses and strictly validates a closed Canvas Map YAML document.
///
/// # Errors
/// Returns a typed Canvas Map error for invalid YAML, keys, paths, or rules.
pub fn parse_canvas_map(
    canvas_id: &str,
    source_path: &str,
    content: &str,
) -> Result<CanvasMapDocument, ProjectError> {
    validate_canvas_map_id(canvas_id)?;
    let expected = canvas_map_path(canvas_id)?;
    if strict_project_path(source_path)? != expected {
        return Err(canvas_map_error(
            "canvas_map_invalid_path",
            format!("Canvas Map path must be \"{expected}\"."),
        ));
    }
    let value: Value = serde_yaml::from_str(content).map_err(|error| {
        let location = error.location();
        ProjectError::service_with_fields(
            "canvas_map_invalid_yaml",
            error.to_string(),
            location.into_iter().flat_map(|location| {
                [
                    ("line".to_owned(), location.line().to_string()),
                    ("column".to_owned(), location.column().to_string()),
                ]
            }),
        )
    })?;
    let mapping = value.as_mapping().ok_or_else(|| {
        canvas_map_error(
            "canvas_map_invalid_yaml",
            "Canvas Map YAML must be a top-level object.",
        )
    })?;
    assert_yaml_keys(mapping, &["paths", "layout"], "Canvas Map")?;
    let paths = mapping
        .get(Value::String("paths".to_owned()))
        .ok_or_else(|| {
            canvas_map_error(
                "canvas_map_invalid_yaml",
                "Canvas Map paths must be an array.",
            )
        })?;
    Ok(CanvasMapDocument {
        canvas_id: canvas_id.to_owned(),
        source_path: expected,
        paths: normalize_path_sources(paths)?
            .into_iter()
            .map(|source| normalize_path_source(&source))
            .collect::<Result<_, _>>()?,
        layout_rows: normalize_layout_rows(mapping.get(Value::String("layout".to_owned())))?,
    })
}

/// Expands a parsed Canvas Map against the current Project file index.
///
/// # Errors
/// Returns a typed error for invalid rule targets, globs, or row conflicts.
pub fn expand_canvas_map(
    map: &CanvasMapDocument,
    entries: &[ProjectPathEntry],
) -> Result<ExpandedCanvasMap, ProjectError> {
    let entry_by_path: HashMap<_, _> = entries
        .iter()
        .map(|entry| (entry.project_relative_path.as_str(), entry.kind))
        .collect();
    let mut files: Vec<_> = entries
        .iter()
        .filter(|entry| entry.kind == ProjectPathKind::File)
        .map(|entry| entry.project_relative_path.clone())
        .collect();
    files.sort_by(|left, right| natural_path_cmp(left, right));
    let mut matched = HashSet::new();
    for rule in &map.paths {
        match rule.kind {
            CanvasMapRuleKind::ExactFile => match entry_by_path.get(rule.pattern.as_str()) {
                Some(ProjectPathKind::Directory) => {
                    return Err(canvas_map_error(
                        "canvas_map_invalid_path",
                        format!(
                            "Canvas Map file rule currently resolves to a directory. Use a trailing slash for recursive folders: {}/",
                            rule.pattern
                        ),
                    ));
                }
                Some(ProjectPathKind::File) => {
                    matched.insert(rule.pattern.clone());
                }
                None => {}
            },
            CanvasMapRuleKind::RecursiveDirectory => {
                if entry_by_path.get(rule.pattern.as_str()) == Some(&ProjectPathKind::File) {
                    return Err(canvas_map_error(
                        "canvas_map_invalid_path",
                        format!(
                            "Canvas Map folder rule currently resolves to a file: {}",
                            rule.pattern
                        ),
                    ));
                }
                for file in &files {
                    if file.starts_with(&format!("{}/", rule.pattern)) {
                        matched.insert(file.clone());
                    }
                }
            }
            CanvasMapRuleKind::FileGlob => {
                let glob_regex = controlled_glob(&rule.pattern)?;
                for file in &files {
                    if glob_regex.is_match(file) {
                        matched.insert(file.clone());
                    }
                }
            }
        }
    }
    let mut matched: Vec<_> = matched.into_iter().collect();
    matched.sort_by(|left, right| natural_path_cmp(left, right));
    let mut nodes = BTreeMap::new();
    if !matched.is_empty() {
        nodes.insert(
            String::new(),
            CanvasMapNodeProjection {
                project_relative_path: String::new(),
                node_kind: CanvasNodeKind::Directory,
            },
        );
    }
    for file in &matched {
        add_ancestors(&mut nodes, file);
        nodes.insert(
            file.clone(),
            CanvasMapNodeProjection {
                project_relative_path: file.clone(),
                node_kind: CanvasNodeKind::File,
            },
        );
    }
    let mut nodes: Vec<_> = nodes.into_values().collect();
    nodes.sort_by(compare_tree_nodes);
    Ok(ExpandedCanvasMap {
        canvas_id: map.canvas_id.clone(),
        source_path: map.source_path.clone(),
        nodes,
        layout_rows: expand_layout_rows(&map.layout_rows, &matched)?,
    })
}

/// Expands an explicit path-rule set used by selective layout reset.
///
/// # Errors
/// Returns a typed error for invalid paths, targets, or globs.
pub fn expand_canvas_map_path_rules(
    rules: &CanvasMapPathRuleSet,
    entries: &[ProjectPathEntry],
) -> Result<Vec<CanvasMapNodeProjection>, ProjectError> {
    let normalized = rules
        .paths
        .iter()
        .map(|path| normalize_literal_rule(path))
        .chain(rules.globs.iter().map(|glob| normalize_glob_rule(glob)))
        .collect::<Result<Vec<_>, _>>()?;
    let entry_by_path: HashMap<_, _> = entries
        .iter()
        .map(|entry| (entry.project_relative_path.as_str(), entry.kind))
        .collect();
    let files: Vec<_> = entries
        .iter()
        .filter(|entry| entry.kind == ProjectPathKind::File)
        .map(|entry| entry.project_relative_path.as_str())
        .collect();
    let mut selected = BTreeMap::new();
    for rule in normalized {
        match rule.kind {
            CanvasMapRuleKind::ExactFile => match entry_by_path.get(rule.pattern.as_str()) {
                Some(ProjectPathKind::Directory) => {
                    return Err(canvas_map_error(
                        "canvas_map_invalid_path",
                        format!(
                            "Canvas Map file rule currently resolves to a directory. Use a trailing slash for recursive folders: {}/",
                            rule.pattern
                        ),
                    ));
                }
                Some(ProjectPathKind::File) => {
                    selected.insert(
                        rule.pattern.clone(),
                        CanvasMapNodeProjection {
                            project_relative_path: rule.pattern,
                            node_kind: CanvasNodeKind::File,
                        },
                    );
                }
                None => {}
            },
            CanvasMapRuleKind::RecursiveDirectory => {
                if entry_by_path.get(rule.pattern.as_str()) == Some(&ProjectPathKind::File) {
                    return Err(canvas_map_error(
                        "canvas_map_invalid_path",
                        format!(
                            "Canvas Map folder rule currently resolves to a file: {}",
                            rule.pattern
                        ),
                    ));
                }
                for entry in entries {
                    if entry.project_relative_path == rule.pattern
                        || entry
                            .project_relative_path
                            .starts_with(&format!("{}/", rule.pattern))
                    {
                        selected.insert(
                            entry.project_relative_path.clone(),
                            CanvasMapNodeProjection {
                                project_relative_path: entry.project_relative_path.clone(),
                                node_kind: match entry.kind {
                                    ProjectPathKind::File => CanvasNodeKind::File,
                                    ProjectPathKind::Directory => CanvasNodeKind::Directory,
                                },
                            },
                        );
                    }
                }
            }
            CanvasMapRuleKind::FileGlob => {
                let matcher = controlled_glob(&rule.pattern)?;
                for file in &files {
                    if matcher.is_match(file) {
                        selected.insert(
                            (*file).to_owned(),
                            CanvasMapNodeProjection {
                                project_relative_path: (*file).to_owned(),
                                node_kind: CanvasNodeKind::File,
                            },
                        );
                    }
                }
            }
        }
    }
    let mut result: Vec<_> = selected.into_values().collect();
    result.sort_by(compare_tree_nodes);
    Ok(result)
}

/// Adds one normalized literal rule while retaining the closed YAML structure.
///
/// # Errors
/// Returns a typed error when the document or new rule is invalid.
pub fn serialize_canvas_map_with_rule(content: &str, rule: &str) -> Result<String, ProjectError> {
    let mut value: Value = serde_yaml::from_str(content)
        .map_err(|error| canvas_map_error("canvas_map_invalid_yaml", error.to_string()))?;
    let mapping = value.as_mapping_mut().ok_or_else(|| {
        canvas_map_error(
            "canvas_map_invalid_yaml",
            "Canvas Map YAML must be a top-level object.",
        )
    })?;
    assert_yaml_keys(mapping, &["paths", "layout"], "Canvas Map")?;
    normalize_layout_rows(mapping.get(Value::String("layout".to_owned())))?;
    let key = Value::String("paths".to_owned());
    let path_value = mapping.get(&key).ok_or_else(|| {
        canvas_map_error(
            "canvas_map_invalid_yaml",
            "Canvas Map paths must be an array.",
        )
    })?;
    let mut sources = normalize_path_sources(path_value)?;
    let normalized = normalize_literal_rule(rule)?;
    let exists = sources.iter().any(|source| {
        normalize_path_source(source)
            .is_ok_and(|current| current.kind == normalized.kind && current.raw == normalized.raw)
    });
    if !exists {
        sources.push(CanvasMapPathSource::Literal(normalized.raw));
    }
    mapping.insert(key, serde_yaml::to_value(sources)?);
    let mut serialized = serde_yaml::to_string(&value)?;
    if !serialized.ends_with('\n') {
        serialized.push('\n');
    }
    Ok(serialized)
}

fn normalize_path_sources(value: &Value) -> Result<Vec<CanvasMapPathSource>, ProjectError> {
    let values = value.as_sequence().ok_or_else(|| {
        canvas_map_error(
            "canvas_map_invalid_yaml",
            "Canvas Map paths must be an array.",
        )
    })?;
    values
        .iter()
        .map(|value| {
            serde_yaml::from_value(value.clone()).map_err(|_| {
                canvas_map_error(
                    "canvas_map_invalid_yaml",
                    "Canvas Map path rule must be a non-empty string or a glob object.",
                )
            })
        })
        .collect()
}

fn normalize_path_source(source: &CanvasMapPathSource) -> Result<CanvasMapRule, ProjectError> {
    match source {
        CanvasMapPathSource::Literal(value) => normalize_literal_rule(value),
        CanvasMapPathSource::Glob(source) => normalize_glob_rule(&source.glob),
    }
}

fn normalize_literal_rule(value: &str) -> Result<CanvasMapRule, ProjectError> {
    let raw = value.trim().replace('\\', "/");
    if raw.is_empty() {
        return Err(canvas_map_error(
            "canvas_map_invalid_yaml",
            "Canvas Map path rule must be a non-empty string.",
        ));
    }
    if raw.starts_with('!') {
        return Err(canvas_map_error(
            "canvas_map_invalid_path",
            "Canvas Map negative rules are not supported.",
        ));
    }
    let is_directory = raw.ends_with('/');
    let pattern = strict_project_path(if is_directory {
        raw.trim_end_matches('/')
    } else {
        &raw
    })?;
    Ok(CanvasMapRule {
        raw: if is_directory {
            format!("{pattern}/")
        } else {
            pattern.clone()
        },
        pattern,
        kind: if is_directory {
            CanvasMapRuleKind::RecursiveDirectory
        } else {
            CanvasMapRuleKind::ExactFile
        },
    })
}

fn normalize_glob_rule(value: &str) -> Result<CanvasMapRule, ProjectError> {
    let raw = value.trim().replace('\\', "/");
    if raw.is_empty() {
        return Err(canvas_map_error(
            "canvas_map_invalid_yaml",
            "Canvas Map glob path rule must be a non-empty string.",
        ));
    }
    if raw.starts_with('!') || raw.ends_with('/') {
        return Err(canvas_map_error(
            "canvas_map_invalid_path",
            "Canvas Map glob path rules must be file globs.",
        ));
    }
    let pattern = strict_project_path(&raw)?;
    if !has_glob_syntax(&pattern) {
        return Err(canvas_map_error(
            "canvas_map_invalid_path",
            "Canvas Map glob path rules must be file globs.",
        ));
    }
    controlled_glob(&pattern)?;
    Ok(CanvasMapRule {
        raw: pattern.clone(),
        pattern,
        kind: CanvasMapRuleKind::FileGlob,
    })
}

fn normalize_layout_rows(value: Option<&Value>) -> Result<Vec<CanvasMapRowRule>, ProjectError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let mapping = value.as_mapping().ok_or_else(|| {
        canvas_map_error(
            "canvas_map_invalid_yaml",
            "Canvas Map layout must be an object.",
        )
    })?;
    assert_yaml_keys(mapping, &["rows"], "Canvas Map layout")?;
    let Some(rows) = mapping.get(Value::String("rows".to_owned())) else {
        return Ok(Vec::new());
    };
    let rows = rows.as_sequence().ok_or_else(|| {
        canvas_map_error(
            "canvas_map_invalid_yaml",
            "Canvas Map layout.rows must be an array.",
        )
    })?;
    rows.iter()
        .map(|value| {
            let value = value.as_str().ok_or_else(|| {
                canvas_map_error(
                    "canvas_map_invalid_yaml",
                    "Canvas Map row rule must be a non-empty string.",
                )
            })?;
            if value.trim().is_empty() {
                return Err(canvas_map_error(
                    "canvas_map_invalid_yaml",
                    "Canvas Map row rule must be a non-empty string.",
                ));
            }
            let rule = normalize_glob_rule(value).map_err(|error| {
                if error.code() == "canvas_map_invalid_yaml" {
                    error
                } else if value.trim_start().starts_with('!') {
                    canvas_map_error(
                        "canvas_map_invalid_path",
                        "Canvas Map negative rules are not supported.",
                    )
                } else {
                    canvas_map_error(
                        "canvas_map_invalid_path",
                        "Canvas Map row rules must be file globs.",
                    )
                }
            })?;
            Ok(CanvasMapRowRule {
                raw: rule.raw,
                pattern: rule.pattern,
            })
        })
        .collect()
}

fn expand_layout_rows(
    rules: &[CanvasMapRowRule],
    files: &[String],
) -> Result<Vec<ExpandedCanvasMapLayoutRow>, ProjectError> {
    let mut matched_by_file = HashMap::new();
    let mut explicit = Vec::new();
    for (index, rule) in rules.iter().enumerate() {
        let matcher = controlled_glob(&rule.pattern)?;
        let mut by_parent: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for file in files.iter().filter(|file| matcher.is_match(file)) {
            if let Some(previous) = matched_by_file.insert(file.as_str(), index)
                && previous != index
            {
                return Err(canvas_map_error(
                    "canvas_map_layout_conflict",
                    format!("Canvas Map row rules match the same file more than once: {file}"),
                ));
            }
            if let Some(parent) = parent_path(file) {
                by_parent.entry(parent).or_default().push(file.clone());
            }
        }
        explicit.extend(rows_for_parents(by_parent));
    }
    let mut remainder: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for file in files {
        if !matched_by_file.contains_key(file.as_str())
            && let Some(parent) = parent_path(file)
        {
            remainder.entry(parent).or_default().push(file.clone());
        }
    }
    explicit.extend(rows_for_parents(remainder));
    Ok(explicit)
}

fn rows_for_parents(parents: BTreeMap<String, Vec<String>>) -> Vec<ExpandedCanvasMapLayoutRow> {
    let mut result = Vec::new();
    for (parent, mut members) in parents {
        members.sort_by(|left, right| natural_path_cmp(left, right));
        result.push(ExpandedCanvasMapLayoutRow {
            parent_project_relative_path: parent,
            member_project_relative_paths: members,
        });
    }
    result
}

fn controlled_glob(pattern: &str) -> Result<Regex, ProjectError> {
    let mut source = String::from("^");
    let chars: Vec<_> = pattern.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '*' if chars.get(index + 1) == Some(&'*') => {
                if chars.get(index + 2) == Some(&'/') {
                    source.push_str("(?:.*/)?");
                    index += 3;
                } else {
                    source.push_str(".*");
                    index += 2;
                }
            }
            '*' => {
                source.push_str("[^/]*");
                index += 1;
            }
            '?' => {
                source.push_str("[^/]");
                index += 1;
            }
            '[' => {
                if let Some(end) = chars[index + 1..].iter().position(|char| *char == ']') {
                    let end = index + 1 + end;
                    source.extend(chars[index..=end].iter());
                    index = end + 1;
                } else {
                    source.push_str("\\[");
                    index += 1;
                }
            }
            character => {
                source.push_str(&regex::escape(&character.to_string()));
                index += 1;
            }
        }
    }
    source.push('$');
    Regex::new(&source).map_err(|error| {
        canvas_map_error(
            "canvas_map_invalid_path",
            format!("Canvas Map glob pattern is invalid: {pattern}: {error}"),
        )
    })
}

fn strict_project_path(path: &str) -> Result<String, ProjectError> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || is_windows_absolute(&normalized)
        || normalized
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(canvas_map_error(
            "canvas_map_invalid_path",
            "Canvas Map path must be a safe relative project path.",
        ));
    }
    Ok(normalized)
}

fn assert_yaml_keys(mapping: &Mapping, allowed: &[&str], label: &str) -> Result<(), ProjectError> {
    for key in mapping.keys() {
        let Some(key) = key.as_str() else {
            return Err(canvas_map_error(
                "canvas_map_invalid_yaml",
                format!("Unsupported {label} field."),
            ));
        };
        if !allowed.contains(&key) {
            return Err(canvas_map_error(
                "canvas_map_invalid_yaml",
                format!("Unsupported {label} field \"{key}\"."),
            ));
        }
    }
    Ok(())
}

fn add_ancestors(nodes: &mut BTreeMap<String, CanvasMapNodeProjection>, path: &str) {
    let parts: Vec<_> = path.split('/').collect();
    let mut current = String::new();
    for part in parts.iter().take(parts.len().saturating_sub(1)) {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        nodes.insert(
            current.clone(),
            CanvasMapNodeProjection {
                project_relative_path: current.clone(),
                node_kind: CanvasNodeKind::Directory,
            },
        );
    }
}

fn compare_tree_nodes(left: &CanvasMapNodeProjection, right: &CanvasMapNodeProjection) -> Ordering {
    let left_parts: Vec<_> = left.project_relative_path.split('/').collect();
    let right_parts: Vec<_> = right.project_relative_path.split('/').collect();
    for (index, (left_part, right_part)) in left_parts.iter().zip(&right_parts).enumerate() {
        if left_part == right_part {
            continue;
        }
        let left_kind = if index == left_parts.len() - 1 {
            left.node_kind
        } else {
            CanvasNodeKind::Directory
        };
        let right_kind = if index == right_parts.len() - 1 {
            right.node_kind
        } else {
            CanvasNodeKind::Directory
        };
        if left_kind != right_kind {
            return if left_kind == CanvasNodeKind::Directory {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        return natural_cmp(left_part, right_part);
    }
    left_parts.len().cmp(&right_parts.len())
}

fn natural_path_cmp(left: &str, right: &str) -> Ordering {
    let left: Vec<_> = left.split('/').collect();
    let right: Vec<_> = right.split('/').collect();
    for (left, right) in left.iter().zip(&right) {
        let order = natural_cmp(left, right);
        if order != Ordering::Equal {
            return order;
        }
    }
    left.len().cmp(&right.len())
}

fn natural_cmp(left: &str, right: &str) -> Ordering {
    let left = left.to_ascii_lowercase();
    let right = right.to_ascii_lowercase();
    let left = natural_parts(&left);
    let right = natural_parts(&right);
    for (left, right) in left.iter().zip(&right) {
        let ordering = if left.bytes().all(|byte| byte.is_ascii_digit())
            && right.bytes().all(|byte| byte.is_ascii_digit())
        {
            let left_number = left.trim_start_matches('0');
            let right_number = right.trim_start_matches('0');
            left_number
                .len()
                .cmp(&right_number.len())
                .then_with(|| left_number.cmp(right_number))
                .then_with(|| left.len().cmp(&right.len()))
        } else {
            left.cmp(right)
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left.len().cmp(&right.len())
}

fn natural_parts(value: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut digit = value.as_bytes().first().is_some_and(u8::is_ascii_digit);
    for (index, byte) in value.bytes().enumerate().skip(1) {
        let next_digit = byte.is_ascii_digit();
        if next_digit != digit {
            result.push(&value[start..index]);
            start = index;
            digit = next_digit;
        }
    }
    result.push(&value[start..]);
    result
}

fn parent_path(path: &str) -> Option<String> {
    path.rsplit_once('/').map_or_else(
        || Some(String::new()),
        |(parent, _)| (!parent.is_empty()).then(|| parent.to_owned()),
    )
}

fn has_glob_syntax(value: &str) -> bool {
    value.contains(['*', '?', '['])
}

fn is_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn canvas_map_error(code: &'static str, message: impl Into<String>) -> ProjectError {
    ProjectError::service(code, message)
}
