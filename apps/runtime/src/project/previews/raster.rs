use std::{
    fs::File,
    io::{Read as _, Seek as _},
    path::Path,
    sync::{Arc, OnceLock},
};

use flate2::read::GzDecoder;
use image::{DynamicImage, RgbaImage};

use super::{PreviewCancellation, cache::Semaphore, libvips_adapter};
use crate::project::ProjectError;

const MAX_RASTER_OUTPUT_ALLOCATION: u64 = 256 * 1024 * 1024;
const MAX_SVG_DIMENSION: u32 = 50_000;
const MAX_SVG_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SVG_ELEMENTS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RasterMetadata {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RasterDimensions {
    pub(super) width: u32,
    pub(super) height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RasterOutputFormat {
    Png,
    Jpeg,
}

pub(crate) struct RasterPreviewEngine {
    pool: Arc<Semaphore>,
    metadata: Semaphore,
}

impl RasterPreviewEngine {
    pub(super) fn new(pool: Arc<Semaphore>, metadata: usize) -> Self {
        Self {
            pool,
            metadata: Semaphore::new(metadata),
        }
    }

    pub(super) fn metadata_file(
        &self,
        path: &Path,
        file: &mut File,
        cancellation: &PreviewCancellation,
    ) -> Result<RasterMetadata, ProjectError> {
        cancellation.check()?;
        let _permit = self.metadata.acquire(cancellation)?;
        let _svg_permit = if is_svg(path) {
            Some(self.pool.acquire(cancellation)?)
        } else {
            None
        };
        raster_metadata(path, file)
    }

    pub(super) fn render_variant_to_file(
        &self,
        source: &Path,
        file: &mut File,
        width: u32,
        format: RasterOutputFormat,
        output: &mut File,
        cancellation: &PreviewCancellation,
    ) -> Result<(), ProjectError> {
        cancellation.check()?;
        let _permit = self.pool.acquire(cancellation)?;
        let metadata = raster_metadata(source, file)?;
        if width == 0 || width > metadata.width {
            return Err(ProjectError::service(
                "canvas_preview_invalid_width",
                format!(
                    "Canvas preview width exceeds source width: {}",
                    source.display()
                ),
            ));
        }
        let target = RasterDimensions {
            width,
            height: scaled_height(metadata.width, metadata.height, width)?,
        };
        validate_target_area(source, target)?;
        if is_svg(source) {
            let image = render_svg(source, file, target)?;
            return libvips_adapter::encode_dynamic_to_file(source, &image, format, output);
        }
        libvips_adapter::render_to_file(source, file, metadata, target, format, output)
    }

    pub(crate) fn load_bounded_admitted(
        source: &Path,
        file: &mut File,
        max_dimension: u32,
        cancellation: &PreviewCancellation,
    ) -> Result<DynamicImage, ProjectError> {
        cancellation.check()?;
        let metadata = raster_metadata(source, file)?;
        let target = bounded_dimensions(metadata.width, metadata.height, max_dimension)?;
        validate_target_area(source, target)?;
        let image = if is_svg(source) {
            render_svg(source, file, target)?
        } else {
            let bytes = libvips_adapter::render_bytes(
                source,
                file,
                metadata,
                target,
                RasterOutputFormat::Png,
            )?;
            image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).map_err(
                |error| {
                    ProjectError::service(
                        "canvas_preview_render_failed",
                        format!(
                            "Canvas raster output could not be decoded ({}): {error}",
                            source.display()
                        ),
                    )
                },
            )?
        };
        cancellation.check()?;
        Ok(image)
    }
}

/// Initializes and validates the process-wide native Raster Preview Engine.
///
/// # Errors
///
/// Returns an error when libvips cannot initialize or does not match the
/// version pinned by the Runtime Product.
pub fn initialize_raster_preview_engine() -> Result<(), ProjectError> {
    libvips_adapter::initialize()
}

fn raster_metadata(path: &Path, file: &mut File) -> Result<RasterMetadata, ProjectError> {
    file.rewind()?;
    if !is_svg(path) {
        return libvips_adapter::metadata(path, file);
    }
    let tree = parse_svg(path, file)?;
    let size = tree.size();
    Ok(RasterMetadata {
        width: finite_svg_dimension(size.width(), path)?,
        height: finite_svg_dimension(size.height(), path)?,
        has_alpha: true,
    })
}

fn parse_svg(path: &Path, file: &mut File) -> Result<resvg::usvg::Tree, ProjectError> {
    file.rewind()?;
    let mut bytes = Vec::new();
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svgz"))
    {
        GzDecoder::new(file)
            .take(MAX_SVG_BYTES + 1)
            .read_to_end(&mut bytes)?;
    } else {
        file.take(MAX_SVG_BYTES + 1).read_to_end(&mut bytes)?;
    }
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_SVG_BYTES {
        return Err(ProjectError::service(
            "canvas_image_too_large",
            format!("Canvas SVG exceeds the decode limit: {}", path.display()),
        ));
    }
    let mut remaining_elements = MAX_SVG_ELEMENTS;
    let exceeds_element_limit = bytes.iter().any(|byte| {
        if *byte != b'<' {
            return false;
        }
        let Some(remaining) = remaining_elements.checked_sub(1) else {
            return true;
        };
        remaining_elements = remaining;
        false
    });
    if exceeds_element_limit {
        return Err(ProjectError::service(
            "canvas_image_too_large",
            format!("Canvas SVG exceeds the element limit: {}", path.display()),
        ));
    }
    let mut options = resvg::usvg::Options {
        resources_dir: None,
        ..resvg::usvg::Options::default()
    };
    options.fontdb = system_fonts();
    resvg::usvg::Tree::from_data(&bytes, &options).map_err(|error| {
        ProjectError::service(
            "canvas_image_not_previewable",
            format!("Canvas SVG could not be parsed: {error}"),
        )
    })
}

#[allow(clippy::cast_precision_loss)]
fn render_svg(
    path: &Path,
    file: &mut File,
    target: RasterDimensions,
) -> Result<DynamicImage, ProjectError> {
    let tree = parse_svg(path, file)?;
    let source = tree.size();
    validate_target_area(path, target)?;
    let mut pixmap =
        resvg::tiny_skia::Pixmap::new(target.width, target.height).ok_or_else(|| {
            ProjectError::service(
                "canvas_image_too_large",
                format!("Canvas SVG preview allocation failed: {}", path.display()),
            )
        })?;
    let scale = (target.width as f32 / source.width()).min(target.height as f32 / source.height());
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    RgbaImage::from_raw(target.width, target.height, pixmap.take_demultiplied())
        .map(DynamicImage::ImageRgba8)
        .ok_or_else(|| {
            ProjectError::service(
                "canvas_preview_render_failed",
                format!(
                    "Canvas SVG output has invalid dimensions: {}",
                    path.display()
                ),
            )
        })
}

fn system_fonts() -> Arc<resvg::usvg::fontdb::Database> {
    static FONTS: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();
    Arc::clone(FONTS.get_or_init(|| {
        let mut fonts = resvg::usvg::fontdb::Database::new();
        fonts.load_system_fonts();
        Arc::new(fonts)
    }))
}

pub(crate) fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, ProjectError> {
    libvips_adapter::encode_dynamic(
        Path::new("Canvas feedback artifact"),
        image,
        RasterOutputFormat::Png,
    )
}

pub(crate) fn composite_svg_overlay(
    image: &mut DynamicImage,
    overlay_svg: &[u8],
) -> Result<(), ProjectError> {
    validate_target_area(
        Path::new("Canvas feedback overlay"),
        RasterDimensions {
            width: image.width(),
            height: image.height(),
        },
    )?;
    let mut options = resvg::usvg::Options {
        resources_dir: None,
        ..resvg::usvg::Options::default()
    };
    options.fontdb = system_fonts();
    let tree = resvg::usvg::Tree::from_data(overlay_svg, &options).map_err(|error| {
        ProjectError::service(
            "canvas_feedback_render_failed",
            format!("Canvas feedback overlay could not be parsed: {error}"),
        )
    })?;
    let mut pixmap =
        resvg::tiny_skia::Pixmap::new(image.width(), image.height()).ok_or_else(|| {
            ProjectError::service(
                "canvas_feedback_render_failed",
                "Canvas feedback overlay allocation failed.",
            )
        })?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );
    let overlay = RgbaImage::from_raw(image.width(), image.height(), pixmap.take_demultiplied())
        .ok_or_else(|| {
            ProjectError::service(
                "canvas_feedback_render_failed",
                "Canvas feedback overlay buffer has invalid dimensions.",
            )
        })?;
    image::imageops::overlay(image, &DynamicImage::ImageRgba8(overlay), 0, 0);
    Ok(())
}

