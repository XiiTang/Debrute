use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::UNIX_EPOCH,
};

use regex::Regex;
use uuid::Uuid;

#[cfg(test)]
use std::cell::RefCell;

use super::{
    ProjectError, ProjectPathBatchItemResult, ProjectPathKind, ProjectPathOperationResult,
    ProjectPathOperationStatus, ProjectTextFile, assert_project_tree_visible_mutation_path,
    assert_project_tree_visible_path, join_project_path, normalize_project_directory_path,
    normalize_project_path_basename, parent_project_path, project_content_hash, rename_no_replace,
    replace_file, resolve_no_symlink_existing_project_path, resolve_project_path,
    resolve_project_path_for_write,
};

const DEFAULT_MAX_TEXT_BYTES: u64 = 1024 * 1024;

#[cfg(test)]
thread_local! {
    static VISIBLE_REPLACEMENT_AFTER_CLAIM: RefCell<Option<(PathBuf, Vec<u8>)>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectPathBatchEntry {
    pub project_relative_path: String,
    pub kind: ProjectPathKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectUploadEntry {
    Directory {
        project_relative_path: String,
    },
    File {
        project_relative_path: String,
        content: Vec<u8>,
    },
    TemporaryFile {
        project_relative_path: String,
        temporary_path: PathBuf,
    },
}

/// Reads a visible UTF-8 Project file with size and binary guards.
///
/// # Errors
/// Returns an error for invalid paths, non-text content, oversize files, or I/O failure.
pub fn read_project_text_file(
    root: &Path,
    relative: &str,
    max_bytes: Option<u64>,
) -> Result<ProjectTextFile, ProjectError> {
    let relative = assert_project_tree_visible_path(relative)?;
    let absolute = resolve_no_symlink_existing_project_path(root, &relative)?;
    let metadata = fs::metadata(&absolute)?;
    if !metadata.is_file() {
        return Err(ProjectError::Validation(format!(
            "Project path is not a file: {relative}"
        )));
    }
    let maximum = max_bytes.unwrap_or(DEFAULT_MAX_TEXT_BYTES);
    if metadata.len() > maximum {
        return Err(ProjectError::Validation(format!(
            "Project file is too large to open as text ({} bytes): {relative}",
            metadata.len()
        )));
    }
    let bytes = fs::read(&absolute)?;
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Err(ProjectError::Validation(format!(
            "Project file appears to be binary, not text: {relative}"
        )));
    }
    let content = String::from_utf8(bytes).map_err(|_| {
        ProjectError::Validation(format!("Project file is not valid UTF-8 text: {relative}"))
    })?;
    project_text_file(relative, &absolute, content, &metadata)
}

/// Replaces a visible text file using a required content-revision comparison.
///
/// # Errors
/// Returns an error for invalid paths, stale revisions, or atomic-write failure.
pub(crate) fn write_project_text_file(
    root: &Path,
    relative: &str,
    content: &str,
    expected_revision: &str,
) -> Result<ProjectTextFile, ProjectError> {
    let relative = assert_project_tree_visible_path(relative)?;
    let absolute = resolve_no_symlink_existing_project_path(root, &relative)?;
    let metadata = fs::metadata(&absolute)?;
    if !metadata.is_file() {
        return Err(ProjectError::Validation(format!(
            "Project path is not a file: {relative}"
        )));
    }
    let actual_revision = project_content_hash(fs::read(&absolute)?);
    if actual_revision != expected_revision {
        return Err(ProjectError::service_with_fields(
            "project_file_revision_conflict",
            format!("Project text file revision is stale: {relative}"),
            [
                ("file_path".to_owned(), relative),
                ("expected_revision".to_owned(), expected_revision.to_owned()),
                ("actual_revision".to_owned(), actual_revision),
            ],
        ));
    }
    let temporary = sibling_temporary(&absolute)?;
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::set_permissions(&temporary, metadata.permissions())?;
        let saved = project_text_file(
            relative.clone(),
            &absolute,
            content.to_owned(),
            &fs::metadata(&temporary)?,
        )?;
        replace_file(&temporary, &absolute)?;
        Ok::<ProjectTextFile, ProjectError>(saved)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn project_text_file(
    relative: String,
    absolute: &Path,
    content: String,
    metadata: &fs::Metadata,
) -> Result<ProjectTextFile, ProjectError> {
    let first_line = content.lines().next().unwrap_or_default();
    let (language, mime_type) = project_text_type(&relative, first_line);
    Ok(ProjectTextFile {
        revision: project_content_hash(content.as_bytes()),
        project_relative_path: relative,
        absolute_path: absolute.to_string_lossy().into_owned(),
        size: metadata.len(),
        mtime_ms: metadata
            .modified()?
            .duration_since(UNIX_EPOCH)
            .map_err(|error| ProjectError::Validation(error.to_string()))?
            .as_secs_f64()
            * 1000.0,
        content,
        language: language.to_owned(),
        mime_type: mime_type.to_owned(),
    })
}

/// Creates one visible file or directory under an existing Project directory.
///
/// # Errors
/// Returns an error for invalid/protected paths, collisions, or I/O failure.
pub(crate) fn create_project_path(
    root: &Path,
    parent: &str,
    name: &str,
    kind: ProjectPathKind,
) -> Result<ProjectPathOperationResult, ProjectError> {
    let relative = join_project_path(parent, name)?;
    assert_project_tree_visible_mutation_path(&relative)?;
    assert_directory(root, &normalize_project_directory_path(parent)?)?;
    let absolute = resolve_project_path_for_write(root, &relative)?;
    if absolute.exists() {
        return Err(ProjectError::Validation(format!(
            "Project path already exists: {relative}"
        )));
    }
    match kind {
        ProjectPathKind::File => {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(absolute)?;
        }
        ProjectPathKind::Directory => fs::create_dir(absolute)?,
    }
    Ok(ProjectPathOperationResult {
        project_relative_path: relative,
        kind,
    })
}

/// Renames one visible Project path without overwriting.
///
/// # Errors
/// Returns an error for invalid/protected paths, collisions, or I/O failure.
pub(crate) fn rename_project_path(
    root: &Path,
    relative: &str,
    name: &str,
) -> Result<ProjectPathOperationResult, ProjectError> {
    let source = normalize_project_directory_path(relative)?;
    assert_project_tree_visible_mutation_path(&source)?;
    let kind = project_path_kind(root, &source)?;
    let target = join_project_path(&parent_project_path(&source)?, name)?;
    assert_project_tree_visible_mutation_path(&target)?;
    let target_absolute = resolve_project_path_for_write(root, &target)?;
    if target_absolute.exists() {
        return Err(ProjectError::Validation(format!(
            "Project path already exists: {target}"
        )));
    }
    rename_no_replace(&resolve_project_path(root, &source)?, &target_absolute)?;
    Ok(ProjectPathOperationResult {
        project_relative_path: target,
        kind,
    })
}

/// Copies normalized top-level Project paths to unique paste targets.
///
/// # Errors
/// Returns an error for invalid batches, recursive copies, symbolic links, or I/O failure.
pub(crate) fn copy_project_paths(
    root: &Path,
    entries: &[ProjectPathBatchEntry],
    target_directory: &str,
) -> Result<Vec<ProjectPathBatchItemResult>, ProjectError> {
    let target_directory = normalize_project_directory_path(target_directory)?;
    assert_directory(root, &target_directory)?;
    let entries = normalized_top_level_entries(root, entries)?;
    for entry in &entries {
        if entry.kind == ProjectPathKind::Directory
            && is_same_or_child(&target_directory, &entry.project_relative_path)
        {
            return Err(ProjectError::Validation(
                "Cannot copy a directory into itself or one of its descendants.".to_owned(),
            ));
        }
        validate_copy_tree(&resolve_project_path(root, &entry.project_relative_path)?)?;
    }
    let mut planned = Vec::new();
    let mut reserved = BTreeSet::new();
    for entry in entries {
        let basename = entry
            .project_relative_path
            .rsplit('/')
            .next()
            .ok_or_else(|| ProjectError::Validation("Project path has no basename.".to_owned()))?;
        let target = unique_paste_target(root, &target_directory, basename, &reserved)?;
        reserved.insert(target.clone());
        planned.push((entry, target));
    }
    let staged = planned
        .iter()
        .map(|(entry, target)| {
            Ok((
                resolve_no_symlink_existing_project_path(root, &entry.project_relative_path)?,
                resolve_project_path_for_write(root, target)?,
            ))
        })
        .collect::<Result<Vec<_>, ProjectError>>()?;
    commit_copied_paths(&staged, false)?;
    Ok(planned
        .into_iter()
        .map(|(entry, target)| ProjectPathBatchItemResult {
            source_project_relative_path: entry.project_relative_path,
            project_relative_path: target,
            kind: entry.kind,
            status: ProjectPathOperationStatus::Ok,
        })
        .collect())
}

/// Moves normalized top-level Project paths into one existing directory.
///
/// # Errors
/// Returns an error for invalid batches, recursive moves, collisions, or I/O failure.
pub(crate) fn move_project_paths(
    root: &Path,
    entries: &[ProjectPathBatchEntry],
    target_directory: &str,
    overwrite: bool,
) -> Result<Vec<ProjectPathBatchItemResult>, ProjectError> {
    let target_directory = normalize_project_directory_path(target_directory)?;
    assert_directory(root, &target_directory)?;
    let entries = normalized_top_level_entries(root, entries)?;
    let mut targets = HashSet::new();
    let mut planned = Vec::new();
    for entry in entries {
        let basename = entry
            .project_relative_path
            .rsplit('/')
            .next()
            .unwrap_or_default();
        let target = join_project_path(&target_directory, basename)?;
        if !targets.insert(target.clone()) {
            return Err(ProjectError::Validation(format!(
                "Duplicate project path target in batch: {target}"
            )));
        }
        assert_project_tree_visible_mutation_path(&target)?;
        if entry.kind == ProjectPathKind::Directory
            && is_same_or_child(&target_directory, &entry.project_relative_path)
        {
            return Err(ProjectError::Validation(
                "Cannot move a directory into itself or one of its descendants.".to_owned(),
            ));
        }
        let skipped = parent_project_path(&entry.project_relative_path)? == target_directory;
        if !skipped && resolve_project_path_for_write(root, &target)?.exists() && !overwrite {
            return Err(ProjectError::Validation(format!(
                "Project path already exists: {target}"
            )));
        }
        planned.push((entry, target, skipped));
    }
    let moves = planned
        .iter()
        .filter(|(_, _, skipped)| !skipped)
        .map(|(entry, target, _)| {
            Ok((
                resolve_no_symlink_existing_project_path(root, &entry.project_relative_path)?,
                resolve_project_path_for_write(root, target)?,
            ))
        })
        .collect::<Result<Vec<_>, ProjectError>>()?;
    commit_moved_paths(&moves, overwrite)?;
    Ok(planned
        .into_iter()
        .map(|(entry, target, skipped)| ProjectPathBatchItemResult {
            source_project_relative_path: entry.project_relative_path.clone(),
            project_relative_path: if skipped {
                entry.project_relative_path
            } else {
                target
            },
            kind: entry.kind,
            status: if skipped {
                ProjectPathOperationStatus::Skipped
            } else {
                ProjectPathOperationStatus::Ok
            },
        })
        .collect())
}

/// Deletes a validated batch of visible Project paths.
///
/// # Errors
/// Returns an error if validation fails before deletion or any deletion fails.
pub(crate) fn delete_project_paths(
    root: &Path,
    entries: &[ProjectPathBatchEntry],
) -> Result<Vec<ProjectPathBatchItemResult>, ProjectError> {
    let entries = normalized_top_level_entries(root, entries)?;
    for entry in &entries {
        resolve_no_symlink_existing_project_path(root, &entry.project_relative_path)?;
    }
    let targets = entries
        .iter()
        .map(|entry| resolve_no_symlink_existing_project_path(root, &entry.project_relative_path))
        .collect::<Result<Vec<_>, _>>()?;
    commit_deleted_paths(&targets)?;
    Ok(entries
        .into_iter()
        .map(|entry| ProjectPathBatchItemResult {
            source_project_relative_path: entry.project_relative_path.clone(),
            project_relative_path: entry.project_relative_path,
            kind: entry.kind,
            status: ProjectPathOperationStatus::Ok,
        })
        .collect())
}

/// Imports fully validated local files or directories into a Project.
///
/// # Errors
/// Returns an error for invalid sources, symbolic links, collisions, or copy failure.
pub(crate) fn import_local_project_paths(
    root: &Path,
    sources: &[PathBuf],
    target_directory: &str,
    overwrite: bool,
) -> Result<Vec<ProjectPathBatchItemResult>, ProjectError> {
    let target_directory = normalize_project_directory_path(target_directory)?;
    assert_directory(root, &target_directory)?;
    let root_real = root.canonicalize()?;
    let mut targets = HashSet::new();
    let mut planned = Vec::new();
    for source in sources {
        if !source.is_absolute() {
            return Err(ProjectError::Validation(format!(
                "External source path must be absolute: {}",
                source.display()
            )));
        }
        if fs::symlink_metadata(source)?.file_type().is_symlink() {
            return Err(ProjectError::Validation(format!(
                "External source path must not be a symbolic link: {}",
                source.display()
            )));
        }
        let metadata = fs::metadata(source)?;
        let kind = if metadata.is_dir() {
            ProjectPathKind::Directory
        } else if metadata.is_file() {
            ProjectPathKind::File
        } else {
            return Err(ProjectError::Validation(format!(
                "External source path is not a file or directory: {}",
                source.display()
            )));
        };
        validate_copy_tree(source)?;
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                ProjectError::Validation("External source name is invalid.".to_owned())
            })?;
        let target = join_project_path(&target_directory, name)?;
        assert_project_tree_visible_mutation_path(&target)?;
        if !targets.insert(target.clone()) {
            return Err(ProjectError::Validation(format!(
                "Duplicate project path target in batch: {target}"
            )));
        }
        let target_absolute = resolve_project_path_for_write(root, &target)?;
        let source_real = source.canonicalize()?;
        if kind == ProjectPathKind::Directory
            && (target_absolute.starts_with(source) || target_absolute.starts_with(&source_real))
        {
            return Err(ProjectError::Validation(
                "Cannot import a project directory into itself or one of its descendants."
                    .to_owned(),
            ));
        }
        if target_absolute.exists() {
            if !overwrite {
                return Err(ProjectError::Validation(format!(
                    "Project path already exists: {target}"
                )));
            }
            if target_absolute.canonicalize()? == source_real {
                return Err(ProjectError::Validation(format!(
                    "External source path resolves to its project import target: {target}"
                )));
            }
        }
        if (source_real == root_real || source_real.starts_with(&root_real))
            && kind == ProjectPathKind::Directory
            && target_absolute.starts_with(&source_real)
        {
            return Err(ProjectError::Validation(
                "Cannot import a project directory into itself or one of its descendants."
                    .to_owned(),
            ));
        }
        planned.push((source.clone(), target, kind));
    }
    let staged = planned
        .iter()
        .map(|(source, target, _)| {
            Ok((
                source.clone(),
                resolve_project_path_for_write(root, target)?,
            ))
        })
        .collect::<Result<Vec<_>, ProjectError>>()?;
    commit_copied_paths(&staged, overwrite)?;
    Ok(planned
        .into_iter()
        .map(|(source, target, kind)| ProjectPathBatchItemResult {
            source_project_relative_path: source.to_string_lossy().into_owned(),
            project_relative_path: target,
            kind,
            status: ProjectPathOperationStatus::Ok,
        })
        .collect())
}

