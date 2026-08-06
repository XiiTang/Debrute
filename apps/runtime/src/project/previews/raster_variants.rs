use std::{
    fs::File,
    io::Seek as _,
    path::{Path, PathBuf},
    sync::Arc,
};

use super::{
    CanvasPreviewFile, PreviewCancellation, ProjectCapabilityFs, ProjectError,
    RASTER_PREVIEW_ENGINE_VERSION,
    cache::{KeyedLocks, Semaphore},
    existing_open_file, open_no_symlink_existing_project_file,
    raster::{RasterMetadata, RasterOutputFormat, RasterPreviewEngine},
    resolve_no_symlink_existing_project_path,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RasterPreviewVariantOutputPolicy {
    MatchSourceAlpha,
    Png,
    Jpeg,
}

pub(super) struct RasterPreviewVariantRequest {
    pub(super) source_path: PathBuf,
    pub(super) source_file: File,
    pub(super) source_content_type: Option<&'static str>,
    pub(super) cache_directory: String,
    pub(super) width: u32,
    pub(super) output_policy: RasterPreviewVariantOutputPolicy,
    pub(super) invalid_width_message: String,
}

pub(super) struct RasterPreviewVariantService {
    raster: RasterPreviewEngine,
    locks: KeyedLocks,
}

impl RasterPreviewVariantService {
    pub(super) fn new(raster_pool: Arc<Semaphore>) -> Self {
        Self {
            raster: RasterPreviewEngine::new(raster_pool, 8),
            locks: KeyedLocks::default(),
        }
    }

    pub(super) fn metadata_file(
        &self,
        path: &Path,
        file: &mut File,
        cancellation: &PreviewCancellation,
    ) -> Result<RasterMetadata, ProjectError> {
        self.raster.metadata_file(path, file, cancellation)
    }

    pub(super) fn resolve(
        &self,
        cache_root: &Path,
        mut request: RasterPreviewVariantRequest,
        cancellation: &PreviewCancellation,
        verify_source: impl Fn() -> Result<(), ProjectError>,
    ) -> Result<CanvasPreviewFile, ProjectError> {
        validate_preview_width(request.width)?;
        let cache_base = format!(
            "{}/raster-engine-v{RASTER_PREVIEW_ENGINE_VERSION}/preview-w{}",
            request.cache_directory, request.width
        );
        let key = format!("{}\0{cache_base}", cache_root.display());
        let _lock = self.locks.acquire(&key, cancellation)?;
        cancellation.check()?;
        verify_source()?;

        let metadata = self.raster.metadata_file(
            &request.source_path,
            &mut request.source_file,
            cancellation,
        )?;
        if request.width > metadata.width {
            return Err(ProjectError::service(
                "canvas_preview_invalid_width",
                request.invalid_width_message,
            ));
        }
        if request.width == metadata.width
            && let Some(content_type) = request.source_content_type
        {
            verify_source()?;
            request.source_file.rewind()?;
            return Ok(CanvasPreviewFile {
                absolute_path: request.source_path,
                file: request.source_file,
                content_type,
            });
        }

        let output = output_for(request.output_policy, metadata);
        let variant_path = format!("{cache_base}.{}", output.extension);
        if let Some((absolute_path, file)) = existing_open_file(cache_root, &variant_path)? {
            verify_source()?;
            return Ok(CanvasPreviewFile {
                absolute_path,
                file,
                content_type: output.content_type,
            });
        }

        ProjectCapabilityFs::open(cache_root)?.atomic_write_stream_checked(
            &variant_path,
            |output_file| {
                self.raster.render_variant_to_file(
                    &request.source_path,
                    &mut request.source_file,
                    request.width,
                    output.format,
                    output_file,
                    cancellation,
                )
            },
            verify_source,
        )?;
        let file = open_no_symlink_existing_project_file(cache_root, &variant_path)?;
        Ok(CanvasPreviewFile {
            absolute_path: resolve_no_symlink_existing_project_path(cache_root, &variant_path)?,
            file,
            content_type: output.content_type,
        })
    }
}

struct RasterPreviewVariantOutput {
    extension: &'static str,
    format: RasterOutputFormat,
    content_type: &'static str,
}

fn output_for(
    policy: RasterPreviewVariantOutputPolicy,
    metadata: RasterMetadata,
) -> RasterPreviewVariantOutput {
    match policy {
        RasterPreviewVariantOutputPolicy::Png => RasterPreviewVariantOutput {
            extension: "png",
            format: RasterOutputFormat::Png,
            content_type: "image/png",
        },
        RasterPreviewVariantOutputPolicy::MatchSourceAlpha if metadata.has_alpha => {
            RasterPreviewVariantOutput {
                extension: "png",
                format: RasterOutputFormat::Png,
                content_type: "image/png",
            }
        }
        RasterPreviewVariantOutputPolicy::Jpeg
        | RasterPreviewVariantOutputPolicy::MatchSourceAlpha => RasterPreviewVariantOutput {
            extension: "jpg",
            format: RasterOutputFormat::Jpeg,
            content_type: "image/jpeg",
        },
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
