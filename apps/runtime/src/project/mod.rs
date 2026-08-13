//! Filesystem-backed Project, structured-document, Canvas, and revision authority.

mod canvas;
mod canvas_store;
mod error;
mod feedback;
mod files;
mod inspection;
mod media;
mod native_shell;
#[cfg(feature = "native-watcher-probe")]
mod native_watcher_probe;
mod paths;
mod platform;
mod previews;
mod registry;
mod service;
mod tree;
mod types;
mod watcher;

pub use canvas::*;
pub(crate) use canvas_store::*;
pub use error::*;
pub use feedback::*;
pub use files::*;
pub(crate) use inspection::*;
pub use media::*;
pub use native_shell::*;
#[cfg(feature = "native-watcher-probe")]
#[doc(hidden)]
pub use native_watcher_probe::run_native_project_watcher_probe;
pub use paths::*;
pub(crate) use platform::{rename_no_replace, replace_file};
pub use previews::*;
pub use registry::*;
pub use service::{CanvasImagePreviewInfo, DefaultProjectNodeAdapter, ProjectNodeAdapter};
pub(crate) use service::{ProjectService, ProjectSourceLease};
pub(crate) use tree::{ProjectTree, ProjectTreeChange};
pub use types::*;

#[cfg(test)]
mod tests;
