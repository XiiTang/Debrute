use std::{collections::BTreeMap, error::Error, fmt, io};

#[derive(Debug)]
pub enum ProjectError {
    Io(io::Error),
    Json(serde_json::Error),
    Yaml(serde_yaml::Error),
    Validation(String),
    Service(ProjectServiceError),
    RegistryClosed,
    ProjectNotFound(String),
    ProjectNotOpen(String),
    RevisionExhausted,
    StatePoisoned,
}

#[derive(Debug)]
/// Opaque detail for a closed Runtime-defined Project service error.
///
/// Callers inspect it through [`ProjectError::code`] and [`ProjectError::field`];
/// only the Project runtime can construct new service error codes.
pub struct ProjectServiceError {
    code: &'static str,
    message: String,
    fields: BTreeMap<String, String>,
}

impl ProjectError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Service(error) => error.code,
            Self::RegistryClosed => "project_registry_closed",
            Self::ProjectNotFound(_) => "project_not_found",
            Self::ProjectNotOpen(_) => "project_not_open",
            Self::RevisionExhausted => "project_revision_exhausted",
            Self::StatePoisoned => "project_state_poisoned",
            Self::Io(_) | Self::Json(_) | Self::Yaml(_) | Self::Validation(_) => "project_invalid",
        }
    }

    #[must_use]
    pub(crate) fn service(code: &'static str, message: impl Into<String>) -> Self {
        Self::Service(ProjectServiceError {
            code,
            message: message.into(),
            fields: BTreeMap::new(),
        })
    }

    #[must_use]
    pub(crate) fn service_with_fields(
        code: &'static str,
        message: impl Into<String>,
        fields: impl IntoIterator<Item = (String, String)>,
    ) -> Self {
        Self::Service(ProjectServiceError {
            code,
            message: message.into(),
            fields: fields.into_iter().collect(),
        })
    }

    #[must_use]
    pub fn field(&self, name: &str) -> Option<&str> {
        match self {
            Self::Service(error) => error.fields.get(name).map(String::as_str),
            _ => None,
        }
    }

    #[must_use]
    pub(crate) fn leaves_mutation_outcome_uncertain(&self) -> bool {
        matches!(
            self.code(),
            "project_file_operation_rollback_failed"
                | "document_push_rollback_failed"
                | "native_shell_trash_quarantined"
                | "native_shell_trash_not_consumed"
        )
    }
}

impl fmt::Display for ProjectError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Json(error) => error.fmt(formatter),
            Self::Yaml(error) => error.fmt(formatter),
            Self::Validation(message) => formatter.write_str(message),
            Self::Service(error) => formatter.write_str(&error.message),
            Self::RegistryClosed => formatter.write_str("Debrute Project registry is closed."),
            Self::ProjectNotFound(root) => {
                write!(formatter, "Debrute Project root does not exist: {root}")
            }
            Self::ProjectNotOpen(project_id) => {
                write!(formatter, "Debrute Project is not open: {project_id}")
            }
            Self::RevisionExhausted => formatter.write_str("Project revision is exhausted."),
            Self::StatePoisoned => formatter.write_str("Project state lock is poisoned."),
        }
    }
}

impl Error for ProjectError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::Yaml(error) => Some(error),
            Self::Validation(_)
            | Self::Service(_)
            | Self::RegistryClosed
            | Self::ProjectNotFound(_)
            | Self::ProjectNotOpen(_)
            | Self::RevisionExhausted
            | Self::StatePoisoned => None,
        }
    }
}

impl From<io::Error> for ProjectError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for ProjectError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<serde_yaml::Error> for ProjectError {
    fn from(error: serde_yaml::Error) -> Self {
        Self::Yaml(error)
    }
}
