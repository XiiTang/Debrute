use std::{
    fs::{self, File},
    io::{Read as _, Seek as _},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::Value;
use uuid::Uuid;

use crate::process::{BoundedProcessSupervisor, ProcessRequest, WorkerKind};

use super::{
    CanvasPreviewFile, PreviewCancellation,
    cache::{
        KeyedLocks, Semaphore, project_relative_path_cache_key, project_revision_cache_key,
        validate_cache_segment,
    },
    existing_file, existing_open_file,
    raster::{RasterOutputFormat, RasterPreviewEngine},
    validate_preview_width,
};
use crate::project::{
    ProjectCapabilityFs, ProjectError, normalize_project_relative_path,
    open_no_symlink_existing_project_file, project_file_revision_from_metadata,
    resolve_no_symlink_existing_project_path,
};

const MEDIA_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const VIDEO_FRAME_TIMEOUT: Duration = Duration::from_secs(30);
const MEDIA_OUTPUT_LIMIT: usize = 1024 * 1024;
const MAX_EXPLICIT_POSTER_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXTRACTED_FRAME_BYTES: u64 = 64 * 1024 * 1024;
const MAX_STABLE_VIDEO_COPY_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const STABLE_VIDEO_COPY_DISK_RESERVE: u64 = 256 * 1024 * 1024;
const STABLE_VIDEO_COPY_TIMEOUT: Duration = Duration::from_secs(30);
const VIDEO_FRAME_SCALE_FILTER: &str = "scale=w='min(4096,iw)':h='min(4096,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaToolPaths {
    pub ffmpeg: Option<PathBuf>,
    pub ffprobe: Option<PathBuf>,
}