fn is_svg(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "svg" | "svgz"))
}

fn validate_target_area(path: &Path, target: RasterDimensions) -> Result<(), ProjectError> {
    let bytes = u64::from(target.width)
        .checked_mul(u64::from(target.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| allocation_error(path))?;
    if target.width == 0 || target.height == 0 || bytes > MAX_RASTER_OUTPUT_ALLOCATION {
        return Err(allocation_error(path));
    }
    Ok(())
}

fn allocation_error(path: &Path) -> ProjectError {
    ProjectError::service(
        "canvas_image_too_large",
        format!(
            "Canvas raster target exceeds the 256 MiB area budget: {}",
            path.display()
        ),
    )
}

fn bounded_dimensions(
    source_width: u32,
    source_height: u32,
    max_dimension: u32,
) -> Result<RasterDimensions, ProjectError> {
    if max_dimension == 0 {
        return Err(ProjectError::Validation(
            "Canvas raster maximum dimension must be positive.".to_owned(),
        ));
    }
    if source_width <= max_dimension && source_height <= max_dimension {
        return Ok(RasterDimensions {
            width: source_width,
            height: source_height,
        });
    }
    if source_width >= source_height {
        return Ok(RasterDimensions {
            width: max_dimension,
            height: scaled_height(source_width, source_height, max_dimension)?,
        });
    }
    let width =
        u64::from(source_width).saturating_mul(u64::from(max_dimension)) / u64::from(source_height);
    Ok(RasterDimensions {
        width: u32::try_from(width.max(1)).map_err(|_| invalid_dimensions())?,
        height: max_dimension,
    })
}

#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn finite_svg_dimension(value: f32, path: &Path) -> Result<u32, ProjectError> {
    if !value.is_finite() || value <= 0.0 || value > MAX_SVG_DIMENSION as f32 {
        return Err(ProjectError::service(
            "canvas_image_invalid_dimensions",
            format!("Canvas SVG dimensions are invalid: {}", path.display()),
        ));
    }
    Ok(value.ceil() as u32)
}

