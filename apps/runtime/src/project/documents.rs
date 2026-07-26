use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use fs2::{FileExt, lock_contended_error};
use uuid::Uuid;

#[cfg(test)]
use std::cell::RefCell;

use super::{
    ProjectError, project_content_hash, replace_file, resolve_no_symlink_project_path_for_write,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectDocumentRole {
    Source,
    Pushed,
    Metadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDocumentDescriptor {
    pub document_type: &'static str,
    pub path_pattern: &'static str,
    pub role: ProjectDocumentRole,
    pub owners: &'static [&'static str],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDocumentRead {
    pub absolute_path: PathBuf,
    pub expected_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDocumentWrite {
    pub absolute_path: PathBuf,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDocumentDelete {
    pub absolute_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDocumentTransaction {
    pub project_root: PathBuf,
    pub owner: String,
    pub reads: Vec<ProjectDocumentRead>,
    pub writes: Vec<ProjectDocumentWrite>,
    pub deletes: Vec<ProjectDocumentDelete>,
}

#[cfg(test)]
#[derive(Default)]
struct DocumentTransactionFaults {
    fail_commit_after_writes: Option<usize>,
    fail_rollback: bool,
}

#[cfg(test)]
thread_local! {
    static DOCUMENT_TRANSACTION_FAULTS: RefCell<DocumentTransactionFaults> = RefCell::default();
}

#[cfg(test)]
pub(super) fn inject_document_rollback_failure_for_test() {
    DOCUMENT_TRANSACTION_FAULTS.with(|faults| {
        *faults.borrow_mut() = DocumentTransactionFaults {
            fail_commit_after_writes: Some(1),
            fail_rollback: true,
        };
    });
}

#[must_use]
pub fn project_document_descriptor(path: &str) -> Option<ProjectDocumentDescriptor> {
    let path = path.replace('\\', "/");
    if match_canvas_document(&path, ".debrute/canvas-maps/", ".yaml", false) {
        return Some(descriptor(
            "canvas-map",
            ".debrute/canvas-maps/<canvas-id>.yaml",
            ProjectDocumentRole::Source,
            &["canvas-map", "canvas-registry"],
        ));
    }
    if path == ".debrute/canvases/index.json" {
        return Some(descriptor(
            "canvas-registry",
            ".debrute/canvases/index.json",
            ProjectDocumentRole::Source,
            &["canvas-registry"],
        ));
    }
    if match_canvas_document(&path, ".debrute/canvases/", ".json", false)
        && path != ".debrute/canvases/index.json"
    {
        return Some(descriptor(
            "canvas-document",
            ".debrute/canvases/<canvas-id>.json",
            ProjectDocumentRole::Pushed,
            &["canvas", "canvas-map", "canvas-registry"],
        ));
    }
    if path == ".debrute/reviews/canvas-feedback.json" {
        return Some(descriptor(
            "canvas-feedback",
            ".debrute/reviews/canvas-feedback.json",
            ProjectDocumentRole::Metadata,
            &["canvas-feedback"],
        ));
    }
    None
}

const fn descriptor(
    document_type: &'static str,
    path_pattern: &'static str,
    role: ProjectDocumentRole,
    owners: &'static [&'static str],
) -> ProjectDocumentDescriptor {
    ProjectDocumentDescriptor {
        document_type,
        path_pattern,
        role,
        owners,
    }
}

fn match_canvas_document(path: &str, prefix: &str, suffix: &str, allow_dot: bool) -> bool {
    let Some(id) = path
        .strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(suffix))
    else {
        return false;
    };
    !id.is_empty()
        && id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || (index > 0 && matches!(byte, b'_' | b'-'))
                || (allow_dot && index > 0 && byte == b'.')
        })
}

/// Reads the current content hash of a registered document candidate.
///
/// # Errors
/// Returns an I/O error when an existing path cannot be read.
pub fn project_document_file_hash(path: &Path) -> Result<Option<String>, ProjectError> {
    match fs::read(path) {
        Ok(content) => Ok(Some(project_content_hash(content))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn project_document_directory_hash(path: &Path) -> Result<Option<String>, ProjectError> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut members = Vec::new();
    for entry in entries {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let kind = if file_type.is_file() {
            "file"
        } else if file_type.is_dir() {
            "directory"
        } else if file_type.is_symlink() {
            "symlink"
        } else {
            "other"
        };
        members.push(format!("{kind}:{}", entry.file_name().to_string_lossy()));
    }
    members.sort();
    Ok(Some(project_content_hash(members.join("\0"))))
}

/// Commits a locked, compare-and-swap Project document transaction atomically.
///
/// # Errors
/// Returns a descriptor, ownership, conflict, staging, commit, or rollback error.
pub(crate) fn commit_project_document_transaction(
    input: &ProjectDocumentTransaction,
) -> Result<(), ProjectError> {
    let prepared = prepare_document_transaction(input).map_err(normalize_document_error)?;
    let mut locks = Vec::new();
    let mut staged = Vec::new();
    let result = execute_document_transaction(&prepared, &mut locks, &mut staged);
    let cleanup = cleanup_document_transaction(&staged, locks);
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(normalize_document_error(error)),
        (Ok(()), Err(cleanup_error)) => {
            eprintln!(
                "Debrute Project document transaction committed but cleanup failed: {cleanup_error}"
            );
            Ok(())
        }
        (Err(error), Err(cleanup_error)) => {
            eprintln!("Debrute Project document transaction cleanup also failed: {cleanup_error}");
            Err(normalize_document_error(error))
        }
    }
}

fn normalize_document_error(error: ProjectError) -> ProjectError {
    if error.code().starts_with("document_") {
        error
    } else {
        ProjectError::service("document_push_failed", error.to_string())
    }
}

struct PreparedDocumentTransaction {
    project_root: PathBuf,
    reads: Vec<(PathBuf, Option<String>)>,
    writes: Vec<(PathBuf, String)>,
    deletes: Vec<PathBuf>,
    targets: BTreeSet<PathBuf>,
    lock_targets: BTreeSet<PathBuf>,
}

fn prepare_document_transaction(
    input: &ProjectDocumentTransaction,
) -> Result<PreparedDocumentTransaction, ProjectError> {
    let declared_root = if input.project_root.is_absolute() {
        input.project_root.clone()
    } else {
        std::env::current_dir()?.join(&input.project_root)
    };
    let root = declared_root.canonicalize()?;
    let reads = input
        .reads
        .iter()
        .map(|read| {
            Ok((
                resolve_document_path(&declared_root, &root, &read.absolute_path, None)?,
                read.expected_hash.clone(),
            ))
        })
        .collect::<Result<Vec<_>, ProjectError>>()?;
    let writes = input
        .writes
        .iter()
        .map(|write| {
            Ok((
                resolve_document_path(
                    &declared_root,
                    &root,
                    &write.absolute_path,
                    Some(&input.owner),
                )?,
                write.content.clone(),
            ))
        })
        .collect::<Result<Vec<_>, ProjectError>>()?;
    let deletes = input
        .deletes
        .iter()
        .map(|delete| {
            resolve_document_path(
                &declared_root,
                &root,
                &delete.absolute_path,
                Some(&input.owner),
            )
        })
        .collect::<Result<Vec<_>, ProjectError>>()?;
    let mut targets = BTreeSet::new();
    for target in writes.iter().map(|(path, _)| path).chain(deletes.iter()) {
        if !targets.insert(target.clone()) {
            return Err(document_error(
                "document_descriptor_violation",
                "Project document transaction contains duplicate targets.",
                target,
            ));
        }
    }

    let mut lock_targets = targets.clone();
    for (path, _) in &reads {
        lock_targets.insert(path.clone());
    }
    Ok(PreparedDocumentTransaction {
        project_root: root,
        reads,
        writes,
        deletes,
        targets,
        lock_targets,
    })
}

fn execute_document_transaction(
    prepared: &PreparedDocumentTransaction,
    locks: &mut Vec<fs::File>,
    staged: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(), ProjectError> {
    acquire_document_locks(&prepared.project_root, &prepared.lock_targets, locks)?;
    let backups = read_document_backups(&prepared.targets)?;
    for (path, expected) in &prepared.reads {
        let actual = if path.is_dir() {
            project_document_directory_hash(path)?
        } else {
            project_document_file_hash(path)?
        };
        if &actual != expected {
            return Err(document_error(
                "document_push_conflict",
                "Project document changed on disk before push commit.",
                path,
            ));
        }
    }
    for (path, content) in &prepared.writes {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = sibling_temporary(path, "tmp")?;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        staged.push((temporary, path.clone()));
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    if let Err(commit_error) = commit_staged_documents(staged, &prepared.deletes) {
        if let Err(rollback_error) = restore_backups(&backups) {
            return Err(ProjectError::service_with_fields(
                "document_push_rollback_failed",
                format!("{commit_error} Rollback cleanup failed: {rollback_error}"),
                [
                    ("commit_error".to_owned(), commit_error.to_string()),
                    ("rollback_error".to_owned(), rollback_error.to_string()),
                ],
            ));
        }
        return Err(ProjectError::service(
            "document_push_failed",
            commit_error.to_string(),
        ));
    }
    Ok(())
}

fn acquire_document_locks(
    project_root: &Path,
    targets: &BTreeSet<PathBuf>,
    locks: &mut Vec<fs::File>,
) -> Result<(), ProjectError> {
    let lock_directory =
        resolve_no_symlink_project_path_for_write(project_root, ".debrute/cache/document-locks")?;
    fs::create_dir_all(&lock_directory)?;
    for path in targets {
        let lock_path = project_document_lock_path(project_root, path);
        let handle = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;
        match handle.try_lock_exclusive() {
            // The lock file is an enduring rendezvous inode. Removing it after unlock would
            // allow a waiter on the old inode and a newcomer on a recreated inode to hold two
            // independent exclusive locks at the same time.
            Ok(()) => locks.push(handle),
            Err(error) if error.kind() == lock_contended_error().kind() => {
                return Err(document_error(
                    "document_push_conflict",
                    "Project document is locked by another writer.",
                    path,
                ));
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn cleanup_document_transaction(
    staged: &[(PathBuf, PathBuf)],
    locks: Vec<fs::File>,
) -> std::io::Result<()> {
    let mut first_error = None;
    for (temporary, _) in staged {
        if let Err(error) = fs::remove_file(temporary)
            && error.kind() != std::io::ErrorKind::NotFound
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    for handle in locks.into_iter().rev() {
        if let Err(error) = FileExt::unlock(&handle)
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

pub(super) fn project_document_lock_path(project_root: &Path, target: &Path) -> PathBuf {
    let identity = target.strip_prefix(project_root).unwrap_or(target);
    let identity = identity.to_string_lossy().replace('\\', "/");
    project_root
        .join(".debrute/cache/document-locks")
        .join(format!(
            "{}.lock",
            project_content_hash(identity.as_bytes())
        ))
}

fn read_document_backups(
    targets: &BTreeSet<PathBuf>,
) -> Result<BTreeMap<PathBuf, Option<Vec<u8>>>, ProjectError> {
    targets
        .iter()
        .map(|path| {
            let content = match fs::read(path) {
                Ok(content) => Some(content),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            Ok((path.clone(), content))
        })
        .collect()
}

fn commit_staged_documents(
    staged: &[(PathBuf, PathBuf)],
    deletes: &[PathBuf],
) -> std::io::Result<()> {
    for (index, (temporary, target)) in staged.iter().enumerate() {
        #[cfg(not(test))]
        let _ = index;
        replace_file(temporary, target)?;
        #[cfg(test)]
        {
            if DOCUMENT_TRANSACTION_FAULTS.with(|faults| {
                let mut faults = faults.borrow_mut();
                if faults.fail_commit_after_writes == Some(index + 1) {
                    faults.fail_commit_after_writes = None;
                    true
                } else {
                    false
                }
            }) {
                return Err(std::io::Error::other(
                    "injected Project document commit failure",
                ));
            }
        }
    }
    for target in deletes {
        match fs::remove_file(target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn resolve_document_path(
    declared_root: &Path,
    canonical_root: &Path,
    absolute: &Path,
    owner: Option<&str>,
) -> Result<PathBuf, ProjectError> {
    let relative = absolute
        .strip_prefix(declared_root)
        .or_else(|_| absolute.strip_prefix(canonical_root))
        .map_err(|_| {
            document_error(
                "document_descriptor_violation",
                "Project document path is outside the project root.",
                absolute,
            )
        })?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    if owner.is_none()
        && matches!(
            relative.as_str(),
            ".debrute/canvas-maps" | ".debrute/canvases"
        )
    {
        return resolve_no_symlink_project_path_for_write(canonical_root, &relative);
    }
    let descriptor = project_document_descriptor(&relative).ok_or_else(|| {
        document_error(
            "document_descriptor_violation",
            "Project document path is not registered.",
            absolute,
        )
    })?;
    if let Some(owner) = owner
        && !descriptor.owners.contains(&owner)
    {
        return Err(ProjectError::service_with_fields(
            "document_descriptor_violation",
            "Project document owner is not allowed to write this document.",
            [
                ("file_path".to_owned(), absolute.display().to_string()),
                ("owner".to_owned(), owner.to_owned()),
                (
                    "document_type".to_owned(),
                    descriptor.document_type.to_owned(),
                ),
            ],
        ));
    }
    resolve_no_symlink_project_path_for_write(canonical_root, &relative)
}

fn restore_backups(backups: &BTreeMap<PathBuf, Option<Vec<u8>>>) -> Result<(), ProjectError> {
    #[cfg(test)]
    if DOCUMENT_TRANSACTION_FAULTS.with(|faults| {
        let mut faults = faults.borrow_mut();
        let fail = faults.fail_rollback;
        faults.fail_rollback = false;
        fail
    }) {
        return Err(ProjectError::service(
            "document_push_failed",
            "injected Project document rollback failure",
        ));
    }
    for (path, content) in backups {
        match content {
            Some(content) => {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let temporary = sibling_temporary(path, "restore.tmp")?;
                fs::write(&temporary, content)?;
                replace_file(&temporary, path)?;
            }
            None => match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            },
        }
    }
    Ok(())
}

fn sibling_temporary(path: &Path, suffix: &str) -> Result<PathBuf, ProjectError> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| ProjectError::Validation("Project document name is invalid.".to_owned()))?;
    Ok(path.with_file_name(format!("{name}.{}.{}", Uuid::new_v4(), suffix)))
}

fn document_error(code: &'static str, message: &str, path: &Path) -> ProjectError {
    ProjectError::service_with_fields(
        code,
        message,
        [("file_path".to_owned(), path.display().to_string())],
    )
}
