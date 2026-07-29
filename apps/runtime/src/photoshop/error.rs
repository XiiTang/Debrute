use std::{error::Error, fmt, io};

use crate::project::ProjectError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhotoshopErrorCode {
    Unavailable,
    SessionInvalid,
    Busy,
    DocumentClosed,
    ProjectOffline,
    ProjectRevisionChanged,
    TargetDirectoryMissing,
    TargetDirectoryNotVisible,
    UnsupportedFileType,
    FileTooLarge,
    InvalidTransferPayload,
    PlaceFailed,
    ExportFailed,
    ProtocolInvalid,
}

impl PhotoshopErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "photoshop_unavailable",
            Self::SessionInvalid => "photoshop_session_invalid",
            Self::Busy => "photoshop_busy",
            Self::DocumentClosed => "photoshop_document_closed",
            Self::ProjectOffline => "project_offline",
            Self::ProjectRevisionChanged => "project_revision_changed",
            Self::TargetDirectoryMissing => "target_directory_missing",
            Self::TargetDirectoryNotVisible => "target_directory_not_visible",
            Self::UnsupportedFileType => "unsupported_file_type",
            Self::FileTooLarge => "file_too_large",
            Self::InvalidTransferPayload => "invalid_transfer_payload",
            Self::PlaceFailed => "photoshop_place_failed",
            Self::ExportFailed => "photoshop_export_failed",
            Self::ProtocolInvalid => "photoshop_protocol_invalid",
        }
    }
}

#[derive(Debug)]
pub struct PhotoshopError {
    code: PhotoshopErrorCode,
    message: &'static str,
}

impl PhotoshopError {
    #[must_use]
    pub const fn new(code: PhotoshopErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }

    #[must_use]
    pub const fn code(&self) -> PhotoshopErrorCode {
        self.code
    }
}

impl fmt::Display for PhotoshopError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for PhotoshopError {}

impl From<ProjectError> for PhotoshopError {
    fn from(error: ProjectError) -> Self {
        let (code, message) = match error.code() {
            "project_not_open" | "project_not_found" => (
                PhotoshopErrorCode::ProjectOffline,
                "The selected Debrute Project is no longer open.",
            ),
            "project_revision_changed" => (
                PhotoshopErrorCode::ProjectRevisionChanged,
                "Debrute Project revision changed.",
            ),
            _ => (
                PhotoshopErrorCode::InvalidTransferPayload,
                "Debrute could not complete the Photoshop Project operation.",
            ),
        };
        eprintln!("Debrute Photoshop Project operation failed: {error}");
        Self::new(code, message)
    }
}

impl From<io::Error> for PhotoshopError {
    fn from(error: io::Error) -> Self {
        eprintln!("Debrute Photoshop file operation failed: {error}");
        Self::new(
            PhotoshopErrorCode::InvalidTransferPayload,
            "Photoshop transfer file operation failed.",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_errors_keep_absolute_paths_out_of_the_photoshop_message() {
        let private_path = r"C:\Users\developer\AppData\Local\Temp\debrute-export.png";
        let error = PhotoshopError::from(ProjectError::ProjectNotFound(private_path.to_owned()));

        assert_eq!(error.code(), PhotoshopErrorCode::ProjectOffline);
        assert_eq!(
            error.to_string(),
            "The selected Debrute Project is no longer open."
        );
        assert!(!error.to_string().contains(private_path));
    }

    #[test]
    fn io_errors_keep_absolute_paths_out_of_the_photoshop_message() {
        let private_path = r"C:\Users\developer\AppData\Local\Temp\debrute-export.png";
        let error = PhotoshopError::from(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("could not write {private_path}"),
        ));

        assert_eq!(error.code(), PhotoshopErrorCode::InvalidTransferPayload);
        assert_eq!(
            error.to_string(),
            "Photoshop transfer file operation failed."
        );
        assert!(!error.to_string().contains(private_path));
    }
}
