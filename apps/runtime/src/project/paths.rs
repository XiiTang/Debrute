use std::{
    fs,
    io::{Read as _, Write as _},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

use cap_std::{ambient_authority, fs::Dir};
use regex::Regex;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{ProjectError, ProjectPathEntry, ProjectPathKind};

pub const PROJECT_FILE: &str = ".debrute/project.json";
pub const CANVAS_INDEX_FILE: &str = ".debrute/canvases/index.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DebruteProjectPaths {
    pub debrute_dir: PathBuf,
    pub project_file: PathBuf,
    pub canvases_dir: PathBuf,
    pub canvas_maps_dir: PathBuf,
    pub canvas_index_file: PathBuf,
    pub global_runtime_dir: PathBuf,
}

#[must_use]
pub fn debrute_project_paths(project_root: &Path, debrute_home: &Path) -> DebruteProjectPaths {
    let debrute_dir = project_root.join(".debrute");
    DebruteProjectPaths {
        project_file: debrute_dir.join("project.json"),
        canvases_dir: debrute_dir.join("canvases"),
        canvas_maps_dir: debrute_dir.join("canvas-maps"),
        canvas_index_file: debrute_dir.join("canvases/index.json"),
        global_runtime_dir: debrute_home.join("runtime"),
        debrute_dir,
    }
}

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

pub(crate) struct ProjectCapabilityFileWrite {
    pub(crate) project_relative_path: String,
    pub(crate) content: Vec<u8>,
    pub(crate) replace: bool,
}

pub(crate) struct ProjectCapabilityFileStage {
    capability: ProjectCapabilityFs,
    files: Vec<StagedCapabilityFile>,
}

struct StagedCapabilityFile {
    stage: String,
    target: String,
    backup: Option<String>,
    replace: bool,
    published: bool,
}

static PROJECT_CAPABILITY_ROOTS: OnceLock<Mutex<std::collections::HashMap<PathBuf, Weak<Dir>>>> =
    OnceLock::new();

impl ProjectCapabilityFs {
    pub(crate) fn open_current(root: &Path) -> Result<Self, ProjectError> {
        Ok(Self {
            root: Arc::new(Dir::open_ambient_dir(root, ambient_authority())?),
        })
    }

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

