use std::{
    cmp::Ordering,
    fs,
    io::{Read as _, Write as _},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

use cap_std::{ambient_authority, fs::Dir};
use regex::Regex;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{ProjectDirectoryState, ProjectError, ProjectPathKind, ProjectTreeEntry};

/// Normalizes a non-root Project-relative path.
///
/// # Errors
/// Returns an error for absolute, empty, traversal, or NUL-containing input.
pub fn normalize_project_relative_path(path: &str) -> Result<String, ProjectError> {
    normalize_project_path(path, false)
}

/// Normalizes a Project-relative directory path, including the empty root path.
///
/// # Errors
/// Returns an error for absolute, traversal, or NUL-containing input.
pub fn normalize_project_directory_path(path: &str) -> Result<String, ProjectError> {
    normalize_project_path(path, true)
}

fn normalize_project_path(path: &str, allow_empty: bool) -> Result<String, ProjectError> {
    if path.starts_with('/') || is_windows_absolute(path) {
        return Err(ProjectError::Validation(format!(
            "Project path must be relative: {path}"
        )));
    }
    if path.contains('\\') {
        return Err(ProjectError::Validation(format!(
            "Project path must not contain backslashes: {path}"
        )));
    }
    if path.is_empty() {
        return allow_empty
            .then(String::new)
            .ok_or_else(|| ProjectError::Validation("Project path must be non-empty.".to_owned()));
    }
    for segment in path.split('/') {
        if segment.is_empty() || matches!(segment, "." | "..") {
            return Err(ProjectError::Validation(format!(
                "Project path must not contain empty, \".\", or \"..\" segments: {path}"
            )));
        }
        validate_portable_path_segment(segment)?;
    }
    Ok(path.to_owned())
}

/// Validates a single Project path basename.
///
/// # Errors
/// Returns an error for empty, reserved, or separator-containing names.
pub fn normalize_project_path_basename(name: &str) -> Result<String, ProjectError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(ProjectError::Validation(
            "Project path name must be non-empty.".to_owned(),
        ));
    }
    if name != trimmed || matches!(trimmed, "." | "..") || trimmed.contains(['/', '\\']) {
        return Err(ProjectError::Validation(
            "Project path name must be a basename.".to_owned(),
        ));
    }
    validate_portable_path_segment(trimmed)?;
    Ok(trimmed.to_owned())
}

fn validate_portable_path_segment(segment: &str) -> Result<(), ProjectError> {
    if segment.chars().any(|character| {
        character == '\0'
            || character.is_control()
            || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
    }) || segment.ends_with(['.', ' '])
    {
        return Err(ProjectError::Validation(format!(
            "Project path segment is not portable across macOS and Windows: {segment:?}"
        )));
    }
    let stem = segment
        .split_once('.')
        .map_or(segment, |(stem, _)| stem)
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|number| {
                (number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9'))
                    || matches!(number, "¹" | "²" | "³")
            });
    if reserved {
        return Err(ProjectError::Validation(format!(
            "Project path segment is a reserved Windows device name: {segment}"
        )));
    }
    Ok(())
}

/// Returns the normalized parent of a Project-relative path.
///
/// # Errors
/// Returns an error when the input path is invalid.
pub fn parent_project_path(path: &str) -> Result<String, ProjectError> {
    let normalized = normalize_project_directory_path(path)?;
    Ok(normalized
        .rsplit_once('/')
        .map_or_else(String::new, |(parent, _)| parent.to_owned()))
}

/// Joins a normalized directory and basename into a Project-relative path.
///
/// # Errors
/// Returns an error when either component is invalid.
pub fn join_project_path(parent: &str, name: &str) -> Result<String, ProjectError> {
    let parent = normalize_project_directory_path(parent)?;
    let name = normalize_project_path_basename(name)?;
    Ok(if parent.is_empty() {
        name
    } else {
        format!("{parent}/{name}")
    })
}

