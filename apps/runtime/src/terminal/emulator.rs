//! Bounded authoritative Terminal emulator and observation checkpoints.

use base64::{Engine as _, engine::general_purpose::STANDARD};

use super::protocol::TerminalCheckpoint;

const MAX_TITLE_BYTES: usize = 1024;
const MAX_PENDING_CSI_BYTES: usize = 1024;
const MAX_CHECKPOINT_ANSI_BYTES: usize = 32 * 1024;

#[derive(Default)]
struct TerminalCallbacks {
    title: String,
    device_response: Vec<u8>,
}

impl vt100::Callbacks for TerminalCallbacks {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        let end = title.len().min(MAX_TITLE_BYTES);
        self.title = String::from_utf8_lossy(&title[..end]).into_owned();
    }

    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        intermediate_1: Option<u8>,
        intermediate_2: Option<u8>,
        params: &[&[u16]],
        final_char: char,
    ) {
        if intermediate_1.is_none()
            && intermediate_2.is_none()
            && final_char == 'n'
            && params.len() == 1
            && params[0] == [6]
        {
            let (row, col) = screen.cursor_position();
            self.device_response.extend_from_slice(
                format!("\x1b[{};{}R", row.saturating_add(1), col.saturating_add(1)).as_bytes(),
            );
        }
    }
}

pub(crate) struct ProcessedTerminalOutput {
    pub(crate) sequence: u64,
    pub(crate) observer_bytes: Vec<u8>,
    pub(crate) device_response: Vec<u8>,
}

pub(crate) struct TerminalEmulator {
    terminal_id: String,
    parser: vt100::Parser<TerminalCallbacks>,
    normal_shadow: NormalScreenShadow,
    observer_output: ObserverOutputFilter,
    output_sequence: u64,
}

impl TerminalEmulator {
    pub(crate) fn new(terminal_id: impl Into<String>, rows: u16, cols: u16) -> Self {
        Self {
            terminal_id: terminal_id.into(),
            parser: vt100::Parser::new_with_callbacks(
                rows,
                cols,
                super::TERMINAL_SCROLLBACK_ROWS,
                TerminalCallbacks::default(),
            ),
            normal_shadow: NormalScreenShadow::new(rows, cols),
            observer_output: ObserverOutputFilter::default(),
            output_sequence: 0,
        }
    }

    pub(crate) fn process_output(&mut self, bytes: &[u8]) -> ProcessedTerminalOutput {
        let observer_bytes = self.observer_output.process(bytes);
        self.normal_shadow.process(bytes);
        self.parser.process(bytes);
        self.output_sequence = self
            .output_sequence
            .checked_add(1)
            .expect("Terminal output sequence exhausted");
        let device_response = std::mem::take(&mut self.parser.callbacks_mut().device_response);
        ProcessedTerminalOutput {
            sequence: self.output_sequence,
            observer_bytes,
            device_response,
        }
    }

    pub(crate) fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.screen_mut().set_size(rows, cols);
        self.normal_shadow.parser.screen_mut().set_size(rows, cols);
    }

    pub(crate) fn title(&self, fallback: &str) -> String {
        if self.parser.callbacks().title.is_empty() {
            fallback.to_owned()
        } else {
            self.parser.callbacks().title.clone()
        }
    }

    pub(crate) fn checkpoint(
        &mut self,
        fallback_title: &str,
    ) -> Result<TerminalCheckpoint, &'static str> {
        let alternate_screen = self.parser.screen().alternate_screen();
        let (ansi, scrollback_rows) = if alternate_screen {
            let mut alternate = b"\x1b[?1049h\x1b[0m\x1b[2J\x1b[H".to_vec();
            alternate.extend_from_slice(&self.parser.screen().state_formatted());
            ansi_reconstruction(self.normal_shadow.parser.screen_mut(), &alternate)?
        } else {
            ansi_reconstruction(self.parser.screen_mut(), &[])?
        };
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let (cursor_row, cursor_col) = screen.cursor_position();
        let title = self.title(fallback_title);
        Ok(TerminalCheckpoint {
            terminal_id: self.terminal_id.clone(),
            output_sequence: self.output_sequence,
            cols,
            rows,
            scrollback_rows: u32::try_from(scrollback_rows)
                .expect("Terminal scrollback cannot exceed its configured row bound"),
            cursor_row,
            cursor_col,
            cursor_hidden: screen.hide_cursor(),
            alternate_screen,
            application_cursor: screen.application_cursor(),
            application_keypad: screen.application_keypad(),
            bracketed_paste: screen.bracketed_paste(),
            title,
            ansi_base64: STANDARD.encode(ansi),
        })
    }
}

struct ObserverOutputFilter {
    escape: EscapeState,
}

impl Default for ObserverOutputFilter {
    fn default() -> Self {
        Self {
            escape: EscapeState::Ground,
        }
    }
}

