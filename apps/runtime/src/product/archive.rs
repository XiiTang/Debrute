use std::{
    collections::HashSet,
    error::Error,
    fmt, fs,
    io::{self, Read as _, Write as _},
    path::{Component, Path, PathBuf},
};

use uuid::Uuid;
use zip::ZipArchive;

use super::{ReleaseAssetKind, StagedProductArchive};

const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_UNCOMPRESSED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Expands a signed Product archive into a fresh, plain directory. The caller
/// still has to pass that directory through [`super::ProductStore`] validation
/// before it can become a version.
///
/// # Errors
///
/// Returns [`ProductArchiveError`] for malformed ZIP data, path traversal,
/// links/devices, duplicate paths, size limits, or filesystem failures.
pub fn extract_product_archive(
    archive: &StagedProductArchive,
    destination_parent: &Path,
) -> Result<PathBuf, ProductArchiveError> {
    if archive.release_asset().kind() != ReleaseAssetKind::Product {
        return Err(ProductArchiveError::WrongAssetKind);
    }
    fs::create_dir_all(destination_parent)?;
    let destination = destination_parent.join(format!(".product-seed-{}", Uuid::new_v4()));
    fs::create_dir(&destination)?;
    let result = extract_into(archive.path(), &destination).map(|()| destination.clone());
    if result.is_err() {
        let _ = fs::remove_dir_all(&destination);
    }
    result
}

fn extract_into(archive_path: &Path, destination: &Path) -> Result<(), ProductArchiveError> {
    let file = fs::File::open(archive_path)?;
    let mut archive = ZipArchive::new(file).map_err(ProductArchiveError::Zip)?;
    if archive.is_empty() || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(ProductArchiveError::InvalidEntryCount(archive.len()));
    }
    let mut paths = HashSet::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(ProductArchiveError::Zip)?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| ProductArchiveError::InvalidPath(entry.name().to_owned()))?
            .clone();
        validate_relative_path(&relative, entry.name())?;
        if !paths.insert(relative.clone()) {
            return Err(ProductArchiveError::DuplicatePath(relative));
        }
        if entry.unix_mode().is_some_and(is_unsupported_unix_mode) {
            return Err(ProductArchiveError::UnsupportedEntry(relative));
        }
        total = total
            .checked_add(entry.size())
            .ok_or(ProductArchiveError::ExpandedSizeExceeded)?;
        if total > MAX_UNCOMPRESSED_BYTES {
            return Err(ProductArchiveError::ExpandedSizeExceeded);
        }
        let output = destination.join(&relative);
        if entry.is_dir() {
            fs::create_dir(&output).or_else(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists && output.is_dir() {
                    Ok(())
                } else {
                    Err(error)
                }
            })?;
            continue;
        }
        let parent = output
            .parent()
            .ok_or_else(|| ProductArchiveError::InvalidPath(entry.name().to_owned()))?;
        fs::create_dir_all(parent)?;
        let mut destination_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)?;
        let expected_size = entry.size();
        let mut limited = entry.take(MAX_UNCOMPRESSED_BYTES + 1);
        let copied = io::copy(&mut limited, &mut destination_file)?;
        if copied != expected_size {
            return Err(ProductArchiveError::EntrySizeMismatch(relative));
        }
        destination_file.flush()?;
        destination_file.sync_all()?;
    }
    if !destination.join("product-manifest.json").is_file() {
        return Err(ProductArchiveError::ManifestMissing);
    }
    #[cfg(target_os = "macos")]
    set_native_entrypoint_permissions(destination)?;
    Ok(())
}

fn validate_relative_path(path: &Path, original: &str) -> Result<(), ProductArchiveError> {
    if original.contains('\\')
        || original.starts_with('/')
        || path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ProductArchiveError::InvalidPath(original.to_owned()));
    }
    Ok(())
}

fn is_unsupported_unix_mode(mode: u32) -> bool {
    let file_type = mode & 0o170_000;
    file_type != 0 && file_type != 0o040_000 && file_type != 0o100_000
}

#[cfg(target_os = "macos")]
fn set_native_entrypoint_permissions(root: &Path) -> Result<(), ProductArchiveError> {
    use std::os::unix::fs::PermissionsExt as _;
    for relative in [
        "runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime",
        "runtime/debrute",
    ] {
        let path = root.join(relative);
        if path.is_file() {
            let mut permissions = fs::metadata(&path)?.permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions)?;
        }
    }
    Ok(())
}

#[derive(Debug)]
pub enum ProductArchiveError {
    Io(io::Error),
    Zip(zip::result::ZipError),
    WrongAssetKind,
    InvalidEntryCount(usize),
    InvalidPath(String),
    DuplicatePath(PathBuf),
    UnsupportedEntry(PathBuf),
    ExpandedSizeExceeded,
    EntrySizeMismatch(PathBuf),
    ManifestMissing,
}

impl fmt::Display for ProductArchiveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Product archive rejected: {self:?}")
    }
}

impl Error for ProductArchiveError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Zip(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for ProductArchiveError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[cfg(test)]
mod tests {
    use std::{fmt::Write as _, fs, io::Write as _};

    use sha2::{Digest as _, Sha256};
    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::*;
    use crate::product::{
        ReleaseArchitecture, ReleaseAssetKind, ReleasePlatform, TrustedReleaseAsset,
    };

    #[test]
    fn extracts_only_plain_relative_product_entries() {
        let root = std::env::temp_dir().join(format!("debrute-archive-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("product.zip");
        write_zip(
            &archive_path,
            &[
                ("product-manifest.json", "{}"),
                (
                    "runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime",
                    "runtime",
                ),
                ("runtime/debrute", "cli"),
            ],
        );
        let staged = staged_archive(&archive_path);

        let extracted = extract_product_archive(&staged, &root.join("extract")).unwrap();

        assert_eq!(
            fs::read_to_string(
                extracted.join("runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime")
            )
            .unwrap(),
            "runtime"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_archive_path_traversal_and_removes_partial_output() {
        let root = std::env::temp_dir().join(format!("debrute-archive-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("product.zip");
        write_zip(
            &archive_path,
            &[("product-manifest.json", "{}"), ("../escaped", "forbidden")],
        );
        let staged = staged_archive(&archive_path);
        let extract_root = root.join("extract");

        assert!(extract_product_archive(&staged, &extract_root).is_err());
        assert!(!root.join("escaped").exists());
        assert_eq!(fs::read_dir(extract_root).unwrap().count(), 0);
        let _ = fs::remove_dir_all(root);
    }

    fn write_zip(path: &Path, files: &[(&str, &str)]) {
        let file = fs::File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        for (name, contents) in files {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(contents.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    fn staged_archive(path: &Path) -> StagedProductArchive {
        let bytes = fs::read(path).unwrap();
        let sha256 =
            Sha256::digest(&bytes)
                .iter()
                .fold(String::with_capacity(64), |mut output, byte| {
                    write!(output, "{byte:02x}").unwrap();
                    output
                });
        StagedProductArchive::new(
            TrustedReleaseAsset::restore(
                ReleaseAssetKind::Product,
                ReleasePlatform::Macos,
                ReleaseArchitecture::Arm64,
                "debrute-product-0.0.4-macos-arm64.zip".to_owned(),
                "https://github.com/xiitang/debrute/releases/download/v0.0.4/debrute-product-0.0.4-macos-arm64.zip".to_owned(),
                sha256,
                bytes.len() as u64,
            ),
            path.to_owned(),
        )
    }
}
