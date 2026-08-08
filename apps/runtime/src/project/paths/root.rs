use std::{
    borrow::Borrow,
    fmt,
    hash::{Hash, Hasher},
    ops::Deref,
    path::{Path, PathBuf},
    sync::Arc,
};

use super::super::ProjectError;

/// Existing canonical Project directory admitted as one Runtime identity.
///
/// The filesystem path is retained for identity, containment, and native I/O.
/// The UTF-8 wire form is derived once for protocol and persisted-state seams.
#[derive(Clone)]
pub struct CanonicalProjectRoot {
    path: PathBuf,
    wire: Arc<str>,
}

impl CanonicalProjectRoot {
    /// Admits one existing Project directory.
    ///
    /// # Errors
    /// Returns a closed Project error for a missing path, non-directory, or a
    /// canonical path that cannot be represented losslessly as UTF-8.
    pub fn open_existing(requested: &Path) -> Result<Self, ProjectError> {
        let path = requested.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ProjectError::ProjectNotFound(requested.to_string_lossy().into_owned())
            } else {
                ProjectError::from(error)
            }
        })?;
        if !path.is_dir() {
            return Err(ProjectError::service(
                "path_not_directory",
                format!("Project root is not a directory: {}", path.display()),
            ));
        }
        let wire = path.to_str().ok_or_else(|| {
            ProjectError::service(
                "project_path_not_utf8",
                "Project root must be representable as UTF-8.",
            )
        })?;
        Ok(Self {
            wire: Arc::from(wire),
            path,
        })
    }

    #[must_use]
    pub fn as_path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn as_wire(&self) -> &str {
        &self.wire
    }

    #[cfg(test)]
    pub(crate) fn detached_for_test(path: &Path) -> Self {
        Self {
            wire: Arc::from(
                path.to_str()
                    .expect("detached test Project roots must be valid UTF-8"),
            ),
            path: path.to_path_buf(),
        }
    }
}

impl AsRef<Path> for CanonicalProjectRoot {
    fn as_ref(&self) -> &Path {
        self.as_path()
    }
}

impl Deref for CanonicalProjectRoot {
    type Target = Path;

    fn deref(&self) -> &Self::Target {
        self.as_path()
    }
}

impl Borrow<Path> for CanonicalProjectRoot {
    fn borrow(&self) -> &Path {
        self.as_path()
    }
}

impl fmt::Debug for CanonicalProjectRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("CanonicalProjectRoot")
            .field(&self.path)
            .finish()
    }
}

impl fmt::Display for CanonicalProjectRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_wire())
    }
}

impl PartialEq for CanonicalProjectRoot {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path
    }
}

impl Eq for CanonicalProjectRoot {}

impl PartialOrd for CanonicalProjectRoot {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for CanonicalProjectRoot {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.path.cmp(&other.path)
    }
}

impl Hash for CanonicalProjectRoot {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.path.hash(state);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::*;

    #[test]
    fn admits_one_existing_directory_as_path_and_wire_identity() {
        let root = std::env::temp_dir().join(format!("debrute-project-root-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        let admitted = CanonicalProjectRoot::open_existing(&root).unwrap();

        assert_eq!(admitted.as_path(), root.canonicalize().unwrap());
        assert_eq!(admitted.as_wire(), admitted.as_path().to_str().unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_missing_and_non_directory_roots() {
        let root = std::env::temp_dir().join(format!("debrute-project-root-{}", Uuid::new_v4()));
        assert_eq!(
            CanonicalProjectRoot::open_existing(&root)
                .unwrap_err()
                .code(),
            "project_not_found"
        );
        fs::write(&root, "fixture").unwrap();
        assert_eq!(
            CanonicalProjectRoot::open_existing(&root)
                .unwrap_err()
                .code(),
            "path_not_directory"
        );
        fs::remove_file(root).unwrap();
    }
}
