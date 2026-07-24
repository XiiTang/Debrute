//! Closed, versioned Project Terminal hub protocol values.

use serde::{Deserialize, Serialize};

pub const TERMINAL_PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalSessionStatus {
    Starting,
    Running,
    Terminating,
    Exited,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSessionView {
    pub id: String,
    pub title: String,
    pub cwd_project_relative_path: String,
    pub cols: u16,
    pub rows: u16,
    pub status: TerminalSessionStatus,
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(clippy::struct_excessive_bools)] // Independent terminal modes are explicit wire fields.
pub struct TerminalCheckpoint {
    pub version: u16,
    pub terminal_id: String,
    pub output_sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub scrollback_rows: u32,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_hidden: bool,
    pub alternate_screen: bool,
    pub application_cursor: bool,
    pub application_keypad: bool,
    pub bracketed_paste: bool,
    pub title: String,
    /// A self-contained ANSI reconstruction program encoded as standard base64.
    pub ansi_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TerminalClientFrame {
    Bind {
        protocol_version: u16,
        connection_credential: String,
    },
    Observe {
        terminal_id: String,
    },
    Unobserve {
        terminal_id: String,
    },
    Input {
        terminal_id: String,
        sequence: u64,
        data: String,
    },
    Resize {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TerminalServerFrame {
    Sync {
        protocol_version: u16,
        topology_revision: u64,
        sessions: Vec<TerminalSessionView>,
        checkpoints: Vec<TerminalCheckpoint>,
    },
    Observed {
        checkpoint: TerminalCheckpoint,
    },
    InputAck {
        terminal_id: String,
        sequence: u64,
    },
    Resized {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    Topology {
        topology_revision: u64,
        sessions: Vec<TerminalSessionView>,
    },
    Output {
        terminal_id: String,
        sequence: u64,
        data_base64: String,
    },
    Status {
        session: TerminalSessionView,
    },
    Exit {
        terminal_id: String,
        exit_code: Option<u32>,
        signal: Option<String>,
    },
    Error {
        terminal_id: Option<String>,
        code: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_frames_use_one_closed_versioned_json_vocabulary() {
        let frame = TerminalClientFrame::Input {
            terminal_id: "terminal-1".to_owned(),
            sequence: 7,
            data: "hello".to_owned(),
        };
        let json = serde_json::to_string(&frame).expect("frame should serialize");
        assert_eq!(
            json,
            r#"{"type":"input","terminalId":"terminal-1","sequence":7,"data":"hello"}"#
        );
        assert_eq!(
            serde_json::from_str::<TerminalClientFrame>(&json).expect("frame should parse"),
            frame
        );
        assert!(serde_json::from_str::<TerminalClientFrame>(r#"{"type":"command"}"#).is_err());
        assert!(
            serde_json::from_str::<TerminalClientFrame>(
                r#"{"type":"input","terminalId":"terminal-1","sequence":7,"data":"hello","extra":true}"#,
            )
            .is_err()
        );
    }
}