/// Materializes a validated relative upload manifest inside a Project.
///
/// # Errors
/// Returns an error for invalid manifests, collisions, or atomic-write failure.
pub(crate) fn import_upload_project_entries(
    root: &Path,
    entries: &[ProjectUploadEntry],
    target_directory: &str,
    overwrite: bool,
) -> Result<Vec<ProjectPathBatchItemResult>, ProjectError> {
    let target_directory = normalize_project_directory_path(target_directory)?;
    assert_directory(root, &target_directory)?;
    let mut targets = HashSet::new();
    let mut planned = Vec::new();
    for entry in entries {
        let (relative, kind) = match entry {
            ProjectUploadEntry::Directory {
                project_relative_path,
            } => (project_relative_path, ProjectPathKind::Directory),
            ProjectUploadEntry::File {
                project_relative_path,
                ..
            }
            | ProjectUploadEntry::TemporaryFile {
                project_relative_path,
                ..
            } => (project_relative_path, ProjectPathKind::File),
        };
        let relative = normalize_project_directory_path(relative)?;
        assert_project_tree_visible_mutation_path(&relative)?;
        if !is_strict_child(&relative, &target_directory) {
            return Err(ProjectError::Validation(format!(
                "Uploaded project path must be inside import target directory: {relative}"
            )));
        }
        if !targets.insert(relative.clone()) {
            return Err(ProjectError::Validation(format!(
                "Duplicate project path target in batch: {relative}"
            )));
        }
        planned.push((entry, relative, kind));
    }
    for (_, file_path, kind) in &planned {
        if *kind == ProjectPathKind::File
            && planned
                .iter()
                .any(|(_, candidate, _)| is_strict_child(candidate, file_path))
        {
            return Err(ProjectError::Validation(format!(
                "Uploaded file target cannot contain another batch target: {file_path}"
            )));
        }
    }
    let top_level: BTreeSet<String> = planned
        .iter()
        .map(|(_, path, _)| upload_top_level(&target_directory, path))
        .collect::<Result<_, _>>()?;
    for target in &top_level {
        if resolve_project_path_for_write(root, target)?.exists() && !overwrite {
            return Err(ProjectError::Validation(format!(
                "Project path already exists: {target}"
            )));
        }
    }
    let staged = stage_upload_entries(root, &target_directory, &planned, &top_level)?;
    commit_staged_paths(&staged, overwrite)?;
    Ok(planned
        .into_iter()
        .map(|(_, path, kind)| ProjectPathBatchItemResult {
            source_project_relative_path: path.clone(),
            project_relative_path: path,
            kind,
            status: ProjectPathOperationStatus::Ok,
        })
        .collect())
}

