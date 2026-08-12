//! Closed macOS/Windows Project file-manager actions.

use std::{
    collections::HashSet,
    fs, io,
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
    AdmittedProjectPathEntry, CanonicalProjectRoot, ProjectDirectoryPath, ProjectError,
    ProjectPathBatchItemResult, ProjectPathKind, ProjectPathRef, assert_project_tree_visible_path,
    is_project_visible_path, resolve_existing_admitted_project_path,
    resolve_no_symlink_existing_project_path,
};

const NATIVE_SHELL_TIMEOUT: Duration = Duration::from_secs(30);

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
        entries: &[ProjectPathRef],
    ) -> Result<(), ProjectError> {
        copy_project_paths_with(project_root, format, entries, |text| {
            crate::native_clipboard::write_text_to_system_clipboard(text)
        })
    }

    /// Opens a directory or selects a file in the platform file manager.
    ///
    /// # Errors
    /// Returns an error for an invalid Project path or failed native action.
    pub fn reveal(&self, project_root: &Path, entry: &ProjectPathRef) -> Result<(), ProjectError> {
        let resolved = validate_entry(project_root, entry)?;
        #[cfg(target_os = "windows")]
        {
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
            self.run(action)
        }
    }

    /// Moves every top-level selected Project path to the system trash.
    ///
    /// The complete batch is validated before the first native effect. There is no retry.
    ///
    /// # Errors
    /// Returns an error only when the complete batch is rejected before the
    /// first native effect. Individual native failures are returned in order.
    pub fn trash(
        &self,
        project_root: &CanonicalProjectRoot,
        entries: &[AdmittedProjectPathEntry],
    ) -> Result<Vec<ProjectPathBatchItemResult>, ProjectError> {
        trash_project_paths_with(project_root, entries, debrute_native_fs::trash_path)
    }

    #[cfg(target_os = "macos")]
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
    relative: ProjectDirectoryPath,
    absolute: PathBuf,
    kind: ProjectPathKind,
}

#[cfg(target_os = "macos")]
struct NativeAction {
    executable: PathBuf,
    args: Vec<String>,
}

fn validate_trash_entries(
    project_root: &CanonicalProjectRoot,
    entries: &[AdmittedProjectPathEntry],
) -> Result<Vec<ResolvedEntry>, ProjectError> {
    if entries.is_empty() {
        return Err(ProjectError::Validation(
            "Project trash requires at least one path.".to_owned(),
        ));
    }
    let mut paths = HashSet::with_capacity(entries.len());
    for entry in entries {
        let path = entry.project_relative_path.as_str();
        if !is_project_visible_path(path) {
            return Err(ProjectError::Validation(format!(
                "Project path is not visible in the Project Tree: {path}"
            )));
        }
        if !paths.insert(path) {
            return Err(ProjectError::Validation(format!(
                "Duplicate Project path in trash batch: {path}"
            )));
        }
    }
    for entry in entries {
        let descendant = entry.project_relative_path.as_str();
        let mut ancestor = entry.project_relative_path.parent();
        while !ancestor.is_root() {
            if paths.contains(ancestor.as_str()) {
                return Err(ProjectError::Validation(format!(
                    "Trash batch must not contain both an ancestor and descendant: {ancestor}, {descendant}"
                )));
            }
            ancestor = ancestor.parent();
        }
    }
    entries
        .iter()
        .map(|entry| {
            let (absolute, metadata) =
                resolve_existing_admitted_project_path(project_root, &entry.project_relative_path)?;
            let matches_kind = match entry.kind {
                ProjectPathKind::File => metadata.is_file(),
                ProjectPathKind::Directory => metadata.is_dir(),
            };
            if !matches_kind {
                return Err(ProjectError::service(
                    "project_path_kind_mismatch",
                    format!(
                        "Resolved Project path has the wrong kind: {}",
                        entry.project_relative_path
                    ),
                ));
            }
            Ok(ResolvedEntry {
                relative: entry.project_relative_path.as_directory_path().clone(),
                absolute,
                kind: entry.kind,
            })
        })
        .collect()
}

fn trash_project_paths_with(
    project_root: &CanonicalProjectRoot,
    entries: &[AdmittedProjectPathEntry],
    mut trash_path: impl FnMut(&Path) -> io::Result<()>,
) -> Result<Vec<ProjectPathBatchItemResult>, ProjectError> {
    let resolved = validate_trash_entries(project_root, entries)?;
    Ok(resolved
        .into_iter()
        .map(|entry| {
            let path = entry.relative.into_string();
            match trash_path(&entry.absolute) {
                Ok(()) => ProjectPathBatchItemResult::ok(path.clone(), path, entry.kind),
                Err(error) => ProjectPathBatchItemResult::failed(
                    path.clone(),
                    entry.kind,
                    format!("Operating system trash failed for {path}: {error}"),
                ),
            }
        })
        .collect())
}

