//! Closed macOS/Windows Project file-manager actions.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use crate::{
    process::{BoundedProcessSupervisor, ProcessCancellation, ProcessRequest, WorkerKind},
    workers::RuntimeWorkerServices,
};

use super::{
    ProjectCapabilityFs, ProjectError, ProjectPathKind, assert_project_tree_visible_path,
    resolve_no_symlink_existing_project_path,
};

const NATIVE_SHELL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectNativePathEntry {
    pub project_relative_path: String,
    pub kind: ProjectPathKind,
}

pub struct ProjectNativeShellService {
    supervisor: Arc<BoundedProcessSupervisor>,
}

impl ProjectNativeShellService {
    #[must_use]
    pub fn new(workers: &RuntimeWorkerServices) -> Self {
        Self {
            supervisor: workers.supervisor(),
        }
    }

    /// Opens the platform Project-directory picker owned by the Runtime.
    ///
    /// # Errors
    /// Returns an error when the native picker cannot be started or reports a
    /// failure distinct from an explicit user cancellation.
    pub fn choose_directory(&self) -> Result<Option<PathBuf>, ProjectError> {
        let (executable, args) = directory_picker_command()?;
        let output = self.supervisor.run(
            ProcessRequest::new(
                WorkerKind::NativeShell,
                executable,
                args,
                NATIVE_SHELL_TIMEOUT,
            ),
            &ProcessCancellation::default(),
        );
        if output.ok {
            let selected = output.stdout.trim();
            return Ok((!selected.is_empty()).then(|| PathBuf::from(selected)));
        }
        let error = output.stderr.trim();
        if output.exit_code == Some(1) && error.to_ascii_lowercase().contains("cancel") {
            return Ok(None);
        }
        Err(ProjectError::service(
            "native_project_picker_failed",
            if error.is_empty() {
                "Native Project picker failed.".to_owned()
            } else {
                error.to_owned()
            },
        ))
    }

    /// Resolves a fully validated batch for clipboard presentation by the Workbench.
    ///
    /// # Errors
    /// Returns an error before producing any result when one entry is invalid.
    pub fn copy_absolute_paths(
        &self,
        project_root: &Path,
        entries: &[ProjectNativePathEntry],
    ) -> Result<Vec<PathBuf>, ProjectError> {
        validate_entries(project_root, entries)
            .map(|entries| entries.into_iter().map(|entry| entry.absolute).collect())
    }

    /// Opens a directory or selects a file in the platform file manager.
    ///
    /// # Errors
    /// Returns an error for an invalid Project path or failed native action.
    pub fn reveal(
        &self,
        project_root: &Path,
        entry: &ProjectNativePathEntry,
    ) -> Result<(), ProjectError> {
        let resolved = validate_entry(project_root, entry)?;
        let action = reveal_action(&resolved.absolute, entry.kind)?;
        self.run(action, Some(&resolved))
    }

    /// Moves every top-level selected Project path to the system trash.
    ///
    /// The complete batch is validated before the first native effect. There is no retry.
    ///
    /// # Errors
    /// Returns the first native failure after any earlier successful effects.
    pub fn trash(
        &self,
        project_root: &Path,
        entries: &[ProjectNativePathEntry],
    ) -> Result<Vec<ProjectNativePathEntry>, ProjectError> {
        ensure_trash_supported()?;
        let resolved = top_level_resolved_entries(validate_entries(project_root, entries)?)?;
        preflight_trash_staging(project_root, &resolved)?;
        for entry in &resolved {
            let quarantined = QuarantinedEntry::claim(entry)?;
            quarantined.revalidate()?;
            if let Err(error) = self.run(trash_action(&quarantined.absolute)?, None) {
                return Err(ProjectError::service_with_fields(
                    "native_shell_trash_quarantined",
                    format!(
                        "Native trash failed after the Project entry was moved into its Runtime-owned staging directory: {error}"
                    ),
                    [(
                        "quarantine_absolute_path".to_owned(),
                        quarantined.absolute.to_string_lossy().into_owned(),
                    )],
                ));
            }
            quarantined.confirm_consumed()?;
        }
        Ok(resolved
            .into_iter()
            .map(|entry| ProjectNativePathEntry {
                project_relative_path: entry.relative,
                kind: entry.kind,
            })
            .collect())
    }