fn stage_upload_entries(
    root: &Path,
    target_directory: &str,
    planned: &[(&ProjectUploadEntry, String, ProjectPathKind)],
    top_level: &BTreeSet<String>,
) -> Result<Vec<(PathBuf, PathBuf)>, ProjectError> {
    let mut roots = BTreeMap::new();
    let result = (|| {
        for top in top_level {
            let target = resolve_project_path_for_write(root, top)?;
            let stage = sibling_temporary(&target)?;
            let top_is_file = planned
                .iter()
                .any(|(_, path, kind)| path == top && *kind == ProjectPathKind::File);
            if !top_is_file {
                fs::create_dir(&stage)?;
            }
            roots.insert(top.clone(), (stage, target));
        }
        materialize_upload_stages(target_directory, planned, &roots)
    })();
    if let Err(error) = result {
        cleanup_paths(roots.values().map(|(stage, _)| stage));
        return Err(error);
    }
    Ok(roots.into_values().collect())
}

fn materialize_upload_stages(
    target_directory: &str,
    planned: &[(&ProjectUploadEntry, String, ProjectPathKind)],
    roots: &BTreeMap<String, (PathBuf, PathBuf)>,
) -> Result<(), ProjectError> {
    let mut directories = planned
        .iter()
        .filter(|(_, _, kind)| *kind == ProjectPathKind::Directory)
        .collect::<Vec<_>>();
    directories.sort_by_key(|(_, path, _)| path.matches('/').count());
    for (_, path, _) in directories {
        fs::create_dir_all(upload_stage_path(target_directory, path, roots)?)?;
    }
    for (entry, path, kind) in planned {
        let stage = upload_stage_path(target_directory, path, roots)?;
        match entry {
            ProjectUploadEntry::File { content, .. } => {
                if let Some(parent) = stage.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut file = fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(stage)?;
                file.write_all(content)?;
                file.sync_all()?;
            }
            ProjectUploadEntry::TemporaryFile { temporary_path, .. } => {
                if let Some(parent) = stage.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(temporary_path, &stage)?;
                fs::OpenOptions::new().read(true).open(&stage)?.sync_all()?;
            }
            ProjectUploadEntry::Directory { .. } => {}
        }
        debug_assert_eq!(*kind, project_upload_kind(entry));
    }
    Ok(())
}

