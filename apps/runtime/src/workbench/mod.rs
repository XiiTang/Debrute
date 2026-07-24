//! Runtime-owned Workbench launch authority and loopback HTTP origin.

mod authority;
mod connections;
mod http;
mod multipart;
mod project_routes;
mod routes;
mod routing;
mod services;
mod websocket;
mod working_copy;

pub(crate) use authority::{DesktopLaunchBinding, SourceWorkbenchRegistrationError};
pub use authority::{WORKBENCH_SESSION_COOKIE, WorkbenchLaunchError, WorkbenchLaunchService};
pub use connections::WORKBENCH_CONNECTION_HEADER;
pub use connections::WorkbenchConnectionRegistry;
pub(crate) use connections::{
    ProjectBindError, ProjectBindOutcome, ProjectBindingCommit, ProjectBindingLease,
    WorkbenchConnectionContext,
};
pub use http::{WorkbenchHttpServer, WorkbenchHttpServerError};
pub use services::{
    ProductUpdateInitiator, RuntimeCliHttpService, RuntimeCliRecordStream, RuntimeHttpServiceError,
    RuntimeProductHttpService, WorkbenchProjectBindingOutcome, WorkbenchRuntimeServices,
    encode_project_path, public_project_snapshot, public_project_sync,
};
pub(crate) use working_copy::WorkingCopyStore;
pub use working_copy::{
    FeedbackDraftKind, FeedbackDraftLabel, FeedbackDraftScope, FeedbackLocalMode,
    FeedbackWorkingCopy, FeedbackWorkingCopyItem, ProjectWorkingCopies, TextWorkingCopy,
};

pub trait CliAuthorizationVerifier: Send + Sync {
    fn is_cli_authorized(&self, authorization: &str) -> bool;
}
