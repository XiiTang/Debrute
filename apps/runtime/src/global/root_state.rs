use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

#[must_use]
pub(crate) fn canonical_root_key(canonical_root: &str) -> String {
    format!("{:x}", Sha256::digest(canonical_root.as_bytes()))
}

#[must_use]
pub(crate) fn root_state_directory(debrute_home: &Path, canonical_root: &str) -> PathBuf {
    debrute_home
        .join("state/roots")
        .join(canonical_root_key(canonical_root))
}

#[must_use]
pub(crate) fn root_cache_directory(debrute_home: &Path, canonical_root: &str) -> PathBuf {
    debrute_home
        .join("cache/roots")
        .join(canonical_root_key(canonical_root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_state_is_bucketed_by_the_canonical_root_bytes() {
        let root = "/projects/campaign";
        let expected = format!("{:x}", Sha256::digest(b"/projects/campaign"));
        assert_eq!(canonical_root_key(root), expected);
        assert_eq!(
            root_state_directory(Path::new("/home/.debrute"), root),
            Path::new("/home/.debrute/state/roots").join(expected)
        );
    }
}