fn upload_stage_path(
    target_directory: &str,
    path: &str,
    roots: &BTreeMap<String, (PathBuf, PathBuf)>,
) -> Result<PathBuf, ProjectError> {
    let top = upload_top_level(target_directory, path)?;
    let stage = &roots.get(&top).ok_or(ProjectError::StatePoisoned)?.0;
    let suffix = path
        .strip_prefix(&top)
        .unwrap_or_default()
        .trim_start_matches('/');
    Ok(if suffix.is_empty() {
        stage.clone()
    } else {
        stage.join(suffix)
    })
}

fn commit_copied_paths(copies: &[(PathBuf, PathBuf)], overwrite: bool) -> Result<(), ProjectError> {
    let mut staged = Vec::new();
    for (source, target) in copies {
        let temporary = match sibling_temporary(target) {
            Ok(temporary) => temporary,
            Err(error) => {
                cleanup_paths(staged.iter().map(|(path, _): &(PathBuf, PathBuf)| path));
                return Err(error);
            }
        };
        if let Err(error) = copy_path(source, &temporary) {
            cleanup_paths(staged.iter().map(|(path, _): &(PathBuf, PathBuf)| path));
            cleanup_paths([&temporary]);
            return Err(error);
        }
        staged.push((temporary, target.clone()));
    }
    commit_staged_paths(&staged, overwrite)
}

fn commit_staged_paths(staged: &[(PathBuf, PathBuf)], overwrite: bool) -> Result<(), ProjectError> {
    let identities = match staged
        .iter()
        .map(|(temporary, _)| project_path_identity(temporary))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(identities) => identities,
        Err(error) => {
            cleanup_paths(staged.iter().map(|(path, _)| path));
            return Err(error);
        }
    };
    let backups = match backup_existing_targets(staged.iter().map(|(_, target)| target), overwrite)
    {
        Ok(backups) => backups,
        Err(error) => {
            cleanup_paths(staged.iter().map(|(path, _)| path));
            return Err(error);
        }
    };
    let mut committed: Vec<(PathBuf, debrute_native_fs::PathIdentity)> = Vec::new();
    for ((temporary, target), identity) in staged.iter().zip(identities) {
        if let Err(error) = rename_no_replace(temporary, target) {
            let mut rollback_errors = remove_committed_paths_for_rollback(&committed);
            rollback_errors.extend(restore_path_backups(&backups));
            cleanup_paths(staged.iter().map(|(path, _)| path));
            return Err(rollback_or_original(error.into(), &rollback_errors));
        }
        committed.push((target.clone(), identity));
    }
    cleanup_paths(backups.iter().map(|(_, backup)| backup));
    Ok(())
}

fn commit_moved_paths(moves: &[(PathBuf, PathBuf)], overwrite: bool) -> Result<(), ProjectError> {
    let identities = moves
        .iter()
        .map(|(source, _)| project_path_identity(source))
        .collect::<Result<Vec<_>, _>>()?;
    let backups = backup_existing_targets(moves.iter().map(|(_, target)| target), overwrite)?;
    let mut committed: Vec<(PathBuf, PathBuf, debrute_native_fs::PathIdentity)> = Vec::new();
    for ((source, target), identity) in moves.iter().zip(identities) {
        if let Err(error) = rename_no_replace(source, target) {
            let mut rollback_errors = Vec::new();
            for (previous_source, previous_target, expected_identity) in committed.iter().rev() {
                match claim_expected_path(previous_target, expected_identity) {
                    Ok(quarantine) => {
                        if let Err(rollback_error) = rename_no_replace(&quarantine, previous_source)
                        {
                            rollback_errors.push(format!(
                                "restore {} from quarantined {}: {rollback_error}",
                                previous_source.display(),
                                quarantine.display()
                            ));
                        }
                    }
                    Err(rollback_error) => rollback_errors.push(rollback_error),
                }
            }
            rollback_errors.extend(restore_path_backups(&backups));
            return Err(rollback_or_original(error.into(), &rollback_errors));
        }
        committed.push((source.clone(), target.clone(), identity));
    }
    cleanup_paths(backups.iter().map(|(_, backup)| backup));
    Ok(())
}

