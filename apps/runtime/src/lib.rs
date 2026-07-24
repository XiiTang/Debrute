//! Debrute's native Runtime process and its narrow native Control Channel.

pub mod cli;
pub mod control;
pub mod generation;
pub mod global;
mod integration_process;
pub mod integrations;
pub mod login;
pub mod model_operation;
pub mod photoshop;
mod process;
pub mod product;
pub mod project;
pub mod terminal;
pub mod workbench;
pub mod workers;

use time::OffsetDateTime;

pub(crate) fn now_rfc3339() -> String {
    let now = OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

#[cfg(test)]
mod tests {
    use time::{OffsetDateTime, format_description::well_known::Rfc3339};

    #[test]
    fn current_timestamp_has_exact_millisecond_precision() {
        let timestamp = super::now_rfc3339();

        assert_eq!(timestamp.len(), 24);
        assert_eq!(timestamp.as_bytes().get(19), Some(&b'.'));
        assert_eq!(timestamp.as_bytes().get(23), Some(&b'Z'));
        OffsetDateTime::parse(&timestamp, &Rfc3339).expect("timestamp should parse as RFC 3339");
    }
}