#[must_use]
pub fn project_path_is_same_or_descendant(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

#[must_use]
pub fn rewrite_project_path(path: &str, source: &str, target: &str) -> String {
    if path == source {
        target.to_owned()
    } else if let Some(suffix) = path
        .strip_prefix(source)
        .and_then(|suffix| suffix.strip_prefix('/'))
    {
        format!("{target}/{suffix}")
    } else {
        path.to_owned()
    }
}

/// Resolves a normalized path lexically beneath the Project root.
///
/// # Errors
/// Returns an error when the root or relative path is invalid.
pub fn resolve_project_path(root: &Path, relative: &str) -> Result<PathBuf, ProjectError> {
    let normalized = normalize_project_directory_path(relative)?;
    let mut result = root.to_path_buf();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(segment) => result.push(segment),
            _ => {
                return Err(ProjectError::Validation(format!(
                    "Project path escapes project root: {relative}"
                )));
            }
        }
    }
    Ok(result)
}

/// Resolves and canonicalizes an existing path without allowing root escape.
///
/// # Errors
/// Returns an error for missing paths, root escape, or I/O failure.
pub fn resolve_existing_project_path(root: &Path, relative: &str) -> Result<PathBuf, ProjectError> {
    let lexical = resolve_project_path(root, relative)?;
    let root_real = root.canonicalize()?;
    let target_real = lexical.canonicalize()?;
    assert_path_inside(&root_real, &target_real, relative)?;
    Ok(target_real)
}

