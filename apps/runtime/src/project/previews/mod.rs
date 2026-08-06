//! Deterministic, revision-bound Canvas preview services.

mod cache;
mod libvips_adapter;
pub(crate) mod raster;
mod raster_variants;
mod video;

use std::{
    collections::HashMap,
    fs::File,
    io::Read as _,
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
    CanvasImageDimensions, CanvasImagePreviewInfo, CanvasVideoPresentation,
    CanvasVideoPresentationKind, CanvasVideoTextTrack, CanvasVideoTextTrackKind,
    ProjectCapabilityFs, ProjectError, ProjectNodeAdapter, ProjectPathKind, ProjectTreeEntry,
    assert_project_tree_visible_path, normalize_project_relative_path,
    open_no_symlink_existing_project_file, project_media_revision,
    resolve_no_symlink_existing_project_path,
};
use cache::{
    Semaphore, atomic_write, project_relative_path_cache_key, project_revision_cache_key,
    safe_cache_segment,
};
use raster::RasterPreviewEngine;
pub use raster::initialize_raster_preview_engine;
use raster_variants::{
    RasterPreviewVariantOutputPolicy, RasterPreviewVariantRequest, RasterPreviewVariantService,
};

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
    pub source_height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasTextPreviewSourceTarget {
    pub project_relative_path: String,
    pub target_identity: String,
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
    debrute_home: PathBuf,
    raster_variants: Arc<RasterPreviewVariantService>,
    raster_pool: Arc<Semaphore>,
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
    fn video_presentation(
        &self,
        project_root: &Path,
        project_relative_path: &str,
    ) -> Result<Option<CanvasVideoPresentation>, ProjectError> {
        let metadata = self.previews.video.read_metadata(
            project_root,
            project_relative_path,
            &PreviewCancellation::default(),
        )?;
        Ok(Some(CanvasVideoPresentation {
            kind: CanvasVideoPresentationKind::Video,
            width: metadata.width,
            height: metadata.height,
            duration_seconds: metadata.duration_seconds,
            text_tracks: video_text_tracks(project_root, project_relative_path)?,
        }))
    }

    fn image_preview_info(
        &self,
        project_root: &Path,
        project_relative_path: &str,
    ) -> Result<Option<CanvasImagePreviewInfo>, ProjectError> {
        let info = self
            .previews
            .image_source_info(project_root, project_relative_path)?;
        Ok(Some(CanvasImagePreviewInfo {
            previewable: info.previewable,
            dimensions: info
                .source_width
                .zip(info.source_height)
                .map(|(width, height)| CanvasImageDimensions {
                    width: u64::from(width),
                    height: u64::from(height),
                }),
        }))
    }
}

impl ProjectPreviewService {
    #[cfg(test)]
    #[must_use]
    pub fn new(workers: &RuntimeWorkerServices, media_tools: MediaToolPaths) -> Self {
        Self::new_with_home(
            workers,
            media_tools,
            std::env::temp_dir().join(format!("debrute-preview-home-{}", uuid::Uuid::new_v4())),
        )
    }

