//! Revision-bound Project media files and transport-neutral byte-range plans.

use std::{fs, path::Path, time::UNIX_EPOCH};

use super::{
    CanvasMediaKind, ProjectError, assert_project_tree_visible_path,
    open_no_symlink_existing_project_file,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug)]
pub struct RevisionedFilePlan {
    pub file: fs::File,
    pub project_relative_path: String,
    pub revision: String,
    pub content_type: String,
    pub file_size: u64,
    pub range: Option<ByteRange>,
}

impl RevisionedFilePlan {
    #[must_use]
    pub fn content_length(&self) -> u64 {
        self.range
            .map_or(self.file_size, |range| range.end - range.start + 1)
    }

    #[must_use]
    pub fn status_code(&self) -> u16 {
        if self.range.is_some() { 206 } else { 200 }
    }

    #[must_use]
    pub fn content_range(&self) -> Option<String> {
        self.range
            .map(|range| format!("bytes {}-{}/{}", range.start, range.end, self.file_size))
    }
}

#[derive(Debug)]
pub enum RevisionedFileResponse {
    File(RevisionedFilePlan),
    RangeNotSatisfiable { file_size: u64 },
}

/// Opens the exact visible Project file represented by a revision and plans one byte range.
///
/// The returned handle, rather than a path reopened by the transport, is the serving authority.
///
/// # Errors
/// Returns a typed error for missing/stale revisions, invalid paths, directories, or I/O failure.
pub fn open_revisioned_project_file(
    project_root: &Path,
    project_relative_path: &str,
    expected_revision: &str,
    range_header: Option<&str>,
) -> Result<RevisionedFileResponse, ProjectError> {
    if expected_revision.is_empty() {
        return Err(ProjectError::service(
            "missing_revision",
            format!(
                "Project file revision is required for raw file responses: {project_relative_path}"
            ),
        ));
    }
    let relative = assert_project_tree_visible_path(project_relative_path)?;
    let file = open_no_symlink_existing_project_file(project_root, &relative)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(ProjectError::service(
            "not_found",
            format!("Project path is not a file: {relative}"),
        ));
    }
    let revision = project_file_revision_from_metadata(&metadata)?;
    if revision != expected_revision {
        return Err(ProjectError::service_with_fields(
            "stale_revision",
            format!("Project file revision does not match source: {relative}"),
            [
                ("expected_revision".to_owned(), expected_revision.to_owned()),
                ("actual_revision".to_owned(), revision),
            ],
        ));
    }
    let file_size = metadata.len();
    let range = match parse_byte_range(range_header, file_size) {
        ParsedRange::Full => None,
        ParsedRange::Partial(range) => Some(range),
        ParsedRange::Unsatisfiable => {
            return Ok(RevisionedFileResponse::RangeNotSatisfiable { file_size });
        }
    };
    Ok(RevisionedFileResponse::File(RevisionedFilePlan {
        file,
        project_relative_path: relative.clone(),
        revision: expected_revision.to_owned(),
        content_type: project_content_type(&relative).to_owned(),
        file_size,
        range,
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParsedRange {
    Full,
    Partial(ByteRange),
    Unsatisfiable,
}

#[must_use]
pub fn parse_byte_range(range_header: Option<&str>, file_size: u64) -> ParsedRange {
    let Some(raw) = range_header else {
        return ParsedRange::Full;
    };
    let Some(value) = raw.strip_prefix("bytes=") else {
        return ParsedRange::Unsatisfiable;
    };
    if value.contains(',') || file_size == 0 {
        return ParsedRange::Unsatisfiable;
    }
    let Some((start_raw, end_raw)) = value.split_once('-') else {
        return ParsedRange::Unsatisfiable;
    };
    if start_raw.is_empty() && end_raw.is_empty() {
        return ParsedRange::Unsatisfiable;
    }
    if start_raw.is_empty() {
        let Ok(suffix_length) = end_raw.parse::<u64>() else {
            return ParsedRange::Unsatisfiable;
        };
        if suffix_length == 0 {
            return ParsedRange::Unsatisfiable;
        }
        let length = suffix_length.min(file_size);
        return ParsedRange::Partial(ByteRange {
            start: file_size - length,
            end: file_size - 1,
        });
    }
    let Ok(start) = start_raw.parse::<u64>() else {
        return ParsedRange::Unsatisfiable;
    };
    let end = if end_raw.is_empty() {
        file_size - 1
    } else {
        let Ok(end) = end_raw.parse::<u64>() else {
            return ParsedRange::Unsatisfiable;
        };
        end
    };
    if end < start || start >= file_size {
        return ParsedRange::Unsatisfiable;
    }
    ParsedRange::Partial(ByteRange {
        start,
        end: end.min(file_size - 1),
    })
}

/// Computes the current Project media revision from one already-open file.
///
/// # Errors
/// Returns an error when the modification time predates the Unix epoch or is unavailable.
pub fn project_file_revision_from_metadata(
    metadata: &fs::Metadata,
) -> Result<String, ProjectError> {
    let modified_ms = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| ProjectError::Validation(error.to_string()))?
        .as_secs_f64()
        * 1000.0;
    Ok(super::project_file_revision(metadata.len(), modified_ms))
}

#[must_use]
pub fn project_content_type(path: &str) -> &'static str {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" | "jpe" | "jfif" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "tif" | "tiff" => "image/tiff",
        "svg" | "svgz" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "m4v" => "video/x-m4v",
        "mp3" => "audio/mpeg",
        "wav" | "wave" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "weba" => "audio/webm",
        "vtt" => "text/vtt; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[must_use]
pub fn project_media_kind_from_content_type(content_type: &str) -> CanvasMediaKind {
    match content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" | "image/jpeg" | "image/webp" | "image/avif" | "image/tiff"
        | "image/svg+xml" => CanvasMediaKind::Image,
        "video/mp4" | "video/webm" | "video/quicktime" | "video/x-m4v" => CanvasMediaKind::Video,
        "audio/mpeg" | "audio/wav" | "audio/x-wav" | "audio/ogg" | "audio/mp4" | "audio/aac"
        | "audio/flac" | "audio/webm" => CanvasMediaKind::Audio,
        _ => CanvasMediaKind::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_ranges_are_closed_to_one_valid_range() {
        assert_eq!(parse_byte_range(None, 10), ParsedRange::Full);
        assert_eq!(
            parse_byte_range(Some("bytes=2-6"), 10),
            ParsedRange::Partial(ByteRange { start: 2, end: 6 })
        );
        assert_eq!(
            parse_byte_range(Some("bytes=7-"), 10),
            ParsedRange::Partial(ByteRange { start: 7, end: 9 })
        );
        assert_eq!(
            parse_byte_range(Some("bytes=-20"), 10),
            ParsedRange::Partial(ByteRange { start: 0, end: 9 })
        );
        for invalid in [
            "items=0-1",
            "bytes=",
            "bytes=0-1,3-4",
            "bytes=8-2",
            "bytes=10-",
        ] {
            assert_eq!(
                parse_byte_range(Some(invalid), 10),
                ParsedRange::Unsatisfiable,
                "unexpected range result for {invalid}"
            );
        }
        assert_eq!(
            parse_byte_range(Some("bytes=0-"), 0),
            ParsedRange::Unsatisfiable
        );
    }

    #[test]
    fn content_types_match_the_existing_media_surface() {
        assert_eq!(project_content_type("FRAME.JPEG"), "image/jpeg");
        assert_eq!(project_content_type("clip.mov"), "video/quicktime");
        assert_eq!(
            project_content_type("captions.vtt"),
            "text/vtt; charset=utf-8"
        );
        assert_eq!(
            project_content_type("unknown.bin"),
            "application/octet-stream"
        );
    }
}