fn validate_clipboard_entries(
    project_root: &Path,
    entries: &[ProjectPathRef],
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
    entries: &[ProjectPathRef],
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
    entries: &[ProjectPathRef],
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
    entry: &ProjectPathRef,
) -> Result<ResolvedEntry, ProjectError> {
    let relative = assert_project_tree_visible_path(&entry.project_relative_path)?;
    validate_resolved_entry(project_root, entry, relative.as_directory_path().clone())
}

fn clipboard_entry_relative_path(entry: &ProjectPathRef) -> Result<String, ProjectError> {
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
    entry: &ProjectPathRef,
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
    Ok(ResolvedEntry {
        relative,
        absolute,
        kind: entry.kind,
    })
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

#[cfg(test)]
mod tests {
    use std::{
        cell::{Cell, RefCell},
        fs,
    };

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
            ProjectPathRef {
                project_relative_path: "b.txt".to_owned(),
                kind: ProjectPathKind::File,
            },
            ProjectPathRef {
                project_relative_path: "folder/a.txt".to_owned(),
                kind: ProjectPathKind::File,
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
            ProjectPathRef {
                project_relative_path: "missing.txt".to_owned(),
                kind: ProjectPathKind::File,
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
        let entries = [ProjectPathRef {
            project_relative_path: "missing/final.png".to_owned(),
            kind: ProjectPathKind::File,
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

        let invalid = [ProjectPathRef {
            project_relative_path: "missing/../outside.png".to_owned(),
            kind: ProjectPathKind::File,
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
        let root_entry = [ProjectPathRef {
            project_relative_path: String::new(),
            kind: ProjectPathKind::Directory,
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

        let invalid_root = [ProjectPathRef {
            project_relative_path: String::new(),
            kind: ProjectPathKind::File,
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
    fn trash_rejects_the_complete_invalid_or_overlapping_batch_before_effects() {
        let root = std::env::temp_dir().join(format!("debrute-native-shell-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("folder/child")).unwrap();
        fs::write(root.join("folder/child/file.txt"), "fixture").unwrap();
        let canonical_root = CanonicalProjectRoot::open_existing(&root).unwrap();
        let entries = crate::project::admit_project_path_entries(vec![
            ProjectPathRef {
                project_relative_path: "folder/child/file.txt".to_owned(),
                kind: ProjectPathKind::File,
            },
            ProjectPathRef {
                project_relative_path: "folder".to_owned(),
                kind: ProjectPathKind::Directory,
            },
        ])
        .unwrap();
        let effects = Cell::new(0);
        assert!(
            trash_project_paths_with(&canonical_root, &entries, |_| {
                effects.set(effects.get() + 1);
                Ok(())
            })
            .is_err()
        );
        assert_eq!(effects.get(), 0);

        let invalid = crate::project::admit_project_path_entries(vec![
            ProjectPathRef {
                project_relative_path: entries[0].project_relative_path.to_string(),
                kind: entries[0].kind,
            },
            ProjectPathRef {
                project_relative_path: "missing.txt".to_owned(),
                kind: ProjectPathKind::File,
            },
        ])
        .unwrap();
        assert!(
            trash_project_paths_with(&canonical_root, &invalid, |_| {
                effects.set(effects.get() + 1);
                Ok(())
            })
            .is_err()
        );
        assert_eq!(effects.get(), 0);

        let duplicate = [entries[0].clone(), entries[0].clone()];
        assert!(trash_project_paths_with(&canonical_root, &duplicate, |_| Ok(())).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn trash_runs_once_per_entry_in_caller_order_and_records_partial_failure() {
        let root = std::env::temp_dir().join(format!("debrute-native-shell-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        for path in ["third.txt", "失败.txt", "first file.txt"] {
            fs::write(root.join(path), "fixture").unwrap();
        }
        let canonical_root = CanonicalProjectRoot::open_existing(&root).unwrap();
        let entries = crate::project::admit_project_path_entries(vec![
            ProjectPathRef {
                project_relative_path: "third.txt".to_owned(),
                kind: ProjectPathKind::File,
            },
            ProjectPathRef {
                project_relative_path: "失败.txt".to_owned(),
                kind: ProjectPathKind::File,
            },
            ProjectPathRef {
                project_relative_path: "first file.txt".to_owned(),
                kind: ProjectPathKind::File,
            },
        ])
        .unwrap();
        let calls = RefCell::new(Vec::new());
        let results = trash_project_paths_with(&canonical_root, &entries, |path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            calls.borrow_mut().push(name.clone());
            if name == "失败.txt" {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(
            calls.into_inner(),
            ["third.txt", "失败.txt", "first file.txt"]
        );
        assert!(matches!(results[0], ProjectPathBatchItemResult::Ok { .. }));
        assert!(matches!(
            results[1],
            ProjectPathBatchItemResult::Failed { .. }
        ));
        assert!(matches!(results[2], ProjectPathBatchItemResult::Ok { .. }));
        assert_eq!(results[1].project_relative_path(), "失败.txt");
        assert_eq!(results.len(), entries.len());

        fs::remove_dir_all(root).unwrap();
    }
}
