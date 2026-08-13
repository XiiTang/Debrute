//! Project-owned file metadata used by Workbench inspection.

use std::{
    fs::File,
    io::{BufReader, Read as _, Seek as _, SeekFrom},
    path::Path,
};

use flate2::read::GzDecoder;
use image::{ImageDecoder as _, ImageReader, metadata::Orientation};

use super::{ProjectImageDimensions, ProjectPathInspectionMedia, project_content_type};

const MAX_SVG_METADATA_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SVG_METADATA_ELEMENTS: usize = 100_000;
const MAX_SVG_DIMENSION: f32 = 50_000.0;

pub(crate) fn inspect_project_file_media(
    project_relative_path: &str,
    source_token: &str,
    file: &mut File,
) -> ProjectPathInspectionMedia {
    let content_type = project_content_type(project_relative_path);
    if content_type.starts_with("image/") {
        return ProjectPathInspectionMedia::Image {
            dimensions: project_image_dimensions(Path::new(project_relative_path), file),
        };
    }
    if content_type.starts_with("video/") {
        return ProjectPathInspectionMedia::Video {
            source_token: source_token.to_owned(),
        };
    }
    if content_type.starts_with("audio/") {
        return ProjectPathInspectionMedia::Audio {
            source_token: source_token.to_owned(),
        };
    }
    ProjectPathInspectionMedia::Other
}

fn project_image_dimensions(path: &Path, file: &mut File) -> Option<ProjectImageDimensions> {
    let original_position = file.stream_position().ok()?;
    let dimensions = (|| {
        file.seek(SeekFrom::Start(0)).ok()?;
        if is_svg(path) {
            return svg_dimensions(path, file);
        }
        if has_extension(path, "avif") {
            let size = imagesize::reader_size(BufReader::new(&mut *file)).ok()?;
            return Some(ProjectImageDimensions {
                width: u64::try_from(size.width).ok()?,
                height: u64::try_from(size.height).ok()?,
            });
        }
        let reader = ImageReader::new(BufReader::new(&mut *file))
            .with_guessed_format()
            .ok()?;
        let mut decoder = reader.into_decoder().ok()?;
        let (mut width, mut height) = decoder.dimensions();
        if matches!(
            decoder.orientation().ok()?,
            Orientation::Rotate90
                | Orientation::Rotate270
                | Orientation::Rotate90FlipH
                | Orientation::Rotate270FlipH
        ) {
            std::mem::swap(&mut width, &mut height);
        }
        Some(ProjectImageDimensions {
            width: u64::from(width),
            height: u64::from(height),
        })
    })();
    file.seek(SeekFrom::Start(original_position)).ok()?;
    dimensions
}

fn svg_dimensions(path: &Path, file: &mut File) -> Option<ProjectImageDimensions> {
    let mut bytes = Vec::new();
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svgz"))
    {
        GzDecoder::new(file)
            .take(MAX_SVG_METADATA_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
    } else {
        file.take(MAX_SVG_METADATA_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
    }
    if u64::try_from(bytes.len()).ok()? > MAX_SVG_METADATA_BYTES {
        return None;
    }
    if bytes
        .iter()
        .filter(|byte| **byte == b'<')
        .nth(MAX_SVG_METADATA_ELEMENTS)
        .is_some()
    {
        return None;
    }
    let tree = resvg::usvg::Tree::from_data(&bytes, &resvg::usvg::Options::default()).ok()?;
    let size = tree.size();
    let width = finite_svg_dimension(size.width())?;
    let height = finite_svg_dimension(size.height())?;
    Some(ProjectImageDimensions { width, height })
}

fn finite_svg_dimension(value: f32) -> Option<u64> {
    (value.is_finite() && value > 0.0 && value <= MAX_SVG_DIMENSION).then_some(value.ceil() as u64)
}

fn is_svg(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "svg" | "svgz"))
}

fn has_extension(path: &Path, expected: &str) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
}