    #[must_use]
    pub fn new_with_home(
        workers: &RuntimeWorkerServices,
        media_tools: MediaToolPaths,
        debrute_home: impl Into<PathBuf>,
    ) -> Self {
        let debrute_home = debrute_home.into();
        let raster_pool = Arc::new(Semaphore::new(3));
        let raster_variants = Arc::new(RasterPreviewVariantService::new(Arc::clone(&raster_pool)));
        Self {
            debrute_home: debrute_home.clone(),
            raster_variants: Arc::clone(&raster_variants),
            raster_pool: Arc::clone(&raster_pool),
            video: CanvasVideoPreviewService::new(
                workers.supervisor(),
                media_tools,
                raster_variants,
                debrute_home,
            ),
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
                source_height: None,
            });
        };
        let source = resolve_no_symlink_existing_project_path(project_root, &relative)?;
        let mut file = open_no_symlink_existing_project_file(project_root, &relative)?;
        let metadata = self.raster_variants.metadata_file(
            &source,
            &mut file,
            &PreviewCancellation::default(),
        )?;
        Ok(CanvasImagePreviewSourceInfo {
            previewable: true,
            source_width: Some(metadata.width),
            source_height: Some(metadata.height),
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
        files: &[ProjectTreeEntry],
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
                .raster_variants
                .metadata_file(&path, &mut file, &PreviewCancellation::default())
                .is_err()
            {
                continue;
            }
            let revision = project_media_revision(&mut file)?;
            expected.insert(
                project_relative_path_cache_key(&relative)?,
                project_revision_cache_key(&revision)?,
            );
        }

        let cache_root = self.cache_root(project_root)?;
        let cache_fs = ProjectCapabilityFs::open(&cache_root)?;
        let cache = match cache_fs.open_directory("canvas-image-previews") {
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
        let relative = previewable_image_path(project_relative_path)?;
        let source = open_revisioned_source(project_root, &relative, revision)?;
        let cache_directory = format!(
            "canvas-image-previews/{}/{}",
            project_relative_path_cache_key(&relative)?,
            project_revision_cache_key(revision)?
        );
        let source_root = source.project_root.clone();
        let source_relative = source.relative.clone();
        let source_identity = source.identity;
        let cache_root = self.cache_root(project_root)?;
        self.raster_variants.resolve(
            &cache_root,
            RasterPreviewVariantRequest {
                source_path: source.path,
                source_file: source.file,
                source_content_type: direct_image_content_type(&relative),
                cache_directory,
                width,
                output_policy: RasterPreviewVariantOutputPolicy::MatchSourceAlpha,
                invalid_width_message: format!(
                    "Canvas preview width exceeds source width: {relative}"
                ),
            },
            cancellation,
            || verify_source_snapshot(&source_root, &source_relative, &source_identity, revision),
        )
    }

    /// Saves one bounded browser-captured text preview source.
    ///
    /// # Errors
    /// Returns an error for invalid identity, size, path, or filesystem state.
    pub fn save_text_preview_source(
        &self,
        project_root: &Path,
        target: &CanvasTextPreviewSourceTarget,
        temporary_source: &Path,
    ) -> Result<(), ProjectError> {
        let source_path = text_source_project_path(target)?;
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
        let cache_root = self.cache_root(project_root)?;
        atomic_write(&cache_root, &source_path, &bytes)
    }

    pub fn read_text_preview_sources(
        &self,
        project_root: &Path,
        targets: &[CanvasTextPreviewSourceTarget],
    ) -> Vec<CanvasTextPreviewSourceView> {
        targets
            .iter()
            .cloned()
            .map(|target| {
                let status = match text_source_project_path(&target).and_then(|path| {
                    self.cache_root(project_root)
                        .and_then(|cache_root| existing_file(&cache_root, &path))
                        .map(|path| path.map(|_| ()))
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
        target: &CanvasTextPreviewSourceTarget,
        width: u32,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasPreviewFile, ProjectError> {
        let source_path = text_source_project_path(target)?;
        let cache_root = self.cache_root(project_root)?;
        let source = existing_file(&cache_root, &source_path)?.ok_or_else(|| {
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
                    ("target_identity".to_owned(), target.target_identity.clone()),
                ],
            )
        })?;
        let file = open_no_symlink_existing_project_file(&cache_root, &source_path)?;
        let source_identity = debrute_native_fs::file_identity(&file)?;
        self.raster_variants.resolve(
            &cache_root,
            RasterPreviewVariantRequest {
                source_path: source,
                source_file: file,
                source_content_type: Some("image/png"),
                cache_directory: text_preview_base_project_path(target)?,
                width,
                output_policy: RasterPreviewVariantOutputPolicy::Png,
                invalid_width_message: format!(
                    "Canvas text preview width exceeds source width: {}",
                    target.project_relative_path
                ),
            },
            cancellation,
            || verify_text_preview_source(&cache_root, &source_path, &source_identity),
        )
    }

    fn cache_root(&self, project_root: &Path) -> Result<PathBuf, ProjectError> {
        let canonical_root = project_root.canonicalize()?;
        let canonical_root = canonical_root.to_str().ok_or_else(|| {
            ProjectError::Validation("Project root must be valid UTF-8.".to_owned())
        })?;
        let root =
            crate::global::root_cache_directory(&self.debrute_home, canonical_root).join("canvas");
        std::fs::create_dir_all(&root)?;
        Ok(root)
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
        drop(child);
        directory.remove_dir(name)?;
    } else {
        directory.remove_file(name)?;
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
    let mut file = open_no_symlink_existing_project_file(project_root, relative)?;
    let actual = project_media_revision(&mut file)?;
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

fn verify_source_snapshot(
    project_root: &Path,
    relative: &str,
    identity: &debrute_native_fs::PathIdentity,
    expected_revision: &str,
) -> Result<(), ProjectError> {
    let mut current = open_no_symlink_existing_project_file(project_root, relative)?;
    let current_revision = project_media_revision(&mut current)?;
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

fn text_source_project_path(
    target: &CanvasTextPreviewSourceTarget,
) -> Result<String, ProjectError> {
    Ok(format!(
        "{}/source.png",
        text_preview_base_project_path(target)?
    ))
}

fn text_preview_base_project_path(
    target: &CanvasTextPreviewSourceTarget,
) -> Result<String, ProjectError> {
    let relative = normalize_project_relative_path(&target.project_relative_path)?;
    Ok(format!(
        "canvas-text-previews/{}/{}",
        project_relative_path_cache_key(&relative)?,
        safe_cache_segment(
            &target.target_identity,
            "Canvas text preview target identity"
        )?
    ))
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
) -> Result<Vec<CanvasVideoTextTrack>, ProjectError> {
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
            let mut file = open_no_symlink_existing_project_file(project_root, &relative)?;
            let revision = project_media_revision(&mut file)?;
            Ok(VideoTrack {
                project_relative_path: relative,
                revision,
                kind: video_text_track_kind(&parsed.kind),
                label: parsed.label,
                srclang: parsed.srclang,
            })
        })
        .collect::<Result<Vec<_>, ProjectError>>()?;
    tracks.sort_by(|left, right| {
        track_rank(left.kind)
            .cmp(&track_rank(right.kind))
            .then(left.project_relative_path.cmp(&right.project_relative_path))
    });
    let caption_count = tracks
        .iter()
        .filter(|track| {
            matches!(
                track.kind,
                CanvasVideoTextTrackKind::Captions | CanvasVideoTextTrackKind::Subtitles
            )
        })
        .count();
    Ok(tracks
        .into_iter()
        .map(|track| CanvasVideoTextTrack {
            project_relative_path: track.project_relative_path,
            file_url: None,
            revision: track.revision,
            kind: track.kind,
            label: track.label,
            srclang: track.srclang,
            default: caption_count == 1
                && matches!(
                    track.kind,
                    CanvasVideoTextTrackKind::Captions | CanvasVideoTextTrackKind::Subtitles
                ),
        })
        .collect())
}

struct VideoTrack {
    project_relative_path: String,
    revision: String,
    kind: CanvasVideoTextTrackKind,
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

fn video_text_track_kind(kind: &str) -> CanvasVideoTextTrackKind {
    match kind {
        "captions" => CanvasVideoTextTrackKind::Captions,
        "chapters" => CanvasVideoTextTrackKind::Chapters,
        "metadata" => CanvasVideoTextTrackKind::Metadata,
        _ => CanvasVideoTextTrackKind::Subtitles,
    }
}

fn track_rank(kind: CanvasVideoTextTrackKind) -> u8 {
    match kind {
        CanvasVideoTextTrackKind::Captions | CanvasVideoTextTrackKind::Subtitles => 0,
        CanvasVideoTextTrackKind::Chapters => 1,
        CanvasVideoTextTrackKind::Metadata => 2,
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
        let mut source = File::open(root.join("assets/source.png")).unwrap();
        let revision = project_media_revision(&mut source).unwrap();
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
        let mut source = File::open(&source_path).unwrap();
        let revision = project_media_revision(&mut source).unwrap();
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
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn intrinsic_tiff_width_still_creates_a_browser_displayable_variant() {
        let root = fixture();
        let source_path = root.join("assets/source.tiff");
        ImageBuffer::from_pixel(8, 4, Rgb([24_u8, 48, 96]))
            .save_with_format(&source_path, image::ImageFormat::Tiff)
            .unwrap();
        let mut source = File::open(&source_path).unwrap();
        let revision = project_media_revision(&mut source).unwrap();
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
        let mut source = File::open(&source_path).unwrap();
        let revision = project_media_revision(&mut source).unwrap();
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
        let mut source = File::open(&source_path).unwrap();
        let revision = project_media_revision(&mut source).unwrap();
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
                source_height: Some(4_000),
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
            target_identity: "style:one".to_owned(),
        };
        service
            .save_text_preview_source(&root, &target, &root.join("assets/source.png"))
            .unwrap();
        let variant = service
            .resolve_text_preview_variant(&root, &target, 4, &PreviewCancellation::default())
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
            target_identity: "style:direct".to_owned(),
        };
        service
            .save_text_preview_source(&root, &target, &root.join("assets/source.png"))
            .unwrap();

        let result = service
            .resolve_text_preview_variant(&root, &target, 8, &PreviewCancellation::default())
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
        let home = std::env::temp_dir().join(format!("debrute-preview-home-{}", Uuid::new_v4()));
        let source_path = root.join("assets/source.png");
        let workers = RuntimeWorkerServices::new();
        let service =
            ProjectPreviewService::new_with_home(&workers, MediaToolPaths::unavailable(), &home);
        let mut source = File::open(&source_path).unwrap();
        let first_revision = project_media_revision(&mut source).unwrap();
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
        let canonical_root = root.canonicalize().unwrap();
        let cache_root =
            crate::global::root_cache_directory(&home, canonical_root.to_str().unwrap())
                .join("canvas/canvas-image-previews");
        fs::write(cache_root.join("invalid-entry"), "invalid").unwrap();
        service
            .reconcile_image_cache(
                &root,
                &[ProjectTreeEntry {
                    project_relative_path: "assets/source.png".to_owned(),
                    kind: ProjectPathKind::File,
                    size_bytes: None,
                    ignored: false,
                    hidden: false,
                    directory_state: None,
                    directory_error: None,
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
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn image_cache_hit_still_validates_the_current_source() {
        let root = fixture();
        let source_path = root.join("assets/source.png");
        let workers = RuntimeWorkerServices::new();
        let service = ProjectPreviewService::new(&workers, MediaToolPaths::unavailable());
        let mut source = File::open(&source_path).unwrap();
        let metadata = source.metadata().unwrap();
        let revision = project_media_revision(&mut source).unwrap();
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

    #[cfg(target_os = "macos")]
    #[test]
    fn image_cache_reconcile_never_follows_an_external_symlink() {
        use std::os::unix::fs::symlink;

        let root = fixture();
        let home = std::env::temp_dir().join(format!("debrute-preview-home-{}", Uuid::new_v4()));
        let external = std::env::temp_dir().join(format!("debrute-external-{}", Uuid::new_v4()));
        fs::create_dir_all(&external).unwrap();
        fs::write(external.join("must-survive"), "outside").unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let cache = crate::global::root_cache_directory(&home, canonical_root.to_str().unwrap())
            .join("canvas/canvas-image-previews");
        if cache.exists() {
            fs::remove_dir_all(&cache).unwrap();
        }
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        symlink(&external, &cache).unwrap();
        let workers = RuntimeWorkerServices::new();
        let service =
            ProjectPreviewService::new_with_home(&workers, MediaToolPaths::unavailable(), &home);
        assert!(service.reconcile_image_cache(&root, &[]).is_err());
        assert!(external.join("must-survive").is_file());
        fs::remove_file(cache).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(external).unwrap();
    }
}
