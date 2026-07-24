mod batch;
mod model_docs;
mod parser;
mod records;
mod service;
mod spec;

pub use parser::{CliParseError, ParsedCliCommand, parse_cli_args};
pub use records::{agent_record, progress_record};
pub use service::RuntimeCliService;
pub use spec::{CliCommandPolicy, CliCommandSpec, command_errors, command_spec, command_specs};

#[cfg(test)]
mod tests;
