use std::{
    fs,
    io::Read as _,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};

use super::{
    CanvasPreviewFile, PreviewCancellation,
    cache::{
        KeyedLocks, atomic_write, project_relative_path_cache_key, project_revision_cache_key,
    },
    existing_open_file,
    raster_variants::{RasterPreviewVariantRequest, RasterPreviewVariantService},
};
use crate::project::{
    CANVAS_VIDEO_TIME_MAX_MS, CanvasMediaKind, ProjectError, ProjectRelativePath,
    ProjectSourceLease, canvas_media_kind_from_path, open_no_symlink_existing_project_file,
    project_media_revision, resolve_no_symlink_existing_project_path,
};

const BROWSER_CAPTURE_VERSION: &str = "browser-v2";
pub const CANVAS_VIDEO_PREVIEW_SOURCE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CAPTURE_DIMENSION: u32 = 4096;
const ASPECT_RATIO_TOLERANCE: f64 = 0.01;
pub const CANVAS_VIDEO_PREVIEW_READ_MAX_TARGETS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasVideoMetadata {
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasVideoPreviewTarget {
    pub project_relative_path: ProjectRelativePath,
    pub source_revision: String,
    pub frame_time_ms: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CanvasVideoPreviewSourceStatus {
    Available {
        source_width: u32,
        metadata: CanvasVideoMetadata,
    },
    Missing {
        metadata: Option<CanvasVideoMetadata>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasVideoPreviewSourceView {
    pub target: CanvasVideoPreviewTarget,
    pub status: CanvasVideoPreviewSourceStatus,
}

pub struct CanvasVideoPreviewService {
    debrute_home: PathBuf,
    raster_variants: Arc<RasterPreviewVariantService>,
    source_locks: KeyedLocks,
}

impl CanvasVideoPreviewService {
    pub(super) fn new(
        raster_variants: Arc<RasterPreviewVariantService>,
        debrute_home: PathBuf,
    ) -> Self {
        Self {
            debrute_home,
            raster_variants,
            source_locks: KeyedLocks::default(),
        }
    }

    pub(crate) fn read_sources(
        &self,
        targets: &[CanvasVideoPreviewTarget],
        cancellation: &PreviewCancellation,
        mut resolve_lease: impl FnMut(
            &CanvasVideoPreviewTarget,
        ) -> Result<ProjectSourceLease, ProjectError>,
    ) -> Result<Vec<CanvasVideoPreviewSourceView>, ProjectError> {
        let mut sources = Vec::with_capacity(targets.len());
        for target in targets.iter().cloned() {
            cancellation.check()?;
            let status = match resolve_lease(&target)
                .and_then(|lease| self.read_source(&lease, &target, cancellation))
            {
                Ok(status) => status,
                Err(error) if error.code() == "canvas_preview_cancelled" => return Err(error),
                Err(error) => CanvasVideoPreviewSourceStatus::Error {
                    message: error.to_string(),
                },
            };
            sources.push(CanvasVideoPreviewSourceView { target, status });
        }
        Ok(sources)
    }

    pub(crate) fn save_source(
        &self,
        lease: &ProjectSourceLease,
        target: &CanvasVideoPreviewTarget,
        metadata: CanvasVideoMetadata,
        uploaded_source: &Path,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasVideoPreviewSourceView, ProjectError> {
        validate_target(target)?;
        validate_metadata(metadata)?;
        validate_video_path(target.project_relative_path.as_str())?;
        assert_target_matches_lease(lease, target)?;
        cancellation.check()?;
        lease.verify_current()?;

        let uploaded_size = fs::metadata(uploaded_source)?.len();
        if uploaded_size == 0 || uploaded_size > CANVAS_VIDEO_PREVIEW_SOURCE_MAX_BYTES {
            return Err(ProjectError::service(
                "canvas_video_preview_source_too_large",
                format!(
                    "Canvas video preview JPEG must be between 1 byte and {CANVAS_VIDEO_PREVIEW_SOURCE_MAX_BYTES} bytes."
                ),
            ));
        }
        let bytes = fs::read(uploaded_source)?;
        let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
            .map_err(|error| {
                ProjectError::service(
                    "canvas_video_preview_source_invalid",
                    format!("Canvas video preview source must be a valid JPEG: {error}"),
                )
            })?;
        let source_width = decoded.width();
        let source_height = decoded.height();
        if source_width == 0
            || source_height == 0
            || source_width.max(source_height) > MAX_CAPTURE_DIMENSION
        {
            return Err(ProjectError::service(
                "canvas_video_preview_source_dimensions_invalid",
                format!(
                    "Canvas video preview JPEG longest edge must not exceed {MAX_CAPTURE_DIMENSION}px."
                ),
            ));
        }
        let metadata_ratio = f64::from(metadata.width) / f64::from(metadata.height);
        let source_ratio = f64::from(source_width) / f64::from(source_height);
        if ((metadata_ratio - source_ratio) / metadata_ratio).abs() > ASPECT_RATIO_TOLERANCE {
            return Err(ProjectError::service(
                "canvas_video_preview_source_aspect_ratio_mismatch",
                "Canvas video preview JPEG aspect ratio does not match browser metadata.",
            ));
        }

        let cache_root = self.cache_root(lease.project_root())?;
        let base = source_base_path(target)?;
        let lock_key = format!("{}\0{base}", cache_root.display());
        let _lock = self.source_locks.acquire(&lock_key, cancellation)?;
        lease.verify_current()?;
        atomic_write(
            &cache_root,
            &format!("{base}/metadata.json"),
            &serde_json::to_vec(&metadata)?,
        )?;
        atomic_write(
            &cache_root,
            &format!("{base}/frames/{}/source.jpg", target.frame_time_ms),
            &bytes,
        )?;
        lease.verify_current()?;
        Ok(CanvasVideoPreviewSourceView {
            target: target.clone(),
            status: CanvasVideoPreviewSourceStatus::Available {
                source_width,
                metadata,
            },
        })
    }

    pub(crate) fn resolve_variant(
        &self,
        lease: &ProjectSourceLease,
        target: &CanvasVideoPreviewTarget,
        width: u32,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasPreviewFile, ProjectError> {
        validate_target(target)?;
        assert_target_matches_lease(lease, target)?;
        let cache_root = self.cache_root(lease.project_root())?;
        let source_relative = source_jpeg_path(target)?;
        let source = resolve_no_symlink_existing_project_path(
            &cache_root,
            ProjectRelativePath::parse(&source_relative)?.as_directory_path(),
        )?;
        let file = open_no_symlink_existing_project_file(
            &cache_root,
            &ProjectRelativePath::parse(&source_relative)?,
        )?;
        let source_identity = debrute_native_fs::file_identity(&file)?;
        self.raster_variants.resolve(
            &cache_root,
            RasterPreviewVariantRequest {
                source_path: source,
                source_file: file,
                source_content_type: Some("image/jpeg"),
                cache_directory: format!(
                    "{}/frames/{}",
                    source_base_path(target)?,
                    target.frame_time_ms
                ),
                width,
                invalid_width_message: format!(
                    "Canvas video preview width exceeds source width: {}",
                    target.project_relative_path
                ),
            },
            cancellation,
            || {
                lease.verify_current()?;
                let current = open_no_symlink_existing_project_file(
                    &cache_root,
                    &ProjectRelativePath::parse(&source_relative)?,
                )?;
                if debrute_native_fs::file_identity(&current)? == source_identity {
                    Ok(())
                } else {
                    Err(ProjectError::service(
                        "canvas_video_preview_source_changed",
                        "Canvas video preview source changed during rendering.",
                    ))
                }
            },
        )
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
        let relative = ProjectRelativePath::parse(project_relative_path)?;
        validate_video_path(relative.as_str())?;
        let mut project_file = open_no_symlink_existing_project_file(project_root, &relative)?;
        let revision = project_media_revision(&mut project_file)?;
        let frame_time_ms = seconds_to_frame_time_ms(current_time_seconds)?;
        let target = CanvasVideoPreviewTarget {
            project_relative_path: relative,
            source_revision: revision,
            frame_time_ms,
        };
        let cache_root = self.cache_root(project_root)?;
        let source_relative = source_jpeg_path(&target)?;
        let Some((source, mut file)) = existing_open_file(&cache_root, &source_relative)? else {
            return Err(ProjectError::service(
                "canvas_feedback_video_source_pending",
                "Canvas feedback video frame is waiting for the Workbench browser capture.",
            ));
        };
        super::raster::RasterPreviewEngine::load_bounded_admitted(
            &source,
            &mut file,
            super::MAX_FEEDBACK_ARTIFACT_DIMENSION,
            cancellation,
        )
    }

    fn read_source(
        &self,
        lease: &ProjectSourceLease,
        target: &CanvasVideoPreviewTarget,
        cancellation: &PreviewCancellation,
    ) -> Result<CanvasVideoPreviewSourceStatus, ProjectError> {
        validate_target(target)?;
        validate_video_path(target.project_relative_path.as_str())?;
        assert_target_matches_lease(lease, target)?;
        lease.verify_current()?;
        cancellation.check()?;
        let cache_root = self.cache_root(lease.project_root())?;
        let metadata = read_cached_metadata(&cache_root, target)?;
        let Some((source, mut file)) = existing_open_file(&cache_root, &source_jpeg_path(target)?)?
        else {
            return Ok(CanvasVideoPreviewSourceStatus::Missing { metadata });
        };
        let raster = self
            .raster_variants
            .metadata_file(&source, &mut file, cancellation)?;
        let Some(metadata) = metadata else {
            return Ok(CanvasVideoPreviewSourceStatus::Missing { metadata: None });
        };
        lease.verify_current()?;
        Ok(CanvasVideoPreviewSourceStatus::Available {
            source_width: raster.width,
            metadata,
        })
    }

    fn cache_root(&self, project_root: &Path) -> Result<PathBuf, ProjectError> {
        let canonical_root = project_root.to_str().ok_or_else(|| {
            ProjectError::Validation("Project root must be valid UTF-8.".to_owned())
        })?;
        let root = crate::global::root_cache_directory(&self.debrute_home, canonical_root)
            .join("canvas/canvas-video-previews");
        fs::create_dir_all(&root)?;
        Ok(root)
    }
}

fn validate_target(target: &CanvasVideoPreviewTarget) -> Result<(), ProjectError> {
    if target.frame_time_ms > CANVAS_VIDEO_TIME_MAX_MS {
        return Err(ProjectError::Validation(
            "Canvas video frame time must be a non-negative safe integer in milliseconds."
                .to_owned(),
        ));
    }
    if target.source_revision.is_empty() {
        return Err(ProjectError::Validation(
            "Canvas video source revision must be non-empty.".to_owned(),
        ));
    }
    Ok(())
}

fn validate_metadata(metadata: CanvasVideoMetadata) -> Result<(), ProjectError> {
    if metadata.width == 0 || metadata.height == 0 {
        return Err(ProjectError::Validation(
            "Canvas video metadata dimensions must be positive integers.".to_owned(),
        ));
    }
    if metadata
        .duration_seconds
        .is_some_and(|duration| !duration.is_finite() || duration < 0.0)
    {
        return Err(ProjectError::Validation(
            "Canvas video duration must be a non-negative finite number.".to_owned(),
        ));
    }
    Ok(())
}

fn validate_video_path(path: &str) -> Result<(), ProjectError> {
    if canvas_media_kind_from_path(path) == CanvasMediaKind::Video {
        Ok(())
    } else {
        Err(ProjectError::Validation(format!(
            "Canvas video preview path is not a supported video candidate: {path}"
        )))
    }
}

fn assert_target_matches_lease(
    lease: &ProjectSourceLease,
    target: &CanvasVideoPreviewTarget,
) -> Result<(), ProjectError> {
    if lease.project_relative_path() == &target.project_relative_path
        && lease.revision() == target.source_revision
    {
        Ok(())
    } else {
        Err(ProjectError::service(
            "canvas_video_preview_source_revision_mismatch",
            "Canvas video preview target does not match its Project source lease.",
        ))
    }
}

fn source_base_path(target: &CanvasVideoPreviewTarget) -> Result<String, ProjectError> {
    Ok(format!(
        "{}/{}/{BROWSER_CAPTURE_VERSION}",
        project_relative_path_cache_key(target.project_relative_path.as_str())?,
        project_revision_cache_key(&target.source_revision)?,
    ))
}

fn source_jpeg_path(target: &CanvasVideoPreviewTarget) -> Result<String, ProjectError> {
    Ok(format!(
        "{}/frames/{}/source.jpg",
        source_base_path(target)?,
        target.frame_time_ms
    ))
}

fn read_cached_metadata(
    cache_root: &Path,
    target: &CanvasVideoPreviewTarget,
) -> Result<Option<CanvasVideoMetadata>, ProjectError> {
    let path = format!("{}/metadata.json", source_base_path(target)?);
    let Some((_absolute, mut file)) = existing_open_file(cache_root, &path)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let metadata = serde_json::from_slice::<CanvasVideoMetadata>(&bytes)?;
    validate_metadata(metadata)?;
    Ok(Some(metadata))
}

fn seconds_to_frame_time_ms(seconds: f64) -> Result<u64, ProjectError> {
    let milliseconds = (seconds * 1000.0).round();
    if milliseconds > CANVAS_VIDEO_TIME_MAX_MS as f64 {
        return Err(ProjectError::Validation(
            "Canvas feedback video time exceeds the supported range.".to_owned(),
        ));
    }
    Ok(milliseconds as u64)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use image::{ImageBuffer, Rgb};
    use uuid::Uuid;

    use super::*;
    use crate::project::previews::cache::Semaphore;

    #[test]
    fn browser_sources_keep_metadata_and_moments_under_one_revision() {
        let fixture = Fixture::new("clip.mkv");
        let service = fixture.service();
        let first = fixture.target(0);
        let second = fixture.target(2_500);
        let capture = fixture.root.join("capture.jpg");
        ImageBuffer::from_pixel(16, 9, Rgb([10_u8, 20, 30]))
            .save(&capture)
            .unwrap();
        let metadata = CanvasVideoMetadata {
            width: 1_920,
            height: 1_080,
            duration_seconds: Some(4.0),
        };

        let saved = service
            .save_source(
                &fixture.lease(),
                &first,
                metadata,
                &capture,
                &PreviewCancellation::default(),
            )
            .unwrap();
        assert!(matches!(
            saved.status,
            CanvasVideoPreviewSourceStatus::Available {
                source_width: 16,
                metadata: saved_metadata,
            } if saved_metadata == metadata
        ));

        let sources = service
            .read_sources(
                &[first.clone(), second],
                &PreviewCancellation::default(),
                |_| Ok(fixture.lease()),
            )
            .unwrap();
        assert!(matches!(
            sources[0].status,
            CanvasVideoPreviewSourceStatus::Available {
                source_width: 16,
                ..
            }
        ));
        assert!(matches!(
            sources[1].status,
            CanvasVideoPreviewSourceStatus::Missing {
                metadata: Some(cached),
            } if cached == metadata
        ));
        let direct = service
            .resolve_variant(
                &fixture.lease(),
                &first,
                16,
                &PreviewCancellation::default(),
            )
            .unwrap();
        assert!(
            direct
                .absolute_path
                .ends_with("browser-v2/frames/0/source.jpg")
        );
        assert_eq!(direct.content_type, "image/jpeg");
        let feedback_frame = service
            .feedback_frame(
                &fixture.root,
                fixture.project_relative_path,
                0.0,
                &PreviewCancellation::default(),
            )
            .unwrap();
        assert_eq!((feedback_frame.width(), feedback_frame.height()), (16, 9));
    }

    #[test]
    fn browser_source_save_rejects_non_jpeg_and_wrong_aspect_ratio() {
        let fixture = Fixture::new("clip.mp4");
        let service = fixture.service();
        let target = fixture.target(0);
        let invalid = fixture.root.join("invalid.jpg");
        fs::write(&invalid, b"not a jpeg").unwrap();
        let metadata = CanvasVideoMetadata {
            width: 1_920,
            height: 1_080,
            duration_seconds: None,
        };
        assert_eq!(
            service
                .save_source(
                    &fixture.lease(),
                    &target,
                    metadata,
                    &invalid,
                    &PreviewCancellation::default(),
                )
                .unwrap_err()
                .code(),
            "canvas_video_preview_source_invalid"
        );

        let wrong_aspect = fixture.root.join("wrong-aspect.jpg");
        ImageBuffer::from_pixel(8, 8, Rgb([0_u8, 0, 0]))
            .save(&wrong_aspect)
            .unwrap();
        assert_eq!(
            service
                .save_source(
                    &fixture.lease(),
                    &target,
                    metadata,
                    &wrong_aspect,
                    &PreviewCancellation::default(),
                )
                .unwrap_err()
                .code(),
            "canvas_video_preview_source_aspect_ratio_mismatch"
        );
    }

    #[test]
    fn feedback_waits_for_the_exact_browser_capture_without_diagnostics() {
        let fixture = Fixture::new("clip.webm");
        let error = fixture
            .service()
            .feedback_frame(
                &fixture.root,
                fixture.project_relative_path,
                1.25,
                &PreviewCancellation::default(),
            )
            .unwrap_err();
        assert_eq!(error.code(), "canvas_feedback_video_source_pending");
    }

    struct Fixture {
        root: PathBuf,
        home: PathBuf,
        project_relative_path: &'static str,
        revision: String,
    }

    impl Fixture {
        fn new(project_relative_path: &'static str) -> Self {
            let id = Uuid::new_v4();
            let root = std::env::temp_dir().join(format!("debrute-video-project-{id}"));
            let home = std::env::temp_dir().join(format!("debrute-video-home-{id}"));
            fs::create_dir_all(&root).unwrap();
            fs::create_dir_all(&home).unwrap();
            fs::write(
                root.join(project_relative_path),
                b"browser-decodes-this-video",
            )
            .unwrap();
            let root = root.canonicalize().unwrap();
            let relative = ProjectRelativePath::parse(project_relative_path).unwrap();
            let mut file = open_no_symlink_existing_project_file(&root, &relative).unwrap();
            let revision = project_media_revision(&mut file).unwrap();
            Self {
                root,
                home,
                project_relative_path,
                revision,
            }
        }

        fn service(&self) -> CanvasVideoPreviewService {
            CanvasVideoPreviewService::new(
                Arc::new(RasterPreviewVariantService::new(Arc::new(Semaphore::new(
                    1,
                )))),
                self.home.clone(),
            )
        }

        fn lease(&self) -> ProjectSourceLease {
            ProjectSourceLease::for_test(
                &self.root,
                self.project_relative_path,
                self.revision.clone(),
            )
            .unwrap()
        }

        fn target(&self, frame_time_ms: u64) -> CanvasVideoPreviewTarget {
            CanvasVideoPreviewTarget {
                project_relative_path: ProjectRelativePath::parse(self.project_relative_path)
                    .unwrap(),
                source_revision: self.revision.clone(),
                frame_time_ms,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
            fs::remove_dir_all(&self.home).unwrap();
        }
    }
}