    fn run(&self, action: NativeAction, entry: Option<&ResolvedEntry>) -> Result<(), ProjectError> {
        if let Some(entry) = entry {
            entry.revalidate()?;
        }
        let output = self.supervisor.run(
            ProcessRequest::new(
                WorkerKind::NativeShell,
                action.executable,
                action.args,
                NATIVE_SHELL_TIMEOUT,
            ),
            &ProcessCancellation::default(),
        );
        if output.ok {
            Ok(())
        } else {
            Err(ProjectError::service(
                "native_shell_failed",
                if output.stderr.trim().is_empty() {
                    "Native Project shell action failed.".to_owned()
                } else {
                    output.stderr.trim().to_owned()
                },
            ))
        }
    }
}

#[cfg(target_os = "macos")]
#[allow(clippy::unnecessary_wraps)]
fn directory_picker_command() -> Result<(PathBuf, Vec<String>), ProjectError> {
    Ok((
        PathBuf::from("/usr/bin/osascript"),
        vec![
            "-e".to_owned(),
            "POSIX path of (choose folder with prompt \"Open Debrute Project\")".to_owned(),
        ],
    ))
}

#[cfg(target_os = "windows")]
#[allow(clippy::unnecessary_wraps)]
fn directory_picker_command() -> Result<(PathBuf, Vec<String>), ProjectError> {
    Ok((
        PathBuf::from("powershell.exe"),
        vec![
            "-NoProfile".to_owned(),
            "-NonInteractive".to_owned(),
            "-Command".to_owned(),
            "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Open Debrute Project'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }".to_owned(),
        ],
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn directory_picker_command() -> Result<(PathBuf, Vec<String>), ProjectError> {
    Err(ProjectError::service(
        "native_project_picker_unsupported",
        "The native Project picker is supported on macOS and Windows.",
    ))
}

fn preflight_trash_staging(
    project_root: &Path,
    entries: &[ResolvedEntry],
) -> Result<(), ProjectError> {
    if entries.is_empty() {
        return Ok(());
    }
    let parent = project_root.parent().ok_or_else(|| {
        ProjectError::service(
            "native_shell_trash_staging_unavailable",
            "A filesystem root cannot be used as the Project root for native trash.",
        )
    })?;
    let parent_identity = debrute_native_fs::path_identity(parent)?;
    if entries
        .iter()
        .any(|entry| entry.identity.volume != parent_identity.volume)
    {
        return Err(ProjectError::service(
            "native_shell_trash_staging_unavailable",
            "Every selected Project entry must share the writable Project-parent filesystem used for native-trash staging.",
        ));
    }
    let parent_capability =
        cap_std::fs::Dir::open_ambient_dir(parent, cap_std::ambient_authority())?;
    let probe_name = format!(".debrute-native-trash-probe-{}", uuid::Uuid::new_v4());
    parent_capability.create_dir(&probe_name).map_err(|error| {
        ProjectError::service_with_fields(
            "native_shell_trash_staging_unavailable",
            format!("Native trash requires a writable Project parent: {error}"),
            [(
                "project_parent".to_owned(),
                parent.to_string_lossy().into_owned(),
            )],
        )
    })?;
    parent_capability.remove_dir(&probe_name).map_err(|error| {
        ProjectError::service_with_fields(
            "native_shell_trash_staging_unavailable",
            format!("Native trash staging preflight could not clean its probe: {error}"),
            [(
                "staging_probe".to_owned(),
                parent.join(&probe_name).to_string_lossy().into_owned(),
            )],
        )
    })?;
    Ok(())
}

struct QuarantinedEntry {
    absolute: PathBuf,
    staging_directory: PathBuf,
    staging_capability: Option<cap_std::fs::Dir>,
    basename: String,
    identity: debrute_native_fs::PathIdentity,
    kind: ProjectPathKind,
}

impl QuarantinedEntry {
    fn claim(entry: &ResolvedEntry) -> Result<Self, ProjectError> {
        let basename = Path::new(&entry.relative)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                ProjectError::Validation("Native trash basename is invalid.".to_owned())
            })?;
        let parent = entry.project_root.parent().ok_or_else(|| {
            ProjectError::service(
                "native_shell_trash_staging_unavailable",
                "A filesystem root cannot be used as the Project root for native trash.",
            )
        })?;
        let parent_identity = debrute_native_fs::path_identity(parent)?;
        if parent_identity.volume != entry.identity.volume {
            return Err(ProjectError::service(
                "native_shell_trash_staging_unavailable",
                "Native trash requires a writable Project parent on the same filesystem; a filesystem or mounted-volume root cannot be used as the Project root for this action.",
            ));
        }
        let staging_name = format!(".debrute-native-trash-{}", uuid::Uuid::new_v4());
        let staging_directory = parent.join(&staging_name);
        let parent_capability =
            cap_std::fs::Dir::open_ambient_dir(parent, cap_std::ambient_authority())?;
        parent_capability.create_dir(&staging_name).map_err(|error| {
            ProjectError::service_with_fields(
                "native_shell_trash_staging_unavailable",
                format!(
                    "Native trash requires a writable Project parent on the same filesystem: {error}"
                ),
                [("project_parent".to_owned(), parent.to_string_lossy().into_owned())],
            )
        })?;
        let staging_capability = parent_capability.open_dir(&staging_name)?;
        let project = ProjectCapabilityFs::open(&entry.project_root)?;
        if let Err(error) =
            project.rename_to_directory(&entry.relative, &staging_capability, basename)
        {
            let _ = parent_capability.remove_dir(&staging_name);
            return Err(error);
        }
        let absolute = staging_directory.join(basename);
        let staged = match entry.kind {
            ProjectPathKind::File => staging_capability.open(basename)?.into_std(),
            ProjectPathKind::Directory => staging_capability.open_dir(basename)?.into_std_file(),
        };
        let identity = debrute_native_fs::file_identity(&staged)?;
        if identity != entry.identity {
            return Err(ProjectError::service_with_fields(
                "project_path_changed",
                format!(
                    "Project path changed while it was claimed for trash and remains staged: {}",
                    entry.relative
                ),
                [(
                    "quarantine_absolute_path".to_owned(),
                    absolute.to_string_lossy().into_owned(),
                )],
            ));
        }
        Ok(Self {
            absolute,
            staging_directory,
            staging_capability: Some(staging_capability),
            basename: basename.to_owned(),
            identity,
            kind: entry.kind,
        })
    }

    fn revalidate(&self) -> Result<(), ProjectError> {
        let capability = self
            .staging_capability
            .as_ref()
            .ok_or(ProjectError::StatePoisoned)?;
        let staged = match self.kind {
            ProjectPathKind::File => capability.open(&self.basename)?.into_std(),
            ProjectPathKind::Directory => capability.open_dir(&self.basename)?.into_std_file(),
        };
        if debrute_native_fs::file_identity(&staged)? == self.identity {
            Ok(())
        } else {
            Err(ProjectError::service(
                "project_path_changed",
                format!(
                    "Runtime native-trash staging changed before the system action: {}",
                    self.absolute.display()
                ),
            ))
        }
    }

    fn confirm_consumed(&self) -> Result<(), ProjectError> {
        let capability = self
            .staging_capability
            .as_ref()
            .ok_or(ProjectError::StatePoisoned)?;
        match capability.symlink_metadata(&self.basename) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(ProjectError::Io(error)),
            Ok(_) => Err(ProjectError::service_with_fields(
                "native_shell_trash_not_consumed",
                "The system trash action returned without consuming the staged Project entry.",
                [(
                    "quarantine_absolute_path".to_owned(),
                    self.absolute.to_string_lossy().into_owned(),
                )],
            )),
        }
    }
}

