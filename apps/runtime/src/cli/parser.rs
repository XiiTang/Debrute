use std::{collections::BTreeMap, error::Error, fmt, path::PathBuf};

use super::spec::{CliCommandPolicy, CliCommandSpec, CliOptionKind, command_spec, command_specs};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCliCommand {
    pub command: &'static str,
    pub policy: CliCommandPolicy,
    pub command_path: Vec<String>,
    pub positional: Vec<String>,
    pub options: BTreeMap<String, String>,
    pub project_root: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliParseError {
    code: &'static str,
    message: String,
    command: String,
}

impl CliParseError {
    fn new(code: &'static str, message: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            command: command.into(),
        }
    }

    #[must_use]
    pub const fn code(&self) -> &'static str {
        self.code
    }

    #[must_use]
    pub fn command(&self) -> &str {
        &self.command
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for CliParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for CliParseError {}

/// Parses the exact closed Rust CLI command registry.
///
/// # Errors
/// Returns a typed parse failure for unknown commands/options, missing values,
/// ambiguous forms, or a Project path that cannot be made absolute.
pub fn parse_cli_args(argv: &[String]) -> Result<ParsedCliCommand, CliParseError> {
    let normalized = normalize_help(argv);
    let spec = matching_spec(&normalized).ok_or_else(|| {
        let command = command_name(&normalized);
        CliParseError::new(
            "invalid_command",
            format!("Unknown Debrute CLI command: {command}"),
            command,
        )
    })?;
    let rest = &normalized[spec.path.len()..];
    let (positional, mut options) = parse_values(spec, rest)?;
    validate(spec, &positional, &options)?;
    let project_root = spec
        .project_positional
        .and_then(|index| positional.get(index))
        .map(absolute_path)
        .transpose()?;
    for option in spec.options.iter().filter(|option| option.project_path) {
        if let Some(value) = options.get_mut(option.name) {
            *value = absolute_path(value)?.to_string_lossy().into_owned();
        }
    }
    Ok(ParsedCliCommand {
        command: spec.command,
        policy: spec.policy,
        command_path: spec.path.iter().map(|value| (*value).to_owned()).collect(),
        positional,
        options,
        project_root,
    })
}

fn normalize_help(argv: &[String]) -> Vec<String> {
    if argv.is_empty() || matches!(argv.first().map(String::as_str), Some("--help" | "-h")) {
        return vec!["commands".to_owned()];
    }
    if let Some(index) = argv
        .iter()
        .position(|argument| argument == "--help" || argument == "-h")
    {
        return std::iter::once("help".to_owned())
            .chain(argv[..index].iter().cloned())
            .collect();
    }
    argv.to_vec()
}

fn matching_spec(argv: &[String]) -> Option<&'static CliCommandSpec> {
    command_specs()
        .iter()
        .filter(|spec| spec.path.len() <= argv.len())
        .filter(|spec| {
            spec.path
                .iter()
                .zip(argv)
                .all(|(expected, actual)| *expected == actual)
        })
        .max_by_key(|spec| spec.path.len())
}

fn parse_values(
    spec: &CliCommandSpec,
    arguments: &[String],
) -> Result<(Vec<String>, BTreeMap<String, String>), CliParseError> {
    let mut positional = Vec::new();
    let mut options = BTreeMap::new();
    let mut repeated = BTreeMap::<String, Vec<String>>::new();
    let mut index = 0;
    while index < arguments.len() {
        let argument = &arguments[index];
        if let Some(key) = argument.strip_prefix("--") {
            let Some(option) = spec.options.iter().find(|option| option.name == key) else {
                return Err(CliParseError::new(
                    "invalid_argument",
                    format!("Unknown option for {}: --{key}", spec.command),
                    spec.command,
                ));
            };
            if option.kind == CliOptionKind::Flag {
                if options.insert(key.to_owned(), "true".to_owned()).is_some() {
                    return Err(duplicate_option(spec.command, key));
                }
                index += 1;
                continue;
            }
            let Some(value) = arguments
                .get(index + 1)
                .filter(|value| !value.starts_with("--"))
            else {
                return Err(CliParseError::new(
                    "missing_argument",
                    format!("--{key} requires a value."),
                    spec.command,
                ));
            };
            if !option.allowed_values.is_empty() && !option.allowed_values.contains(&value.as_str())
            {
                return Err(CliParseError::new(
                    "invalid_input",
                    format!(
                        "--{key} must be one of {}.",
                        option.allowed_values.join(", ")
                    ),
                    spec.command,
                ));
            }
            if option.kind == CliOptionKind::Repeatable {
                let values = repeated.entry(key.to_owned()).or_default();
                values.push(value.clone());
                options.insert(
                    key.to_owned(),
                    serde_json::to_string(values).expect("string arrays always serialize"),
                );
            } else if options.insert(key.to_owned(), value.clone()).is_some() {
                return Err(duplicate_option(spec.command, key));
            }
            index += 2;
        } else {
            positional.push(argument.clone());
            index += 1;
        }
    }
    Ok((positional, options))
}

fn validate(
    spec: &CliCommandSpec,
    positional: &[String],
    options: &BTreeMap<String, String>,
) -> Result<(), CliParseError> {
    if positional.len() < spec.minimum_positionals {
        return Err(CliParseError::new(
            "missing_argument",
            format!(
                "{} requires {}.",
                spec.command,
                required_positionals(spec.command)
            ),
            spec.command,
        ));
    }
    if positional.len() > spec.maximum_positionals {
        return Err(CliParseError::new(
            "invalid_argument",
            format!(
                "Unexpected argument for {}: {}",
                spec.command, positional[spec.maximum_positionals]
            ),
            spec.command,
        ));
    }
    if spec.command == "help" && command_spec(positional).is_none() {
        return Err(CliParseError::new(
            "invalid_command",
            format!("Unknown Debrute CLI command: {}", positional.join(" ")),
            positional.join("."),
        ));
    }
    if let Some(option) = spec
        .options
        .iter()
        .find(|option| option.required && !options.contains_key(option.name))
    {
        return Err(required_option(spec.command, option.name));
    }
    if spec.command == "canvas.reset-layout" {
        let all = options.get("all").is_some_and(|value| value == "true");
        let has_rules = options.contains_key("path") || options.contains_key("glob");
        if all == has_rules {
            return Err(CliParseError::new(
                "invalid_input",
                "canvas.reset-layout requires --all or at least one --path/--glob.",
                spec.command,
            ));
        }
    }
    Ok(())
}

fn command_name(argv: &[String]) -> String {
    matching_spec(argv).map_or_else(
        || match argv {
            [first, second, ..] if !second.starts_with("--") => format!("{first}.{second}"),
            [first, ..] => first.clone(),
            [] => "commands".to_owned(),
        },
        |spec| spec.command.to_owned(),
    )
}

fn absolute_path(value: &String) -> Result<PathBuf, CliParseError> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Ok(path);
    }
    std::env::current_dir()
        .map(|directory| directory.join(path))
        .map_err(|error| {
            CliParseError::new(
                "internal_error",
                format!("Unable to resolve Project path: {error}"),
                "project",
            )
        })
}

fn required_positionals(command: &str) -> &'static str {
    command_specs()
        .iter()
        .find(|spec| spec.command == command)
        .map_or("arguments", |spec| spec.input)
}

fn required_option(command: &str, key: &str) -> CliParseError {
    CliParseError::new("missing_argument", format!("--{key} is required."), command)
}

fn duplicate_option(command: &str, key: &str) -> CliParseError {
    CliParseError::new(
        "invalid_argument",
        format!("--{key} may only be provided once."),
        command,
    )
}
