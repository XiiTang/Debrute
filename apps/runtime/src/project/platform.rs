use std::{io, path::Path};

#[cfg(not(target_os = "windows"))]
use std::fs;

#[cfg(target_os = "windows")]
pub(crate) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    debrute_windows_product_fs::replace_file_atomic(source, destination)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

pub(crate) fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    debrute_native_fs::rename_no_replace(source, destination)
}
