//! Project-scoped, memory-only PTY Terminal authority.

mod emulator;
pub mod protocol;
mod service;

pub use protocol::*;
pub use service::*;

const TERMINAL_SCROLLBACK_ROWS: usize = 1_000;