impl MediaToolPaths {
    #[must_use]
    pub fn unavailable() -> Self {
        Self {
            ffmpeg: None,
            ffprobe: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CanvasVideoMetadata {
    pub width: u32,
    pub height: u32,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasVideoPreviewSourceKind {
    InitialPoster,
    PlaybackFrame,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasVideoPreviewTarget {
    pub project_relative_path: String,
    pub video_revision: String,
    pub current_time_seconds: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CanvasVideoPreviewSourceStatus {
    Available {
        source_kind: CanvasVideoPreviewSourceKind,
        source_key: String,
        source_width: u32,
    },
    Error {
        source_kind: CanvasVideoPreviewSourceKind,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasVideoPreviewSourceView {
    pub target: CanvasVideoPreviewTarget,
    pub status: CanvasVideoPreviewSourceStatus,
}

pub struct CanvasVideoPreviewService {
    supervisor: Arc<BoundedProcessSupervisor>,
    tools: MediaToolPaths,
    raster: RasterPreviewEngine,
    stable_copy_admission: Semaphore,
    source_locks: KeyedLocks,
    variant_locks: KeyedLocks,
}

impl CanvasVideoPreviewService {
    pub(super) fn new(
        supervisor: Arc<BoundedProcessSupervisor>,
        tools: MediaToolPaths,
        raster_pool: Arc<super::cache::Semaphore>,
    ) -> Self {
        Self {
            supervisor,
            tools,
            raster: RasterPreviewEngine::new(raster_pool, 8),
            stable_copy_admission: Semaphore::new(1),
            source_locks: KeyedLocks::default(),
            variant_locks: KeyedLocks::default(),
        }
    }

    /// Reads the fixed ffprobe projection for one Project video.
    ///
    /// # Errors
    /// Returns an error for an invalid path, unavailable ffprobe, cancellation, or invalid output.
    pub fn read_metadata(
        &self,
        project_root: &Path,
        project_relative_path: &str,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasVideoMetadata, ProjectError> {
        let source = StableVideoInput::open(
            project_root,
            project_relative_path,
            &self.stable_copy_admission,
            cancellation,
        )?;
        self.read_metadata_path(&source.path, cancellation)
    }

    pub(crate) fn feedback_frame(
        &self,
        project_root: &Path,
        project_relative_path: &str,
        current_time_seconds: f64,
        cancellation: &PreviewCancellation,
    ) -> Result<image::DynamicImage, ProjectError> {
        if !current_time_seconds.is_finite() || current_time_seconds < 0.0 {
            return Err(ProjectError::Validation(
                "Canvas feedback video time must be a non-negative finite number.".to_owned(),
            ));
        }
        let source = StableVideoInput::open(
            project_root,
            project_relative_path,
            &self.stable_copy_admission,
            cancellation,
        )?;
        let temporary =
            self.extract_frame_temporary(&source.path, current_time_seconds, cancellation)?;
        (|| {
            let mut file = File::open(&temporary.path)?;
            RasterPreviewEngine::load_bounded_admitted(
                &temporary.path,
                &mut file,
                super::MAX_FEEDBACK_ARTIFACT_DIMENSION,
                cancellation,
            )
        })()
    }

    /// Resolves the requested video preview sources independently.
    ///
    /// # Errors
    /// Returns an error when a target has an invalid playback timestamp.
    pub fn read_sources(
        &self,
        project_root: &Path,
        canvas_id: &str,
        targets: &[CanvasVideoPreviewTarget],
        cancellation: &PreviewCancellation,
    ) -> Result<Vec<CanvasVideoPreviewSourceView>, ProjectError> {
        let mut result = Vec::with_capacity(targets.len());
        for target in targets.iter().cloned() {
            let source_kind = source_kind(target.current_time_seconds)?;
            let status = match self.resolve_source(project_root, canvas_id, &target, cancellation) {
                Ok(source) => CanvasVideoPreviewSourceStatus::Available {
                    source_kind,
                    source_key: source.source_key,
                    source_width: source.source_width,
                },
                Err(error) => CanvasVideoPreviewSourceStatus::Error {
                    source_kind,
                    message: error.to_string(),
                },
            };
            result.push(CanvasVideoPreviewSourceView { target, status });
        }
        Ok(result)
    }

    /// Resolves one revision-bound JPEG variant from an accepted source key.
    ///
    /// # Errors
    /// Returns an error for invalid identity, unavailable source, cancellation, or decode failure.
    pub fn resolve_variant(
        &self,
        project_root: &Path,
        canvas_id: &str,
        target: &CanvasVideoPreviewTarget,
        source_key: &str,
        width: u32,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasPreviewFile, ProjectError> {
        validate_preview_width(width)?;
        let kind = source_kind(target.current_time_seconds)?;
        let directory = video_source_directory(
            canvas_id,
            &target.project_relative_path,
            &target.video_revision,
            kind,
            source_key,
        )?;
        assert_video_revision(project_root, target)?;
        assert_source_key_current(project_root, target, kind, source_key)?;
        let (source_project_path, source) =
            source_file(project_root, &directory)?.ok_or_else(|| {
                ProjectError::service_with_fields(
                    "canvas_video_preview_source_missing",
                    format!(
                        "Canvas video preview source is not available: {}",
                        target.project_relative_path
                    ),
                    [
                        ("canvas_id".to_owned(), canvas_id.to_owned()),
                        (
                            "project_relative_path".to_owned(),
                            target.project_relative_path.clone(),
                        ),
                        ("video_revision".to_owned(), target.video_revision.clone()),
                        ("source_key".to_owned(), source_key.to_owned()),
                    ],
                )
            })?;
        let mut file = open_no_symlink_existing_project_file(project_root, &source_project_path)?;
        let metadata = self
            .raster
            .metadata_file(&source, &mut file, cancellation)?;
        if width > metadata.width {
            return Err(ProjectError::service(
                "canvas_preview_invalid_width",
                format!(
                    "Canvas video preview width exceeds source width: {}",
                    target.project_relative_path
                ),
            ));
        }
        if width == metadata.width {
            assert_source_key_current(project_root, target, kind, source_key)?;
            let content_type = match Path::new(&source_project_path)
                .extension()
                .and_then(|extension| extension.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref()
            {
                Some("png") => "image/png",
                Some("webp") => "image/webp",
                Some("avif") => "image/avif",
                _ => "image/jpeg",
            };
            return Ok(CanvasPreviewFile {
                absolute_path: source,
                file,
                content_type,
            });
        }
        let variant = format!(
            "{directory}/raster-engine-v{}/preview-w{width}.jpg",
            super::RASTER_PREVIEW_ENGINE_VERSION
        );
        let key = format!("{}\0{variant}", project_root.display());
        let _lock = self.variant_locks.acquire(&key, cancellation)?;
        assert_video_revision(project_root, target)?;
        assert_source_key_current(project_root, target, kind, source_key)?;
        if let Some((path, file)) = existing_open_file(project_root, &variant)? {
            assert_source_key_current(project_root, target, kind, source_key)?;
            return Ok(CanvasPreviewFile {
                absolute_path: path,
                file,
                content_type: "image/jpeg",
            });
        }
        ProjectCapabilityFs::open(project_root)?.atomic_write_stream_checked(
            &variant,
            |output| {
                self.raster.render_variant_to_file(
                    &source,
                    &mut file,
                    width,
                    RasterOutputFormat::Jpeg,
                    output,
                    cancellation,
                )
            },
            || assert_source_key_current(project_root, target, kind, source_key),
        )?;
        let file = open_no_symlink_existing_project_file(project_root, &variant)?;
        Ok(CanvasPreviewFile {
            absolute_path: resolve_no_symlink_existing_project_path(project_root, &variant)?,
            file,
            content_type: "image/jpeg",
        })
    }

    fn resolve_source(
        &self,
        project_root: &Path,
        canvas_id: &str,
        target: &CanvasVideoPreviewTarget,
        cancellation: &PreviewCancellation,
    ) -> Result<ResolvedSource, ProjectError> {
        cancellation.check()?;
        assert_video_revision(project_root, target)?;
        let kind = source_kind(target.current_time_seconds)?;
        let hint = match kind {
            CanvasVideoPreviewSourceKind::InitialPoster => "initial".to_owned(),
            CanvasVideoPreviewSourceKind::PlaybackFrame => {
                playback_source_key(target.current_time_seconds)?
            }
        };
        let key = format!(
            "{}\0{canvas_id}\0{}\0{}\0{hint}",
            project_root.display(),
            target.project_relative_path,
            target.video_revision
        );
        let _lock = self.source_locks.acquire(&key, cancellation)?;
        assert_video_revision(project_root, target)?;
        match kind {
            CanvasVideoPreviewSourceKind::InitialPoster => {
                if let Some(poster) = explicit_poster(project_root, &target.project_relative_path)?
                {
                    self.resolve_explicit_poster(
                        project_root,
                        canvas_id,
                        target,
                        poster,
                        cancellation,
                    )
                } else {
                    let source_key = auto_initial_source_key(&target.video_revision)?;
                    self.resolve_extracted_frame(
                        project_root,
                        canvas_id,
                        target,
                        kind,
                        &source_key,
                        0.0,
                        cancellation,
                    )
                }
            }
            CanvasVideoPreviewSourceKind::PlaybackFrame => {
                let metadata =
                    self.read_metadata(project_root, &target.project_relative_path, cancellation)?;
                if metadata
                    .duration_seconds
                    .is_some_and(|duration| target.current_time_seconds > duration)
                {
                    return Err(ProjectError::service(
                        "canvas_video_preview_time_out_of_range",
                        format!(
                            "Canvas video playback time exceeds video duration: {}",
                            target.project_relative_path
                        ),
                    ));
                }
                let source_key = playback_source_key(target.current_time_seconds)?;
                self.resolve_extracted_frame(
                    project_root,
                    canvas_id,
                    target,
                    kind,
                    &source_key,
                    target.current_time_seconds,
                    cancellation,
                )
            }
        }
    }

    fn resolve_explicit_poster(
        &self,
        project_root: &Path,
        canvas_id: &str,
        target: &CanvasVideoPreviewTarget,
        mut poster: ExplicitPoster,
        cancellation: &PreviewCancellation,
    ) -> Result<ResolvedSource, ProjectError> {
        let source_key = explicit_poster_source_key(&poster)?;
        let directory = video_source_directory(
            canvas_id,
            &target.project_relative_path,
            &target.video_revision,
            CanvasVideoPreviewSourceKind::InitialPoster,
            &source_key,
        )?;
        let extension = poster
            .absolute
            .extension()
            .and_then(|extension| extension.to_str())
            .map_or_else(|| "jpg".to_owned(), str::to_ascii_lowercase);
        let source_project_path = format!("{directory}/source.{extension}");
        let source = if let Some(source) = existing_file(project_root, &source_project_path)? {
            source
        } else {
            poster.file.rewind()?;
            let mut bytes = Vec::new();
            poster
                .file
                .by_ref()
                .take(MAX_EXPLICIT_POSTER_BYTES + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_EXPLICIT_POSTER_BYTES {
                return Err(ProjectError::service(
                    "canvas_video_poster_invalid",
                    format!(
                        "Canvas video explicit poster grew beyond the size limit: {}",
                        poster.relative
                    ),
                ));
            }
            let actual_revision = project_file_revision_from_metadata(&poster.file.metadata()?)?;
            if actual_revision != poster.revision {
                return Err(ProjectError::service(
                    "canvas_video_poster_changed",
                    format!(
                        "Canvas video explicit poster changed during preview rendering: {}",
                        poster.relative
                    ),
                ));
            }
            ProjectCapabilityFs::open(project_root)?.atomic_write_checked(
                &source_project_path,
                &bytes,
                || {
                    cancellation.check()?;
                    assert_video_revision(project_root, target)?;
                    assert_source_key_current(
                        project_root,
                        target,
                        CanvasVideoPreviewSourceKind::InitialPoster,
                        &source_key,
                    )
                },
            )?;
            resolve_no_symlink_existing_project_path(project_root, &source_project_path)?
        };
        let mut file = open_no_symlink_existing_project_file(project_root, &source_project_path)?;
        let metadata = self
            .raster
            .metadata_file(&source, &mut file, cancellation)?;
        Ok(ResolvedSource {
            source_key,
            source_width: metadata.width,
        })
    }

    #[allow(clippy::too_many_arguments)] // The complete cache identity is intentionally explicit.
    fn resolve_extracted_frame(
        &self,
        project_root: &Path,
        canvas_id: &str,
        target: &CanvasVideoPreviewTarget,
        kind: CanvasVideoPreviewSourceKind,
        source_key: &str,
        time: f64,
        cancellation: &PreviewCancellation,
    ) -> Result<ResolvedSource, ProjectError> {
        let directory = video_source_directory(
            canvas_id,
            &target.project_relative_path,
            &target.video_revision,
            kind,
            source_key,
        )?;
        let source_project_path = format!("{directory}/source.jpg");
        let source = if let Some(source) = existing_file(project_root, &source_project_path)? {
            source
        } else {
            let video = StableVideoInput::open(
                project_root,
                &target.project_relative_path,
                &self.stable_copy_admission,
                cancellation,
            )?;
            let temporary = self.extract_frame_temporary(&video.path, time, cancellation)?;
            let publication = (|| {
                assert_video_revision(project_root, target)?;
                let bytes = read_file_limited(
                    &temporary.path,
                    MAX_EXTRACTED_FRAME_BYTES,
                    "canvas_video_preview_frame_too_large",
                    "Extracted Canvas video preview frame",
                )?;
                ProjectCapabilityFs::open(project_root)?.atomic_write_checked(
                    &source_project_path,
                    &bytes,
                    || {
                        cancellation.check()?;
                        assert_video_revision(project_root, target)?;
                        assert_source_key_current(project_root, target, kind, source_key)
                    },
                )
            })();
            publication?;
            resolve_no_symlink_existing_project_path(project_root, &source_project_path)?
        };
        let mut file = open_no_symlink_existing_project_file(project_root, &source_project_path)?;
        let metadata = self
            .raster
            .metadata_file(&source, &mut file, cancellation)?;
        Ok(ResolvedSource {
            source_key: source_key.to_owned(),
            source_width: metadata.width,
        })
    }

    fn read_metadata_path(
        &self,
        source: &Path,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasVideoMetadata, ProjectError> {
        let ffprobe = self.tools.ffprobe.as_ref().ok_or_else(|| {
            ProjectError::service(
                "ffprobe_unavailable",
                "FFprobe is required to inspect Canvas video metadata.",
            )
        })?;
        let mut request = ProcessRequest::new(
            WorkerKind::MediaProbe,
            ffprobe,
            vec![
                "-v".to_owned(),
                "error".to_owned(),
                "-select_streams".to_owned(),
                "v:0".to_owned(),
                "-show_entries".to_owned(),
                "stream=codec_type,width,height,duration:format=duration".to_owned(),
                "-of".to_owned(),
                "json".to_owned(),
                source.to_string_lossy().into_owned(),
            ],
            MEDIA_PROBE_TIMEOUT,
        );
        request.output_limit = MEDIA_OUTPUT_LIMIT;
        let output = self.supervisor.run(request, &cancellation.process);
        if !output.ok {
            return Err(ProjectError::service(
                "ffprobe_failed",
                output.stderr.trim().to_owned(),
            ));
        }
        parse_ffprobe_video_metadata(&output.stdout)
    }

    fn extract_frame_temporary(
        &self,
        video: &Path,
        time: f64,
        cancellation: &PreviewCancellation,
    ) -> Result<TemporaryFrame, ProjectError> {
        let ffmpeg = self.tools.ffmpeg.as_ref().ok_or_else(|| {
            ProjectError::service(
                "ffmpeg_unavailable",
                "FFmpeg is required to create Canvas video previews.",
            )
        })?;
        let directory =
            std::env::temp_dir().join(format!(".debrute-runtime-frame-{}", Uuid::new_v4()));
        fs::create_dir(&directory)?;
        let temporary = TemporaryFrame {
            path: directory.join("frame.jpg"),
            directory,
        };
        let mut request = ProcessRequest::new(
            WorkerKind::VideoFrame,
            ffmpeg,
            vec![
                "-hide_banner".to_owned(),
                "-loglevel".to_owned(),
                "error".to_owned(),
                "-y".to_owned(),
                "-ss".to_owned(),
                time.to_string(),
                "-i".to_owned(),
                video.to_string_lossy().into_owned(),
                "-frames:v".to_owned(),
                "1".to_owned(),
                "-vf".to_owned(),
                VIDEO_FRAME_SCALE_FILTER.to_owned(),
                temporary.path.to_string_lossy().into_owned(),
            ],
            VIDEO_FRAME_TIMEOUT,
        );
        request.output_limit = MEDIA_OUTPUT_LIMIT;
        let result = self.supervisor.run(request, &cancellation.process);
        if !result.ok {
            return Err(ProjectError::service(
                "ffmpeg_frame_failed",
                result.stderr.trim().to_owned(),
            ));
        }
        Ok(temporary)
    }
}

fn assert_source_key_current(
    project_root: &Path,
    target: &CanvasVideoPreviewTarget,
    kind: CanvasVideoPreviewSourceKind,
    source_key: &str,
) -> Result<(), ProjectError> {
    let expected = match kind {
        CanvasVideoPreviewSourceKind::InitialPoster => {
            if let Some(poster) = explicit_poster(project_root, &target.project_relative_path)? {
                explicit_poster_source_key(&poster)?
            } else {
                auto_initial_source_key(&target.video_revision)?
            }
        }
        CanvasVideoPreviewSourceKind::PlaybackFrame => {
            playback_source_key(target.current_time_seconds)?
        }
    };
    if source_key == expected {
        Ok(())
    } else {
        Err(ProjectError::service_with_fields(
            "canvas_video_preview_source_changed",
            format!(
                "Canvas video preview source identity changed: {}",
                target.project_relative_path
            ),
            [
                (
                    "project_relative_path".to_owned(),
                    target.project_relative_path.clone(),
                ),
                ("video_revision".to_owned(), target.video_revision.clone()),
                ("source_key".to_owned(), source_key.to_owned()),
                ("expected_source_key".to_owned(), expected),
            ],
        ))
    }
}

fn explicit_poster_source_key(poster: &ExplicitPoster) -> Result<String, ProjectError> {
    validate_cache_segment(
        &format!(
            "v1--explicit--{}--{}",
            project_relative_path_cache_key(&poster.relative)?,
            project_revision_cache_key(&poster.revision)?
        ),
        "Canvas video preview source key",
    )
}

fn read_file_limited(
    path: &Path,
    limit: u64,
    code: &'static str,
    label: &'static str,
) -> Result<Vec<u8>, ProjectError> {
    let mut file = File::open(path)?;
    if file.metadata()?.len() > limit {
        return Err(ProjectError::service(
            code,
            format!("{label} exceeds the {limit}-byte limit."),
        ));
    }
    let capacity = usize::try_from(limit.min(1024 * 1024)).unwrap_or(1024 * 1024);
    let mut bytes = Vec::with_capacity(capacity);
    file.by_ref().take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(ProjectError::service(
            code,
            format!("{label} grew beyond the {limit}-byte limit."),
        ));
    }
    Ok(bytes)
}

struct TemporaryFrame {
    path: PathBuf,
    directory: PathBuf,
}

impl Drop for TemporaryFrame {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}

/// Parses the fixed ffprobe JSON projection used by the Runtime.
///
/// # Errors
/// Returns an error when the projection has no valid video dimensions.
pub fn parse_ffprobe_video_metadata(stdout: &str) -> Result<CanvasVideoMetadata, ProjectError> {
    let value: Value = serde_json::from_str(stdout)?;
    let streams = value
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ProjectError::Validation("ffprobe output did not include streams.".to_owned())
        })?;
    let stream = streams
        .iter()
        .find(|stream| {
            stream.get("codec_type").and_then(Value::as_str) == Some("video")
                && positive_u32(stream.get("width")).is_some()
                && positive_u32(stream.get("height")).is_some()
        })
        .ok_or_else(|| {
            ProjectError::Validation(
                "ffprobe output did not include video width and height.".to_owned(),
            )
        })?;
    let width = positive_u32(stream.get("width"))
        .ok_or_else(|| ProjectError::Validation("ffprobe video width is invalid.".to_owned()))?;
    let height = positive_u32(stream.get("height"))
        .ok_or_else(|| ProjectError::Validation("ffprobe video height is invalid.".to_owned()))?;
    let duration_seconds = positive_f64(stream.get("duration")).or_else(|| {
        value
            .get("format")
            .and_then(|format| positive_f64(format.get("duration")))
    });
    Ok(CanvasVideoMetadata {
        width,
        height,
        duration_seconds,
    })
}

fn positive_u32(value: Option<&Value>) -> Option<u32> {
    let value = value?.as_u64()?;
    u32::try_from(value).ok().filter(|value| *value > 0)
}

fn positive_f64(value: Option<&Value>) -> Option<f64> {
    let value = match value? {
        Value::Number(value) => value.as_f64()?,
        Value::String(value) => value.parse().ok()?,
        _ => return None,
    };
    (value.is_finite() && value > 0.0).then_some(value)
}

struct ResolvedSource {
    source_key: String,
    source_width: u32,
}

struct ExplicitPoster {
    relative: String,
    absolute: PathBuf,
    revision: String,
    file: File,
}

struct StableVideoInput {
    path: PathBuf,
    directory: PathBuf,
}

impl StableVideoInput {
    fn open(
        project_root: &Path,
        project_relative_path: &str,
        copy_admission: &Semaphore,
        cancellation: &PreviewCancellation,
    ) -> Result<Self, ProjectError> {
        let relative = normalize_project_relative_path(project_relative_path)?;
        cancellation.check()?;
        let mut source = open_no_symlink_existing_project_file(project_root, &relative)?;
        let source_identity = debrute_native_fs::file_identity(&source)?;
        let source_metadata = source.metadata()?;
        let source_revision = project_file_revision_from_metadata(&source_metadata)?;
        let source_length = source_metadata.len();
        let directory =
            std::env::temp_dir().join(format!(".debrute-runtime-video-{}", Uuid::new_v4()));
        fs::create_dir(&directory)?;
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
        let path = directory.join("source");
        let project = ProjectCapabilityFs::open(project_root)?;
        let temporary_directory =
            cap_std::fs::Dir::open_ambient_dir(&directory, cap_std::ambient_authority())?;
        let publication = (|| {
            if project
                .hard_link_to(&relative, &temporary_directory, "source")
                .is_err()
            {
                copy_stable_video(
                    &mut source,
                    &path,
                    &directory,
                    &relative,
                    source_length,
                    copy_admission,
                    cancellation,
                )?;
            } else {
                let snapshot = temporary_directory.open("source")?.into_std();
                if debrute_native_fs::file_identity(&snapshot)? != source_identity {
                    return Err(ProjectError::service(
                        "project_path_changed",
                        format!(
                            "Project video changed while its stable input was linked: {relative}"
                        ),
                    ));
                }
            }
            cancellation.check()?;
            let current_identity = debrute_native_fs::file_identity(&source)?;
            let current_revision = project_file_revision_from_metadata(&source.metadata()?)?;
            if source_identity != current_identity || source_revision != current_revision {
                return Err(ProjectError::service(
                    "project_path_changed",
                    format!("Project video changed while its stable input was created: {relative}"),
                ));
            }
            Ok(())
        })();
        if let Err(error) = publication {
            let _ = fs::remove_dir_all(&directory);
            return Err(error);
        }
        Ok(Self { path, directory })
    }
}

fn copy_stable_video(
    source: &mut File,
    destination_path: &Path,
    directory: &Path,
    relative: &str,
    source_length: u64,
    copy_admission: &Semaphore,
    cancellation: &PreviewCancellation,
) -> Result<(), ProjectError> {
    if source_length > MAX_STABLE_VIDEO_COPY_BYTES {
        return Err(ProjectError::service(
            "canvas_video_stable_input_too_large",
            format!(
                "Canvas video requires a cross-volume copy larger than the {MAX_STABLE_VIDEO_COPY_BYTES}-byte stable-input limit: {relative}"
            ),
        ));
    }
    let _copy_permit = copy_admission.acquire(cancellation)?;
    let required_space = source_length
        .checked_add(STABLE_VIDEO_COPY_DISK_RESERVE)
        .ok_or_else(|| {
            ProjectError::service(
                "canvas_video_stable_input_too_large",
                format!("Canvas video stable-input size is invalid: {relative}"),
            )
        })?;
    if fs2::available_space(directory)? < required_space {
        return Err(ProjectError::service(
            "canvas_video_stable_input_no_space",
            format!(
                "Canvas video stable-input copy lacks required temporary disk space: {relative}"
            ),
        ));
    }
    source.rewind()?;
    let mut destination = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination_path)?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let deadline = Instant::now() + STABLE_VIDEO_COPY_TIMEOUT;
    let mut copied = 0_u64;
    loop {
        cancellation.check()?;
        ensure_stable_copy_deadline(deadline, relative)?;
        let read = source.read(&mut buffer)?;
        ensure_stable_copy_deadline(deadline, relative)?;
        if read == 0 {
            break;
        }
        let read_bytes = u64::try_from(read).map_err(|_| {
            ProjectError::service(
                "canvas_video_stable_input_too_large",
                format!("Canvas video copy size is invalid: {relative}"),
            )
        })?;
        copied = copied.checked_add(read_bytes).ok_or_else(|| {
            ProjectError::service(
                "canvas_video_stable_input_too_large",
                format!("Canvas video grew during stable-input copy: {relative}"),
            )
        })?;
        if copied > source_length || copied > MAX_STABLE_VIDEO_COPY_BYTES {
            return Err(ProjectError::service(
                "canvas_video_stable_input_too_large",
                format!("Canvas video grew during stable-input copy: {relative}"),
            ));
        }
        std::io::Write::write_all(&mut destination, &buffer[..read])?;
    }
    if copied != source_length {
        return Err(ProjectError::service(
            "project_path_changed",
            format!("Project video changed while its stable input was copied: {relative}"),
        ));
    }
    ensure_stable_copy_deadline(deadline, relative)?;
    destination.sync_all()?;
    ensure_stable_copy_deadline(deadline, relative)?;
    Ok(())
}

fn ensure_stable_copy_deadline(deadline: Instant, relative: &str) -> Result<(), ProjectError> {
    if Instant::now() >= deadline {
        Err(ProjectError::service(
            "canvas_video_stable_input_timeout",
            format!("Canvas video stable-input copy exceeded its bounded deadline: {relative}"),
        ))
    } else {
        Ok(())
    }
}

impl Drop for StableVideoInput {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn explicit_poster(
    project_root: &Path,
    video_path: &str,
) -> Result<Option<ExplicitPoster>, ProjectError> {
    let video = normalize_project_relative_path(video_path)?;
    let (directory, name) = video
        .rsplit_once('/')
        .map_or(("", video.as_str()), |value| value);
    let base = name.rsplit_once('.').map_or(name, |(base, _)| base);
    for suffix in [
        ".poster.png",
        ".poster.jpg",
        ".poster.jpeg",
        ".poster.webp",
        ".poster.avif",
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".avif",
    ] {
        let candidate = if directory.is_empty() {
            format!("{base}{suffix}")
        } else {
            format!("{directory}/{base}{suffix}")
        };
        let file = match open_no_symlink_existing_project_file(project_root, &candidate) {
            Ok(file) => file,
            Err(ProjectError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                continue;
            }
            Err(error) => return Err(error),
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(ProjectError::service(
                "canvas_video_poster_invalid",
                format!("Canvas video explicit poster is not a file: {candidate}"),
            ));
        }
        if metadata.len() > MAX_EXPLICIT_POSTER_BYTES {
            return Err(ProjectError::service(
                "canvas_video_poster_invalid",
                format!("Canvas video explicit poster is too large: {candidate}"),
            ));
        }
        let absolute = resolve_no_symlink_existing_project_path(project_root, &candidate)?;
        return Ok(Some(ExplicitPoster {
            relative: candidate,
            absolute,
            revision: project_file_revision_from_metadata(&metadata)?,
            file,
        }));
    }
    Ok(None)
}

fn assert_video_revision(
    project_root: &Path,
    target: &CanvasVideoPreviewTarget,
) -> Result<(), ProjectError> {
    let relative = normalize_project_relative_path(&target.project_relative_path)?;
    let file = open_no_symlink_existing_project_file(project_root, &relative)?;
    let actual = project_file_revision_from_metadata(&file.metadata()?)?;
    if actual == target.video_revision {
        Ok(())
    } else {
        Err(ProjectError::service_with_fields(
            "canvas_video_preview_revision_mismatch",
            format!("Canvas video preview revision does not match source: {relative}"),
            [
                ("project_relative_path".to_owned(), relative),
                ("video_revision".to_owned(), target.video_revision.clone()),
                ("actual_revision".to_owned(), actual),
            ],
        ))
    }
}

fn source_kind(time: f64) -> Result<CanvasVideoPreviewSourceKind, ProjectError> {
    if !time.is_finite() || time < 0.0 {
        return Err(ProjectError::Validation(
            "Canvas video preview timestamp must be a non-negative finite number.".to_owned(),
        ));
    }
    Ok(if time == 0.0 {
        CanvasVideoPreviewSourceKind::InitialPoster
    } else {
        CanvasVideoPreviewSourceKind::PlaybackFrame
    })
}

fn playback_source_key(time: f64) -> Result<String, ProjectError> {
    source_kind(time)?;
    validate_cache_segment(
        &format!("v1--playback--t-{time}"),
        "Canvas video preview source key",
    )
}

fn auto_initial_source_key(revision: &str) -> Result<String, ProjectError> {
    validate_cache_segment(
        &format!("v1--auto-0s--{}", project_revision_cache_key(revision)?),
        "Canvas video preview source key",
    )
}

fn video_source_directory(
    canvas_id: &str,
    video_path: &str,
    revision: &str,
    kind: CanvasVideoPreviewSourceKind,
    source_key: &str,
) -> Result<String, ProjectError> {
    if canvas_id.is_empty()
        || matches!(canvas_id, "." | "..")
        || !canvas_id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'.' | b'-'))
        })
    {
        return Err(ProjectError::Validation(
            "Canvas video preview canvas id must be a valid id.".to_owned(),
        ));
    }
    let kind = match kind {
        CanvasVideoPreviewSourceKind::InitialPoster => "initial-poster",
        CanvasVideoPreviewSourceKind::PlaybackFrame => "playback-frame",
    };
    Ok(format!(
        ".debrute/cache/canvas-video-previews/{canvas_id}/{}/{}/{kind}/{}",
        project_relative_path_cache_key(video_path)?,
        project_revision_cache_key(revision)?,
        validate_cache_segment(source_key, "Canvas video preview source key")?
    ))
}

fn source_file(
    project_root: &Path,
    directory: &str,
) -> Result<Option<(String, PathBuf)>, ProjectError> {
    let project = ProjectCapabilityFs::open(project_root)?;
    let mut candidates = match project.open_directory(directory) {
        Ok(entries) => entries
            .entries()?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                (name.starts_with("source.")
                    && name["source.".len()..]
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()))
                .then_some(name)
            })
            .collect::<Vec<_>>(),
        Err(ProjectError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    candidates.sort();
    match candidates.as_slice() {
        [] => Ok(None),
        [name] => {
            let project_path = format!("{directory}/{name}");
            resolve_no_symlink_existing_project_path(project_root, &project_path)
                .map(|absolute| Some((project_path, absolute)))
        }
        _ => Err(ProjectError::service(
            "canvas_video_preview_cache_invalid",
            format!("Canvas video preview source is ambiguous: {directory}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffprobe_metadata_uses_video_stream_and_format_duration_fallback() {
        let metadata = parse_ffprobe_video_metadata(
            r#"{"streams":[{"codec_type":"audio"},{"codec_type":"video","width":1920,"height":1080}],"format":{"duration":"3.5"}}"#,
        )
        .unwrap();
        assert_eq!(metadata.width, 1920);
        assert_eq!(metadata.height, 1080);
        assert_eq!(metadata.duration_seconds, Some(3.5));
    }

    #[test]
    fn source_identity_includes_canvas_path_revision_kind_and_key() {
        assert_eq!(
            video_source_directory(
                "canvas-1",
                "assets/clip.mp4",
                "1000:20",
                CanvasVideoPreviewSourceKind::PlaybackFrame,
                "v1--playback--t-1.5",
            )
            .unwrap(),
            ".debrute/cache/canvas-video-previews/canvas-1/assets%2Fclip.mp4--b00959a8cfb7dc12/1000%3A20/playback-frame/v1--playback--t-1.5"
        );
    }

    #[test]
    fn extracted_video_frames_are_scaled_before_publication() {
        assert!(VIDEO_FRAME_SCALE_FILTER.contains("min(4096,iw)"));
        assert!(VIDEO_FRAME_SCALE_FILTER.contains("min(4096,ih)"));
        assert!(VIDEO_FRAME_SCALE_FILTER.contains("force_original_aspect_ratio=decrease"));
    }

    #[test]
    fn extracted_video_frame_reads_are_bounded() {
        let root = std::env::temp_dir().join(format!("debrute-frame-limit-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let frame = root.join("frame.jpg");
        fs::write(&frame, vec![0_u8; 33]).unwrap();

        let error = read_file_limited(&frame, 32, "frame_too_large", "Frame").unwrap_err();
        assert_eq!(error.code(), "frame_too_large");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stable_video_input_survives_project_root_replacement() {
        let root = std::env::temp_dir().join(format!("debrute-video-input-{}", Uuid::new_v4()));
        let moved = root.with_extension("moved");
        fs::create_dir_all(root.join("media")).unwrap();
        fs::write(root.join("media/clip.mov"), b"fixture").unwrap();

        let input = StableVideoInput::open(
            &root,
            "media/clip.mov",
            &Semaphore::new(1),
            &PreviewCancellation::default(),
        )
        .unwrap();

        assert!(!input.path.starts_with(&root));
        fs::rename(&root, &moved).unwrap();
        fs::create_dir_all(root.join("media")).unwrap();
        fs::write(root.join("media/clip.mov"), b"replacement").unwrap();
        assert_eq!(fs::read(&input.path).unwrap(), b"fixture");
        drop(input);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(moved).unwrap();
    }

    #[test]
    fn explicit_poster_change_rejects_the_previous_source_key() {
        let root = std::env::temp_dir().join(format!("debrute-video-poster-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("media")).unwrap();
        fs::write(root.join("media/clip.mp4"), b"video").unwrap();
        image::RgbaImage::new(2, 2)
            .save(root.join("media/clip.poster.png"))
            .unwrap();
        let video = File::open(root.join("media/clip.mp4")).unwrap();
        let target = CanvasVideoPreviewTarget {
            project_relative_path: "media/clip.mp4".to_owned(),
            video_revision: project_file_revision_from_metadata(&video.metadata().unwrap())
                .unwrap(),
            current_time_seconds: 0.0,
        };
        let poster = explicit_poster(&root, &target.project_relative_path)
            .unwrap()
            .unwrap();
        let old_source_key = explicit_poster_source_key(&poster).unwrap();
        image::RgbaImage::new(5, 3)
            .save(root.join("media/clip.poster.png"))
            .unwrap();

        let error = assert_source_key_current(
            &root,
            &target,
            CanvasVideoPreviewSourceKind::InitialPoster,
            &old_source_key,
        )
        .unwrap_err();
        assert_eq!(error.code(), "canvas_video_preview_source_changed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn intrinsic_video_preview_width_returns_the_selected_source_and_smaller_variants_use_engine_identity()
     {
        let root = std::env::temp_dir().join(format!("debrute-video-direct-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("media")).unwrap();
        fs::write(root.join("media/clip.mp4"), b"video").unwrap();
        image::RgbaImage::new(2, 2)
            .save(root.join("media/clip.poster.png"))
            .unwrap();
        let video = File::open(root.join("media/clip.mp4")).unwrap();
        let target = CanvasVideoPreviewTarget {
            project_relative_path: "media/clip.mp4".to_owned(),
            video_revision: project_file_revision_from_metadata(&video.metadata().unwrap())
                .unwrap(),
            current_time_seconds: 0.0,
        };
        let workers = crate::workers::RuntimeWorkerServices::new();
        let service = CanvasVideoPreviewService::new(
            workers.supervisor(),
            MediaToolPaths::unavailable(),
            Arc::new(Semaphore::new(3)),
        );
        let source = service
            .resolve_source(&root, "canvas-1", &target, &PreviewCancellation::default())
            .unwrap();
        let direct = service
            .resolve_variant(
                &root,
                "canvas-1",
                &target,
                &source.source_key,
                2,
                &PreviewCancellation::default(),
            )
            .unwrap();
        assert!(direct.absolute_path.ends_with("source.png"));

        let derived = service
            .resolve_variant(
                &root,
                "canvas-1",
                &target,
                &source.source_key,
                1,
                &PreviewCancellation::default(),
            )
            .unwrap();
        assert!(
            derived
                .absolute_path
                .ends_with("raster-engine-v1/preview-w1.jpg")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
