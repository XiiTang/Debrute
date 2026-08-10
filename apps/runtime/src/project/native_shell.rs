//! Closed macOS/Windows Project file-manager actions.

use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

#[cfg(target_os = "windows")]
use base64::{Engine as _, engine::general_purpose::STANDARD};

use crate::{
    process::{BoundedProcessSupervisor, ProcessCancellation, ProcessRequest, WorkerKind},
    workers::RuntimeWorkerServices,
};

use super::{
    CanonicalProjectRoot, ProjectDirectoryPath, ProjectError, ProjectPathEntry, ProjectPathKind,
    ProjectRelativePath, assert_project_tree_visible_path,
    resolve_no_symlink_existing_project_path,
};

const NATIVE_SHELL_TIMEOUT: Duration = Duration::from_secs(30);
pub const NATIVE_TRASH_WORKER_COMMAND: &str = "__native-trash";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectPathClipboardFormat {
    Absolute,
    Relative,
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
        let (executable, args) = directory_picker_command();
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
            #[cfg(target_os = "macos")]
            return Ok(decode_directory_picker_output(&output.stdout));
            #[cfg(target_os = "windows")]
            return decode_directory_picker_output(&output.stdout);
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

    /// Validates and writes one complete Project-path batch to the system clipboard.
    ///
    /// # Errors
    /// Returns an error before changing the clipboard when one entry is invalid,
    /// or when the platform clipboard command fails.
    pub fn copy_paths_to_system_clipboard(
        &self,
        project_root: &Path,
        format: ProjectPathClipboardFormat,
        entries: &[ProjectPathEntry],
    ) -> Result<(), ProjectError> {
        copy_project_paths_with(project_root, format, entries, |text| {
            crate::native_clipboard::write_text_to_system_clipboard(text)
        })
    }

    /// Opens a directory or selects a file in the platform file manager.
    ///
    /// # Errors
    /// Returns an error for an invalid Project path or failed native action.
    pub fn reveal(
        &self,
        project_root: &Path,
        entry: &ProjectPathEntry,
    ) -> Result<(), ProjectError> {
        let resolved = validate_entry(project_root, entry)?;
        #[cfg(target_os = "windows")]
        {
            resolved.revalidate()?;
            let result = match entry.kind {
                ProjectPathKind::File => {
                    debrute_native_fs::reveal_file_in_shell(&resolved.absolute)
                }
                ProjectPathKind::Directory => {
                    debrute_native_fs::open_directory_in_shell(&resolved.absolute)
                }
            };
            result.map_err(|error| {
                ProjectError::service(
                    "native_shell_failed",
                    format!("Native Project reveal failed: {error}"),
                )
            })
        }
        #[cfg(target_os = "macos")]
        let action = reveal_action(&resolved.absolute, entry.kind);
        #[cfg(target_os = "macos")]
        {
            resolved.revalidate()?;
            self.run(action)
        }
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
        entries: &[ProjectPathEntry],
    ) -> Result<Vec<ProjectPathEntry>, ProjectError> {
        let resolved = top_level_resolved_entries(validate_entries(project_root, entries)?)?;
        for entry in &resolved {
            self.run(trash_action(entry)?)?;
        }
        Ok(resolved
            .into_iter()
            .map(|entry| ProjectPathEntry {
                project_relative_path: entry.relative.into_string(),
                kind: entry.kind,
                size_bytes: None,
            })
            .collect())
    }

    fn run(&self, action: NativeAction) -> Result<(), ProjectError> {
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
fn directory_picker_command() -> (PathBuf, Vec<String>) {
    (
        PathBuf::from("/usr/bin/osascript"),
        vec![
            "-e".to_owned(),
            "POSIX path of (choose folder with prompt \"Open Debrute Project\")".to_owned(),
        ],
    )
}

#[cfg(target_os = "macos")]
fn decode_directory_picker_output(output: &str) -> Option<PathBuf> {
    let selected = output.trim();
    (!selected.is_empty()).then(|| PathBuf::from(selected))
}

#[cfg(target_os = "windows")]
fn directory_picker_command() -> (PathBuf, Vec<String>) {
    (
        PathBuf::from("powershell.exe"),
        vec![
            "-NoProfile".to_owned(),
            "-NonInteractive".to_owned(),
            "-Command".to_owned(),
            "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Open Debrute Project'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $bytes = [System.Text.Encoding]::UTF8.GetBytes($d.SelectedPath); [Console]::Out.Write([Convert]::ToBase64String($bytes)) }".to_owned(),
        ],
    )
}

#[cfg(target_os = "windows")]
fn decode_directory_picker_output(output: &str) -> Result<Option<PathBuf>, ProjectError> {
    let selected = output.trim();
    if selected.is_empty() {
        return Ok(None);
    }
    let decoded = STANDARD.decode(selected).map_err(|error| {
        ProjectError::service(
            "native_project_picker_invalid_output",
            format!("Native Project picker returned invalid encoded output: {error}"),
        )
    })?;
    let selected = String::from_utf8(decoded).map_err(|error| {
        ProjectError::service(
            "native_project_picker_invalid_output",
            format!("Native Project picker returned a non-UTF-8 path: {error}"),
        )
    })?;
    Ok(Some(PathBuf::from(selected)))
}

struct ResolvedEntry {
    project_root: PathBuf,
    relative: ProjectDirectoryPath,
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

#[derive(Debug, PartialEq, Eq)]
struct NativeTrashWorkerRequest {
    project_root: CanonicalProjectRoot,
    relative: ProjectRelativePath,
    expected_identity: debrute_native_fs::PathIdentity,
    expected_kind: ProjectPathKind,
}

impl NativeTrashWorkerRequest {
    fn parse(arguments: &[OsString]) -> Result<Self, ProjectError> {
        let [
            root_flag,
            root,
            relative_flag,
            relative,
            volume_flag,
            volume,
            file_flag,
            file,
            kind_flag,
            kind,
        ] = arguments
        else {
            return Err(invalid_native_trash_arguments());
        };
        if root_flag != OsStr::new("--project-root")
            || relative_flag != OsStr::new("--project-relative-path")
            || volume_flag != OsStr::new("--expected-volume")
            || file_flag != OsStr::new("--expected-file")
            || kind_flag != OsStr::new("--expected-kind")
        {
            return Err(invalid_native_trash_arguments());
        }
        let requested_root = PathBuf::from(root);
        if !requested_root.is_absolute() {
            return Err(ProjectError::service(
                "native_trash_worker_invalid_project_root",
                "Native trash worker Project root must be an absolute canonical path.",
            ));
        }
        let project_root = CanonicalProjectRoot::open_existing(&requested_root)?;
        if project_root.as_path() != requested_root {
            return Err(ProjectError::service(
                "project_path_changed",
                "Native trash worker Project root changed before execution.",
            ));
        }
        let relative = relative
            .to_str()
            .ok_or_else(invalid_native_trash_arguments)
            .and_then(ProjectRelativePath::parse)?;
        let parse_identity_part = |value: &OsString| {
            value
                .to_str()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(invalid_native_trash_arguments)
        };
        let expected_kind = match kind.to_str() {
            Some("file") => ProjectPathKind::File,
            Some("directory") => ProjectPathKind::Directory,
            _ => return Err(invalid_native_trash_arguments()),
        };
        Ok(Self {
            project_root,
            relative,
            expected_identity: debrute_native_fs::PathIdentity {
                volume: parse_identity_part(volume)?,
                file: parse_identity_part(file)?,
            },
            expected_kind,
        })
    }

    fn resolve(&self) -> Result<PathBuf, ProjectError> {
        let requested_root = self.project_root.as_path();
        let current_root = CanonicalProjectRoot::open_existing(requested_root)?;
        if current_root != self.project_root {
            return Err(ProjectError::service(
                "project_path_changed",
                "Native trash worker Project root changed before execution.",
            ));
        }
        let path = resolve_no_symlink_existing_project_path(
            requested_root,
            self.relative.as_directory_path(),
        )?;
        let metadata = fs::symlink_metadata(&path)?;
        let kind_matches = match self.expected_kind {
            ProjectPathKind::File => metadata.is_file(),
            ProjectPathKind::Directory => metadata.is_dir(),
        };
        let identity = validate_entry_identity(
            requested_root,
            self.relative.as_directory_path(),
            self.expected_kind,
        )?;
        if !kind_matches || identity != self.expected_identity {
            return Err(ProjectError::service(
                "project_path_changed",
                format!(
                    "Native trash path changed before execution: {}",
                    self.relative
                ),
            ));
        }
        Ok(path)
    }
}

fn invalid_native_trash_arguments() -> ProjectError {
    ProjectError::service(
        "native_trash_worker_invalid_arguments",
        "Native trash worker arguments do not match the closed internal contract.",
    )
}

/// Executes the private native-trash worker command without starting Runtime
/// product state, HTTP, Control, or Project sessions.
///
/// # Errors
/// Returns a closed worker-contract, identity, or operating-system trash error.
#[doc(hidden)]
pub fn run_native_trash_worker(arguments: &[OsString]) -> Result<(), ProjectError> {
    let request = NativeTrashWorkerRequest::parse(arguments)?;
    let path = request.resolve()?;
    debrute_native_fs::trash_path(&path).map_err(|error| {
        ProjectError::service(
            "native_trash_failed",
            format!(
                "Operating system trash failed for {}: {error}",
                request.relative
            ),
        )
    })
}

fn validate_entries(
    project_root: &Path,
    entries: &[ProjectPathEntry],
) -> Result<Vec<ResolvedEntry>, ProjectError> {
    entries
        .iter()
        .map(|entry| validate_entry(project_root, entry))
        .collect()
}

fn validate_clipboard_entries(
    project_root: &Path,
    entries: &[ProjectPathEntry],
) -> Result<Vec<ResolvedEntry>, ProjectError> {
    entries
        .iter()
        .map(|entry| {
            let relative = clipboard_entry_relative_path(entry)?;
            validate_resolved_entry(project_root, entry, ProjectDirectoryPath::parse(&relative)?)
        })
        .collect()
}

fn project_path_clipboard_text(
    project_root: &Path,
    format: ProjectPathClipboardFormat,
    entries: &[ProjectPathEntry],
) -> Result<String, ProjectError> {
    if entries.is_empty() {
        return Err(ProjectError::Validation(
            "Project path clipboard copy requires at least one entry.".to_owned(),
        ));
    }
    let paths = match format {
        ProjectPathClipboardFormat::Absolute => validate_clipboard_entries(project_root, entries)?
            .into_iter()
            .map(|entry| entry.absolute.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        ProjectPathClipboardFormat::Relative => entries
            .iter()
            .map(|entry| {
                clipboard_entry_relative_path(entry).map(|path| {
                    if path.is_empty() {
                        ".".to_owned()
                    } else {
                        display_project_relative_path(&path)
                    }
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(paths.join("\n"))
}

fn copy_project_paths_with(
    project_root: &Path,
    format: ProjectPathClipboardFormat,
    entries: &[ProjectPathEntry],
    writer: impl FnOnce(&str) -> std::io::Result<()>,
) -> Result<(), ProjectError> {
    let text = project_path_clipboard_text(project_root, format, entries)?;
    writer(&text).map_err(|error| {
        ProjectError::service(
            "native_clipboard_failed",
            format!("System clipboard write failed: {error}"),
        )
    })
}

#[cfg(target_os = "windows")]
fn display_project_relative_path(path: &str) -> String {
    path.replace('/', "\\")
}

#[cfg(not(target_os = "windows"))]
fn display_project_relative_path(path: &str) -> String {
    path.to_owned()
}

fn validate_entry(
    project_root: &Path,
    entry: &ProjectPathEntry,
) -> Result<ResolvedEntry, ProjectError> {
    let relative = assert_project_tree_visible_path(&entry.project_relative_path)?;
    validate_resolved_entry(project_root, entry, relative.as_directory_path().clone())
}

fn clipboard_entry_relative_path(entry: &ProjectPathEntry) -> Result<String, ProjectError> {
    if entry.project_relative_path.is_empty() {
        return if entry.kind == ProjectPathKind::Directory {
            Ok(String::new())
        } else {
            Err(ProjectError::Validation(
                "The Project root clipboard entry must be a directory.".to_owned(),
            ))
        };
    }
    assert_project_tree_visible_path(&entry.project_relative_path)
        .map(super::ProjectRelativePath::into_string)
}

fn validate_resolved_entry(
    project_root: &Path,
    entry: &ProjectPathEntry,
    relative: ProjectDirectoryPath,
) -> Result<ResolvedEntry, ProjectError> {
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
    relative: &ProjectDirectoryPath,
    kind: ProjectPathKind,
) -> Result<debrute_native_fs::PathIdentity, ProjectError> {
    let absolute = resolve_no_symlink_existing_project_path(project_root, relative)?;
    let identity = if kind == ProjectPathKind::File {
        let relative_file = ProjectRelativePath::parse(relative.as_str())?;
        let file = super::open_no_symlink_existing_project_file(project_root, &relative_file)?;
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
fn reveal_action(path: &Path, kind: ProjectPathKind) -> NativeAction {
    let mut args = Vec::new();
    if kind == ProjectPathKind::File {
        args.push("-R".to_owned());
    }
    args.push(path.to_string_lossy().into_owned());
    NativeAction {
        executable: PathBuf::from("/usr/bin/open"),
        args,
    }
}

fn trash_action(entry: &ResolvedEntry) -> Result<NativeAction, ProjectError> {
    let project_root = entry.project_root.to_str().ok_or_else(|| {
        ProjectError::service(
            "project_path_not_utf8",
            "Native trash Project root must be representable as UTF-8.",
        )
    })?;
    let executable = std::env::current_exe().map_err(ProjectError::from)?;
    Ok(NativeAction {
        executable,
        args: vec![
            NATIVE_TRASH_WORKER_COMMAND.to_owned(),
            "--project-root".to_owned(),
            project_root.to_owned(),
            "--project-relative-path".to_owned(),
            entry.relative.to_string(),
            "--expected-volume".to_owned(),
            entry.identity.volume.to_string(),
            "--expected-file".to_owned(),
            entry.identity.file.to_string(),
            "--expected-kind".to_owned(),
            match entry.kind {
                ProjectPathKind::File => "file",
                ProjectPathKind::Directory => "directory",
            }
            .to_owned(),
        ],
    })
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, fs};

    use uuid::Uuid;

    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_directory_picker_output_handles_empty_and_selected_paths() {
        assert_eq!(decode_directory_picker_output("  \n"), None);
        assert_eq!(
            decode_directory_picker_output("/Users/debrute/Project\n"),
            Some(PathBuf::from("/Users/debrute/Project"))
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_directory_picker_output_preserves_unicode_project_paths() {
        let selected = r"E:\onedrive\城启设计\CQ奖项申报";
        let encoded = STANDARD.encode(selected.as_bytes());

        assert_eq!(
            decode_directory_picker_output(&encoded).expect("picker output should decode"),
            Some(PathBuf::from(selected))
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_directory_picker_output_rejects_invalid_encoding() {
        assert_eq!(
            decode_directory_picker_output("  \n").expect("empty output is cancellation"),
            None
        );
        assert_eq!(
            decode_directory_picker_output("not-base64")
                .expect_err("invalid base64 should fail")
                .code(),
            "native_project_picker_invalid_output"
        );
        let invalid_utf8 = STANDARD.encode([0xff, 0xfe]);
        assert_eq!(
            decode_directory_picker_output(&invalid_utf8)
                .expect_err("invalid UTF-8 should fail")
                .code(),
            "native_project_picker_invalid_output"
        );
    }

    #[test]
    fn project_path_clipboard_text_preserves_batch_order_and_validates_atomically() {
        let root = std::env::temp_dir().join(format!("debrute-clipboard-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("folder")).unwrap();
        fs::write(root.join("folder/a.txt"), "a").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        let entries = vec![
            ProjectPathEntry {
                project_relative_path: "b.txt".to_owned(),
                kind: ProjectPathKind::File,
                size_bytes: None,
            },
            ProjectPathEntry {
                project_relative_path: "folder/a.txt".to_owned(),
                kind: ProjectPathKind::File,
                size_bytes: None,
            },
        ];

        let absolute =
            project_path_clipboard_text(&root, ProjectPathClipboardFormat::Absolute, &entries)
                .unwrap();
        assert_eq!(
            absolute,
            format!(
                "{}\n{}",
                root.join("b.txt").to_string_lossy(),
                root.join("folder").join("a.txt").to_string_lossy()
            )
        );

        let invalid_absolute = [
            entries[0].clone(),
            ProjectPathEntry {
                project_relative_path: "missing.txt".to_owned(),
                kind: ProjectPathKind::File,
                size_bytes: None,
            },
        ];
        assert!(
            project_path_clipboard_text(
                &root,
                ProjectPathClipboardFormat::Absolute,
                &invalid_absolute,
            )
            .is_err()
        );
        let writer_calls = Cell::new(0);
        assert!(
            copy_project_paths_with(
                &root,
                ProjectPathClipboardFormat::Absolute,
                &invalid_absolute,
                |_| {
                    writer_calls.set(writer_calls.get() + 1);
                    Ok(())
                },
            )
            .is_err()
        );
        assert_eq!(writer_calls.get(), 0);

        copy_project_paths_with(
            &root,
            ProjectPathClipboardFormat::Absolute,
            &entries,
            |_| {
                writer_calls.set(writer_calls.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(writer_calls.get(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relative_clipboard_text_accepts_missing_nodes_and_uses_platform_path_style() {
        let entries = [ProjectPathEntry {
            project_relative_path: "missing/final.png".to_owned(),
            kind: ProjectPathKind::File,
            size_bytes: None,
        }];
        let text = project_path_clipboard_text(
            Path::new("/unused"),
            ProjectPathClipboardFormat::Relative,
            &entries,
        )
        .unwrap();
        #[cfg(target_os = "windows")]
        assert_eq!(text, "missing\\final.png");
        #[cfg(not(target_os = "windows"))]
        assert_eq!(text, "missing/final.png");

        let invalid = [ProjectPathEntry {
            project_relative_path: "missing/../outside.png".to_owned(),
            kind: ProjectPathKind::File,
            size_bytes: None,
        }];
        assert!(
            project_path_clipboard_text(
                Path::new("/unused"),
                ProjectPathClipboardFormat::Relative,
                &invalid,
            )
            .is_err()
        );
        assert!(
            project_path_clipboard_text(
                Path::new("/unused"),
                ProjectPathClipboardFormat::Relative,
                &[],
            )
            .is_err()
        );
    }

    #[test]
    fn project_root_clipboard_text_uses_the_absolute_root_and_relative_dot() {
        let root = std::env::temp_dir().join(format!("debrute-clipboard-root-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root_entry = [ProjectPathEntry {
            project_relative_path: String::new(),
            kind: ProjectPathKind::Directory,
            size_bytes: None,
        }];

        assert_eq!(
            project_path_clipboard_text(&root, ProjectPathClipboardFormat::Absolute, &root_entry)
                .unwrap(),
            root.to_string_lossy()
        );
        assert_eq!(
            project_path_clipboard_text(&root, ProjectPathClipboardFormat::Relative, &root_entry)
                .unwrap(),
            "."
        );

        let invalid_root = [ProjectPathEntry {
            project_relative_path: String::new(),
            kind: ProjectPathKind::File,
            size_bytes: None,
        }];
        assert!(
            project_path_clipboard_text(
                &root,
                ProjectPathClipboardFormat::Relative,
                &invalid_root,
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_batch_is_validated_and_nested_entries_are_removed_before_effects() {
        let root = std::env::temp_dir().join(format!("debrute-native-shell-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("folder/child")).unwrap();
        fs::write(root.join("folder/child/file.txt"), "fixture").unwrap();
        let entries = vec![
            ProjectPathEntry {
                project_relative_path: "folder/child/file.txt".to_owned(),
                kind: ProjectPathKind::File,
                size_bytes: None,
            },
            ProjectPathEntry {
                project_relative_path: "folder".to_owned(),
                kind: ProjectPathKind::Directory,
                size_bytes: None,
            },
        ];
        let top_level =
            top_level_resolved_entries(validate_entries(&root, &entries).unwrap()).unwrap();
        assert_eq!(top_level.len(), 1);
        assert_eq!(top_level[0].relative, "folder");
        assert_eq!(validate_entries(&root, &entries).unwrap().len(), 2);
        let invalid = [
            entries[0].clone(),
            ProjectPathEntry {
                project_relative_path: "missing.txt".to_owned(),
                kind: ProjectPathKind::File,
                size_bytes: None,
            },
        ];
        assert!(validate_entries(&root, &invalid).is_err());
        let invalid_nested = [
            entries[1].clone(),
            ProjectPathEntry {
                project_relative_path: "folder/../outside".to_owned(),
                kind: ProjectPathKind::File,
                size_bytes: None,
            },
        ];
        assert!(validate_entries(&root, &invalid_nested).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_trash_revalidates_and_targets_the_original_project_path() {
        let root = std::env::temp_dir().join(format!("debrute-native-shell-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("folder")).unwrap();
        fs::write(root.join("folder/file.txt"), "fixture").unwrap();
        let root = root.canonicalize().unwrap();
        let entry = validate_entry(
            &root,
            &ProjectPathEntry {
                project_relative_path: "folder/file.txt".to_owned(),
                kind: ProjectPathKind::File,
                size_bytes: None,
            },
        )
        .unwrap();
        let action = trash_action(&entry).unwrap();
        assert_eq!(action.args[0], NATIVE_TRASH_WORKER_COMMAND);
        assert_eq!(action.args[1], "--project-root");
        assert_eq!(action.args[2], root.to_str().unwrap());
        assert_eq!(action.args[3], "--project-relative-path");
        assert_eq!(action.args[4], "folder/file.txt");
        assert_eq!(action.args[5], "--expected-volume");
        assert_eq!(action.args[6], entry.identity.volume.to_string());
        assert_eq!(action.args[7], "--expected-file");
        assert_eq!(action.args[8], entry.identity.file.to_string());
        assert_eq!(action.args[9], "--expected-kind");
        assert_eq!(action.args[10], "file");

        fs::rename(
            root.join("folder/file.txt"),
            root.join("folder/original.txt"),
        )
        .unwrap();
        fs::write(root.join("folder/file.txt"), "replacement").unwrap();
        assert_eq!(
            entry.revalidate().unwrap_err().code(),
            "project_path_changed"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_trash_worker_rejects_open_or_malformed_arguments() {
        assert_eq!(
            NativeTrashWorkerRequest::parse(&[]).unwrap_err().code(),
            "native_trash_worker_invalid_arguments"
        );
        let arguments = [
            OsString::from("--project-root"),
            OsString::from("relative-root"),
            OsString::from("--project-relative-path"),
            OsString::from("fixture.txt"),
            OsString::from("--expected-volume"),
            OsString::from("1"),
            OsString::from("--expected-file"),
            OsString::from("2"),
            OsString::from("--expected-kind"),
            OsString::from("file"),
        ];
        assert_eq!(
            NativeTrashWorkerRequest::parse(&arguments)
                .unwrap_err()
                .code(),
            "native_trash_worker_invalid_project_root"
        );
    }

    #[test]
    fn native_trash_worker_rejects_a_changed_identity_without_an_effect() {
        let root = std::env::temp_dir().join(format!("debrute-trash-worker-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("fixture.txt");
        fs::write(&path, "fixture").unwrap();
        let request = NativeTrashWorkerRequest {
            project_root: CanonicalProjectRoot::open_existing(&root).unwrap(),
            relative: ProjectRelativePath::parse("fixture.txt").unwrap(),
            expected_identity: debrute_native_fs::PathIdentity { volume: 0, file: 0 },
            expected_kind: ProjectPathKind::File,
        };

        assert_eq!(
            request.resolve().unwrap_err().code(),
            "project_path_changed"
        );
        assert!(path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn native_trash_worker_rejects_a_project_root_replaced_by_a_symlink() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!("debrute-trash-root-{}", Uuid::new_v4()));
        let root = base.join("project");
        let moved = base.join("moved");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("fixture.txt");
        fs::write(&path, "fixture").unwrap();
        let request = NativeTrashWorkerRequest {
            project_root: CanonicalProjectRoot::open_existing(&root).unwrap(),
            relative: ProjectRelativePath::parse("fixture.txt").unwrap(),
            expected_identity: debrute_native_fs::path_identity(&path).unwrap(),
            expected_kind: ProjectPathKind::File,
        };

        fs::rename(&root, &moved).unwrap();
        symlink(&moved, &root).unwrap();

        assert_eq!(
            request.resolve().unwrap_err().code(),
            "project_path_changed"
        );
        assert!(moved.join("fixture.txt").exists());
        fs::remove_file(root).unwrap();
        fs::remove_dir_all(base).unwrap();
    }
}
