//! Runtime-owned system clipboard text output.

use std::{
    io::{self, Write as _},
    process::{Command, Stdio},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt as _;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Writes one complete text value to the current platform's system clipboard.
///
/// # Errors
/// Returns an I/O error when the platform clipboard command cannot start, accept
/// the complete value, or exits unsuccessfully.
pub fn write_text_to_system_clipboard(text: &str) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let command = Command::new("/usr/bin/pbcopy");
    #[cfg(target_os = "windows")]
    let command = {
        let mut command = Command::new("clip.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };

    write_text_to_command(command, text)
}

fn write_text_to_command(mut command: Command, text: &str) -> io::Result<()> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("clipboard command stdin is unavailable"))?
        .write_all(text.as_bytes())?;
    let status = child.wait()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "clipboard command exited with {status}"
        )))
    }
}
