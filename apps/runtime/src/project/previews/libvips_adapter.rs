use std::{
    fs::File,
    io::{Read as _, Seek as _},
    path::Path,
    sync::OnceLock,
};

use image::DynamicImage;
use rs_vips::{
    Vips, VipsImage, VipsSource, VipsTarget,
    enums::{Access, BandFormat, FailOn, ForeignKeep, Interpretation, Kernel},
    voption::{Setter as _, VOption},
};

use super::{RasterMetadata, RasterOutputFormat, raster::RasterDimensions};
use crate::project::ProjectError;

pub(super) const LIBVIPS_VERSION: &str = "8.18.4";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RasterInputFormat {
    Jpeg,
    Png,
    Webp,
    Avif,
    Tiff,
}

pub(super) fn initialize() -> Result<(), ProjectError> {
    static INITIALIZATION: OnceLock<Result<(), String>> = OnceLock::new();
    match INITIALIZATION.get_or_init(initialize_once) {
        Ok(()) => Ok(()),
        Err(message) => Err(ProjectError::service(
            "raster_preview_engine_unavailable",
            message.clone(),
        )),
    }
}

pub(super) fn metadata(path: &Path, file: &mut File) -> Result<RasterMetadata, ProjectError> {
    initialize()?;
    let format = validate_input_format(path, file)?;
    let image = load(path, file, format, None)?;
    validate_single_page(path, &image)?;
    let image = image
        .autorot()
        .map_err(|error| native_error(path, "apply source orientation", &error))?;
    image_metadata(path, &image)
}

pub(super) fn render_bytes(
    path: &Path,
    file: &mut File,
    source_metadata: RasterMetadata,
    target: RasterDimensions,
    format: RasterOutputFormat,
) -> Result<Vec<u8>, ProjectError> {
    let image = prepare_render_image(path, file, source_metadata, target)?;
    let target = VipsTarget::new_to_memory()
        .map_err(|error| native_error(path, "create encoded output", &error))?;
    save(path, &image, &target, format)?;
    let bytes = target.get_blob();
    if bytes.is_empty() {
        return Err(ProjectError::service(
            "canvas_preview_render_failed",
            format!(
                "Canvas raster encoder produced no output: {}",
                path.display()
            ),
        ));
    }
    Ok(bytes)
}