fn commit_deleted_paths(targets: &[PathBuf]) -> Result<(), ProjectError> {
    let mut tombstones: Vec<(PathBuf, PathBuf)> = Vec::new();
    for target in targets {
        let tombstone = match sibling_temporary(target) {
            Ok(tombstone) => tombstone,
            Err(error) => {
                let mut rollback_errors = Vec::new();
                for (previous_target, previous_tombstone) in tombstones.iter().rev() {
                    if let Err(rollback_error) =
                        rename_no_replace(previous_tombstone, previous_target)
                    {
                        rollback_errors.push(format!(
                            "restore {} from {}: {rollback_error}",
                            previous_target.display(),
                            previous_tombstone.display()
                        ));
                    }
                }
                return Err(rollback_or_original(error, &rollback_errors));
            }
        };
        if let Err(error) = rename_no_replace(target, &tombstone) {
            let mut rollback_errors = Vec::new();
            for (previous_target, previous_tombstone) in tombstones.iter().rev() {
                if let Err(rollback_error) = rename_no_replace(previous_tombstone, previous_target)
                {
                    rollback_errors.push(format!(
                        "restore {} from {}: {rollback_error}",
                        previous_target.display(),
                        previous_tombstone.display()
                    ));
                }
            }
            return Err(rollback_or_original(error.into(), &rollback_errors));
        }
        tombstones.push((target.clone(), tombstone));
    }
    cleanup_paths(tombstones.iter().map(|(_, tombstone)| tombstone));
    Ok(())
}

fn backup_existing_targets<'a>(
    targets: impl IntoIterator<Item = &'a PathBuf>,
    overwrite: bool,
) -> Result<Vec<(PathBuf, PathBuf)>, ProjectError> {
    let mut backups = Vec::new();
    for target in targets {
        if !target.exists() {
            continue;
        }
        if !overwrite {
            let error = ProjectError::Validation(format!(
                "Project path already exists: {}",
                target.display()
            ));
            return Err(rollback_or_original(error, &restore_path_backups(&backups)));
        }
        let backup = match sibling_temporary(target) {
            Ok(backup) => backup,
            Err(error) => {
                return Err(rollback_or_original(error, &restore_path_backups(&backups)));
            }
        };
        if let Err(error) = rename_no_replace(target, &backup) {
            return Err(rollback_or_original(
                error.into(),
                &restore_path_backups(&backups),
            ));
        }
        backups.push((target.clone(), backup));
    }
    Ok(backups)
}

fn restore_path_backups(backups: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut errors = Vec::new();
    for (target, backup) in backups.iter().rev() {
        if let Err(error) = rename_no_replace(backup, target) {
            errors.push(format!(
                "restore {} from {}: {error}",
                target.display(),
                backup.display()
            ));
        }
    }
    errors
}

fn remove_committed_paths_for_rollback(
    paths: &[(PathBuf, debrute_native_fs::PathIdentity)],
) -> Vec<String> {
    let mut errors = Vec::new();
    for (path, expected_identity) in paths.iter().rev() {
        match claim_expected_path(path, expected_identity) {
            Ok(quarantine) => {
                if let Err(error) = remove_path(&quarantine) {
                    errors.push(format!(
                        "remove quarantined rollback target {}: {error}",
                        quarantine.display()
                    ));
                }
            }
            Err(error) => errors.push(error),
        }
    }
    errors
}

fn claim_expected_path(
    path: &Path,
    expected_identity: &debrute_native_fs::PathIdentity,
) -> Result<PathBuf, String> {
    let quarantine = sibling_temporary(path).map_err(|error| {
        format!(
            "allocate rollback quarantine for {}: {error}",
            path.display()
        )
    })?;
    rename_no_replace(path, &quarantine).map_err(|error| {
        format!(
            "claim rollback target {} into {}: {error}",
            path.display(),
            quarantine.display()
        )
    })?;

    #[cfg(test)]
    VISIBLE_REPLACEMENT_AFTER_CLAIM.with(|replacement| {
        let mut replacement = replacement.borrow_mut();
        if replacement
            .as_ref()
            .is_some_and(|(replacement_path, _)| replacement_path == path)
            && let Some((_, content)) = replacement.take()
        {
            fs::write(path, content).expect("injected visible replacement should be written");
        }
    });

    match project_path_identity(&quarantine) {
        Ok(actual) if actual == *expected_identity => Ok(quarantine),
        inspection => {
            let reason = match inspection {
                Ok(_) => format!("rollback target changed after commit: {}", path.display()),
                Err(error) => format!("inspect rollback target {}: {error}", path.display()),
            };
            match rename_no_replace(&quarantine, path) {
                Ok(()) => Err(reason),
                Err(error) => Err(format!(
                    "{reason}; preserve unexpected object at {} after restore failed: {error}",
                    quarantine.display()
                )),
            }
        }
    }
}

#[cfg(test)]
pub(super) fn inject_visible_replacement_after_claim_for_test(path: &Path, content: &[u8]) {
    VISIBLE_REPLACEMENT_AFTER_CLAIM.with(|replacement| {
        *replacement.borrow_mut() = Some((path.to_path_buf(), content.to_vec()));
    });
}

#[cfg(test)]
pub(super) fn remove_committed_paths_for_rollback_for_test(
    paths: &[(PathBuf, debrute_native_fs::PathIdentity)],
) -> Vec<String> {
    remove_committed_paths_for_rollback(paths)
}

#[cfg(all(test, unix))]
pub(super) fn commit_staged_paths_for_test(
    staged: &[(PathBuf, PathBuf)],
) -> Result<(), ProjectError> {
    commit_staged_paths(staged, false)
}

fn project_path_identity(path: &Path) -> Result<debrute_native_fs::PathIdentity, ProjectError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(ProjectError::Validation(format!(
            "Project operation path must not contain a symbolic link: {}",
            path.display()
        )));
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(ProjectError::Validation(format!(
            "Project operation path is not a file or directory: {}",
            path.display()
        )));
    }
    debrute_native_fs::path_identity(path).map_err(ProjectError::from)
}

fn rollback_or_original(original: ProjectError, rollback_errors: &[String]) -> ProjectError {
    if rollback_errors.is_empty() {
        return original;
    }
    ProjectError::service_with_fields(
        "project_file_operation_rollback_failed",
        format!("Project file operation failed and could not be fully rolled back: {original}"),
        [
            ("original_error".to_owned(), original.to_string()),
            ("rollback_errors".to_owned(), rollback_errors.join("\n")),
        ],
    )
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path)
        }
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn cleanup_paths<'a>(paths: impl IntoIterator<Item = &'a PathBuf>) {
    for path in paths {
        if let Err(error) = remove_path(path) {
            // The logical mutation has already committed. Managed temporary paths are hidden
            // from Project snapshots, so cleanup is best-effort but must remain observable.
            eprintln!(
                "Debrute deferred cleanup for managed Project path {}: {error}",
                path.display()
            );
        }
    }
}

