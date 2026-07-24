//! Deterministic, revision-bound Canvas preview services.

mod cache;
mod libvips_adapter;
pub(crate) mod raster;
mod video;

use std::{
    collections::HashMap,
    fs::File,
    io::{Read as _, Seek as _},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[cfg(test)]
use std::fs;

pub use raster::{RasterMetadata, RasterOutputFormat};
pub use video::*;

use crate::{process::ProcessCancellation, workers::RuntimeWorkerServices};

use super::{
    CanvasDesiredNode, CanvasLayoutSize, CanvasMediaKind, CanvasNodeKind,
    DefaultProjectNodeAdapter, ProjectCapabilityFs, ProjectError, ProjectFileEntry,
    ProjectNodeAdapter, ProjectPathKind, assert_project_tree_visible_path,
    normalize_project_relative_path, open_no_symlink_existing_project_file,
    project_file_revision_from_metadata, resolve_no_symlink_existing_project_path,
};
use cache::{
    KeyedLocks, Semaphore, atomic_write, project_relative_path_cache_key,
    project_revision_cache_key, safe_cache_segment,
};
use raster::RasterPreviewEngine;
pub use raster::initialize_raster_preview_engine;

pub(crate) const RASTER_PREVIEW_ENGINE_VERSION: u32 = 1;
const MAX_TEXT_PREVIEW_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FEEDBACK_ARTIFACT_DIMENSION: u32 = 4096;

#[derive(Clone, Default)]
pub struct PreviewCancellation {
    cancelled: Arc<AtomicBool>,
    process: ProcessCancellation,
}

impl PreviewCancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.process.cancel();
    }

    pub(crate) fn check(&self) -> Result<(), ProjectError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(ProjectError::service(
                "canvas_preview_cancelled",
                "Canvas preview request was cancelled.",
            ))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug)]