fn scaled_height(source_width: u32, source_height: u32, width: u32) -> Result<u32, ProjectError> {
    let height = u64::from(source_height)
        .checked_mul(u64::from(width))
        .ok_or_else(invalid_dimensions)?
        .div_ceil(u64::from(source_width));
    u32::try_from(height.max(1)).map_err(|_| invalid_dimensions())
}

fn invalid_dimensions() -> ProjectError {
    ProjectError::service(
        "canvas_image_invalid_dimensions",
        "Canvas preview dimensions exceed the supported range.",
    )
}

#[allow(dead_code)]
fn _assert_send_sync() {
    fn assert<T: Send + Sync>() {}
    assert::<RasterPreviewEngine>();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_dimensions_limit_extreme_portrait_sources() {
        assert_eq!(
            bounded_dimensions(1, 50_000, 4_096).unwrap(),
            RasterDimensions {
                width: 1,
                height: 4_096
            }
        );
    }

    #[test]
    fn target_area_budget_allows_wide_panoramas_but_rejects_oversized_squares() {
        validate_target_area(
            Path::new("panorama.png"),
            RasterDimensions {
                width: 60_000,
                height: 1,
            },
        )
        .unwrap();
        let error = validate_target_area(
            Path::new("square.png"),
            RasterDimensions {
                width: 10_000,
                height: 10_000,
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "canvas_image_too_large");
    }

    #[test]
    fn svg_structure_is_rejected_before_unbounded_tree_construction() {
        let path =
            std::env::temp_dir().join(format!("debrute-svg-elements-{}.svg", uuid::Uuid::new_v4()));
        std::fs::write(&path, vec![b'<'; MAX_SVG_ELEMENTS + 1]).unwrap();
        let mut file = File::open(&path).unwrap();

        let error = parse_svg(&path, &mut file).unwrap_err();
        assert_eq!(error.code(), "canvas_image_too_large");

        std::fs::remove_file(path).unwrap();
    }
}