fn normalized_top_level_entries(
    root: &Path,
    entries: &[ProjectPathBatchEntry],
) -> Result<Vec<ProjectPathBatchEntry>, ProjectError> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        let path = normalize_project_directory_path(&entry.project_relative_path)?;
        if !seen.insert(path.clone()) {
            continue;
        }
        assert_project_tree_visible_mutation_path(&path)?;
        let kind = project_path_kind(root, &path)?;
        if kind != entry.kind {
            return Err(ProjectError::Validation(format!(
                "Project path kind mismatch: {path}"
            )));
        }
        normalized.push(ProjectPathBatchEntry {
            project_relative_path: path,
            kind,
        });
    }
    let mut top_level = Vec::<ProjectPathBatchEntry>::new();
    for entry in normalized {
        if top_level.iter().any(|candidate| {
            is_same_or_child(
                &entry.project_relative_path,
                &candidate.project_relative_path,
            )
        }) {
            continue;
        }
        top_level.retain(|candidate| {
            !is_same_or_child(
                &candidate.project_relative_path,
                &entry.project_relative_path,
            )
        });
        top_level.push(entry);
    }
    Ok(top_level)
}

fn project_path_kind(root: &Path, relative: &str) -> Result<ProjectPathKind, ProjectError> {
    let metadata = fs::metadata(resolve_no_symlink_existing_project_path(root, relative)?)?;
    if metadata.is_dir() {
        Ok(ProjectPathKind::Directory)
    } else if metadata.is_file() {
        Ok(ProjectPathKind::File)
    } else {
        Err(ProjectError::Validation(format!(
            "Project path is not a file or directory: {relative}"
        )))
    }
}

fn assert_directory(root: &Path, relative: &str) -> Result<(), ProjectError> {
    if fs::metadata(resolve_no_symlink_existing_project_path(root, relative)?)?.is_dir() {
        Ok(())
    } else {
        Err(ProjectError::Validation(format!(
            "Project path is not a directory: {relative}"
        )))
    }
}

fn unique_paste_target(
    root: &Path,
    directory: &str,
    source_name: &str,
    reserved: &BTreeSet<String>,
) -> Result<String, ProjectError> {
    let name = normalize_project_path_basename(source_name)?;
    let extension = Path::new(&name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    let stem = name.strip_suffix(&extension).unwrap_or(&name);
    let mut index = 0;
    loop {
        let candidate_name = match index {
            0 => name.clone(),
            1 => format!("{stem} copy{extension}"),
            _ => format!("{stem} copy {index}{extension}"),
        };
        let candidate = join_project_path(directory, &candidate_name)?;
        if !reserved.contains(&candidate)
            && !resolve_project_path_for_write(root, &candidate)?.exists()
        {
            return Ok(candidate);
        }
        index += 1;
    }
}

fn copy_path(source: &Path, destination: &Path) -> Result<(), ProjectError> {
    let metadata = fs::metadata(source)?;
    if metadata.is_file() {
        fs::copy(source, destination)?;
        return Ok(());
    }
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(ProjectError::Validation(format!(
                "External source path must not contain a symbolic link: {}",
                entry.path().display()
            )));
        }
        copy_path(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

fn validate_copy_tree(source: &Path) -> Result<(), ProjectError> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(ProjectError::Validation(format!(
            "External source path must not contain a symbolic link: {}",
            source.display()
        )));
    }
    if metadata.is_file() {
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(ProjectError::Validation(format!(
            "External source path is not a file or directory: {}",
            source.display()
        )));
    }
    for entry in fs::read_dir(source)? {
        validate_copy_tree(&entry?.path())?;
    }
    Ok(())
}

fn sibling_temporary(path: &Path) -> Result<PathBuf, ProjectError> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| ProjectError::Validation("Project file name is invalid.".to_owned()))?;
    Ok(path.with_file_name(format!("{name}.{}.tmp", Uuid::new_v4())))
}

fn is_same_or_child(candidate: &str, parent: &str) -> bool {
    candidate == parent || candidate.starts_with(&format!("{parent}/"))
}

fn is_strict_child(candidate: &str, parent: &str) -> bool {
    if parent.is_empty() {
        !candidate.is_empty()
    } else {
        candidate.starts_with(&format!("{parent}/"))
    }
}

fn upload_top_level(target: &str, path: &str) -> Result<String, ProjectError> {
    let relative = if target.is_empty() {
        path
    } else {
        path.strip_prefix(&format!("{target}/")).ok_or_else(|| {
            ProjectError::Validation(format!(
                "Uploaded project path must be inside import target directory: {path}"
            ))
        })?
    };
    join_project_path(target, relative.split('/').next().unwrap_or_default())
}

fn project_upload_kind(entry: &ProjectUploadEntry) -> ProjectPathKind {
    match entry {
        ProjectUploadEntry::Directory { .. } => ProjectPathKind::Directory,
        ProjectUploadEntry::File { .. } | ProjectUploadEntry::TemporaryFile { .. } => {
            ProjectPathKind::File
        }
    }
}

fn project_text_type(path: &str, first_line: &str) -> (&'static str, &'static str) {
    project_text_file_type_for_path(path, Some(first_line)).unwrap_or(("plaintext", "text/plain"))
}

/// Resolves the registered text language and MIME type for a path or first line.
#[must_use]
pub fn project_text_file_type_for_path(
    path: &str,
    first_line: Option<&str>,
) -> Option<(&'static str, &'static str)> {
    let lower = path.to_ascii_lowercase();
    let filename = lower.rsplit('/').next().unwrap_or(&lower);
    PROJECT_TEXT_FILE_TYPES
        .iter()
        .find(|kind| kind.filenames.contains(&filename))
        .or_else(|| {
            PROJECT_TEXT_FILE_TYPES.iter().find(|kind| {
                kind.patterns.iter().any(|pattern| {
                    let candidate = if pattern.contains('/') {
                        &lower
                    } else {
                        filename
                    };
                    text_filename_pattern_matches(pattern, candidate)
                })
            })
        })
        .or_else(|| {
            PROJECT_TEXT_FILE_TYPES.iter().find(|kind| {
                kind.extensions
                    .iter()
                    .any(|extension| lower.ends_with(extension))
            })
        })
        .map(|kind| (kind.language, kind.mime_type))
        .or_else(|| first_line.and_then(project_text_first_line_type))
}

