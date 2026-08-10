use std::{ffi::OsStr, fmt, ops::Deref, path::Path};

use super::super::ProjectError;

/// Validated, non-empty, portable Project-relative path.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectRelativePath(ProjectDirectoryPath);

/// Validated, portable Project-relative directory path. The empty value names
/// the Project root.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectDirectoryPath(String);

impl ProjectRelativePath {
    /// Parses the current closed Project path contract.
    ///
    /// # Errors
    /// Returns an error for absolute, empty, traversal, non-portable, or
    /// separator-invalid input.
    pub fn parse(path: &str) -> Result<Self, ProjectError> {
        validate_project_path(path, false)?;
        Ok(Self(ProjectDirectoryPath(path.to_owned())))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0.into_string()
    }

    #[must_use]
    pub fn parent(&self) -> ProjectDirectoryPath {
        self.0.parent()
    }

    #[must_use]
    pub fn as_directory_path(&self) -> &ProjectDirectoryPath {
        &self.0
    }

    /// Replaces the final segment with one validated Project basename.
    ///
    /// # Errors
    /// Returns an error when `name` is not a portable basename.
    pub fn with_name(&self, name: &str) -> Result<Self, ProjectError> {
        self.parent().join_name(name)
    }
}

impl ProjectDirectoryPath {
    /// Parses the current closed Project directory path contract.
    ///
    /// # Errors
    /// Returns an error for absolute, traversal, non-portable, or
    /// separator-invalid input.
    pub fn parse(path: &str) -> Result<Self, ProjectError> {
        validate_project_path(path, true)?;
        Ok(Self(path.to_owned()))
    }

    #[must_use]
    pub fn root() -> Self {
        Self(String::new())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }

    #[must_use]
    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub fn parent(&self) -> Self {
        Self(
            self.0
                .rsplit_once('/')
                .map_or_else(String::new, |(parent, _)| parent.to_owned()),
        )
    }

    /// Appends one validated basename and returns a non-empty Project path.
    ///
    /// # Errors
    /// Returns an error when `name` is not a portable basename.
    pub fn join_name(&self, name: &str) -> Result<ProjectRelativePath, ProjectError> {
        let name = super::normalize_project_path_basename(name)?;
        ProjectRelativePath::parse(&if self.is_root() {
            name
        } else {
            format!("{self}/{name}")
        })
    }
}

impl AsRef<str> for ProjectRelativePath {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl AsRef<str> for ProjectDirectoryPath {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl AsRef<Path> for ProjectRelativePath {
    fn as_ref(&self) -> &Path {
        Path::new(self.as_str())
    }
}

impl AsRef<Path> for ProjectDirectoryPath {
    fn as_ref(&self) -> &Path {
        Path::new(self.as_str())
    }
}

impl AsRef<OsStr> for ProjectRelativePath {
    fn as_ref(&self) -> &OsStr {
        OsStr::new(self.as_str())
    }
}

impl AsRef<OsStr> for ProjectDirectoryPath {
    fn as_ref(&self) -> &OsStr {
        OsStr::new(self.as_str())
    }
}

impl PartialEq<str> for ProjectRelativePath {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<&str> for ProjectRelativePath {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl PartialEq<str> for ProjectDirectoryPath {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<&str> for ProjectDirectoryPath {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl Deref for ProjectRelativePath {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl Deref for ProjectDirectoryPath {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl fmt::Display for ProjectRelativePath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl fmt::Display for ProjectDirectoryPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

pub(super) fn validate_portable_path_segment(segment: &str) -> Result<(), ProjectError> {
    if segment.chars().any(|character| {
        character == '\0'
            || character.is_control()
            || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
    }) || segment.ends_with(['.', ' '])
    {
        return Err(ProjectError::Validation(format!(
            "Project path segment is not portable across macOS and Windows: {segment:?}"
        )));
    }
    if debrute_native_fs::is_windows_reserved_device_component(segment) {
        return Err(ProjectError::Validation(format!(
            "Project path segment is a reserved Windows device name: {segment}"
        )));
    }
    Ok(())
}

fn validate_project_path(path: &str, allow_empty: bool) -> Result<(), ProjectError> {
    if path.starts_with('/') || super::is_windows_absolute(path) {
        return Err(ProjectError::Validation(format!(
            "Project path must be relative: {path}"
        )));
    }
    if path.contains('\\') {
        return Err(ProjectError::Validation(format!(
            "Project path must not contain backslashes: {path}"
        )));
    }
    if path.is_empty() {
        return allow_empty
            .then_some(())
            .ok_or_else(|| ProjectError::Validation("Project path must be non-empty.".to_owned()));
    }
    for segment in path.split('/') {
        if segment.is_empty() || matches!(segment, "." | "..") {
            return Err(ProjectError::Validation(format!(
                "Project path must not contain empty, \".\", or \"..\" segments: {path}"
            )));
        }
        validate_portable_path_segment(segment)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_path_is_non_empty_and_portable() {
        assert_eq!(
            ProjectRelativePath::parse("media/片段.png")
                .unwrap()
                .as_str(),
            "media/片段.png"
        );
        for invalid in [
            "",
            "/absolute",
            r"C:\absolute",
            r"media\file.png",
            "media//file.png",
            "media/../file.png",
            "media/CON.txt",
            "media/CON .txt",
            "media/LPT³.log",
            "media/trailing. ",
        ] {
            assert!(ProjectRelativePath::parse(invalid).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn directory_path_alone_admits_the_project_root() {
        assert!(ProjectDirectoryPath::parse("").unwrap().is_root());
        assert_eq!(
            ProjectDirectoryPath::parse("media/stills")
                .unwrap()
                .as_str(),
            "media/stills"
        );
        assert_eq!(
            ProjectRelativePath::parse("media/stills/frame.png")
                .unwrap()
                .parent()
                .as_str(),
            "media/stills"
        );
    }
}