impl Drop for QuarantinedEntry {
    fn drop(&mut self) {
        self.staging_capability.take();
        let _ = fs::remove_dir(&self.staging_directory);
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[allow(clippy::unnecessary_wraps)]
fn ensure_trash_supported() -> Result<(), ProjectError> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn ensure_trash_supported() -> Result<(), ProjectError> {
    Err(ProjectError::service(
        "native_shell_unsupported",
        "Native Project shell actions are unsupported on this distribution target.",
    ))
}

struct ResolvedEntry {
    project_root: PathBuf,
    relative: String,
    absolute: PathBuf,
    identity: debrute_native_fs::PathIdentity,
    kind: ProjectPathKind,
}

impl ResolvedEntry {
    fn revalidate(&self) -> Result<(), ProjectError> {
        let current = validate_entry_identity(&self.project_root, &self.relative, self.kind)?;
        if current == self.identity {
            Ok(())
        } else {
            Err(ProjectError::service(
                "project_path_changed",
                format!(
                    "Project path changed before its native action: {}",
                    self.relative
                ),
            ))
        }
    }
}

struct NativeAction {
    executable: PathBuf,
    args: Vec<String>,
}

fn validate_entries(
    project_root: &Path,
    entries: &[ProjectNativePathEntry],
) -> Result<Vec<ResolvedEntry>, ProjectError> {
    entries
        .iter()
        .map(|entry| validate_entry(project_root, entry))
        .collect()
}

fn validate_entry(
    project_root: &Path,
    entry: &ProjectNativePathEntry,
) -> Result<ResolvedEntry, ProjectError> {
    let relative = assert_project_tree_visible_path(&entry.project_relative_path)?;
    let absolute = resolve_no_symlink_existing_project_path(project_root, &relative)?;
    let metadata = fs::symlink_metadata(&absolute)?;
    let matches_kind = match entry.kind {
        ProjectPathKind::File => metadata.is_file(),
        ProjectPathKind::Directory => metadata.is_dir(),
    };
    if !matches_kind {
        return Err(ProjectError::service(
            "project_path_kind_mismatch",
            format!("Resolved Project path has the wrong kind: {relative}"),
        ));
    }
    let identity = validate_entry_identity(project_root, &relative, entry.kind)?;
    Ok(ResolvedEntry {
        project_root: project_root.to_path_buf(),
        relative,
        absolute,
        identity,
        kind: entry.kind,
    })
}

fn validate_entry_identity(
    project_root: &Path,
    relative: &str,
    kind: ProjectPathKind,
) -> Result<debrute_native_fs::PathIdentity, ProjectError> {
    let absolute = resolve_no_symlink_existing_project_path(project_root, relative)?;
    let identity = if kind == ProjectPathKind::File {
        let file = super::open_no_symlink_existing_project_file(project_root, relative)?;
        debrute_native_fs::file_identity(&file)?
    } else {
        debrute_native_fs::path_identity(&absolute)?
    };
    let current = resolve_no_symlink_existing_project_path(project_root, relative)?;
    if debrute_native_fs::path_identity(&current)? != identity {
        return Err(ProjectError::service(
            "project_path_changed",
            format!("Project path changed during native validation: {relative}"),
        ));
    }
    Ok(identity)
}

fn top_level_resolved_entries(
    entries: Vec<ResolvedEntry>,
) -> Result<Vec<ResolvedEntry>, ProjectError> {
    let mut result: Vec<ResolvedEntry> = Vec::new();
    for entry in entries {
        let nested = result
            .iter()
            .map(|candidate| is_resolved_same_or_child(&entry, candidate))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .any(|nested| nested);
        if nested {
            continue;
        }
        let mut retained = Vec::with_capacity(result.len() + 1);
        for candidate in result {
            if !is_resolved_same_or_child(&candidate, &entry)? {
                retained.push(candidate);
            }
        }
        retained.push(entry);
        result = retained;
    }
    Ok(result)
}

fn is_resolved_same_or_child(
    candidate: &ResolvedEntry,
    parent: &ResolvedEntry,
) -> Result<bool, ProjectError> {
    if candidate.identity == parent.identity {
        return Ok(true);
    }
    if parent.kind != ProjectPathKind::Directory {
        return Ok(false);
    }
    let mut ancestor = candidate.absolute.parent();
    while let Some(path) = ancestor.filter(|path| path.starts_with(&parent.project_root)) {
        if debrute_native_fs::path_identity(path)? == parent.identity {
            return Ok(true);
        }
        ancestor = path.parent();
    }
    Ok(false)
}

#[cfg(target_os = "macos")]
#[allow(clippy::unnecessary_wraps)] // Uniform fallible platform-adapter signature across cfgs.
fn reveal_action(path: &Path, kind: ProjectPathKind) -> Result<NativeAction, ProjectError> {
    let mut args = Vec::new();
    if kind == ProjectPathKind::File {
        args.push("-R".to_owned());
    }
    args.push(path.to_string_lossy().into_owned());
    Ok(NativeAction {
        executable: PathBuf::from("/usr/bin/open"),
        args,
    })
}

#[cfg(target_os = "windows")]
#[allow(clippy::unnecessary_wraps)] // Uniform fallible platform-adapter signature across cfgs.
fn reveal_action(path: &Path, kind: ProjectPathKind) -> Result<NativeAction, ProjectError> {
    let path = path.to_string_lossy().into_owned();
    Ok(NativeAction {
        executable: PathBuf::from("explorer.exe"),
        args: if kind == ProjectPathKind::File {
            vec![format!("/select,{path}")]
        } else {
            vec![path]
        },
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn reveal_action(_path: &Path, _kind: ProjectPathKind) -> Result<NativeAction, ProjectError> {
    Err(ProjectError::service(
        "native_shell_unsupported",
        "Native Project shell actions are unsupported on this distribution target.",
    ))
}

#[cfg(target_os = "macos")]
#[allow(clippy::unnecessary_wraps)] // Uniform fallible platform-adapter signature across cfgs.
fn trash_action(path: &Path) -> Result<NativeAction, ProjectError> {
    Ok(NativeAction {
        executable: PathBuf::from("/usr/bin/osascript"),
        args: vec![
            "-e".to_owned(),
            "on run argv".to_owned(),
            "-e".to_owned(),
            "tell application \"Finder\" to delete POSIX file (item 1 of argv)".to_owned(),
            "-e".to_owned(),
            "end run".to_owned(),
            "--".to_owned(),
            path.to_string_lossy().into_owned(),
        ],
    })
}

#[cfg(target_os = "windows")]
#[allow(clippy::unnecessary_wraps)] // Uniform fallible platform-adapter signature across cfgs.
fn trash_action(path: &Path) -> Result<NativeAction, ProjectError> {
    const SCRIPT: &str = "Add-Type -AssemblyName Microsoft.VisualBasic; $path = $args[0]; if ([System.IO.Directory]::Exists($path)) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin') }";
    Ok(NativeAction {
        executable: PathBuf::from("powershell.exe"),
        args: vec![
            "-NoProfile".to_owned(),
            "-NonInteractive".to_owned(),
            "-Command".to_owned(),
            SCRIPT.to_owned(),
            path.to_string_lossy().into_owned(),
        ],
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn trash_action(_path: &Path) -> Result<NativeAction, ProjectError> {
    Err(ProjectError::service(
        "native_shell_unsupported",
        "Native Project shell actions are unsupported on this distribution target.",
    ))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::*;

    #[test]
    fn full_batch_is_validated_and_nested_entries_are_removed_before_effects() {
        let root = std::env::temp_dir().join(format!("debrute-native-shell-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("folder/child")).unwrap();
        fs::write(root.join("folder/child/file.txt"), "fixture").unwrap();
        let entries = vec![
            ProjectNativePathEntry {
                project_relative_path: "folder/child/file.txt".to_owned(),
                kind: ProjectPathKind::File,
            },
            ProjectNativePathEntry {
                project_relative_path: "folder".to_owned(),
                kind: ProjectPathKind::Directory,
            },
        ];
        let top_level =
            top_level_resolved_entries(validate_entries(&root, &entries).unwrap()).unwrap();
        assert_eq!(top_level.len(), 1);
        assert_eq!(top_level[0].relative, "folder");
        assert_eq!(validate_entries(&root, &entries).unwrap().len(), 2);
        let invalid = [
            entries[0].clone(),
            ProjectNativePathEntry {
                project_relative_path: "missing.txt".to_owned(),
                kind: ProjectPathKind::File,
            },
        ];
        assert!(validate_entries(&root, &invalid).is_err());
        let invalid_nested = [
            entries[1].clone(),
            ProjectNativePathEntry {
                project_relative_path: "folder/../outside".to_owned(),
                kind: ProjectPathKind::File,
            },
        ];
        assert!(validate_entries(&root, &invalid_nested).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn trash_claim_survives_project_root_replacement_without_overwriting_rollback() {
        let root = std::env::temp_dir().join(format!("debrute-native-shell-{}", Uuid::new_v4()));
        let moved = root.with_extension("moved");
        fs::create_dir_all(root.join("folder")).unwrap();
        fs::write(root.join("folder/file.txt"), "fixture").unwrap();
        let entry = validate_entry(
            &root,
            &ProjectNativePathEntry {
                project_relative_path: "folder/file.txt".to_owned(),
                kind: ProjectPathKind::File,
            },
        )
        .unwrap();
        let quarantined = QuarantinedEntry::claim(&entry).unwrap();
        let staging_directory = quarantined.staging_directory.clone();
        assert!(!root.join("folder/file.txt").exists());
        assert!(!quarantined.absolute.starts_with(&root));
        assert!(quarantined.absolute.is_file());
        fs::rename(&root, &moved).unwrap();
        fs::create_dir_all(root.join("folder")).unwrap();
        fs::write(root.join("folder/file.txt"), "replacement").unwrap();
        assert_eq!(
            fs::read(root.join("folder/file.txt")).unwrap(),
            b"replacement"
        );
        assert_eq!(fs::read(&quarantined.absolute).unwrap(), b"fixture");
        drop(quarantined);
        fs::remove_dir_all(staging_directory).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(moved).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_trash_passes_the_path_as_an_argument_not_script_source() {
        let action = trash_action(Path::new("/tmp/brief \"draft\".md")).unwrap();
        assert_eq!(action.executable, Path::new("/usr/bin/osascript"));
        assert_eq!(action.args.last().unwrap(), "/tmp/brief \"draft\".md");
        assert!(!action.args[3].contains("draft"));
    }
}
