//! Revision-bound Project media files and transport-neutral byte-range plans.

use std::{
    fs,
    io::{Read as _, Seek as _, SeekFrom},
    path::Path,
};

use sha2::{Digest as _, Sha256};

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
    let mut file = open_no_symlink_existing_project_file(project_root, &relative)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(ProjectError::service(
            "not_found",
            format!("Project path is not a file: {relative}"),
        ));
    }
    let revision = project_media_revision(&mut file)?;
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
        project_relative_path: relative.to_string(),
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

/// Computes the exact Project media revision by streaming one already-open file.
///
/// # Errors
/// Returns an error when the file cannot be read or its original position cannot be restored.
pub(crate) fn project_media_revision(file: &mut fs::File) -> Result<String, ProjectError> {
    let original_position = file.stream_position()?;
    file.seek(SeekFrom::Start(0))?;
    let revision = (|| {
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok::<_, ProjectError>(format!("sha256:{:x}", hasher.finalize()))
    })();
    let restore = file.seek(SeekFrom::Start(original_position));
    match (revision, restore) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
        (Ok(revision), Ok(_)) => Ok(revision),
    }
}

struct ProjectContentType {
    extensions: &'static [&'static str],
    content_types: &'static [&'static str],
    canvas_media_kind: CanvasMediaKind,
}

const fn content_type(
    extensions: &'static [&'static str],
    content_types: &'static [&'static str],
    canvas_media_kind: CanvasMediaKind,
) -> ProjectContentType {
    ProjectContentType {
        extensions,
        content_types,
        canvas_media_kind,
    }
}

const PROJECT_CONTENT_TYPES: &[ProjectContentType] = &[
    content_type(
        &["html"],
        &["text/html; charset=utf-8"],
        CanvasMediaKind::Unknown,
    ),
    content_type(
        &["js", "mjs"],
        &["text/javascript; charset=utf-8"],
        CanvasMediaKind::Unknown,
    ),
    content_type(
        &["css"],
        &["text/css; charset=utf-8"],
        CanvasMediaKind::Unknown,
    ),
    content_type(
        &["json"],
        &["application/json; charset=utf-8"],
        CanvasMediaKind::Unknown,
    ),
    content_type(&["png"], &["image/png"], CanvasMediaKind::Image),
    content_type(
        &["jpg", "jpeg", "jpe", "jfif"],
        &["image/jpeg"],
        CanvasMediaKind::Image,
    ),
    content_type(&["gif"], &["image/gif"], CanvasMediaKind::Image),
    content_type(&["webp"], &["image/webp"], CanvasMediaKind::Image),
    content_type(&["avif"], &["image/avif"], CanvasMediaKind::Image),
    content_type(&["tif", "tiff"], &["image/tiff"], CanvasMediaKind::Image),
    content_type(&["svg", "svgz"], &["image/svg+xml"], CanvasMediaKind::Image),
    content_type(&["mp4"], &["video/mp4"], CanvasMediaKind::Video),
    content_type(&["webm"], &["video/webm"], CanvasMediaKind::Video),
    content_type(&["mov"], &["video/quicktime"], CanvasMediaKind::Video),
    content_type(&["m4v"], &["video/x-m4v"], CanvasMediaKind::Video),
    content_type(&["mp3"], &["audio/mpeg"], CanvasMediaKind::Audio),
    content_type(
        &["wav", "wave"],
        &["audio/wav", "audio/x-wav"],
        CanvasMediaKind::Audio,
    ),
    content_type(
        &["ogg", "oga", "opus"],
        &["audio/ogg"],
        CanvasMediaKind::Audio,
    ),
    content_type(
        &["m4a", "aac"],
        &["audio/mp4", "audio/aac"],
        CanvasMediaKind::Audio,
    ),
    content_type(&["flac"], &["audio/flac"], CanvasMediaKind::Audio),
    content_type(&["weba"], &["audio/webm"], CanvasMediaKind::Audio),
    content_type(
        &["vtt"],
        &["text/vtt; charset=utf-8"],
        CanvasMediaKind::Unknown,
    ),
];

#[must_use]
pub fn project_content_type(path: &str) -> &'static str {
    let extension = Path::new(path).extension().and_then(|value| value.to_str());
    extension
        .and_then(|extension| {
            PROJECT_CONTENT_TYPES.iter().find(|entry| {
                entry
                    .extensions
                    .iter()
                    .any(|candidate| extension.eq_ignore_ascii_case(candidate))
            })
        })
        .map_or("application/octet-stream", |entry| entry.content_types[0])
}

#[must_use]
pub fn project_media_kind_from_content_type(content_type: &str) -> CanvasMediaKind {
    let content_type = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim();
    PROJECT_CONTENT_TYPES
        .iter()
        .find(|entry| {
            entry.content_types.iter().any(|candidate| {
                candidate
                    .split(';')
                    .next()
                    .unwrap_or(candidate)
                    .trim()
                    .eq_ignore_ascii_case(content_type)
            })
        })
        .map_or(CanvasMediaKind::Unknown, |entry| entry.canvas_media_kind)
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Seek as _};

    use uuid::Uuid;

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

    #[test]
    fn media_revision_hashes_content_and_restores_the_open_file_position() {
        let root = std::env::temp_dir().join(format!("debrute-media-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let first_path = root.join("first.bin");
        let second_path = root.join("second.bin");
        fs::write(&first_path, b"aaaa").unwrap();
        fs::write(&second_path, b"bbbb").unwrap();
        let mut first = fs::File::open(first_path).unwrap();
        let mut second = fs::File::open(second_path).unwrap();
        first.seek(SeekFrom::Start(2)).unwrap();

        let first_revision = project_media_revision(&mut first).unwrap();
        let second_revision = project_media_revision(&mut second).unwrap();

        assert_ne!(first_revision, second_revision);
        assert!(first_revision.starts_with("sha256:"));
        assert_eq!(first.stream_position().unwrap(), 2);
        fs::remove_dir_all(root).unwrap();
    }
}
