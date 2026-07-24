//! Filesystem-backed Project, structured-document, Canvas, and revision authority.

mod canvas;
mod canvas_map;
mod documents;
mod error;
mod feedback;
mod files;
mod generated_assets;
mod media;
mod native_shell;
mod paths;
mod platform;
mod previews;
mod registry;
mod service;
mod types;
mod watcher;

pub use canvas::*;
pub use canvas_map::*;
pub use documents::*;
pub use error::*;
pub use feedback::*;
pub use files::*;
pub use generated_assets::*;
pub use media::*;
pub use native_shell::*;
pub use paths::*;
pub(crate) use platform::{rename_no_replace, replace_file};
pub use previews::*;
pub use registry::*;
pub(crate) use service::ProjectService;
pub use service::{DefaultProjectNodeAdapter, ProjectNodeAdapter};
pub use types::*;

#[cfg(test)]
mod tests;