impl ObserverOutputFilter {
    fn process(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(bytes.len());
        for &byte in bytes {
            let state = std::mem::replace(&mut self.escape, EscapeState::Ground);
            match state {
                EscapeState::Ground if byte == 0x1b => self.escape = EscapeState::Escape,
                EscapeState::Ground => output.push(byte),
                EscapeState::Escape if byte == b'[' => {
                    self.escape = EscapeState::Csi(vec![0x1b, b'[']);
                }
                EscapeState::Escape => output.extend_from_slice(&[0x1b, byte]),
                EscapeState::Csi(mut sequence) => {
                    sequence.push(byte);
                    if sequence.len() > MAX_PENDING_CSI_BYTES {
                        output.extend_from_slice(&sequence);
                    } else if (0x40..=0x7e).contains(&byte) {
                        if !is_cursor_position_query(&sequence) {
                            output.extend_from_slice(&sequence);
                        }
                    } else {
                        self.escape = EscapeState::Csi(sequence);
                    }
                }
            }
        }
        output
    }
}

fn is_cursor_position_query(sequence: &[u8]) -> bool {
    if !sequence.starts_with(b"\x1b[") || sequence.last() != Some(&b'n') {
        return false;
    }
    std::str::from_utf8(&sequence[2..sequence.len() - 1])
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        == Some(6)
}

fn ansi_reconstruction(
    screen: &mut vt100::Screen,
    trailing: &[u8],
) -> Result<(Vec<u8>, usize), &'static str> {
    let (_, cols) = screen.size();
    let mut tail = b"\x1b[0m\x1b[2J\x1b[H".to_vec();
    tail.extend_from_slice(&screen.state_formatted());
    tail.extend_from_slice(trailing);
    if tail.len() + 2 > MAX_CHECKPOINT_ANSI_BYTES {
        screen.set_scrollback(0);
        return Err("Terminal visible state exceeds the checkpoint byte budget.");
    }
    screen.set_scrollback(usize::MAX);
    let scrollback_rows = screen.scrollback();
    let mut recent_rows = Vec::new();
    let mut used = tail.len() + 2;
    for offset in 1..=scrollback_rows {
        screen.set_scrollback(offset);
        if let Some(row) = screen.rows_formatted(0, cols).next() {
            let newline = usize::from(!screen.row_wrapped(0)) * 2;
            if used + row.len() + newline > MAX_CHECKPOINT_ANSI_BYTES {
                break;
            }
            used += row.len() + newline;
            recent_rows.push((row, newline != 0));
        }
    }
    screen.set_scrollback(0);
    let retained_rows = recent_rows.len();
    let mut ansi = b"\x1bc".to_vec();
    for (row, newline) in recent_rows.into_iter().rev() {
        ansi.extend_from_slice(&row);
        if newline {
            ansi.extend_from_slice(b"\r\n");
        }
    }
    ansi.extend_from_slice(&tail);
    Ok((ansi, retained_rows))
}

struct NormalScreenShadow {
    parser: vt100::Parser,
    target: ShadowTarget,
    escape: EscapeState,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ShadowTarget {
    Normal,
    Alternate,
}

enum EscapeState {
    Ground,
    Escape,
    Csi(Vec<u8>),
}

impl NormalScreenShadow {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, super::TERMINAL_SCROLLBACK_ROWS),
            target: ShadowTarget::Normal,
            escape: EscapeState::Ground,
        }
    }

    fn process(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.process_byte(byte);
        }
    }

    fn process_byte(&mut self, byte: u8) {
        let state = std::mem::replace(&mut self.escape, EscapeState::Ground);
        match state {
            EscapeState::Ground if byte == 0x1b => self.escape = EscapeState::Escape,
            EscapeState::Ground => self.forward(&[byte]),
            EscapeState::Escape if byte == b'[' => {
                self.escape = EscapeState::Csi(vec![0x1b, b'[']);
            }
            EscapeState::Escape => {
                self.forward(&[0x1b, byte]);
            }
            EscapeState::Csi(mut sequence) => {
                sequence.push(byte);
                if sequence.len() > MAX_PENDING_CSI_BYTES {
                    self.forward(&sequence);
                } else if (0x40..=0x7e).contains(&byte) {
                    if let Some(target) = alternate_target(&sequence) {
                        self.target = target;
                    } else {
                        self.forward(&sequence);
                    }
                } else {
                    self.escape = EscapeState::Csi(sequence);
                }
            }
        }
    }

    fn forward(&mut self, bytes: &[u8]) {
        if self.target == ShadowTarget::Normal {
            self.parser.process(bytes);
        }
    }
}

