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
    existing_file,
    raster::RasterPreviewEngine,
    raster_variants::{
        RasterPreviewVariantOutputPolicy, RasterPreviewVariantRequest, RasterPreviewVariantService,
    },
};
use crate::project::{
    CANVAS_VIDEO_TIME_MAX_MS, ProjectCapabilityFs, ProjectError, normalize_project_relative_path,
    open_no_symlink_existing_project_file, project_media_revision,
    resolve_no_symlink_existing_project_path,
};

const MEDIA_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const VIDEO_FRAME_TIMEOUT: Duration = Duration::from_secs(30);
const MEDIA_OUTPUT_LIMIT: usize = 1024 * 1024;
const MAX_EXTRACTED_FRAME_BYTES: u64 = 64 * 1024 * 1024;
const MAX_STABLE_VIDEO_COPY_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const STABLE_VIDEO_COPY_DISK_RESERVE: u64 = 256 * 1024 * 1024;
const STABLE_VIDEO_COPY_TIMEOUT: Duration = Duration::from_secs(30);
const VIDEO_FRAME_SCALE_FILTER: &str = "scale=w='min(4096,iw)':h='min(4096,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
pub const CANVAS_VIDEO_PREVIEW_PROBE_MAX_TARGETS: usize = 10;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasVideoPreviewTarget {
    pub project_relative_path: String,
    pub source_revision: String,
    pub frame_time_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanvasVideoPreviewProbeStatus {
    Ready {
        canonical_source_identity: String,
        source_width: u32,
    },
    NeedsSource {
        canonical_source_identity: String,
    },
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasVideoPreviewProbeView {
    pub target: CanvasVideoPreviewTarget,
    pub status: CanvasVideoPreviewProbeStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanvasVideoPreviewEnsureStatus {
    Ready {
        canonical_source_identity: String,
        source_width: u32,
    },
    SourceChanged,
    Failed {
        message: String,
    },
}

pub struct CanvasVideoPreviewService {
    debrute_home: PathBuf,
    supervisor: Arc<BoundedProcessSupervisor>,
    tools: MediaToolPaths,
    raster_variants: Arc<RasterPreviewVariantService>,
    stable_input_copy_admission: Semaphore,
    source_locks: KeyedLocks,
}

impl CanvasVideoPreviewService {
    pub(super) fn new(
        supervisor: Arc<BoundedProcessSupervisor>,
        tools: MediaToolPaths,
        raster_variants: Arc<RasterPreviewVariantService>,
        debrute_home: PathBuf,
    ) -> Self {
        Self {
            debrute_home,
            supervisor,
            tools,
            raster_variants,
            stable_input_copy_admission: Semaphore::new(1),
            source_locks: KeyedLocks::default(),
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
            &self.stable_input_copy_admission,
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
            &self.stable_input_copy_admission,
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

    /// Probes requested canonical frame sources without generating missing frames.
    ///
    /// # Errors
    /// Returns an error only when the whole request is cancelled.
    pub fn probe_sources(
        &self,
        project_root: &Path,
        canvas_id: &str,
        targets: &[CanvasVideoPreviewTarget],
        cancellation: &PreviewCancellation,
    ) -> Result<Vec<CanvasVideoPreviewProbeView>, ProjectError> {
        let mut result = Vec::with_capacity(targets.len());
        for target in targets.iter().cloned() {
            cancellation.check()?;
            let status = match self.probe_source(project_root, canvas_id, &target, cancellation) {
                Ok(status) => status,
                Err(error) if error.code() == "canvas_preview_cancelled" => return Err(error),
                Err(error) => CanvasVideoPreviewProbeStatus::Failed {
                    message: error.to_string(),
                },
            };
            result.push(CanvasVideoPreviewProbeView { target, status });
        }
        Ok(result)
    }

    /// Ensures one exact canonical frame source bound to a Probe-owned canonical source identity.
    ///
    /// # Errors
    /// Returns an error when the request is cancelled.
    pub fn ensure_source(
        &self,
        project_root: &Path,
        canvas_id: &str,
        target: &CanvasVideoPreviewTarget,
        canonical_source_identity: &str,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasVideoPreviewEnsureStatus, ProjectError> {
        if assert_canonical_source_identity_current(target, canonical_source_identity).is_err() {
            return Ok(CanvasVideoPreviewEnsureStatus::SourceChanged);
        }
        match self.ensure_source_inner(
            project_root,
            canvas_id,
            target,
            canonical_source_identity,
            cancellation,
        ) {
            Ok(source) => Ok(CanvasVideoPreviewEnsureStatus::Ready {
                canonical_source_identity: source.canonical_source_identity,
                source_width: source.source_width,
            }),
            Err(error) if error.code() == "canvas_preview_cancelled" => Err(error),
            Err(error)
                if matches!(
                    error.code(),
                    "canvas_video_preview_source_revision_mismatch"
                        | "canvas_video_preview_source_changed"
                        | "project_path_changed"
                ) =>
            {
                Ok(CanvasVideoPreviewEnsureStatus::SourceChanged)
            }
            Err(error) => Ok(CanvasVideoPreviewEnsureStatus::Failed {
                message: error.to_string(),
            }),
        }
    }

    /// Resolves one revision-bound JPEG variant from an accepted canonical source identity.
    ///
    /// # Errors
    /// Returns an error for invalid identity, unavailable source, cancellation, or decode failure.
    pub fn resolve_variant(
        &self,
        project_root: &Path,
        canvas_id: &str,
        target: &CanvasVideoPreviewTarget,
        canonical_source_identity: &str,
        width: u32,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasPreviewFile, ProjectError> {
        let directory = video_source_directory(
            canvas_id,
            &target.project_relative_path,
            &target.source_revision,
            canonical_source_identity,
        )?;
        assert_source_revision(project_root, target)?;
        assert_canonical_source_identity_current(target, canonical_source_identity)?;
        let cache_root = self.cache_root(project_root)?;
        let (source_project_path, source) =
            source_file(&cache_root, &directory)?.ok_or_else(|| {
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
                        ("source_revision".to_owned(), target.source_revision.clone()),
                        (
                            "canonical_source_identity".to_owned(),
                            canonical_source_identity.to_owned(),
                        ),
                    ],
                )
            })?;
        let file = open_no_symlink_existing_project_file(&cache_root, &source_project_path)?;
        self.raster_variants.resolve(
            &cache_root,
            RasterPreviewVariantRequest {
                source_path: source,
                source_file: file,
                source_content_type: Some("image/jpeg"),
                cache_directory: directory,
                width,
                output_policy: RasterPreviewVariantOutputPolicy::Jpeg,
                invalid_width_message: format!(
                    "Canvas video preview width exceeds source width: {}",
                    target.project_relative_path
                ),
            },
            cancellation,
            || {
                assert_source_revision(project_root, target)?;
                assert_canonical_source_identity_current(target, canonical_source_identity)
            },
        )
    }

    fn probe_source(
        &self,
        project_root: &Path,
        canvas_id: &str,
        target: &CanvasVideoPreviewTarget,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasVideoPreviewProbeStatus, ProjectError> {
        cancellation.check()?;
        assert_source_revision(project_root, target)?;
        let canonical_source_identity = frame_canonical_source_identity(target.frame_time_ms)?;
        let directory = video_source_directory(
            canvas_id,
            &target.project_relative_path,
            &target.source_revision,
            &canonical_source_identity,
        )?;
        let cache_root = self.cache_root(project_root)?;
        let Some((source_project_path, source)) = source_file(&cache_root, &directory)? else {
            return Ok(CanvasVideoPreviewProbeStatus::NeedsSource {
                canonical_source_identity,
            });
        };
        let mut file = open_no_symlink_existing_project_file(&cache_root, &source_project_path)?;
        let metadata = self
            .raster_variants
            .metadata_file(&source, &mut file, cancellation)?;
        Ok(CanvasVideoPreviewProbeStatus::Ready {
            canonical_source_identity,
            source_width: metadata.width,
        })
    }

    fn ensure_source_inner(
        &self,
        project_root: &Path,
        canvas_id: &str,
        target: &CanvasVideoPreviewTarget,
        canonical_source_identity: &str,
        cancellation: &PreviewCancellation,
    ) -> Result<ResolvedSource, ProjectError> {
        cancellation.check()?;
        assert_source_revision(project_root, target)?;
        assert_canonical_source_identity_current(target, canonical_source_identity)?;
        let key = format!(
            "{}\0{canvas_id}\0{}\0{}\0{canonical_source_identity}",
            project_root.display(),
            target.project_relative_path,
            target.source_revision
        );
        let _lock = self.source_locks.acquire(&key, cancellation)?;
        assert_source_revision(project_root, target)?;
        assert_canonical_source_identity_current(target, canonical_source_identity)?;
        let directory = video_source_directory(
            canvas_id,
            &target.project_relative_path,
            &target.source_revision,
            canonical_source_identity,
        )?;
        let source_project_path = format!("{directory}/source.jpg");
        let cache_root = self.cache_root(project_root)?;
        let source = if let Some(source) = existing_file(&cache_root, &source_project_path)? {
            source
        } else {
            let video = StableVideoInput::open(
                project_root,
                &target.project_relative_path,
                &self.stable_input_copy_admission,
                cancellation,
            )?;
            let metadata = self.read_metadata_path(&video.path, cancellation)?;
            if metadata
                .duration_seconds
                .is_some_and(|duration| frame_time_seconds(target.frame_time_ms) > duration)
            {
                return Err(ProjectError::service(
                    "canvas_video_preview_time_out_of_range",
                    format!(
                        "Canvas video playback time exceeds video duration: {}",
                        target.project_relative_path
                    ),
                ));
            }
            let temporary = self.extract_frame_temporary(
                &video.path,
                frame_time_seconds(target.frame_time_ms),
                cancellation,
            )?;
            let publication = (|| {
                assert_source_revision(project_root, target)?;
                let bytes = read_file_limited(
                    &temporary.path,
                    MAX_EXTRACTED_FRAME_BYTES,
                    "canvas_video_preview_frame_too_large",
                    "Extracted Canvas video preview frame",
                )?;
                ProjectCapabilityFs::open(&cache_root)?.atomic_write_checked(
                    &source_project_path,
                    &bytes,
                    || {
                        cancellation.check()?;
                        assert_source_revision(project_root, target)?;
                        assert_canonical_source_identity_current(target, canonical_source_identity)
                    },
                )
            })();
            publication?;
            resolve_no_symlink_existing_project_path(&cache_root, &source_project_path)?
        };
        let mut file = open_no_symlink_existing_project_file(&cache_root, &source_project_path)?;
        let metadata = self
            .raster_variants
            .metadata_file(&source, &mut file, cancellation)?;
        Ok(ResolvedSource {
            canonical_source_identity: canonical_source_identity.to_owned(),
            source_width: metadata.width,
        })
    }

    fn cache_root(&self, project_root: &Path) -> Result<PathBuf, ProjectError> {
        let canonical_root = project_root.canonicalize()?;
        let canonical_root = canonical_root.to_str().ok_or_else(|| {
            ProjectError::Validation("Project root must be valid UTF-8.".to_owned())
        })?;
        let root =
            crate::global::root_cache_directory(&self.debrute_home, canonical_root).join("canvas");
        fs::create_dir_all(&root)?;
        Ok(root)
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

fn assert_canonical_source_identity_current(
    target: &CanvasVideoPreviewTarget,
    canonical_source_identity: &str,
) -> Result<(), ProjectError> {
    let expected = frame_canonical_source_identity(target.frame_time_ms)?;
    if canonical_source_identity == expected {
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
                ("source_revision".to_owned(), target.source_revision.clone()),
                (
                    "canonical_source_identity".to_owned(),
                    canonical_source_identity.to_owned(),
                ),
                ("expected_canonical_source_identity".to_owned(), expected),
            ],
        ))
    }
}

fn frame_canonical_source_identity(frame_time_ms: u64) -> Result<String, ProjectError> {
    if frame_time_ms > CANVAS_VIDEO_TIME_MAX_MS {
        return Err(ProjectError::Validation(
            "Canvas video preview time must be a non-negative safe integer in milliseconds."
                .to_owned(),
        ));
    }
    validate_cache_segment(
        &format!("frame-v1--ms-{frame_time_ms}"),
        "Canvas video preview canonical source identity",
    )
}

fn frame_time_seconds(frame_time_ms: u64) -> f64 {
    Duration::from_millis(frame_time_ms).as_secs_f64()
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
    canonical_source_identity: String,
    source_width: u32,
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
        let source_revision = project_media_revision(&mut source)?;
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
            let current_revision = project_media_revision(&mut source)?;
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

fn assert_source_revision(
    project_root: &Path,
    target: &CanvasVideoPreviewTarget,
) -> Result<(), ProjectError> {
    let relative = normalize_project_relative_path(&target.project_relative_path)?;
    let mut file = open_no_symlink_existing_project_file(project_root, &relative)?;
    let actual = project_media_revision(&mut file)?;
    if actual == target.source_revision {
        Ok(())
    } else {
        Err(ProjectError::service_with_fields(
            "canvas_video_preview_source_revision_mismatch",
            format!("Canvas video preview revision does not match source: {relative}"),
            [
                ("project_relative_path".to_owned(), relative),
                ("source_revision".to_owned(), target.source_revision.clone()),
                ("actual_revision".to_owned(), actual),
            ],
        ))
    }
}

fn video_source_directory(
    canvas_id: &str,
    video_path: &str,
    revision: &str,
    canonical_source_identity: &str,
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
    Ok(format!(
        "canvas-video-previews/{canvas_id}/{}/{}/{}",
        project_relative_path_cache_key(video_path)?,
        project_revision_cache_key(revision)?,
        validate_cache_segment(
            canonical_source_identity,
            "Canvas video preview canonical source identity"
        )?
    ))
}

fn source_file(
    project_root: &Path,
    directory: &str,
) -> Result<Option<(String, PathBuf)>, ProjectError> {
    let project_path = format!("{directory}/source.jpg");
    existing_file(project_root, &project_path)
        .map(|source| source.map(|absolute| (project_path, absolute)))
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
    fn source_identity_includes_canvas_path_revision_and_runtime_key() {
        assert_eq!(
            video_source_directory(
                "canvas-1",
                "assets/clip.mp4",
                "1000:20",
                "frame-v1--ms-1500",
            )
            .unwrap(),
            "canvas-video-previews/canvas-1/assets%2Fclip.mp4--b00959a8cfb7dc12/1000%3A20/frame-v1--ms-1500"
        );
    }

    #[test]
    fn zero_milliseconds_is_an_ordinary_frame_source_identity() {
        assert_eq!(
            frame_canonical_source_identity(0).unwrap(),
            "frame-v1--ms-0"
        );
        assert_eq!(
            frame_canonical_source_identity(1_500).unwrap(),
            "frame-v1--ms-1500"
        );
        assert!(frame_canonical_source_identity(CANVAS_VIDEO_TIME_MAX_MS + 1).is_err());
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
    fn probe_reports_a_missing_zero_millisecond_frame_without_generating_it() {
        let root = std::env::temp_dir().join(format!("debrute-video-direct-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("media")).unwrap();
        fs::write(root.join("media/clip.mp4"), b"video").unwrap();
        let mut video = File::open(root.join("media/clip.mp4")).unwrap();
        let target = CanvasVideoPreviewTarget {
            project_relative_path: "media/clip.mp4".to_owned(),
            source_revision: project_media_revision(&mut video).unwrap(),
            frame_time_ms: 0,
        };
        let workers = crate::workers::RuntimeWorkerServices::new();
        let raster_pool = Arc::new(Semaphore::new(3));
        let service = CanvasVideoPreviewService::new(
            workers.supervisor(),
            MediaToolPaths::unavailable(),
            Arc::new(RasterPreviewVariantService::new(raster_pool)),
            root.join("home"),
        );
        let sources = service
            .probe_sources(
                &root,
                "canvas-1",
                std::slice::from_ref(&target),
                &PreviewCancellation::default(),
            )
            .unwrap();
        assert!(matches!(
            sources[0].status,
            CanvasVideoPreviewProbeStatus::NeedsSource { ref canonical_source_identity }
                if canonical_source_identity == "frame-v1--ms-0"
        ));
        fs::remove_dir_all(root).unwrap();
    }
}