/// Resolves an existing path while rejecting symbolic links in every component.
///
/// # Errors
/// Returns an error for missing paths, symbolic links, root escape, or I/O failure.
pub fn resolve_no_symlink_existing_project_path(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, ProjectError> {
    let lexical = resolve_project_path(root, relative)?;
    assert_no_symlink_components(root, relative)?;
    let root_real = root.canonicalize()?;
    let target_real = lexical.canonicalize()?;
    assert_path_inside(&root_real, &target_real, relative)?;
    Ok(lexical)
}

/// Opens one Project file and binds the no-symlink/root-containment validation to
/// the returned handle's stable filesystem identity.
///
/// A second path validation after `open` closes the check/open race: if any path
/// component changed, the current path identity cannot match the already-open handle.
///
/// # Errors
/// Returns an error for an invalid path, symbolic-link/root escape, non-file target,
/// identity race, or I/O failure.
pub fn open_no_symlink_existing_project_file(
    root: &Path,
    relative: &str,
) -> Result<fs::File, ProjectError> {
    let absolute = resolve_no_symlink_existing_project_path(root, relative)?;
    let file = fs::File::open(&absolute)?;
    if !file.metadata()?.is_file() {
        return Err(ProjectError::Validation(format!(
            "Project path is not a file: {relative}"
        )));
    }
    let handle_identity = debrute_native_fs::file_identity(&file)?;
    let current = resolve_no_symlink_existing_project_path(root, relative)?;
    let path_identity = debrute_native_fs::path_identity(&current)?;
    if handle_identity != path_identity {
        return Err(ProjectError::service(
            "project_path_changed",
            format!("Project path changed while it was being opened: {relative}"),
        ));
    }
    Ok(file)
}

/// Resolves a possibly missing write target beneath a canonical Project root.
///
/// # Errors
/// Returns an error for invalid paths, root escape, or invalid existing parents.
pub fn resolve_project_path_for_write(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, ProjectError> {
    resolve_project_path_for_write_inner(root, relative)
}

/// Resolves a write target while rejecting symbolic links in existing components.
///
/// # Errors
/// Returns an error for invalid paths, symbolic links, or root escape.
pub fn resolve_no_symlink_project_path_for_write(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, ProjectError> {
    resolve_project_path_for_write_inner(root, relative)
}

/// Handle-anchored Project filesystem authority for internal writes, moves,
/// and cleanup. Relative operations cannot escape through a concurrently
/// replaced symbolic-link component.
#[derive(Clone)]
pub(crate) struct ProjectCapabilityFs {
    root: Arc<Dir>,
}

static PROJECT_CAPABILITY_ROOTS: OnceLock<Mutex<std::collections::HashMap<PathBuf, Weak<Dir>>>> =
    OnceLock::new();

impl ProjectCapabilityFs {
    pub(crate) fn open(root: &Path) -> Result<Self, ProjectError> {
        let roots =
            PROJECT_CAPABILITY_ROOTS.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
        let mut roots = roots
            .lock()
            .expect("Project capability root registry lock poisoned");
        roots.retain(|_, root| root.strong_count() > 0);
        if let Some(root) = roots.get(root).and_then(Weak::upgrade) {
            return Ok(Self { root });
        }
        let directory = Arc::new(Dir::open_ambient_dir(root, ambient_authority())?);
        roots.insert(root.to_path_buf(), Arc::downgrade(&directory));
        Ok(Self { root: directory })
    }

    pub(crate) fn bind_session_root(root: &Path) -> Result<Self, ProjectError> {
        let roots =
            PROJECT_CAPABILITY_ROOTS.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
        let mut roots = roots
            .lock()
            .expect("Project capability root registry lock poisoned");
        roots.retain(|_, root| root.strong_count() > 0);
        let directory = Arc::new(Dir::open_ambient_dir(root, ambient_authority())?);
        roots.insert(root.to_path_buf(), Arc::downgrade(&directory));
        Ok(Self { root: directory })
    }

    pub(crate) fn unbind_session_root(&self, root: &Path) {
        let Some(roots) = PROJECT_CAPABILITY_ROOTS.get() else {
            return;
        };
        let mut roots = roots
            .lock()
            .expect("Project capability root registry lock poisoned");
        if roots
            .get(root)
            .and_then(Weak::upgrade)
            .is_some_and(|bound| Arc::ptr_eq(&bound, &self.root))
        {
            roots.remove(root);
        }
        roots.retain(|_, root| root.strong_count() > 0);
    }

    pub(crate) fn open_directory(&self, relative: &str) -> Result<Dir, ProjectError> {
        let relative = normalize_project_directory_path(relative)?;
        if relative.is_empty() {
            return Ok(self.root.try_clone()?);
        }
        Ok(self.root.open_dir(relative)?)
    }

    pub(crate) fn ensure_directory(&self, relative: &str) -> Result<Dir, ProjectError> {
        let relative = normalize_project_directory_path(relative)?;
        if relative.is_empty() {
            return Ok(self.root.try_clone()?);
        }
        self.root.create_dir_all(&relative)?;
        Ok(self.root.open_dir(relative)?)
    }

    pub(crate) fn atomic_write(&self, relative: &str, bytes: &[u8]) -> Result<(), ProjectError> {
        let relative = normalize_project_relative_path(relative)?;
        let (parent, name) = split_parent_name(&relative)?;
        let directory = self.ensure_directory(parent)?;
        let temporary = format!(".{name}.{}.tmp", Uuid::new_v4());
        let result = (|| {
            let mut options = cap_std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            let mut file = directory.open_with(&temporary, &options)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            directory.rename(&temporary, &directory, name)?;
            Ok(())
        })();
        finish_atomic_write(result, &directory, &temporary)
    }

    pub(crate) fn atomic_write_checked<E, F>(
        &self,
        relative: &str,
        bytes: &[u8],
        mut check: F,
    ) -> Result<(), E>
    where
        E: From<ProjectError> + std::fmt::Display,
        F: FnMut() -> Result<(), E>,
    {
        let relative = normalize_project_relative_path(relative)?;
        let (parent, name) = split_parent_name(&relative)?;
        let directory = self.ensure_directory(parent)?;
        let temporary = format!(".{name}.{}.tmp", Uuid::new_v4());
        let result = (|| {
            check()?;
            let mut options = cap_std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            let mut file = directory
                .open_with(&temporary, &options)
                .map_err(ProjectError::from)?;
            for chunk in bytes.chunks(1024 * 1024) {
                check()?;
                file.write_all(chunk).map_err(ProjectError::from)?;
            }
            check()?;
            file.sync_all().map_err(ProjectError::from)?;
            check()?;
            directory
                .rename(&temporary, &directory, name)
                .map_err(ProjectError::from)?;
            Ok(())
        })();
        finish_atomic_write(result, &directory, &temporary)
    }

    pub(crate) fn atomic_write_stream_checked<E, R, F>(
        &self,
        relative: &str,
        render: R,
        mut check: F,
    ) -> Result<(), E>
    where
        E: From<ProjectError> + std::fmt::Display,
        R: FnOnce(&mut std::fs::File) -> Result<(), E>,
        F: FnMut() -> Result<(), E>,
    {
        let relative = normalize_project_relative_path(relative)?;
        let (parent, name) = split_parent_name(&relative)?;
        let directory = self.ensure_directory(parent)?;
        let temporary = format!(".{name}.{}.tmp", Uuid::new_v4());
        let result = (|| {
            check()?;
            let mut options = cap_std::fs::OpenOptions::new();
            options.read(true).write(true).create_new(true);
            let mut file = directory
                .open_with(&temporary, &options)
                .map_err(ProjectError::from)?
                .into_std();
            render(&mut file)?;
            check()?;
            file.sync_all().map_err(ProjectError::from)?;
            check()?;
            drop(file);
            directory
                .rename(&temporary, &directory, name)
                .map_err(ProjectError::from)?;
            Ok(())
        })();
        finish_atomic_write(result, &directory, &temporary)
    }

    pub(crate) fn read_limited(
        &self,
        relative: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, ProjectError> {
        let relative = normalize_project_relative_path(relative)?;
        let mut file = self.root.open(relative)?;
        if file.metadata()?.len() > u64::try_from(max_bytes).unwrap_or(u64::MAX) {
            return Err(ProjectError::service(
                "project_document_too_large",
                format!("Project document exceeds {max_bytes} bytes."),
            ));
        }
        let limit = u64::try_from(max_bytes).unwrap_or(u64::MAX);
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(limit.saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() > max_bytes {
            return Err(ProjectError::service(
                "project_document_too_large",
                format!("Project document exceeds {max_bytes} bytes."),
            ));
        }
        Ok(bytes)
    }

    pub(crate) fn remove_file(&self, relative: &str) -> Result<(), ProjectError> {
        let relative = normalize_project_relative_path(relative)?;
        self.root.remove_file(relative)?;
        Ok(())
    }

    pub(crate) fn hard_link_to(
        &self,
        source: &str,
        destination: &Dir,
        destination_name: &str,
    ) -> Result<(), ProjectError> {
        let source = normalize_project_relative_path(source)?;
        normalize_project_path_basename(destination_name)?;
        self.root.hard_link(source, destination, destination_name)?;
        Ok(())
    }
}

fn finish_atomic_write<E>(result: Result<(), E>, directory: &Dir, temporary: &str) -> Result<(), E>
where
    E: From<ProjectError> + std::fmt::Display,
{
    let Err(error) = result else {
        return Ok(());
    };
    match directory.remove_file(temporary) {
        Ok(()) => Err(error),
        Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => Err(error),
        Err(cleanup_error) => Err(E::from(ProjectError::service(
            "project_atomic_write_cleanup_failed",
            format!("{error} Temporary file cleanup also failed: {cleanup_error}"),
        ))),
    }
}

fn split_parent_name(relative: &str) -> Result<(&str, &str), ProjectError> {
    relative.rsplit_once('/').map_or_else(
        || Ok(("", relative)),
        |(parent, name)| {
            normalize_project_directory_path(parent)?;
            normalize_project_path_basename(name)?;
            Ok((parent, name))
        },
    )
}

fn resolve_project_path_for_write_inner(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, ProjectError> {
    let lexical = resolve_project_path(root, relative)?;
    assert_no_symlink_components(root, relative)?;
    let root_real = root.canonicalize()?;
    match fs::symlink_metadata(&lexical) {
        Ok(metadata) => {
            debug_assert!(!metadata.file_type().is_symlink());
            let target_real = lexical.canonicalize()?;
            assert_path_inside(&root_real, &target_real, relative)?;
            Ok(lexical)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut parent = lexical.parent().ok_or_else(|| {
                ProjectError::Validation("Project path has no parent.".to_owned())
            })?;
            loop {
                match parent.canonicalize() {
                    Ok(parent_real) => {
                        assert_path_inside(&root_real, &parent_real, relative)?;
                        return Ok(lexical);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        parent = parent.parent().ok_or_else(|| {
                            ProjectError::Validation(format!(
                                "Project path escapes project root: {relative}"
                            ))
                        })?;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Err(error) => Err(error.into()),
    }
}

fn assert_no_symlink_components(root: &Path, relative: &str) -> Result<(), ProjectError> {
    let normalized = normalize_project_directory_path(relative)?;
    let mut current = root.to_path_buf();
    for component in Path::new(&normalized).components() {
        let Component::Normal(segment) = component else {
            return Err(ProjectError::Validation(format!(
                "Project path escapes project root: {relative}"
            )));
        };
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ProjectError::Validation(format!(
                    "Project path must not contain a symbolic link: {relative}"
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn assert_path_inside(root: &Path, target: &Path, relative: &str) -> Result<(), ProjectError> {
    if target == root || target.starts_with(root) {
        return Ok(());
    }
    Err(ProjectError::Validation(format!(
        "Project path escapes project root through a symlink: {relative}"
    )))
}

/// Requires a normalized path to be visible in the Project Tree.
///
/// # Errors
/// Returns an error when the path is invalid or excluded by Project policy.
pub fn assert_project_tree_visible_path(path: &str) -> Result<String, ProjectError> {
    let normalized = normalize_project_relative_path(path)?;
    if !is_project_visible_path(&normalized) {
        return Err(ProjectError::Validation(format!(
            "Project path is not visible in the Project Tree: {path}"
        )));
    }
    Ok(normalized)
}

/// Requires a visible path that may be mutated through the Project filesystem API.
///
/// # Errors
/// Returns an error when the path is invalid or excluded.
pub fn assert_project_tree_visible_mutation_path(path: &str) -> Result<String, ProjectError> {
    assert_project_tree_visible_path(path)
}

#[must_use]
pub fn is_project_visible_path(path: &str) -> bool {
    let folded_segments = path
        .split('/')
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    if folded_segments.iter().any(|segment| {
        matches!(
            segment.as_str(),
            ".git" | ".svn" | ".hg" | ".jj" | ".sl" | ".repo" | "cvs"
        )
    }) || folded_segments
        .iter()
        .any(|segment| matches!(segment.as_str(), ".ds_store" | "thumbs.db"))
    {
        return false;
    }
    !path
        .split('/')
        .any(|segment| managed_temporary().is_match(segment))
}

fn managed_temporary() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)^(?:.+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.restore)?|\.debrute-(?:upload|adobe-transfer)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$",
        )
        .expect("managed temporary regex is static")
    })
}

fn is_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

/// Lists only the direct visible children of one Project directory.
///
/// # Errors
/// Returns an error when the directory path is invalid or cannot be read safely.
pub fn list_project_directory(
    root: &Path,
    project_relative_directory: &str,
) -> Result<Vec<ProjectTreeEntry>, ProjectError> {
    let directory = normalize_project_directory_path(project_relative_directory)?;
    if !directory.is_empty() && !is_project_visible_path(&directory) {
        return Err(ProjectError::Validation(format!(
            "Project directory is not visible: {directory}"
        )));
    }
    let project = ProjectCapabilityFs::open(root)?;
    let current = project.open_directory(&directory)?;
    let mut result = Vec::new();
    for entry in current.entries()? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if directory.is_empty() {
            name
        } else {
            format!("{directory}/{name}")
        };
        if file_type.is_dir() && !file_type.is_symlink() && is_project_visible_path(&relative) {
            result.push(ProjectTreeEntry {
                project_relative_path: relative,
                kind: ProjectPathKind::Directory,
                size_bytes: None,
                directory_state: Some(ProjectDirectoryState::Unloaded),
                directory_error: None,
            });
        } else if file_type.is_file() && is_project_visible_path(&relative) {
            result.push(ProjectTreeEntry {
                project_relative_path: relative,
                kind: ProjectPathKind::File,
                size_bytes: Some(entry.metadata()?.len()),
                directory_state: None,
                directory_error: None,
            });
        }
    }
    result.sort_by(compare_project_tree_entries);
    Ok(result)
}

/// Compares two Project Tree siblings using the shared presentation order.
#[must_use]
pub fn compare_project_tree_entries(left: &ProjectTreeEntry, right: &ProjectTreeEntry) -> Ordering {
    match (left.kind, right.kind) {
        (ProjectPathKind::Directory, ProjectPathKind::File) => Ordering::Less,
        (ProjectPathKind::File, ProjectPathKind::Directory) => Ordering::Greater,
        _ => {
            let left_name = left
                .project_relative_path
                .rsplit('/')
                .next()
                .unwrap_or(&left.project_relative_path);
            let right_name = right
                .project_relative_path
                .rsplit('/')
                .next()
                .unwrap_or(&right.project_relative_path);
            natural_name_cmp(left_name, right_name)
                .then_with(|| left_name.cmp(right_name))
                .then_with(|| left.project_relative_path.cmp(&right.project_relative_path))
        }
    }
}

pub(crate) fn natural_name_cmp(left: &str, right: &str) -> Ordering {
    let left_folded = left
        .chars()
        .flat_map(char::to_lowercase)
        .collect::<String>();
    let right_folded = right
        .chars()
        .flat_map(char::to_lowercase)
        .collect::<String>();
    let mut left = left_folded.chars().peekable();
    let mut right = right_folded.chars().peekable();
    loop {
        match (left.peek(), right.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b)) if a.is_ascii_digit() && b.is_ascii_digit() => {
                let a =
                    std::iter::from_fn(|| left.next_if(char::is_ascii_digit)).collect::<String>();
                let b =
                    std::iter::from_fn(|| right.next_if(char::is_ascii_digit)).collect::<String>();
                let a_trimmed = a.trim_start_matches('0');
                let b_trimmed = b.trim_start_matches('0');
                let order = a_trimmed
                    .len()
                    .cmp(&b_trimmed.len())
                    .then_with(|| a_trimmed.cmp(b_trimmed))
                    .then_with(|| a.len().cmp(&b.len()));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(_), Some(_)) => {
                let order = left
                    .next()
                    .unwrap_or_default()
                    .cmp(&right.next().unwrap_or_default());
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

#[must_use]
pub fn project_content_hash(content: impl AsRef<[u8]>) -> String {
    format!("sha256:{:x}", Sha256::digest(content.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_visibility_is_case_insensitive_across_every_segment() {
        for path in [".GIT/objects/one", "nested/.Git/objects/one"] {
            assert!(!is_project_visible_path(path), "{path} must stay excluded");
        }
        assert!(is_project_visible_path(".debrute/feedback/feedback.json"));
        assert!(is_project_visible_path("nested/.Debrute/CACHE/preview.png"));
    }

    #[test]
    fn project_paths_reject_windows_namespace_aliases_and_streams() {
        for path in [
            ".debrute./cache/file",
            ".git /config",
            "media/file.txt:stream",
            "media/NUL.txt",
            "media/COM1",
            "media/COM¹.txt",
            "media/LPT³",
            "media/bad\0name",
            "media/bad\u{1f}name",
        ] {
            assert!(normalize_project_relative_path(path).is_err(), "{path:?}");
        }
    }

    #[test]
    fn natural_name_order_uses_per_character_unicode_case_folding() {
        assert_eq!(natural_name_cmp("Ος", "ΟΣ"), Ordering::Less);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn capability_root_denies_ambient_path_replacement_until_released() {
        let root = std::env::temp_dir().join(format!("debrute-cap-root-{}", Uuid::new_v4()));
        let moved = root.with_extension("moved");
        fs::create_dir_all(&root).unwrap();
        let capability = ProjectCapabilityFs::open(&root).unwrap();

        assert!(fs::rename(&root, &moved).is_err());
        drop(capability);
        fs::rename(&root, &moved).unwrap();

        fs::remove_dir_all(moved).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn capability_write_never_follows_an_external_parent_symlink() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("debrute-cap-root-{}", Uuid::new_v4()));
        let external =
            std::env::temp_dir().join(format!("debrute-cap-external-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("artifacts")).unwrap();
        fs::create_dir_all(&external).unwrap();
        symlink(&external, root.join("artifacts/output")).unwrap();
        assert!(
            ProjectCapabilityFs::open(&root)
                .unwrap()
                .atomic_write("artifacts/output/preview.bin", b"preview")
                .is_err()
        );
        assert!(!external.join("preview.bin").exists());
        fs::remove_file(root.join("artifacts/output")).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(external).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn capability_root_remains_bound_when_the_ambient_path_is_replaced() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("debrute-cap-root-{}", Uuid::new_v4()));
        let moved = root.with_extension("moved");
        let external =
            std::env::temp_dir().join(format!("debrute-cap-external-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&external).unwrap();
        let capability = ProjectCapabilityFs::open(&root).unwrap();
        fs::rename(&root, &moved).unwrap();
        symlink(&external, &root).unwrap();

        capability.atomic_write("output/value", b"owned").unwrap();

        assert_eq!(fs::read(moved.join("output/value")).unwrap(), b"owned");
        assert!(!external.join("output/value").exists());
        fs::remove_file(root).unwrap();
        fs::remove_dir_all(moved).unwrap();
        fs::remove_dir_all(external).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_new_session_rebinds_the_same_path_without_an_old_session_aba() {
        let root = std::env::temp_dir().join(format!("debrute-cap-root-{}", Uuid::new_v4()));
        let moved = root.with_extension("moved");
        fs::create_dir_all(&root).unwrap();
        let old = ProjectCapabilityFs::bind_session_root(&root).unwrap();
        fs::rename(&root, &moved).unwrap();
        fs::create_dir_all(&root).unwrap();
        let new = ProjectCapabilityFs::bind_session_root(&root).unwrap();

        old.atomic_write("output/old", b"old").unwrap();
        new.atomic_write("output/new", b"new").unwrap();
        old.unbind_session_root(&root);
        ProjectCapabilityFs::open(&root)
            .unwrap()
            .atomic_write("output/current", b"current")
            .unwrap();

        assert!(moved.join("output/old").is_file());
        assert!(root.join("output/new").is_file());
        assert!(root.join("output/current").is_file());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(moved).unwrap();
    }

    #[test]
    fn checked_stream_write_never_publishes_stale_output() {
        use std::{cell::Cell, io::Write as _};

        let root = std::env::temp_dir().join(format!("debrute-stream-root-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let checks = Cell::new(0_u8);
        let result = ProjectCapabilityFs::open(&root)
            .unwrap()
            .atomic_write_stream_checked(
                "derived/preview.png",
                |file| {
                    file.write_all(b"rendered")?;
                    Ok::<(), ProjectError>(())
                },
                || {
                    let next = checks.get() + 1;
                    checks.set(next);
                    if next == 1 {
                        Ok(())
                    } else {
                        Err(ProjectError::service("stale", "source changed"))
                    }
                },
            );

        assert_eq!(result.unwrap_err().code(), "stale");
        assert!(!root.join("derived/preview.png").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