fn alternate_target(sequence: &[u8]) -> Option<ShadowTarget> {
    if sequence.len() < 5 || !sequence.starts_with(b"\x1b[?") {
        return None;
    }
    let final_byte = *sequence.last()?;
    if final_byte != b'h' && final_byte != b'l' {
        return None;
    }
    let parameters = std::str::from_utf8(&sequence[3..sequence.len() - 1]).ok()?;
    let changes_alternate = parameters
        .split(';')
        .any(|value| matches!(value, "47" | "1047" | "1049"));
    if !changes_alternate {
        return None;
    }
    Some(if final_byte == b'h' {
        ShadowTarget::Alternate
    } else {
        ShadowTarget::Normal
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replay(checkpoint: &TerminalCheckpoint) -> vt100::Parser {
        let mut parser = vt100::Parser::new(
            checkpoint.rows,
            checkpoint.cols,
            super::super::TERMINAL_SCROLLBACK_ROWS,
        );
        parser.process(
            &STANDARD
                .decode(&checkpoint.ansi_base64)
                .expect("checkpoint should decode"),
        );
        parser
    }

    #[test]
    fn checkpoint_rebuilds_bounded_screen_and_modes() {
        let mut emulator = TerminalEmulator::new("terminal-1", 2, 12);
        emulator.process_output(b"one\r\ntwo\r\nthree\x1b[?2004h");
        let checkpoint = emulator.checkpoint("Terminal").unwrap();
        let rebuilt = replay(&checkpoint);
        assert_eq!(
            rebuilt.screen().contents(),
            emulator.parser.screen().contents()
        );
        assert!(rebuilt.screen().bracketed_paste());
        assert!(checkpoint.scrollback_rows >= 1);
        assert_eq!(checkpoint.output_sequence, 1);
        assert!(
            serde_json::to_value(&checkpoint)
                .expect("checkpoint should serialize")
                .get("version")
                .is_none()
        );
    }

    #[test]
    #[should_panic(expected = "Terminal output sequence exhausted")]
    fn output_sequence_exhaustion_fails_fast() {
        let mut emulator = TerminalEmulator::new("terminal-1", 2, 12);
        emulator.output_sequence = u64::MAX;
        emulator.process_output(b"final output");
    }

    #[test]
    fn alternate_checkpoint_preserves_the_hidden_normal_screen() {
        let mut emulator = TerminalEmulator::new("terminal-1", 2, 12);
        emulator.process_output(b"normal\r\nstate\x1b[?1049halt-screen");
        let checkpoint = emulator.checkpoint("Terminal").unwrap();
        assert!(checkpoint.alternate_screen);
        let mut rebuilt = replay(&checkpoint);
        assert!(rebuilt.screen().alternate_screen());
        assert!(rebuilt.screen().contents().contains("alt-screen"));

        rebuilt.process(b"\x1b[?1049l");
        emulator.process_output(b"\x1b[?1049l");
        assert_eq!(
            rebuilt.screen().contents(),
            emulator.parser.screen().contents()
        );
        assert!(rebuilt.screen().contents().contains("normal"));
    }

    #[test]
    fn window_title_is_bounded_and_carried_separately() {
        let mut emulator = TerminalEmulator::new("terminal-1", 2, 12);
        emulator.process_output(b"\x1b]2;Debrute Shell\x07");
        assert_eq!(
            emulator.checkpoint("fallback").unwrap().title,
            "Debrute Shell"
        );
    }

    #[test]
    fn cursor_position_queries_are_answered_once_by_the_runtime() {
        let mut emulator = TerminalEmulator::new("terminal-1", 24, 80);
        let processed = emulator.process_output(b"abc\x1b[6nvisible\x1b[6n");

        assert_eq!(processed.sequence, 1);
        assert_eq!(processed.observer_bytes, b"abcvisible");
        assert_eq!(processed.device_response, b"\x1b[1;4R\x1b[1;11R");
        assert_eq!(emulator.parser.screen().contents(), "abcvisible");
    }

    #[test]
    fn cursor_position_queries_survive_output_chunk_boundaries() {
        let mut emulator = TerminalEmulator::new("terminal-1", 24, 80);
        let first = emulator.process_output(b"abc\x1b[");
        let second = emulator.process_output(b"6nvisible");

        assert_eq!(first.observer_bytes, b"abc");
        assert!(first.device_response.is_empty());
        assert_eq!(second.observer_bytes, b"visible");
        assert_eq!(second.device_response, b"\x1b[1;4R");
    }

    #[test]
    fn checkpoint_retains_recent_scrollback_within_the_wire_budget() {
        let mut emulator = TerminalEmulator::new("terminal-1", 4, 80);
        for line in 0..5_000 {
            emulator.process_output(format!("line-{line:04}-{}\r\n", "x".repeat(64)).as_bytes());
        }

        let checkpoint = emulator.checkpoint("Terminal").unwrap();
        let ansi = STANDARD.decode(&checkpoint.ansi_base64).unwrap();
        assert!(ansi.len() <= MAX_CHECKPOINT_ANSI_BYTES);
        assert!(
            checkpoint.scrollback_rows
                <= u32::try_from(super::super::TERMINAL_SCROLLBACK_ROWS).unwrap()
        );
        assert!(String::from_utf8_lossy(&ansi).contains("line-4999"));
    }
}