struct ProjectTextFileType {
    language: &'static str,
    mime_type: &'static str,
    extensions: &'static [&'static str],
    filenames: &'static [&'static str],
    patterns: &'static [&'static str],
}

const fn text_type(
    language: &'static str,
    mime_type: &'static str,
    extensions: &'static [&'static str],
    filenames: &'static [&'static str],
    patterns: &'static [&'static str],
) -> ProjectTextFileType {
    ProjectTextFileType {
        language,
        mime_type,
        extensions,
        filenames,
        patterns,
    }
}

const PROJECT_TEXT_FILE_TYPES: &[ProjectTextFileType] = &[
    text_type(
        "markdown",
        "text/markdown",
        &[
            ".md",
            ".markdown",
            ".mkd",
            ".mkdn",
            ".mdwn",
            ".mdown",
            ".markdn",
            ".mdtxt",
            ".mdtext",
            ".mdc",
            ".prompt.md",
            ".instructions.md",
            ".agent.md",
            ".chatmode.md",
        ],
        &["skill.md", "copilot-instructions.md"],
        &[],
    ),
    text_type(
        "jsonl",
        "application/jsonl",
        &[".jsonl", ".ndjson"],
        &[],
        &[],
    ),
    text_type(
        "jsonc",
        "application/jsonc",
        &[
            ".jsonc",
            ".code-workspace",
            ".code-profile",
            ".eslintrc",
            ".eslintrc.json",
            ".jsfmtrc",
            ".jshintrc",
            ".swcrc",
            ".hintrc",
            ".babelrc",
            ".toolset.jsonc",
        ],
        &[
            "tsconfig.json",
            "jsconfig.json",
            "settings.json",
            "launch.json",
            "tasks.json",
            "mcp.json",
            "keybindings.json",
            "extensions.json",
            "argv.json",
            "profiles.json",
            "devcontainer.json",
            ".devcontainer.json",
            "babel.config.json",
            "bun.lock",
            ".babelrc.json",
            ".ember-cli",
            "typedoc.json",
        ],
        &[
            "tsconfig.*.json",
            "jsconfig.*.json",
            "tsconfig-*.json",
            "jsconfig-*.json",
            "**/.github/hooks/*.json",
        ],
    ),
    text_type(
        "json",
        "application/json",
        &[
            ".json",
            ".bowerrc",
            ".jscsrc",
            ".webmanifest",
            ".js.map",
            ".css.map",
            ".ts.map",
            ".har",
            ".jslintrc",
            ".jsonld",
            ".geojson",
            ".ipynb",
            ".vuerc",
            ".tsbuildinfo",
            ".code-snippets",
        ],
        &["package.json", "composer.lock", ".watchmanconfig"],
        &["**/snippets*.json"],
    ),
    text_type(
        "yaml",
        "application/yaml",
        &[
            ".yaml",
            ".yml",
            ".eyaml",
            ".eyml",
            ".cff",
            ".yaml-tmlanguage",
            ".yaml-tmpreferences",
            ".yaml-tmtheme",
            ".winget",
        ],
        &[],
        &[
            "compose.yml",
            "compose.yaml",
            "compose.*.yml",
            "compose.*.yaml",
            "*docker*compose*.yml",
            "*docker*compose*.yaml",
        ],
    ),
    text_type(
        "shell",
        "text/x-shellscript",
        &[
            ".sh",
            ".bash",
            ".bashrc",
            ".bash_aliases",
            ".bash_profile",
            ".bash_login",
            ".bash_logout",
            ".profile",
            ".zsh",
            ".zshrc",
            ".zprofile",
            ".zlogin",
            ".zlogout",
            ".zshenv",
            ".zsh-theme",
            ".fish",
            ".ksh",
            ".csh",
            ".cshrc",
            ".tcshrc",
            ".yashrc",
            ".yash_profile",
            ".xprofile",
            ".xsession",
            ".xsessionrc",
        ],
        &[
            "apkbuild",
            "pkgbuild",
            ".envrc",
            ".hushlogin",
            "zshrc",
            "zshenv",
            "zlogin",
            "zprofile",
            "zlogout",
            "bashrc_apple_terminal",
            "zshrc_apple_terminal",
        ],
        &[],
    ),
    text_type(
        "dotenv",
        "text/plain",
        &[".env"],
        &[".env", ".flaskenv", "user-dirs.dirs"],
        &[".env.*"],
    ),
    text_type("ini", "text/plain", &[".ini"], &[], &[]),
    text_type(
        "properties",
        "text/plain",
        &[
            ".conf",
            ".properties",
            ".cfg",
            ".directory",
            ".gitattributes",
            ".gitconfig",
            ".gitmodules",
            ".editorconfig",
            ".repo",
        ],
        &["gitconfig", ".npmrc"],
        &["**/.config/git/config", "**/.git/config"],
    ),
    text_type("log", "text/plain", &[".log"], &[], &["*.log.?"]),
    text_type(
        "html",
        "text/html",
        &[
            ".html", ".htm", ".shtml", ".xhtml", ".xht", ".mdoc", ".jsp", ".asp", ".aspx",
            ".jshtm", ".volt", ".ejs", ".rhtml",
        ],
        &[],
        &[],
    ),
    text_type("scss", "text/css", &[".scss"], &[], &[]),
    text_type("less", "text/css", &[".less"], &[], &[]),
    text_type("css", "text/css", &[".css"], &[], &[]),
    text_type(
        "xml",
        "application/xml",
        &[
            ".xml", ".xsd", ".atom", ".axml", ".axaml", ".bpmn", ".csl", ".csproj", ".dita",
            ".ditamap", ".dtd", ".fxml", ".iml", ".jmx", ".launch", ".mxml", ".nuspec", ".opml",
            ".proj", ".props", ".pubxml", ".targets", ".tmx", ".wixproj", ".wxi", ".wxl", ".wxs",
            ".xaml", ".xib", ".xlf", ".xliff", ".xsl", ".xslt",
        ],
        &[],
        &[],
    ),
    text_type("javascriptreact", "text/javascript", &[".jsx"], &[], &[]),
    text_type(
        "javascript",
        "text/javascript",
        &[".js", ".mjs", ".cjs", ".es6", ".pac"],
        &["jakefile"],
        &[],
    ),
    text_type("typescriptreact", "text/typescript", &[".tsx"], &[], &[]),
    text_type(
        "typescript",
        "text/typescript",
        &[".ts", ".cts", ".mts"],
        &[],
        &[],
    ),
    text_type(
        "python",
        "text/x-python",
        &[
            ".py", ".pyw", ".pyi", ".gyp", ".gypi", ".rpy", ".cpy", ".ipy", ".pyt",
        ],
        &["sconstruct", "sconscript"],
        &[],
    ),
    text_type(
        "ruby",
        "text/x-ruby",
        &[
            ".rb", ".rbx", ".rjs", ".gemspec", ".rake", ".ru", ".erb", ".podspec", ".rbi",
        ],
        &[
            "rakefile",
            "gemfile",
            "guardfile",
            "podfile",
            "capfile",
            "vagrantfile",
            "brewfile",
            "fastfile",
            "appfile",
        ],
        &[],
    ),
    text_type(
        "php",
        "application/x-httpd-php",
        &[".php", ".php4", ".php5", ".phtml", ".ctp"],
        &[],
        &[],
    ),
    text_type("sql", "application/sql", &[".sql", ".dsql"], &[], &[]),
    text_type(
        "powershell",
        "text/plain",
        &[".ps1", ".psm1", ".psd1", ".pssc", ".psrc"],
        &[],
        &[],
    ),
    text_type("bat", "text/plain", &[".bat", ".cmd"], &[], &[]),
    text_type("go", "text/x-go", &[".go"], &[], &[]),
    text_type("rust", "text/x-rustsrc", &[".rs"], &[], &[]),
    text_type("java", "text/x-java-source", &[".java", ".jav"], &[], &[]),
    text_type(
        "cpp",
        "text/x-c++src",
        &[
            ".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h++", ".ipp", ".inl", ".tpp",
            ".txx",
        ],
        &[],
        &[],
    ),
    text_type("c", "text/x-csrc", &[".c", ".h", ".i"], &[], &[]),
    text_type("lua", "text/x-lua", &[".lua"], &[], &[]),
    text_type(
        "perl",
        "text/x-perl",
        &[".pl", ".pm", ".pod", ".t"],
        &[],
        &[],
    ),
    text_type(
        "r",
        "text/x-r-source",
        &[".r", ".rprofile", ".rhistory", ".rt"],
        &[],
        &[],
    ),
    text_type(
        "dockerfile",
        "text/plain",
        &[".dockerfile", ".containerfile"],
        &["dockerfile", "containerfile"],
        &["dockerfile.*", "containerfile.*"],
    ),
    text_type(
        "makefile",
        "text/plain",
        &[".mk", ".mak"],
        &["makefile", "gnumakefile", "ocamlmakefile"],
        &[],
    ),
    text_type("diff", "text/plain", &[".diff", ".patch", ".rej"], &[], &[]),
    text_type("csv", "text/csv", &[".csv"], &[], &[]),
    text_type("tsv", "text/tab-separated-values", &[".tsv"], &[], &[]),
    text_type(
        "subtitle",
        "text/plain",
        &[".srt", ".ass", ".ssa", ".sbv"],
        &[],
        &[],
    ),
    text_type("webvtt", "text/vtt", &[".vtt"], &[], &[]),
    text_type("toml", "application/toml", &[".toml"], &[], &[]),
    text_type(
        "tex",
        "application/x-tex",
        &[".tex", ".latex", ".ltx", ".sty", ".cls"],
        &[],
        &[],
    ),
    text_type("textile", "text/x-textile", &[".textile"], &[], &[]),
    text_type("protobuf", "text/x-protobuf", &[".proto"], &[], &[]),
    text_type("restructuredtext", "text/x-rst", &[".rst"], &[], &[]),
    text_type(
        "asciidoc",
        "text/x-asciidoc",
        &[".adoc", ".asciidoc"],
        &[],
        &[],
    ),
    text_type("org", "text/x-org", &[".org"], &[], &[]),
    text_type(
        "plaintext",
        "text/plain",
        &[".txt"],
        &[
            "license",
            ".gitignore",
            "readme",
            "changelog",
            "contributing",
            "notice",
            "authors",
            "copying",
        ],
        &[],
    ),
];

