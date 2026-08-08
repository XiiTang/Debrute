use std::{io, path::Path};

pub(crate) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    debrute_native_fs::replace_file_atomic(source, destination)
}

pub(crate) fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    debrute_native_fs::rename_no_replace(source, destination)
}