    /// Stages a logical group of files through the already-open Project
    /// directory capability without publishing any target paths.
    pub(crate) fn stage_files(
        &self,
        writes: Vec<ProjectCapabilityFileWrite>,
    ) -> Result<ProjectCapabilityFileStage, ProjectError> {
        let mut staged = Vec::with_capacity(writes.len());
        stage_capability_files(self, writes, &mut staged)?;
        Ok(ProjectCapabilityFileStage {
            capability: self.clone(),
            files: staged,
        })
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

    pub(crate) fn file_size(&self, relative: &str) -> Result<u64, ProjectError> {
        let relative = normalize_project_relative_path(relative)?;
        Ok(self.root.open(relative)?.metadata()?.len())
    }

    pub(crate) fn remove_file(&self, relative: &str) -> Result<(), ProjectError> {
        let relative = normalize_project_relative_path(relative)?;
        self.root.remove_file(relative)?;
        Ok(())
    }

    pub(crate) fn rename_to_directory(
        &self,
        from: &str,
        destination: &Dir,
        destination_name: &str,
    ) -> Result<(), ProjectError> {
        let from = normalize_project_relative_path(from)?;
        normalize_project_path_basename(destination_name)?;
        self.root.rename(from, destination, destination_name)?;
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

impl ProjectCapabilityFileStage {
    pub(crate) fn capability(&self) -> &ProjectCapabilityFs {
        &self.capability
    }

    pub(crate) fn commit_more(
        mut self,
        writes: Vec<ProjectCapabilityFileWrite>,
    ) -> Result<(), ProjectError> {
        stage_capability_files(&self.capability, writes, &mut self.files)?;
        if let Err(error) = publish_capability_files(&self.capability.root, &mut self.files) {
            let rollback = rollback_capability_files(&self.capability.root, &mut self.files);
            let cleanup = cleanup_capability_files(&self.capability.root, &mut self.files);
            return match (rollback, cleanup) {
                (Ok(()), Ok(())) => Err(error.into()),
                (Err(rollback_error), Ok(())) => Err(ProjectError::service(
                    "project_file_commit_rollback_failed",
                    format!("{error} Rollback also failed: {rollback_error}"),
                )),
                (Ok(()), Err(cleanup_error)) => Err(ProjectError::service(
                    "project_file_commit_cleanup_failed",
                    format!("{error} Cleanup also failed: {cleanup_error}"),
                )),
                (Err(rollback_error), Err(cleanup_error)) => Err(ProjectError::service(
                    "project_file_commit_rollback_failed",
                    format!(
                        "{error} Rollback also failed: {rollback_error} Cleanup also failed: {cleanup_error}"
                    ),
                )),
            };
        }
        if let Err(error) = cleanup_capability_files(&self.capability.root, &mut self.files) {
            eprintln!("Debrute Project files were published but temporary cleanup failed: {error}");
        }
        Ok(())
    }
}

impl Drop for ProjectCapabilityFileStage {
    fn drop(&mut self) {
        if let Err(error) = cleanup_capability_files(&self.capability.root, &mut self.files) {
            eprintln!("Debrute Project staged file cleanup failed: {error}");
        }
    }
}

fn stage_capability_files(
    capability: &ProjectCapabilityFs,
    writes: Vec<ProjectCapabilityFileWrite>,
    staged: &mut Vec<StagedCapabilityFile>,
) -> Result<(), ProjectError> {
    let mut targets = staged
        .iter()
        .map(|file| file.target.clone())
        .collect::<std::collections::HashSet<_>>();
    let mut normalized = Vec::with_capacity(writes.len());
    for write in writes {
        let target = normalize_project_relative_path(&write.project_relative_path)?;
        if !targets.insert(target.clone()) {
            return Err(ProjectError::Validation(format!(
                "Project file commit contains a duplicate target: {target}"
            )));
        }
        let (parent, name) = split_parent_name(&target)?;
        let parent = parent.to_owned();
        let name = name.to_owned();
        normalized.push((target, parent, name, write.content, write.replace));
    }

    for (target, parent, name, content, replace) in normalized {
        if let Err(error) = capability.ensure_directory(&parent) {
            return match cleanup_capability_files(&capability.root, staged) {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(ProjectError::service(
                    "project_file_stage_cleanup_failed",
                    format!("{error} Cleanup also failed: {cleanup_error}"),
                )),
            };
        }
        let stage = if parent.is_empty() {
            format!(".{name}.{}.tmp", Uuid::new_v4())
        } else {
            format!("{parent}/.{name}.{}.tmp", Uuid::new_v4())
        };
        let mut options = cap_std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let stage_result = (|| {
            let mut file = capability.root.open_with(&stage, &options)?;
            file.write_all(&content)?;
            file.sync_all()?;
            Ok::<(), std::io::Error>(())
        })();
        if let Err(error) = stage_result {
            staged.push(StagedCapabilityFile {
                stage,
                target,
                backup: None,
                replace,
                published: false,
            });
            return match cleanup_capability_files(&capability.root, staged) {
                Ok(()) => Err(error.into()),
                Err(cleanup_error) => Err(ProjectError::service(
                    "project_file_stage_cleanup_failed",
                    format!("{error} Cleanup also failed: {cleanup_error}"),
                )),
            };
        }
        staged.push(StagedCapabilityFile {
            stage,
            target,
            backup: None,
            replace,
            published: false,
        });
    }
    Ok(())
}

fn publish_capability_files(root: &Dir, files: &mut [StagedCapabilityFile]) -> std::io::Result<()> {
    for file in files {
        match root.symlink_metadata(&file.target) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(std::io::Error::other(format!(
                    "Project commit target is not a regular file: {}",
                    file.target
                )));
            }
            Ok(_) if file.replace => {
                let (parent, name) = split_parent_name(&file.target)
                    .map_err(|error| std::io::Error::other(error.to_string()))?;
                let backup = if parent.is_empty() {
                    format!(".{name}.{}.restore.tmp", Uuid::new_v4())
                } else {
                    format!("{parent}/.{name}.{}.restore.tmp", Uuid::new_v4())
                };
                root.hard_link(&file.target, root, &backup)?;
                file.backup = Some(backup);
            }
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("Project commit target already exists: {}", file.target),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        if file.replace {
            root.rename(&file.stage, root, &file.target)?;
            file.published = true;
        } else {
            root.hard_link(&file.stage, root, &file.target)?;
            file.published = true;
            root.remove_file(&file.stage)?;
        }
    }
    Ok(())
}

fn rollback_capability_files(
    root: &Dir,
    files: &mut [StagedCapabilityFile],
) -> std::io::Result<()> {
    let mut first_error = None;
    for file in files.iter_mut().rev() {
        if file.published {
            if let Some(backup) = file.backup.take() {
                remember_capability_error(
                    root.rename(&backup, root, &file.target),
                    &mut first_error,
                );
            } else {
                remember_missing_ok(root.remove_file(&file.target), &mut first_error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn cleanup_capability_files(
    root: &Dir,
    files: &mut Vec<StagedCapabilityFile>,
) -> std::io::Result<()> {
    let mut first_error = None;
    for mut file in files.drain(..) {
        remember_missing_ok(root.remove_file(&file.stage), &mut first_error);
        if let Some(backup) = file.backup.take() {
            remember_missing_ok(root.remove_file(backup), &mut first_error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn remember_capability_error(
    result: std::io::Result<()>,
    first_error: &mut Option<std::io::Error>,
) {
    if let Err(error) = result
        && first_error.is_none()
    {
        *first_error = Some(error);
    }
}

fn remember_missing_ok(result: std::io::Result<()>, first_error: &mut Option<std::io::Error>) {
    if let Err(error) = result
        && error.kind() != std::io::ErrorKind::NotFound
        && first_error.is_none()
    {
        *first_error = Some(error);
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
/// Returns an error when the path is invalid or hidden by Project policy.
pub fn assert_project_tree_visible_path(path: &str) -> Result<String, ProjectError> {
    let normalized = normalize_project_relative_path(path)?;
    if !is_project_visible_path(&normalized) {
        return Err(ProjectError::Validation(format!(
            "Project path is not visible in the Project Tree: {path}"
        )));
    }
    Ok(normalized)
}

/// Requires a visible path that is not owned by the Project Document System.
///
/// # Errors
/// Returns an error when the path is invalid, hidden, or protected.
pub fn assert_project_tree_visible_mutation_path(path: &str) -> Result<String, ProjectError> {
    let normalized = assert_project_tree_visible_path(path)?;
    if is_protected_project_document_mutation_path(&normalized) {
        return Err(ProjectError::Validation(format!(
            "Project path is protected by the Project Document System: {path}"
        )));
    }
    Ok(normalized)
}

#[must_use]
pub fn is_project_visible_path(path: &str) -> bool {
    let policy = reserved_namespace_policy_path(path);
    let policy_case_folded = policy.to_ascii_lowercase();
    if is_same_or_child(&policy_case_folded, ".git")
        || is_same_or_child(&policy_case_folded, ".debrute/cache")
        || is_same_or_child(&policy_case_folded, ".debrute/reviews/rendered-feedback")
    {
        return false;
    }
    let segments: Vec<_> = policy.split('/').collect();
    if segments.first() == Some(&".debrute")
        && segments
            .iter()
            .skip(1)
            .any(|segment| segment.to_ascii_lowercase().ends_with(".lock"))
    {
        return false;
    }
    !segments
        .iter()
        .any(|segment| managed_temporary().is_match(segment))
}

#[must_use]
pub fn is_protected_project_document_mutation_path(path: &str) -> bool {
    is_same_or_child(&reserved_namespace_policy_path(path), ".debrute")
}

fn reserved_namespace_policy_path(path: &str) -> String {
    let (first, rest) = path
        .split_once('/')
        .map_or((path, None), |(a, b)| (a, Some(b)));
    let normalized_first = if first.eq_ignore_ascii_case(".git") {
        ".git"
    } else if first.eq_ignore_ascii_case(".debrute") {
        ".debrute"
    } else {
        first
    };
    rest.map_or_else(
        || normalized_first.to_owned(),
        |rest| format!("{normalized_first}/{rest}"),
    )
}

fn is_same_or_child(candidate: &str, parent: &str) -> bool {
    candidate == parent || candidate.starts_with(&format!("{parent}/"))
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

/// Lists the deterministic visible Project file tree.
///
/// # Errors
/// Returns an error when the root cannot be traversed safely.
pub fn list_project_files(root: &Path) -> Result<Vec<ProjectPathEntry>, ProjectError> {
    let mut result = Vec::new();
    let project = ProjectCapabilityFs::open(root)?;
    walk_visible(&project.root, "", &mut result)?;
    result.sort_by(|left, right| left.project_relative_path.cmp(&right.project_relative_path));
    Ok(result)
}

fn walk_visible(
    current: &Dir,
    prefix: &str,
    result: &mut Vec<ProjectPathEntry>,
) -> Result<(), ProjectError> {
    let entries = match current.entries() {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if file_type.is_dir() && !file_type.is_symlink() {
            if !is_project_visible_path(&relative) {
                continue;
            }
            result.push(ProjectPathEntry {
                project_relative_path: relative.clone(),
                kind: ProjectPathKind::Directory,
            });
            walk_visible(&entry.open_dir()?, &relative, result)?;
        } else if file_type.is_file() && is_project_visible_path(&relative) {
            result.push(ProjectPathEntry {
                project_relative_path: relative,
                kind: ProjectPathKind::File,
            });
        }
    }
    Ok(())
}

#[must_use]
pub fn project_content_hash(content: impl AsRef<[u8]>) -> String {
    format!("sha256:{:x}", Sha256::digest(content.as_ref()))
}

#[must_use]
pub fn project_file_revision(size: u64, mtime_ms: f64) -> String {
    format!("{}:{size}", mtime_ms.round())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_visibility_is_case_insensitive_across_every_segment() {
        for path in [
            ".DEBRUTE/CACHE/preview.png",
            ".debrute/Cache/preview.png",
            ".Debrute/REVIEWS/Rendered-Feedback/frame.png",
            ".DEBRUTE/reviews/RENDERED-FEEDBACK/frame.png",
            ".Debrute/Canvases/INDEX.JSON.LOCK",
            ".GIT/objects/one",
        ] {
            assert!(!is_project_visible_path(path), "{path} must stay hidden");
        }
        assert!(is_project_visible_path(".debrute/reviews/notes.md"));
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
    fn dropping_staged_project_files_publishes_nothing_and_removes_temporary_files() {
        let root = std::env::temp_dir().join(format!("debrute-cap-root-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let capability = ProjectCapabilityFs::open(&root).unwrap();
        let staged = capability
            .stage_files(vec![ProjectCapabilityFileWrite {
                project_relative_path: "generated/output.bin".to_owned(),
                content: b"staged".to_vec(),
                replace: false,
            }])
            .unwrap();

        assert!(!root.join("generated/output.bin").exists());
        assert!(list_project_files(&root).unwrap().iter().all(|entry| {
            !Path::new(&entry.project_relative_path)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("tmp"))
        }));
        drop(staged);
        assert!(
            fs::read_dir(root.join("generated"))
                .unwrap()
                .next()
                .is_none()
        );
        drop(capability);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn capability_root_denies_ambient_path_replacement_until_released() {
        let root = std::env::temp_dir().join(format!("debrute-cap-root-{}", Uuid::new_v4()));
        let moved = root.with_extension("moved");
        fs::create_dir_all(&root).unwrap();
        let capability = ProjectCapabilityFs::open_current(&root).unwrap();

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
        fs::create_dir_all(root.join(".debrute")).unwrap();
        fs::create_dir_all(&external).unwrap();
        symlink(&external, root.join(".debrute/cache")).unwrap();
        assert!(
            ProjectCapabilityFs::open(&root)
                .unwrap()
                .atomic_write(".debrute/cache/preview.bin", b"preview")
                .is_err()
        );
        assert!(!external.join("preview.bin").exists());
        fs::remove_file(root.join(".debrute/cache")).unwrap();
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

        capability
            .atomic_write(".debrute/cache/value", b"owned")
            .unwrap();

        assert_eq!(
            fs::read(moved.join(".debrute/cache/value")).unwrap(),
            b"owned"
        );
        assert!(!external.join(".debrute/cache/value").exists());
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

        old.atomic_write(".debrute/cache/old", b"old").unwrap();
        new.atomic_write(".debrute/cache/new", b"new").unwrap();
        old.unbind_session_root(&root);
        ProjectCapabilityFs::open(&root)
            .unwrap()
            .atomic_write(".debrute/cache/current", b"current")
            .unwrap();

        assert!(moved.join(".debrute/cache/old").is_file());
        assert!(root.join(".debrute/cache/new").is_file());
        assert!(root.join(".debrute/cache/current").is_file());
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
                ".debrute/cache/preview.png",
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
        assert!(!root.join(".debrute/cache/preview.png").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
