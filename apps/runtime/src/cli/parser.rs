use std::{collections::BTreeMap, error::Error, fmt, path::PathBuf};

use super::spec::{CliCommandPolicy, CliCommandSpec, command_spec, command_specs};

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
    if argv.iter().any(|argument| argument == "--json") {
        return Err(CliParseError::new(
            "invalid_argument",
            "--json is not supported. Debrute CLI always emits debrute/1 Agent Records.",
            command_name(argv),
        ));
    }
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
    let (positional, options) = parse_values(spec, rest)?;
    validate(spec, &positional, &options)?;
    let project_root = project_positional_index(spec.command)
        .and_then(|index| positional.get(index))
        .map(absolute_path)
        .transpose()?;
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
    let allowed = allowed_options(spec.command);
    let mut positional = Vec::new();
    let mut options = BTreeMap::new();
    let mut repeated = BTreeMap::<String, Vec<String>>::new();
    let mut index = 0;
    while index < arguments.len() {
        let argument = &arguments[index];
        if let Some(key) = argument.strip_prefix("--") {
            if !allowed.contains(&key) {
                return Err(CliParseError::new(
                    "invalid_argument",
                    format!("Unknown option for {}: --{key}", spec.command),
                    spec.command,
                ));
            }
            if boolean_options(spec.command).contains(&key) {
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
            if repeatable_options(spec.command).contains(&key) {
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
    let (minimum, maximum) = positional_count(spec.command);
    if positional.len() < minimum {
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
    if positional.len() > maximum {
        return Err(CliParseError::new(
            "invalid_argument",
            format!(
                "Unexpected argument for {}: {}",
                spec.command, positional[maximum]
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
    if matches!(
        spec.command,
        "generate.image" | "generate.video" | "generate.tts" | "generate.music" | "generate.sfx"
    ) && !options.contains_key("input-json")
    {
        return Err(required_option(spec.command, "input-json"));
    }
    if spec.command == "generated-asset.lookup" && !options.contains_key("path") {
        return Err(required_option(spec.command, "path"));
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
    if spec.command == "workbench.start"
        && let Some(frontend) = options.get("frontend")
        && !matches!(frontend.as_str(), "default" | "desktop" | "browser")
    {
        return Err(CliParseError::new(
            "invalid_input",
            "--frontend must be one of default, desktop, or browser.",
            spec.command,
        ));
    }
    if spec.command == "generate.image-batch" {
        let source_count = usize::from(options.contains_key("manifest"))
            + usize::from(options.contains_key("input-jsonl"));
        if source_count != 1 {
            return Err(CliParseError::new(
                "invalid_input",
                "generate.image-batch requires exactly one of --manifest or --input-jsonl.",
                spec.command,
            ));
        }
        if !options.contains_key("log") {
            return Err(required_option(spec.command, "log"));
        }
    }
    Ok(())
}

fn command_name(argv: &[String]) -> String {
    let filtered = argv
        .iter()
        .filter(|argument| !matches!(argument.as_str(), "--help" | "-h" | "--json"))
        .collect::<Vec<_>>();
    matching_spec(
        &filtered
            .iter()
            .map(|value| (*value).clone())
            .collect::<Vec<_>>(),
    )
    .map_or_else(
        || match filtered.as_slice() {
            [first, second, ..] if !second.starts_with("--") => format!("{first}.{second}"),
            [first, ..] => (*first).clone(),
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

fn project_positional_index(command: &str) -> Option<usize> {
    matches!(
        command,
        "project.init"
            | "project.status"
            | "project.validate"
            | "canvas-map.push"
            | "canvas.create"
            | "canvas.rename"
            | "canvas.delete"
            | "canvas.reorder"
            | "canvas.repair-index"
            | "canvas.reset-layout"
            | "generated-asset.lookup"
            | "generate.image"
            | "generate.image-batch"
            | "generate.video"
            | "generate.tts"
            | "generate.music"
            | "generate.sfx"
    )
    .then_some(0)
    .or_else(|| (command == "workbench.start").then_some(0))
}

fn positional_count(command: &str) -> (usize, usize) {
    match command {
        "models.image.describe"
        | "models.video.describe"
        | "models.tts.describe"
        | "models.music.describe"
        | "models.sfx.describe"
        | "project.init"
        | "project.status"
        | "project.validate"
        | "canvas.create"
        | "canvas.repair-index"
        | "generated-asset.lookup"
        | "generate.image"
        | "generate.image-batch"
        | "generate.video"
        | "generate.tts"
        | "generate.music"
        | "generate.sfx" => (1, 1),
        "workbench.start" => (0, 1),
        "canvas-map.push" | "canvas.delete" | "canvas.reset-layout" => (2, 2),
        "canvas.rename" => (3, 3),
        "canvas.reorder" => (2, usize::MAX),
        "help" => (1, 3),
        _ => (0, 0),
    }
}

fn required_positionals(command: &str) -> &'static str {
    command_specs()
        .iter()
        .find(|spec| spec.command == command)
        .map_or("arguments", |spec| spec.input)
}

fn allowed_options(command: &str) -> &'static [&'static str] {
    match command {
        "workbench.start" => &["frontend"],
        "canvas.reset-layout" => &["all", "path", "glob"],
        "generated-asset.lookup" => &["path"],
        "generate.image" | "generate.video" | "generate.tts" | "generate.music"
        | "generate.sfx" => &["input-json", "timeout-ms"],
        "generate.image-batch" => &[
            "manifest",
            "input-jsonl",
            "log",
            "summary",
            "concurrency",
            "timeout-ms",
            "overwrite-existing",
        ],
        _ => &[],
    }
}

fn boolean_options(command: &str) -> &'static [&'static str] {
    match command {
        "canvas.reset-layout" => &["all"],
        "generate.image-batch" => &["overwrite-existing"],
        _ => &[],
    }
}

fn repeatable_options(command: &str) -> &'static [&'static str] {
    if command == "canvas.reset-layout" {
        &["path", "glob"]
    } else {
        &[]
    }
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