fn project_text_first_line_type(first_line: &str) -> Option<(&'static str, &'static str)> {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str, &'static str)>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            [
                (r"^#cloud-config\b", "yaml", "application/yaml"),
                (
                    r"^#!.*\b(?:bash|fish|zsh|sh|ksh|dtksh|pdksh|mksh|ash|dash|yash|csh|jcsh|tcsh|itcsh)\b",
                    "shell",
                    "text/x-shellscript",
                ),
                (r"(?i)^<\?xml\b", "xml", "application/xml"),
                (r"^#!.*\bnode\b", "javascript", "text/javascript"),
                (
                    r"^#!.*\b(?:deno|bun|ts-node)\b",
                    "typescript",
                    "text/typescript",
                ),
                (r"^#!\s*/?.*\bpython[0-9.-]*\b", "python", "text/x-python"),
                (r"^#!\s*/.*\bruby\b", "ruby", "text/x-ruby"),
                (r"^#!\s*/.*\bphp\b", "php", "application/x-httpd-php"),
                (r"^#!\s*/.*\bpwsh\b", "powershell", "text/plain"),
                (r"^#!\s*/usr/bin/make\b", "makefile", "text/plain"),
            ]
            .into_iter()
            .map(|(pattern, language, mime_type)| {
                (
                    Regex::new(pattern).expect("Project text first-line regex is static"),
                    language,
                    mime_type,
                )
            })
            .collect()
        })
        .iter()
        .find(|(pattern, _, _)| pattern.is_match(first_line))
        .map(|(_, language, mime_type)| (*language, *mime_type))
}

fn text_filename_pattern_matches(pattern: &str, value: &str) -> bool {
    let chars = pattern.chars().collect::<Vec<_>>();
    let mut source = String::from("(?i)^");
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '*' && chars.get(index + 1) == Some(&'*') {
            if chars.get(index + 2) == Some(&'/') {
                source.push_str("(?:.*/)?");
                index += 3;
            } else {
                source.push_str(".*");
                index += 2;
            }
        } else if chars[index] == '*' {
            source.push_str("[^/]*");
            index += 1;
        } else if chars[index] == '?' {
            source.push_str("[^/]");
            index += 1;
        } else {
            source.push_str(&regex::escape(&chars[index].to_string()));
            index += 1;
        }
    }
    source.push('$');
    Regex::new(&source).is_ok_and(|regex| regex.is_match(value))
}