pub struct CanvasPreviewFile {
    pub absolute_path: PathBuf,
    pub file: File,
    pub content_type: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanvasImagePreviewSourceInfo {
    pub previewable: bool,
    pub source_width: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasTextPreviewSourceTarget {
    pub project_relative_path: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanvasTextPreviewSourceStatus {
    Available,
    Missing,
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasTextPreviewSourceView {
    pub target: CanvasTextPreviewSourceTarget,
    pub status: CanvasTextPreviewSourceStatus,
}

pub struct ProjectPreviewService {
    raster: RasterPreviewEngine,
    raster_pool: Arc<Semaphore>,
    image_locks: KeyedLocks,
    text_locks: KeyedLocks,
    video: CanvasVideoPreviewService,
}

pub struct NativeProjectNodeAdapter {
    previews: Arc<ProjectPreviewService>,
}

impl NativeProjectNodeAdapter {
    #[must_use]
    pub fn new(previews: Arc<ProjectPreviewService>) -> Self {
        Self { previews }
    }
}

impl ProjectNodeAdapter for NativeProjectNodeAdapter {
    fn layout_size(
        &self,
        project_root: &Path,
        node: &CanvasDesiredNode,
    ) -> Result<CanvasLayoutSize, ProjectError> {
        match (node.node_kind, node.media_kind) {
            (CanvasNodeKind::File, Some(CanvasMediaKind::Image)) => {
                let relative = previewable_image_path(&node.project_relative_path)?;
                let source = resolve_no_symlink_existing_project_path(project_root, &relative)?;
                let mut file = open_no_symlink_existing_project_file(project_root, &relative)?;
                let metadata = self.previews.raster.metadata_file(
                    &source,
                    &mut file,
                    &PreviewCancellation::default(),
                )?;
                Ok(CanvasLayoutSize {
                    width: f64::from(metadata.width),
                    height: f64::from(metadata.height),
                })
            }
            (CanvasNodeKind::File, Some(CanvasMediaKind::Video)) => {
                let metadata = self.previews.video.read_metadata(
                    project_root,
                    &node.project_relative_path,
                    &PreviewCancellation::default(),
                )?;
                Ok(CanvasLayoutSize {
                    width: f64::from(metadata.width),
                    height: f64::from(metadata.height),
                })
            }
            _ => DefaultProjectNodeAdapter.layout_size(project_root, node),
        }
    }

    fn video_presentation(
        &self,
        project_root: &Path,
        project_relative_path: &str,
    ) -> Result<Option<serde_json::Value>, ProjectError> {
        let metadata = self.previews.video.read_metadata(
            project_root,
            project_relative_path,
            &PreviewCancellation::default(),
        )?;
        let mut presentation = serde_json::json!({
            "kind": "video",
            "width": metadata.width,
            "height": metadata.height,
            "textTracks": video_text_tracks(project_root, project_relative_path)?
        });
        if let Some(duration) = metadata.duration_seconds {
            presentation["durationSeconds"] = serde_json::json!(duration);
        }
        Ok(Some(presentation))
    }

    fn image_preview_info(
        &self,
        project_root: &Path,
        project_relative_path: &str,
    ) -> Result<Option<(bool, Option<u64>)>, ProjectError> {
        let info = self
            .previews
            .image_source_info(project_root, project_relative_path)?;
        Ok(Some((info.previewable, info.source_width.map(u64::from))))
    }
}

impl ProjectPreviewService {
    #[must_use]
    pub fn new(workers: &RuntimeWorkerServices, media_tools: MediaToolPaths) -> Self {
        let raster_pool = Arc::new(Semaphore::new(3));
        Self {
            raster: RasterPreviewEngine::new(Arc::clone(&raster_pool), 4),
            raster_pool: Arc::clone(&raster_pool),
            image_locks: KeyedLocks::default(),
            text_locks: KeyedLocks::default(),
            video: CanvasVideoPreviewService::new(workers.supervisor(), media_tools, raster_pool),
        }
    }

    pub(crate) fn with_feedback_raster<T>(
        &self,
        cancellation: &PreviewCancellation,
        render: impl FnOnce() -> Result<T, ProjectError>,
    ) -> Result<T, ProjectError> {
        let _permit = self.raster_pool.acquire(cancellation)?;
        render()
    }

    /// Inspects whether one Project image can produce bounded Canvas previews.
    ///
    /// # Errors
    /// Returns an error when a supported image path cannot be opened or inspected.
    pub fn image_source_info(
        &self,
        project_root: &Path,
        project_relative_path: &str,
    ) -> Result<CanvasImagePreviewSourceInfo, ProjectError> {
        let Ok(relative) = previewable_image_path(project_relative_path) else {
            return Ok(CanvasImagePreviewSourceInfo {
                previewable: false,
                source_width: None,
            });
        };
        let source = resolve_no_symlink_existing_project_path(project_root, &relative)?;
        let mut file = open_no_symlink_existing_project_file(project_root, &relative)?;
        let metadata =
            self.raster
                .metadata_file(&source, &mut file, &PreviewCancellation::default())?;
        Ok(CanvasImagePreviewSourceInfo {
            previewable: true,
            source_width: Some(metadata.width),
        })
    }

    /// Removes image-preview cache entries that no longer match a current,
    /// previewable Project source and its exact revision.
    ///
    /// # Errors
    /// Returns an error when the cache directory cannot be reconciled safely.
    pub fn reconcile_image_cache(
        &self,
        project_root: &Path,
        files: &[ProjectFileEntry],
    ) -> Result<(), ProjectError> {
        let mut expected = HashMap::new();
        for entry in files {
            if entry.kind != ProjectPathKind::File {
                continue;
            }
            let Ok(relative) = previewable_image_path(&entry.project_relative_path) else {
                continue;
            };
            let Ok(mut file) = open_no_symlink_existing_project_file(project_root, &relative)
            else {
                continue;
            };
            let path = resolve_no_symlink_existing_project_path(project_root, &relative)?;
            if self
                .raster
                .metadata_file(&path, &mut file, &PreviewCancellation::default())
                .is_err()
            {
                continue;
            }
            let revision = project_file_revision_from_metadata(&file.metadata()?)?;
            expected.insert(
                project_relative_path_cache_key(&relative)?,
                project_revision_cache_key(&revision)?,
            );
        }

        let project = ProjectCapabilityFs::open(project_root)?;
        let cache = match project.open_directory(".debrute/cache/canvas-image-previews") {
            Ok(cache) => cache,
            Err(ProjectError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let sources = cache.entries()?.collect::<Result<Vec<_>, _>>()?;
        for source in sources {
            let source_type = source.file_type()?;
            let source_name = source.file_name().into_string().ok();
            let expected_revision = source_name
                .as_ref()
                .and_then(|name| expected.get(name))
                .filter(|_| source_type.is_dir() && !source_type.is_symlink());
            let Some(expected_revision) = expected_revision else {
                remove_capability_entry(&cache, &source)?;
                continue;
            };
            let source_directory = source.open_dir()?;
            for revision in source_directory.entries()?.collect::<Result<Vec<_>, _>>()? {
                let file_type = revision.file_type()?;
                let current_revision = revision.file_name()
                    == std::ffi::OsStr::new(expected_revision)
                    && file_type.is_dir()
                    && !file_type.is_symlink();
                if !current_revision {
                    remove_capability_entry(&source_directory, &revision)?;
                    continue;
                }
                let revision_directory = revision.open_dir()?;
                let expected_engine = format!("raster-engine-v{RASTER_PREVIEW_ENGINE_VERSION}");
                for engine in revision_directory
                    .entries()?
                    .collect::<Result<Vec<_>, _>>()?
                {
                    let engine_type = engine.file_type()?;
                    if engine.file_name() != std::ffi::OsStr::new(&expected_engine)
                        || !engine_type.is_dir()
                        || engine_type.is_symlink()
                    {
                        remove_capability_entry(&revision_directory, &engine)?;
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) fn feedback_image(
        project_root: &Path,
        project_relative_path: &str,
        cancellation: &PreviewCancellation,
    ) -> Result<image::DynamicImage, ProjectError> {
        let relative = previewable_image_path(project_relative_path)?;
        let source = resolve_no_symlink_existing_project_path(project_root, &relative)?;
        let mut file = open_no_symlink_existing_project_file(project_root, &relative)?;
        RasterPreviewEngine::load_bounded_admitted(
            &source,
            &mut file,
            MAX_FEEDBACK_ARTIFACT_DIMENSION,
            cancellation,
        )
    }

    pub(crate) fn feedback_video_frame(
        &self,
        project_root: &Path,
        project_relative_path: &str,
        current_time_seconds: f64,
        cancellation: &PreviewCancellation,
    ) -> Result<image::DynamicImage, ProjectError> {
        self.video.feedback_frame(
            project_root,
            project_relative_path,
            current_time_seconds,
            cancellation,
        )
    }

    /// Resolves one deterministic revision-bound image preview.
    ///
    /// # Errors
    /// Returns an error for invalid identity, stale source, cancellation, or decode failure.
    pub fn resolve_image_preview(
        &self,
        project_root: &Path,
        project_relative_path: &str,
        revision: &str,
        width: u32,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasPreviewFile, ProjectError> {
        validate_preview_width(width)?;
        let relative = previewable_image_path(project_relative_path)?;
        let key = format!(
            "{}\0{relative}\0{revision}\0{width}",
            project_root.display()
        );
        let _lock = self.image_locks.acquire(&key, cancellation)?;
        cancellation.check()?;
        let mut source = open_revisioned_source(project_root, &relative, revision)?;
        let base = format!(
            ".debrute/cache/canvas-image-previews/{}/{}/raster-engine-v{RASTER_PREVIEW_ENGINE_VERSION}/preview-w{width}",
            project_relative_path_cache_key(&relative)?,
            project_revision_cache_key(revision)?
        );
        let metadata = self
            .raster
            .metadata_file(&source.path, &mut source.file, cancellation)?;
        if width > metadata.width {
            return Err(ProjectError::service(
                "canvas_preview_invalid_width",
                format!("Canvas preview width exceeds source width: {relative}"),
            ));
        }
        if width == metadata.width
            && let Some(content_type) = direct_image_content_type(&relative)
        {
            verify_source_revision(&source, revision)?;
            source.file.rewind()?;
            return Ok(CanvasPreviewFile {
                absolute_path: source.path,
                file: source.file,
                content_type,
            });
        }
        if let Some(cached) = existing_preview(project_root, &base, &["jpg", "png"])? {
            verify_source_revision(&source, revision)?;
            return Ok(cached);
        }
        let (extension, format, content_type) = if metadata.has_alpha {
            ("png", RasterOutputFormat::Png, "image/png")
        } else {
            ("jpg", RasterOutputFormat::Jpeg, "image/jpeg")
        };
        let project_path = format!("{base}.{extension}");
        let source_root = source.project_root.clone();
        let source_relative = source.relative.clone();
        let source_identity = source.identity;
        ProjectCapabilityFs::open(project_root)?.atomic_write_stream_checked(
            &project_path,
            |output| {
                self.raster.render_variant_to_file(
                    &source.path,
                    &mut source.file,
                    width,
                    format,
                    output,
                    cancellation,
                )
            },
            || verify_source_snapshot(&source_root, &source_relative, &source_identity, revision),
        )?;
        let file = open_no_symlink_existing_project_file(project_root, &project_path)?;
        Ok(CanvasPreviewFile {
            absolute_path: resolve_no_symlink_existing_project_path(project_root, &project_path)?,
            file,
            content_type,
        })
    }

    /// Saves one bounded browser-captured text preview source.
    ///
    /// # Errors
    /// Returns an error for invalid identity, size, path, or filesystem state.
    pub fn save_text_preview_source(
        &self,
        project_root: &Path,
        canvas_id: &str,
        target: &CanvasTextPreviewSourceTarget,
        temporary_source: &Path,
    ) -> Result<(), ProjectError> {
        let source_path = text_source_project_path(canvas_id, target)?;
        let source = File::open(temporary_source)?;
        let metadata = source.metadata()?;
        if !metadata.is_file() || metadata.len() > MAX_TEXT_PREVIEW_SOURCE_BYTES {
            return Err(ProjectError::service(
                "canvas_text_preview_source_invalid",
                "Canvas text preview source is missing, not a file, or too large.",
            ));
        }
        let mut bytes = Vec::new();
        source
            .take(MAX_TEXT_PREVIEW_SOURCE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_TEXT_PREVIEW_SOURCE_BYTES {
            return Err(ProjectError::service(
                "canvas_text_preview_source_invalid",
                "Canvas text preview source grew beyond the size limit.",
            ));
        }
        atomic_write(project_root, &source_path, &bytes)
    }

    pub fn read_text_preview_sources(
        &self,
        project_root: &Path,
        canvas_id: &str,
        targets: &[CanvasTextPreviewSourceTarget],
    ) -> Vec<CanvasTextPreviewSourceView> {
        targets
            .iter()
            .cloned()
            .map(|target| {
                let status = match text_source_project_path(canvas_id, &target).and_then(|path| {
                    existing_file(project_root, &path).map(|path| path.map(|_| ()))
                }) {
                    Ok(Some(())) => CanvasTextPreviewSourceStatus::Available,
                    Ok(None) => CanvasTextPreviewSourceStatus::Missing,
                    Err(error) => CanvasTextPreviewSourceStatus::Error(error.to_string()),
                };
                CanvasTextPreviewSourceView { target, status }
            })
            .collect()
    }

    /// Resolves one deterministic text-capture width variant.
    ///
    /// # Errors
    /// Returns an error for invalid identity, missing source, cancellation, or decode failure.
    pub fn resolve_text_preview_variant(
        &self,
        project_root: &Path,
        canvas_id: &str,
        target: &CanvasTextPreviewSourceTarget,
        width: u32,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasPreviewFile, ProjectError> {
        validate_preview_width(width)?;
        let source_path = text_source_project_path(canvas_id, target)?;
        let source = existing_file(project_root, &source_path)?.ok_or_else(|| {
            ProjectError::service_with_fields(
                "canvas_text_preview_source_missing",
                format!(
                    "Canvas text preview source is not available: {}",
                    target.project_relative_path
                ),
                [
                    (
                        "project_relative_path".to_owned(),
                        target.project_relative_path.clone(),
                    ),
                    ("canvas_id".to_owned(), canvas_id.to_owned()),
                    ("fingerprint".to_owned(), target.fingerprint.clone()),
                ],
            )
        })?;
        let mut file = open_no_symlink_existing_project_file(project_root, &source_path)?;
        let source_identity = debrute_native_fs::file_identity(&file)?;
        let metadata = self
            .raster
            .metadata_file(&source, &mut file, cancellation)?;
        let preview_base = text_preview_base_project_path(canvas_id, target)?;
        reconcile_raster_engine_directory(project_root, &preview_base)?;
        if width > metadata.width {
            return Err(ProjectError::service(
                "canvas_preview_invalid_width",
                format!(
                    "Canvas text preview width exceeds source width: {}",
                    target.project_relative_path
                ),
            ));
        }
        if width == metadata.width {
            verify_text_preview_source(project_root, &source_path, &source_identity)?;
            return Ok(CanvasPreviewFile {
                absolute_path: source,
                file,
                content_type: "image/png",
            });
        }
        let variant_path = text_variant_project_path(canvas_id, target, width)?;
        let key = format!("{}\0{variant_path}", project_root.display());
        let _lock = self.text_locks.acquire(&key, cancellation)?;
        if let Some((path, file)) = existing_open_file(project_root, &variant_path)? {
            verify_text_preview_source(project_root, &source_path, &source_identity)?;
            return Ok(CanvasPreviewFile {
                absolute_path: path,
                file,
                content_type: "image/png",
            });
        }
        ProjectCapabilityFs::open(project_root)?.atomic_write_stream_checked(
            &variant_path,
            |output| {
                self.raster.render_variant_to_file(
                    &source,
                    &mut file,
                    width,
                    RasterOutputFormat::Png,
                    output,
                    cancellation,
                )
            },
            || verify_text_preview_source(project_root, &source_path, &source_identity),
        )?;
        let file = open_no_symlink_existing_project_file(project_root, &variant_path)?;
        Ok(CanvasPreviewFile {
            absolute_path: resolve_no_symlink_existing_project_path(project_root, &variant_path)?,
            file,
            content_type: "image/png",
        })
    }

    #[must_use]
    pub fn video(&self) -> &CanvasVideoPreviewService {
        &self.video
    }
}

fn remove_capability_entry(
    directory: &cap_std::fs::Dir,
    entry: &cap_std::fs::DirEntry,
) -> Result<(), ProjectError> {
    let file_type = entry.file_type()?;
    let name = entry.file_name();
    if file_type.is_dir() && !file_type.is_symlink() {
        let child = entry.open_dir()?;
        let entries = child.entries()?.collect::<Result<Vec<_>, _>>()?;
        for child_entry in entries {
            remove_capability_entry(&child, &child_entry)?;
        }
        directory.remove_dir(name)?;
    } else {
        directory.remove_file(name)?;
    }
    Ok(())
}

pub(super) fn reconcile_raster_engine_directory(
    project_root: &Path,
    project_relative_directory: &str,
) -> Result<(), ProjectError> {
    let project = ProjectCapabilityFs::open(project_root)?;
    let directory = match project.open_directory(project_relative_directory) {
        Ok(directory) => directory,
        Err(ProjectError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let expected = format!("raster-engine-v{RASTER_PREVIEW_ENGINE_VERSION}");
    for entry in directory.entries()?.collect::<Result<Vec<_>, _>>()? {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.starts_with("raster-engine-v") {
            continue;
        }
        let file_type = entry.file_type()?;
        if name != expected || !file_type.is_dir() || file_type.is_symlink() {
            remove_capability_entry(&directory, &entry)?;
        }
    }
    Ok(())
}

struct RevisionedSource {
    project_root: PathBuf,
    relative: String,
    path: PathBuf,
    file: File,
    identity: debrute_native_fs::PathIdentity,
}

fn open_revisioned_source(
    project_root: &Path,
    relative: &str,
    expected_revision: &str,
) -> Result<RevisionedSource, ProjectError> {
    if expected_revision.is_empty() {
        return Err(ProjectError::service(
            "missing_revision",
            "Canvas preview revision is required.",
        ));
    }
    let path = resolve_no_symlink_existing_project_path(project_root, relative)?;
    let file = open_no_symlink_existing_project_file(project_root, relative)?;
    let actual = project_file_revision_from_metadata(&file.metadata()?)?;
    if actual != expected_revision {
        return Err(ProjectError::service_with_fields(
            "canvas_preview_revision_mismatch",
            format!("Canvas preview revision does not match source: {relative}"),
            [
                ("project_relative_path".to_owned(), relative.to_owned()),
                ("expected_revision".to_owned(), expected_revision.to_owned()),
                ("actual_revision".to_owned(), actual),
            ],
        ));
    }
    let identity = debrute_native_fs::file_identity(&file)?;
    Ok(RevisionedSource {
        project_root: project_root.to_path_buf(),
        relative: relative.to_owned(),
        path,
        file,
        identity,
    })
}

fn verify_source_revision(
    source: &RevisionedSource,
    expected_revision: &str,
) -> Result<(), ProjectError> {
    let handle_revision = project_file_revision_from_metadata(&source.file.metadata()?)?;
    let current = open_no_symlink_existing_project_file(&source.project_root, &source.relative)?;
    let current_revision = project_file_revision_from_metadata(&current.metadata()?)?;
    let current_identity = debrute_native_fs::file_identity(&current)?;
    if handle_revision == expected_revision
        && current_revision == expected_revision
        && current_identity == source.identity
    {
        Ok(())
    } else {
        Err(ProjectError::service(
            "canvas_preview_revision_mismatch",
            "Canvas preview source changed during rendering.",
        ))
    }
}

fn verify_source_snapshot(
    project_root: &Path,
    relative: &str,
    identity: &debrute_native_fs::PathIdentity,
    expected_revision: &str,
) -> Result<(), ProjectError> {
    let current = open_no_symlink_existing_project_file(project_root, relative)?;
    let current_revision = project_file_revision_from_metadata(&current.metadata()?)?;
    let current_identity = debrute_native_fs::file_identity(&current)?;
    if current_revision == expected_revision && &current_identity == identity {
        Ok(())
    } else {
        Err(ProjectError::service(
            "canvas_preview_revision_mismatch",
            "Canvas preview source changed during rendering.",
        ))
    }
}

fn verify_text_preview_source(
    project_root: &Path,
    source_path: &str,
    source_identity: &debrute_native_fs::PathIdentity,
) -> Result<(), ProjectError> {
    let current = open_no_symlink_existing_project_file(project_root, source_path)?;
    if &debrute_native_fs::file_identity(&current)? == source_identity {
        Ok(())
    } else {
        Err(ProjectError::service(
            "canvas_preview_revision_mismatch",
            "Canvas text preview source changed during rendering.",
        ))
    }
}

fn previewable_image_path(path: &str) -> Result<String, ProjectError> {
    let relative = assert_project_tree_visible_path(path)?;
    let extension = Path::new(&relative)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "jpe" | "jfif" | "webp" | "avif" | "tif" | "tiff" | "svg" | "svgz"
    ) {
        Ok(relative)
    } else {
        Err(ProjectError::service(
            "canvas_image_not_previewable",
            format!("Canvas image is not previewable: {relative}"),
        ))
    }
}

fn direct_image_content_type(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" | "jpe" | "jfif" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn validate_preview_width(width: u32) -> Result<(), ProjectError> {
    if width == 0 {
        Err(ProjectError::service(
            "canvas_preview_invalid_width",
            "Canvas preview width must be positive.",
        ))
    } else {
        Ok(())
    }
}

fn text_source_project_path(
    canvas_id: &str,
    target: &CanvasTextPreviewSourceTarget,
) -> Result<String, ProjectError> {
    Ok(format!(
        "{}/source.png",
        text_preview_base_project_path(canvas_id, target)?
    ))
}

fn text_variant_project_path(
    canvas_id: &str,
    target: &CanvasTextPreviewSourceTarget,
    width: u32,
) -> Result<String, ProjectError> {
    validate_preview_width(width)?;
    Ok(format!(
        "{}/raster-engine-v{RASTER_PREVIEW_ENGINE_VERSION}/preview-w{width}.png",
        text_preview_base_project_path(canvas_id, target)?
    ))
}

fn text_preview_base_project_path(
    canvas_id: &str,
    target: &CanvasTextPreviewSourceTarget,
) -> Result<String, ProjectError> {
    if !is_canvas_id(canvas_id) {
        return Err(ProjectError::Validation(
            "Canvas text preview canvas id must be a valid id.".to_owned(),
        ));
    }
    let relative = normalize_project_relative_path(&target.project_relative_path)?;
    Ok(format!(
        ".debrute/cache/canvas-text-previews/{canvas_id}/{}/{}",
        project_relative_path_cache_key(&relative)?,
        safe_cache_segment(&target.fingerprint, "Canvas text preview fingerprint")?
    ))
}

fn is_canvas_id(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'.' | b'-'))
        })
}

fn existing_preview(
    project_root: &Path,
    base: &str,
    extensions: &[&str],
) -> Result<Option<CanvasPreviewFile>, ProjectError> {
    for extension in extensions {
        let project_path = format!("{base}.{extension}");
        if let Some((path, file)) = existing_open_file(project_root, &project_path)? {
            return Ok(Some(CanvasPreviewFile {
                absolute_path: path,
                file,
                content_type: if *extension == "png" {
                    "image/png"
                } else {
                    "image/jpeg"
                },
            }));
        }
    }
    Ok(None)
}

fn existing_open_file(
    project_root: &Path,
    relative: &str,
) -> Result<Option<(PathBuf, File)>, ProjectError> {
    let Some(path) = existing_file(project_root, relative)? else {
        return Ok(None);
    };
    let file = open_no_symlink_existing_project_file(project_root, relative)?;
    Ok(Some((path, file)))
}

fn existing_file(project_root: &Path, relative: &str) -> Result<Option<PathBuf>, ProjectError> {
    match open_no_symlink_existing_project_file(project_root, relative) {
        Ok(_) => resolve_no_symlink_existing_project_path(project_root, relative).map(Some),
        Err(ProjectError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn video_text_tracks(
    project_root: &Path,
    video_path: &str,
) -> Result<Vec<serde_json::Value>, ProjectError> {
    let video = normalize_project_relative_path(video_path)?;
    let (directory_relative, name) = video
        .rsplit_once('/')
        .map_or(("", video.as_str()), |value| value);
    let base = name.rsplit_once('.').map_or(name, |(base, _)| base);
    let directory = ProjectCapabilityFs::open(project_root)?.open_directory(directory_relative)?;
    let mut tracks = directory
        .entries()?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            name.starts_with(&format!("{base}."))
                && Path::new(name)
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("vtt"))
        })
        .filter_map(|name| {
            let relative = if directory_relative.is_empty() {
                name
            } else {
                format!("{directory_relative}/{name}")
            };
            parse_video_track(&video, &relative).map(|track| (relative, track))
        })
        .map(|(relative, parsed)| {
            let file = open_no_symlink_existing_project_file(project_root, &relative)?;
            let revision = project_file_revision_from_metadata(&file.metadata()?)?;
            Ok(VideoTrack {
                project_relative_path: relative,
                revision,
                kind: parsed.kind,
                label: parsed.label,
                srclang: parsed.srclang,
            })
        })
        .collect::<Result<Vec<_>, ProjectError>>()?;
    tracks.sort_by(|left, right| {
        track_rank(&left.kind)
            .cmp(&track_rank(&right.kind))
            .then(left.project_relative_path.cmp(&right.project_relative_path))
    });
    let caption_count = tracks
        .iter()
        .filter(|track| matches!(track.kind.as_str(), "captions" | "subtitles"))
        .count();
    Ok(tracks
        .into_iter()
        .map(|track| {
            let mut value = serde_json::json!({
                "projectRelativePath": track.project_relative_path,
                "revision": track.revision,
                "kind": track.kind,
                "label": track.label,
                "default": caption_count == 1 && matches!(track.kind.as_str(), "captions" | "subtitles")
            });
            if let Some(srclang) = track.srclang {
                value["srclang"] = serde_json::Value::String(srclang);
            }
            value
        })
        .collect())
}

struct VideoTrack {
    project_relative_path: String,
    revision: String,
    kind: String,
    label: String,
    srclang: Option<String>,
}

struct ParsedVideoTrack {
    kind: String,
    label: String,
    srclang: Option<String>,
}

fn parse_video_track(video_path: &str, candidate: &str) -> Option<ParsedVideoTrack> {
    let video_name = video_path.rsplit('/').next()?;
    let base = video_name
        .rsplit_once('.')
        .map_or(video_name, |(base, _)| base);
    let name = candidate.rsplit('/').next()?;
    if !name.starts_with(&format!("{base}."))
        || !Path::new(name)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("vtt"))
    {
        return None;
    }
    let parts = name[base.len() + 1..name.len() - ".vtt".len()]
        .split('.')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let marker = parts.last().copied();
    let kind = match marker {
        Some("captions") => "captions",
        Some("chapters") => "chapters",
        Some("thumbnails" | "storyboard") => "metadata",
        _ => "subtitles",
    };
    let language = if kind == "metadata" || parts.is_empty() {
        None
    } else if matches!(marker, Some("captions" | "subtitles" | "chapters")) {
        (parts.len() > 1).then(|| parts[..parts.len() - 1].join("."))
    } else {
        Some(parts.join("."))
    };
    let label = match (kind, language.as_deref()) {
        ("metadata", _) => "thumbnails".to_owned(),
        ("captions", Some("en")) => "English Captions".to_owned(),
        (_, Some("en")) => "English".to_owned(),
        ("captions", Some("zh-CN")) => "Chinese Captions".to_owned(),
        (_, Some("zh-CN")) => "Chinese".to_owned(),
        (_, Some(language)) => language.to_owned(),
        ("chapters", None) => "Chapters".to_owned(),
        ("captions", None) => "Captions".to_owned(),
        _ => "Subtitles".to_owned(),
    };
    Some(ParsedVideoTrack {
        kind: kind.to_owned(),
        label,
        srclang: language,
    })
}

fn track_rank(kind: &str) -> u8 {
    match kind {
        "captions" | "subtitles" => 0,
        "chapters" => 1,
        _ => 2,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Condvar, Mutex, mpsc},
        thread,
        time::Duration,
    };

    use image::{GenericImageView as _, ImageBuffer, Rgb, Rgba, codecs::jpeg::JpegEncoder};
    use uuid::Uuid;

    use super::*;

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("debrute-preview-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("assets")).unwrap();
        let image = ImageBuffer::from_pixel(8, 4, Rgba([255_u8, 0, 0, 128]));
        image.save(root.join("assets/source.png")).unwrap();
        root
    }

    #[test]
    fn raster_preview_pool_admits_three_jobs_and_holds_the_fourth() {
        let service = Arc::new(ProjectPreviewService::new(
            &RuntimeWorkerServices::new(),
            MediaToolPaths::unavailable(),
        ));
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let (entered_sender, entered_receiver) = mpsc::channel();
        let mut workers = Vec::new();
        for _ in 0..4 {
            let service = Arc::clone(&service);
            let gate = Arc::clone(&gate);
            let entered_sender = entered_sender.clone();
            workers.push(thread::spawn(move || {
                service
                    .with_feedback_raster(&PreviewCancellation::default(), || {
                        entered_sender.send(()).unwrap();
                        let (lock, available) = &*gate;
                        let mut released = lock.lock().unwrap();
                        while !*released {
                            released = available.wait(released).unwrap();
                        }
                        Ok(())
                    })
                    .unwrap();
            }));
        }
        drop(entered_sender);

        let mut entered = 0;
        for _ in 0..3 {
            if entered_receiver
                .recv_timeout(Duration::from_millis(200))
                .is_ok()
            {
                entered += 1;
            }
        }
        let fourth_entered_early = entered_receiver
            .recv_timeout(Duration::from_millis(50))
            .is_ok();

        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        for worker in workers {
            worker.join().unwrap();
        }

        assert_eq!(entered, 3);
        assert!(!fourth_entered_early);
    }

    struct SolidRgbImage {
        width: u32,
        height: u32,
    }

    impl image::GenericImageView for SolidRgbImage {
        type Pixel = Rgb<u8>;

        fn dimensions(&self) -> (u32, u32) {
            (self.width, self.height)
        }

        fn get_pixel(&self, _x: u32, _y: u32) -> Self::Pixel {
            Rgb([24, 48, 96])
        }
    }

    fn write_solid_jpeg(path: &Path, width: u32, height: u32) {
        let file = File::create(path).unwrap();
        JpegEncoder::new_with_quality(file, 82)
            .encode_image(&SolidRgbImage { width, height })
            .unwrap();
    }

    #[test]
    fn image_preview_is_revision_bound_and_deterministic() {
        let root = fixture();
        let source = File::open(root.join("assets/source.png")).unwrap();
        let revision = project_file_revision_from_metadata(&source.metadata().unwrap()).unwrap();
        let service = ProjectPreviewService::new(
            &RuntimeWorkerServices::new(),
            MediaToolPaths::unavailable(),
        );
        let result = service
            .resolve_image_preview(
                &root,
                "assets/source.png",
                &revision,
                4,
                &PreviewCancellation::default(),
            )
            .unwrap();
        assert_eq!(result.content_type, "image/png");
        assert!(
            result
                .absolute_path
                .ends_with("raster-engine-v1/preview-w4.png")
        );
        assert!(result.absolute_path.is_file());
        assert_eq!(
            service
                .resolve_image_preview(
                    &root,
                    "assets/source.png",
                    "stale",
                    4,
                    &PreviewCancellation::default(),
                )
                .unwrap_err()
                .code(),
            "canvas_preview_revision_mismatch"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn intrinsic_image_width_returns_the_revision_bound_source_without_an_equal_width_cache() {
        let root = fixture();
        let source_path = root.join("assets/source.png");
        let source = File::open(&source_path).unwrap();
        let revision = project_file_revision_from_metadata(&source.metadata().unwrap()).unwrap();
        let service = ProjectPreviewService::new(
            &RuntimeWorkerServices::new(),
            MediaToolPaths::unavailable(),
        );

        let mut result = service
            .resolve_image_preview(
                &root,
                "assets/source.png",
                &revision,
                8,
                &PreviewCancellation::default(),
            )
            .unwrap();

        assert_eq!(result.absolute_path, source_path);
        assert_eq!(result.content_type, "image/png");
        let mut served = Vec::new();
        result.file.read_to_end(&mut served).unwrap();
        assert_eq!(served, fs::read(&source_path).unwrap());
        assert!(!root.join(".debrute/cache/canvas-image-previews").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn intrinsic_tiff_width_still_creates_a_browser_displayable_variant() {
        let root = fixture();
        let source_path = root.join("assets/source.tiff");
        ImageBuffer::from_pixel(8, 4, Rgb([24_u8, 48, 96]))
            .save_with_format(&source_path, image::ImageFormat::Tiff)
            .unwrap();
        let source = File::open(&source_path).unwrap();
        let revision = project_file_revision_from_metadata(&source.metadata().unwrap()).unwrap();
        let service = ProjectPreviewService::new(
            &RuntimeWorkerServices::new(),
            MediaToolPaths::unavailable(),
        );

        let result = service
            .resolve_image_preview(
                &root,
                "assets/source.tiff",
                &revision,
                8,
                &PreviewCancellation::default(),
            )
            .unwrap();

        assert_ne!(result.absolute_path, source_path);
        assert_eq!(result.content_type, "image/jpeg");
        assert!(
            result
                .absolute_path
                .ends_with("raster-engine-v1/preview-w8.jpg")
        );
        assert_eq!(
            image::open(result.absolute_path).unwrap().dimensions(),
            (8, 4)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_width_is_limited_by_source_and_target_area_not_a_fixed_dimension_cap() {
        let root = fixture();
        let source_path = root.join("assets/panorama.png");
        ImageBuffer::from_pixel(9_000, 1, Rgba([1_u8, 2, 3, 255]))
            .save(&source_path)
            .unwrap();
        let source = File::open(&source_path).unwrap();
        let revision = project_file_revision_from_metadata(&source.metadata().unwrap()).unwrap();
        let service = ProjectPreviewService::new(
            &RuntimeWorkerServices::new(),
            MediaToolPaths::unavailable(),
        );

        let result = service
            .resolve_image_preview(
                &root,
                "assets/panorama.png",
                &revision,
                8_500,
                &PreviewCancellation::default(),
            )
            .unwrap();

        assert_eq!(image::open(result.absolute_path).unwrap().width(), 8_500);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn large_jpeg_is_a_previewable_node_and_renders_a_bounded_variant() {
        let root = fixture();
        let source_path = root.join("assets/large.jpg");
        write_solid_jpeg(&source_path, 5_000, 4_000);
        let source = File::open(&source_path).unwrap();
        let revision = project_file_revision_from_metadata(&source.metadata().unwrap()).unwrap();
        let service = ProjectPreviewService::new(
            &RuntimeWorkerServices::new(),
            MediaToolPaths::unavailable(),
        );
        assert_eq!(
            service
                .image_source_info(&root, "assets/large.jpg")
                .unwrap(),
            CanvasImagePreviewSourceInfo {
                previewable: true,
                source_width: Some(5_000),
            }
        );

        let result = service
            .resolve_image_preview(
                &root,
                "assets/large.jpg",
                &revision,
                625,
                &PreviewCancellation::default(),
            )
            .unwrap();
        assert_eq!(result.content_type, "image/jpeg");
        assert_eq!(
            image::open(&result.absolute_path).unwrap().dimensions(),
            (625, 500)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn feedback_image_is_bounded_to_the_artifact_dimension() {
        let root = fixture();
        let source_path = root.join("assets/wide.jpg");
        write_solid_jpeg(&source_path, 5_000, 100);
        let portrait_path = root.join("assets/portrait.jpg");
        write_solid_jpeg(&portrait_path, 1, 5_000);

        assert_eq!(
            ProjectPreviewService::feedback_image(
                &root,
                "assets/wide.jpg",
                &PreviewCancellation::default(),
            )
            .unwrap()
            .dimensions(),
            (4_096, 82)
        );
        assert_eq!(
            ProjectPreviewService::feedback_image(
                &root,
                "assets/portrait.jpg",
                &PreviewCancellation::default(),
            )
            .unwrap()
            .dimensions(),
            (1, 4_096)
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn text_preview_source_and_variant_use_complete_identity() {
        let root = fixture();
        let service = ProjectPreviewService::new(
            &RuntimeWorkerServices::new(),
            MediaToolPaths::unavailable(),
        );
        let target = CanvasTextPreviewSourceTarget {
            project_relative_path: "notes/title.md".to_owned(),
            fingerprint: "style:one".to_owned(),
        };
        service
            .save_text_preview_source(&root, "canvas-1", &target, &root.join("assets/source.png"))
            .unwrap();
        let old_engine = root
            .join(text_preview_base_project_path("canvas-1", &target).unwrap())
            .join("raster-engine-v0");
        fs::create_dir_all(&old_engine).unwrap();
        let variant = service
            .resolve_text_preview_variant(
                &root,
                "canvas-1",
                &target,
                4,
                &PreviewCancellation::default(),
            )
            .unwrap();
        assert!(
            variant
                .absolute_path
                .to_string_lossy()
                .contains("style%3Aone")
        );
        assert!(
            variant
                .absolute_path
                .ends_with("raster-engine-v1/preview-w4.png")
        );
        assert!(!old_engine.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn intrinsic_text_preview_width_returns_the_canonical_source() {
        let root = fixture();
        let service = ProjectPreviewService::new(
            &RuntimeWorkerServices::new(),
            MediaToolPaths::unavailable(),
        );
        let target = CanvasTextPreviewSourceTarget {
            project_relative_path: "notes/title.md".to_owned(),
            fingerprint: "style:direct".to_owned(),
        };
        service
            .save_text_preview_source(&root, "canvas-1", &target, &root.join("assets/source.png"))
            .unwrap();

        let result = service
            .resolve_text_preview_variant(
                &root,
                "canvas-1",
                &target,
                8,
                &PreviewCancellation::default(),
            )
            .unwrap();

        assert!(result.absolute_path.ends_with("source.png"));
        assert!(
            !result
                .absolute_path
                .parent()
                .unwrap()
                .join("raster-engine-v1/preview-w8.png")
                .exists()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn image_cache_reconcile_removes_old_revisions_and_invalid_entries() {
        let root = fixture();
        let source_path = root.join("assets/source.png");
        let workers = RuntimeWorkerServices::new();
        let service = ProjectPreviewService::new(&workers, MediaToolPaths::unavailable());
        let source = File::open(&source_path).unwrap();
        let first_revision =
            project_file_revision_from_metadata(&source.metadata().unwrap()).unwrap();
        let preview = service
            .resolve_image_preview(
                &root,
                "assets/source.png",
                &first_revision,
                4,
                &PreviewCancellation::default(),
            )
            .unwrap();
        drop(preview);
        ImageBuffer::from_pixel(16, 9, Rgba([1_u8, 2, 3, 255]))
            .save(&source_path)
            .unwrap();
        let cache_root = root.join(".debrute/cache/canvas-image-previews");
        fs::write(cache_root.join("invalid-entry"), "invalid").unwrap();
        service
            .reconcile_image_cache(
                &root,
                &[ProjectFileEntry {
                    project_relative_path: "assets/source.png".to_owned(),
                    kind: ProjectPathKind::File,
                }],
            )
            .unwrap();
        assert!(!cache_root.join("invalid-entry").exists());
        assert!(
            !cache_root
                .join(project_relative_path_cache_key("assets/source.png").unwrap())
                .join(project_revision_cache_key(&first_revision).unwrap())
                .exists()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn image_cache_hit_still_validates_the_current_source() {
        let root = fixture();
        let source_path = root.join("assets/source.png");
        let workers = RuntimeWorkerServices::new();
        let service = ProjectPreviewService::new(&workers, MediaToolPaths::unavailable());
        let source = File::open(&source_path).unwrap();
        let metadata = source.metadata().unwrap();
        let revision = project_file_revision_from_metadata(&metadata).unwrap();
        drop(
            service
                .resolve_image_preview(
                    &root,
                    "assets/source.png",
                    &revision,
                    4,
                    &PreviewCancellation::default(),
                )
                .unwrap(),
        );
        let damaged = vec![0_u8; usize::try_from(metadata.len()).unwrap()];
        fs::write(&source_path, damaged).unwrap();
        File::options()
            .write(true)
            .open(&source_path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
            .unwrap();
        assert!(
            service
                .resolve_image_preview(
                    &root,
                    "assets/source.png",
                    &revision,
                    4,
                    &PreviewCancellation::default(),
                )
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn image_cache_reconcile_keeps_only_the_current_raster_engine_version() {
        let root = fixture();
        let source = File::open(root.join("assets/source.png")).unwrap();
        let revision = project_file_revision_from_metadata(&source.metadata().unwrap()).unwrap();
        let service = ProjectPreviewService::new(
            &RuntimeWorkerServices::new(),
            MediaToolPaths::unavailable(),
        );
        let preview = service
            .resolve_image_preview(
                &root,
                "assets/source.png",
                &revision,
                4,
                &PreviewCancellation::default(),
            )
            .unwrap();
        let current_engine = preview.absolute_path.parent().unwrap().to_path_buf();
        let revision_directory = current_engine.parent().unwrap();
        let old_engine = revision_directory.join("raster-engine-v0");
        fs::create_dir_all(&old_engine).unwrap();
        fs::write(old_engine.join("preview-w4.png"), b"old").unwrap();

        service
            .reconcile_image_cache(
                &root,
                &[ProjectFileEntry {
                    project_relative_path: "assets/source.png".to_owned(),
                    kind: ProjectPathKind::File,
                }],
            )
            .unwrap();

        assert!(current_engine.is_dir());
        assert!(!old_engine.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn image_cache_reconcile_never_follows_an_external_symlink() {
        use std::os::unix::fs::symlink;

        let root = fixture();
        let external = std::env::temp_dir().join(format!("debrute-external-{}", Uuid::new_v4()));
        fs::create_dir_all(&external).unwrap();
        fs::write(external.join("must-survive"), "outside").unwrap();
        let cache = root.join(".debrute/cache/canvas-image-previews");
        if cache.exists() {
            fs::remove_dir_all(&cache).unwrap();
        }
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        symlink(&external, &cache).unwrap();
        let workers = RuntimeWorkerServices::new();
        let service = ProjectPreviewService::new(&workers, MediaToolPaths::unavailable());
        assert!(service.reconcile_image_cache(&root, &[]).is_err());
        assert!(external.join("must-survive").is_file());
        fs::remove_file(cache).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(external).unwrap();
    }
}