pub(super) fn render_to_file(
    path: &Path,
    file: &mut File,
    source_metadata: RasterMetadata,
    target: RasterDimensions,
    format: RasterOutputFormat,
    output: &mut File,
) -> Result<(), ProjectError> {
    let image = prepare_render_image(path, file, source_metadata, target)?;
    let target = VipsTarget::new_to_writer(output.try_clone()?)
        .map_err(|error| native_error(path, "create encoded output", &error))?;
    save(path, &image, &target, format)?;
    drop(target);
    if output.metadata()?.len() == 0 {
        return Err(ProjectError::service(
            "canvas_preview_render_failed",
            format!(
                "Canvas raster encoder produced no output: {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

pub(super) fn encode_dynamic_to_file(
    path: &Path,
    image: &DynamicImage,
    format: RasterOutputFormat,
    output: &mut File,
) -> Result<(), ProjectError> {
    let image = dynamic_to_vips(path, image)?;
    let target = VipsTarget::new_to_writer(output.try_clone()?)
        .map_err(|error| native_error(path, "create encoded output", &error))?;
    save(path, &image, &target, format)?;
    drop(target);
    if output.metadata()?.len() == 0 {
        return Err(ProjectError::service(
            "canvas_preview_render_failed",
            format!(
                "Canvas raster encoder produced no output: {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

pub(super) fn encode_dynamic(
    path: &Path,
    image: &DynamicImage,
    format: RasterOutputFormat,
) -> Result<Vec<u8>, ProjectError> {
    let image = dynamic_to_vips(path, image)?;
    let target = VipsTarget::new_to_memory()
        .map_err(|error| native_error(path, "create encoded output", &error))?;
    save(path, &image, &target, format)?;
    let bytes = target.get_blob();
    if bytes.is_empty() {
        return Err(ProjectError::service(
            "canvas_preview_render_failed",
            format!(
                "Canvas raster encoder produced no output: {}",
                path.display()
            ),
        ));
    }
    Ok(bytes)
}

fn prepare_render_image(
    path: &Path,
    file: &mut File,
    source_metadata: RasterMetadata,
    target: RasterDimensions,
) -> Result<VipsImage, ProjectError> {
    initialize()?;
    let input_format = validate_input_format(path, file)?;
    let image = load(
        path,
        file,
        input_format,
        Some((source_metadata.width, target.width)),
    )?;
    validate_single_page(path, &image)?;
    let image = image
        .autorot()
        .map_err(|error| native_error(path, "apply source orientation", &error))?;
    resize_and_normalize(path, &image, source_metadata, target)
}

fn dynamic_to_vips(path: &Path, image: &DynamicImage) -> Result<VipsImage, ProjectError> {
    initialize()?;
    let rgba = image.to_rgba8();
    let width = i32::try_from(rgba.width()).map_err(|_| invalid_dimensions(path))?;
    let height = i32::try_from(rgba.height()).map_err(|_| invalid_dimensions(path))?;
    let image = VipsImage::new_from_memory_copy(rgba.as_raw(), width, height, 4, BandFormat::Uchar)
        .map_err(|error| native_error(path, "import raster pixels", &error))?;
    image
        .copy_with_opts(VOption::new().set("interpretation", Interpretation::Srgb as i32))
        .map_err(|error| native_error(path, "mark raster pixels as sRGB", &error))
}

fn initialize_once() -> Result<(), String> {
    Vips::init("Debrute Runtime")
        .map_err(|error| format!("libvips initialization failed: {error}"))?;
    let reported =
        Vips::version_string().map_err(|error| format!("libvips version query failed: {error}"))?;
    let version = reported.split_whitespace().next().unwrap_or_default();
    if version != LIBVIPS_VERSION {
        return Err(format!(
            "Debrute Runtime requires libvips {LIBVIPS_VERSION}, but loaded {reported}."
        ));
    }
    Vips::cache_set_max(0);
    Vips::cache_set_max_mem(0);
    Vips::cache_set_max_files(0);
    Ok(())
}

fn validate_input_format(path: &Path, file: &mut File) -> Result<RasterInputFormat, ProjectError> {
    let expected = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg" | "jpe" | "jfif") => RasterInputFormat::Jpeg,
        Some("png") => RasterInputFormat::Png,
        Some("webp") => RasterInputFormat::Webp,
        Some("avif") => RasterInputFormat::Avif,
        Some("tif" | "tiff") => RasterInputFormat::Tiff,
        _ => {
            return Err(not_previewable(
                path,
                "extension is not a supported raster format",
            ));
        }
    };
    file.rewind()?;
    let mut header = [0_u8; 64];
    let length = file.read(&mut header)?;
    file.rewind()?;
    let header = &header[..length];
    let actual = if header.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(RasterInputFormat::Jpeg)
    } else if header.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(RasterInputFormat::Png)
    } else if header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        Some(RasterInputFormat::Webp)
    } else if is_avif_header(header) {
        Some(RasterInputFormat::Avif)
    } else if header.starts_with(b"II*\0") || header.starts_with(b"MM\0*") {
        Some(RasterInputFormat::Tiff)
    } else {
        None
    };
    if actual == Some(expected) {
        Ok(expected)
    } else {
        Err(not_previewable(
            path,
            "encoded content does not match its extension",
        ))
    }
}

fn is_avif_header(header: &[u8]) -> bool {
    if header.len() < 12 || &header[4..8] != b"ftyp" {
        return false;
    }
    header[8..]
        .chunks_exact(4)
        .any(|brand| matches!(brand, b"avif" | b"avis"))
}

fn load(
    path: &Path,
    file: &mut File,
    format: RasterInputFormat,
    target_width: Option<(u32, u32)>,
) -> Result<VipsImage, ProjectError> {
    file.rewind()?;
    let source = VipsSource::new_from_reader(file.try_clone()?)
        .map_err(|error| native_error(path, "open validated source", &error))?;
    let base = VOption::new()
        .set("access", Access::Sequential as i32)
        .set("fail_on", FailOn::Error as i32)
        .set("revalidate", true);
    let image = match format {
        RasterInputFormat::Jpeg => {
            let shrink = target_width.map_or(1, |(source_width, target_width)| {
                jpeg_shrink_for_width(source_width, target_width)
            });
            VipsImage::jpegload_source_with_opts(&source, base.set("shrink", shrink))
        }
        RasterInputFormat::Png => VipsImage::pngload_source_with_opts(&source, base),
        RasterInputFormat::Webp => VipsImage::webpload_source_with_opts(&source, base),
        RasterInputFormat::Avif => VipsImage::heifload_source_with_opts(&source, base),
        RasterInputFormat::Tiff => VipsImage::tiffload_source_with_opts(&source, base),
    };
    image.map_err(|error| native_error(path, "decode validated source", &error))
}

fn jpeg_shrink_for_width(source_width: u32, target_width: u32) -> i32 {
    [8_u32, 4, 2]
        .into_iter()
        .find(|factor| source_width / factor >= target_width)
        .map_or(1, |factor| i32::try_from(factor).unwrap_or(1))
}

fn validate_single_page(path: &Path, image: &VipsImage) -> Result<(), ProjectError> {
    if image.get_n_pages() == 1 {
        Ok(())
    } else {
        Err(not_previewable(
            path,
            "animated or multi-page raster input is not supported",
        ))
    }
}

fn image_metadata(path: &Path, image: &VipsImage) -> Result<RasterMetadata, ProjectError> {
    let width = positive_dimension(path, image.get_width(), "width")?;
    let height = positive_dimension(path, image.get_height(), "height")?;
    Ok(RasterMetadata {
        width,
        height,
        has_alpha: image.hasalpha(),
    })
}

fn resize_and_normalize(
    path: &Path,
    image: &VipsImage,
    source: RasterMetadata,
    target: RasterDimensions,
) -> Result<VipsImage, ProjectError> {
    let decoded = image_metadata(path, image)?;
    if target.width == 0
        || target.height == 0
        || target.width > source.width
        || target.height > source.height
    {
        return Err(ProjectError::service(
            "canvas_preview_invalid_width",
            format!(
                "Canvas preview dimensions exceed the source: {}",
                path.display()
            ),
        ));
    }
    let has_profile = image
        .get_typeof("icc-profile-data")
        .map_err(|error| native_error(path, "inspect source colour profile", &error))?
        != 0;
    let image = if has_profile {
        image
            .icc_transform("srgb")
            .map_err(|error| native_error(path, "convert source colour profile to sRGB", &error))?
    } else {
        image
            .colourspace(Interpretation::Srgb)
            .map_err(|error| native_error(path, "convert source pixels to sRGB", &error))?
    };
    let width_scale = f64::from(target.width) / f64::from(decoded.width);
    let height_scale = f64::from(target.height) / f64::from(decoded.height);
    let image = if target.width == decoded.width && target.height == decoded.height {
        image
    } else {
        image
            .resize_with_opts(
                width_scale,
                VOption::new()
                    .set("vscale", height_scale)
                    .set("kernel", Kernel::Lanczos3 as i32),
            )
            .map_err(|error| native_error(path, "resize raster preview", &error))?
    };
    image
        .cast(BandFormat::Uchar)
        .map_err(|error| native_error(path, "convert raster preview to 8-bit pixels", &error))
}

fn save(
    path: &Path,
    image: &VipsImage,
    target: &VipsTarget,
    format: RasterOutputFormat,
) -> Result<(), ProjectError> {
    let result = match format {
        RasterOutputFormat::Png => image.pngsave_target_with_opts(
            target,
            VOption::new()
                .set("bitdepth", 8)
                .set("keep", ForeignKeep::None as i32),
        ),
        RasterOutputFormat::Jpeg => image.jpegsave_target_with_opts(
            target,
            VOption::new()
                .set("Q", 82)
                .set("optimize_coding", true)
                .set("keep", ForeignKeep::None as i32),
        ),
    };
    result.map_err(|error| native_error(path, "encode raster preview", &error))
}

fn positive_dimension(path: &Path, value: i32, label: &str) -> Result<u32, ProjectError> {
    u32::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            ProjectError::service(
                "canvas_image_invalid_dimensions",
                format!("Canvas image {label} is invalid: {}", path.display()),
            )
        })
}

fn invalid_dimensions(path: &Path) -> ProjectError {
    ProjectError::service(
        "canvas_image_invalid_dimensions",
        format!("Canvas image dimensions are invalid: {}", path.display()),
    )
}

fn not_previewable(path: &Path, reason: &str) -> ProjectError {
    ProjectError::service(
        "canvas_image_not_previewable",
        format!(
            "Canvas image is not previewable ({reason}): {}",
            path.display()
        ),
    )
}

fn native_error(path: &Path, action: &str, error: &rs_vips::error::Error) -> ProjectError {
    ProjectError::service(
        "canvas_preview_render_failed",
        format!(
            "Canvas raster engine could not {action} ({}): {error}",
            path.display()
        ),
    )
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{ImageBuffer, ImageFormat, Rgb, Rgba};

    use super::*;

    #[test]
    fn startup_requires_the_exact_pinned_libvips_version() {
        initialize().unwrap();
        assert_eq!(Vips::version_string().unwrap(), LIBVIPS_VERSION);
    }

    #[test]
    fn explicit_raster_loaders_require_matching_extension_and_signature() {
        assert_eq!(
            validated("photo.jpg", b"\xff\xd8\xffpayload"),
            RasterInputFormat::Jpeg
        );
        assert_eq!(
            validated("photo.png", b"\x89PNG\r\n\x1a\npayload"),
            RasterInputFormat::Png
        );
        assert_eq!(
            validated("photo.webp", b"RIFF\x04\0\0\0WEBPpayload"),
            RasterInputFormat::Webp
        );
        assert_eq!(
            validated("photo.tiff", b"II*\0payload"),
            RasterInputFormat::Tiff
        );
        assert_eq!(
            validated("photo.avif", b"\0\0\0\x18ftypavif\0\0\0\0avif"),
            RasterInputFormat::Avif
        );

        let mismatch = validation_error("photo.png", b"\xff\xd8\xffpayload");
        assert_eq!(mismatch.code(), "canvas_image_not_previewable");
    }

    #[test]
    fn heic_and_unknown_bmff_brands_are_not_accepted_as_avif() {
        for header in [
            b"\0\0\0\x18ftypheic\0\0\0\0heic".as_slice(),
            b"\0\0\0\x18ftypmif1\0\0\0\0heic".as_slice(),
        ] {
            let error = validation_error("photo.avif", header);
            assert_eq!(error.code(), "canvas_image_not_previewable");
        }
    }

    #[test]
    fn supported_formats_decode_and_render_through_the_native_engine() {
        for (name, format) in [
            ("fixture.jpg", ImageFormat::Jpeg),
            ("fixture.png", ImageFormat::Png),
            ("fixture.webp", ImageFormat::WebP),
            ("fixture.avif", ImageFormat::Avif),
            ("fixture.tiff", ImageFormat::Tiff),
        ] {
            let path = encoded_fixture(name, format);
            let mut file = File::open(&path).unwrap();
            let source = metadata(&path, &mut file).unwrap();
            assert_eq!((source.width, source.height), (4, 2), "{name}");
            let output = render_bytes(
                &path,
                &mut file,
                source,
                RasterDimensions {
                    width: 2,
                    height: 1,
                },
                if source.has_alpha {
                    RasterOutputFormat::Png
                } else {
                    RasterOutputFormat::Jpeg
                },
            )
            .unwrap();
            let rendered = image::load_from_memory(&output).unwrap();
            assert_eq!((rendered.width(), rendered.height()), (2, 1), "{name}");
            remove_temporary(&path);
        }
    }

    #[test]
    fn exif_orientation_is_applied_before_dimensions_and_output_are_derived() {
        let plain = encoded_fixture_bytes(ImageFormat::Jpeg);
        let path = temporary_file("oriented.jpg", &jpeg_with_orientation(&plain, 6));
        let mut file = File::open(&path).unwrap();
        let source = metadata(&path, &mut file).unwrap();
        assert_eq!((source.width, source.height), (2, 4));
        let output = render_bytes(
            &path,
            &mut file,
            source,
            RasterDimensions {
                width: 1,
                height: 2,
            },
            RasterOutputFormat::Jpeg,
        )
        .unwrap();
        let rendered = image::load_from_memory_with_format(&output, ImageFormat::Jpeg).unwrap();
        assert_eq!((rendered.width(), rendered.height()), (1, 2));
        assert!(!output.windows(6).any(|window| window == b"Exif\0\0"));
        remove_temporary(&path);
    }

    #[test]
    fn alpha_input_is_encoded_as_an_alpha_preserving_png() {
        let pixels = ImageBuffer::from_fn(4, 2, |x, _| {
            Rgba([20, 40, 60, if x == 0 { 96 } else { 255 }])
        });
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(pixels)
            .write_to(&mut encoded, ImageFormat::Png)
            .unwrap();
        let path = temporary_file("alpha.png", &encoded.into_inner());
        let mut file = File::open(&path).unwrap();
        let source = metadata(&path, &mut file).unwrap();
        assert!(source.has_alpha);
        let output = render_bytes(
            &path,
            &mut file,
            source,
            RasterDimensions {
                width: 2,
                height: 1,
            },
            RasterOutputFormat::Png,
        )
        .unwrap();
        assert!(output.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(
            image::load_from_memory(&output)
                .unwrap()
                .color()
                .has_alpha()
        );
        remove_temporary(&path);
    }

    fn validated(name: &str, bytes: &[u8]) -> RasterInputFormat {
        let path = temporary_file(name, bytes);
        let mut file = File::open(&path).unwrap();
        let format = validate_input_format(&path, &mut file).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(path.parent().unwrap()).unwrap();
        format
    }

    fn validation_error(name: &str, bytes: &[u8]) -> ProjectError {
        let path = temporary_file(name, bytes);
        let mut file = File::open(&path).unwrap();
        let error = validate_input_format(&path, &mut file).unwrap_err();
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(path.parent().unwrap()).unwrap();
        error
    }

    fn temporary_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let directory =
            std::env::temp_dir().join(format!("debrute-libvips-adapter-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn encoded_fixture(name: &str, format: ImageFormat) -> std::path::PathBuf {
        temporary_file(name, &encoded_fixture_bytes(format))
    }

    fn encoded_fixture_bytes(format: ImageFormat) -> Vec<u8> {
        let pixels = ImageBuffer::from_fn(4, 2, |x, y| {
            Rgb([
                u8::try_from(x * 50).unwrap(),
                u8::try_from(y * 100).unwrap(),
                180,
            ])
        });
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(pixels)
            .write_to(&mut output, format)
            .unwrap();
        output.into_inner()
    }

    fn jpeg_with_orientation(jpeg: &[u8], orientation: u16) -> Vec<u8> {
        assert!(jpeg.starts_with(&[0xff, 0xd8]));
        let mut output = Vec::with_capacity(jpeg.len() + 36);
        output.extend_from_slice(&jpeg[..2]);
        output.extend_from_slice(&[
            0xff,
            0xe1,
            0x00,
            0x22,
            b'E',
            b'x',
            b'i',
            b'f',
            0,
            0,
            b'I',
            b'I',
            0x2a,
            0,
            8,
            0,
            0,
            0,
            1,
            0,
            0x12,
            0x01,
            3,
            0,
            1,
            0,
            0,
            0,
            u8::try_from(orientation).unwrap(),
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ]);
        output.extend_from_slice(&jpeg[2..]);
        output
    }

    fn remove_temporary(path: &Path) {
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(path.parent().unwrap()).unwrap();
    }
}
