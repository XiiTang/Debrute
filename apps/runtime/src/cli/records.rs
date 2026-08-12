use std::{collections::BTreeMap, error::Error, fmt};

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CliPrimitive {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
}

impl CliPrimitive {
    fn try_from_value(value: &Value) -> Result<Self, AgentRecordError> {
        match value {
            Value::Null => Ok(Self::Null),
            Value::Bool(value) => Ok(Self::Bool(*value)),
            Value::Number(value) => Ok(Self::Number(value.clone())),
            Value::String(value) => Ok(Self::String(value.clone())),
            Value::Array(_) | Value::Object(_) => {
                Err(AgentRecordError("CLI field values must be primitive."))
            }
        }
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
}

impl From<String> for CliPrimitive {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<&str> for CliPrimitive {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CliFields(BTreeMap<String, CliPrimitive>);

impl CliFields {
    /// Converts one JSON object whose values are all CLI primitives.
    ///
    /// # Errors
    ///
    /// Returns an error when the value is not an object or contains an array or object field.
    pub fn try_from_value(value: &Value) -> Result<Self, AgentRecordError> {
        let object = value
            .as_object()
            .ok_or(AgentRecordError("CLI fields must be an object."))?;
        let fields = object
            .iter()
            .map(|(key, value)| {
                CliPrimitive::try_from_value(value).map(|value| (key.clone(), value))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self(fields))
    }

    pub fn insert(&mut self, key: impl Into<String>, value: CliPrimitive) {
        self.0.insert(key.into(), value);
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&CliPrimitive> {
        self.0.get(key)
    }

    fn get_key_value(&self, key: &str) -> Option<(&String, &CliPrimitive)> {
        self.0.get_key_value(key)
    }

    fn iter(&self) -> impl Iterator<Item = (&String, &CliPrimitive)> {
        self.0.iter()
    }

    fn len(&self) -> usize {
        self.0.len()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CliRecord {
    pub name: String,
    pub fields: CliFields,
}

impl CliRecord {
    /// Converts one JSON value to the closed CLI record shape.
    ///
    /// # Errors
    ///
    /// Returns an error when required fields are missing, fields are extra, or a field value is
    /// not primitive.
    pub fn try_from_value(value: Value) -> Result<Self, AgentRecordError> {
        serde_json::from_value(value)
            .map_err(|_| AgentRecordError("CLI record has an invalid closed shape."))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum CliResult {
    Ok {
        command: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        records: Vec<CliRecord>,
        #[serde(default)]
        fields: CliFields,
    },
    Error {
        command: String,
        code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        log: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        records: Vec<CliRecord>,
        #[serde(default)]
        fields: CliFields,
    },
}

impl CliResult {
    /// Converts one JSON value to the closed CLI result shape.
    ///
    /// # Errors
    ///
    /// Returns an error when the envelope, records, or primitive fields violate the contract.
    pub fn try_from_value(value: Value) -> Result<Self, AgentRecordError> {
        serde_json::from_value(value)
            .map_err(|_| AgentRecordError("CLI result has an invalid closed shape."))
    }

    #[must_use]
    pub fn command(&self) -> &str {
        match self {
            Self::Ok { command, .. } | Self::Error { command, .. } => command,
        }
    }

    #[must_use]
    pub fn error_code(&self) -> Option<&str> {
        match self {
            Self::Ok { .. } => None,
            Self::Error { code, .. } => Some(code),
        }
    }

    #[must_use]
    pub fn records(&self) -> &[CliRecord] {
        match self {
            Self::Ok { records, .. } | Self::Error { records, .. } => records,
        }
    }

    #[must_use]
    pub fn fields(&self) -> &CliFields {
        match self {
            Self::Ok { fields, .. } | Self::Error { fields, .. } => fields,
        }
    }

    #[must_use]
    pub fn with_command(mut self, command: impl Into<String>) -> Self {
        match &mut self {
            Self::Ok {
                command: current, ..
            }
            | Self::Error {
                command: current, ..
            } => *current = command.into(),
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CliProgress {
    pub event: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub records: Vec<CliRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum CliStreamEvent {
    Progress { fields: CliProgress },
    Result { result: CliResult },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRecordError(&'static str);

impl fmt::Display for AgentRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl Error for AgentRecordError {}

/// Renders one typed terminal CLI result using the stable unversioned Agent Record protocol.
#[must_use]
pub fn agent_record(result: &CliResult) -> String {
    let command = result.command();
    let mut lines = match result {
        CliResult::Ok { .. } => vec![format!(
            "debrute ok cmd={}",
            format_value(&CliPrimitive::String(command.to_owned()))
        )],
        CliResult::Error { code, log, .. } => {
            let mut lines = vec![format!(
                "debrute error cmd={} code={}",
                format_value(&CliPrimitive::String(command.to_owned())),
                format_value(&CliPrimitive::String(code.to_owned()))
            )];
            if let Some(log) = log {
                lines.push(format!(
                    "log={}",
                    format_value(&CliPrimitive::String(log.clone()))
                ));
            }
            lines
        }
    };
    for record in result.records() {
        lines.push(format!(
            "{}{}",
            record.name,
            format_fields(&record.fields, record_field_order(&record.name))
        ));
    }
    for (key, value) in ordered_fields(result.fields(), result_field_order(command)) {
        if !value.is_null() {
            lines.push(format!("{key}={}", format_value(value)));
        }
    }
    lines.join("\n")
}

/// Renders one streaming progress block using the stable Agent Record protocol.
#[must_use]
pub fn progress_record(command: &str, progress: &CliProgress) -> String {
    let mut lines = vec![format!(
        "debrute progress cmd={} event={}",
        format_value(&CliPrimitive::String(command.to_owned())),
        format_value(&CliPrimitive::String(progress.event.clone()))
    )];
    for record in &progress.records {
        lines.push(format!(
            "{}{}",
            record.name,
            format_fields(&record.fields, record_field_order(&record.name))
        ));
    }
    lines.join("\n")
}

fn format_fields(fields: &CliFields, priority: &[&str]) -> String {
    let pairs = ordered_fields(fields, priority)
        .into_iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| format!("{key}={}", format_value(value)))
        .collect::<Vec<_>>();
    if pairs.is_empty() {
        String::new()
    } else {
        format!(" {}", pairs.join(" "))
    }
}

fn ordered_fields<'a>(
    fields: &'a CliFields,
    priority: &[&str],
) -> Vec<(&'a str, &'a CliPrimitive)> {
    let mut output = Vec::with_capacity(fields.len());
    for key in priority {
        if let Some((field_key, value)) = fields.get_key_value(key) {
            output.push((field_key.as_str(), value));
        }
    }
    for (key, value) in fields.iter() {
        if !priority.contains(&key.as_str()) {
            output.push((key.as_str(), value));
        }
    }
    output
}

fn format_value(value: &CliPrimitive) -> String {
    match value {
        CliPrimitive::Null => "null".to_owned(),
        CliPrimitive::Bool(value) => value.to_string(),
        CliPrimitive::Number(value) => value.to_string(),
        CliPrimitive::String(value) => {
            let escaped = escape_value(value);
            if needs_quotes(&escaped) {
                format!("\"{escaped}\"")
            } else {
                escaped
            }
        }
    }
}

fn escape_value(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '"' => output.push_str("\\\""),
            character if character <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&character) => {
                use std::fmt::Write as _;
                let _ = write!(output, "\\u{:04x}", u32::from(character));
            }
            character => output.push(character),
        }
    }
    output
}

fn needs_quotes(value: &str) -> bool {
    value.is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || matches!(character, '=' | '"' | '\\'))
}

fn record_field_order(name: &str) -> &'static [&'static str] {
    match name {
        "model" => &["id", "summary"],
        "operation" => &[
            "id",
            "model_kind",
            "state",
            "accepted_at",
            "shape",
            "model",
            "item_count",
            "concurrency",
            "timeout_seconds",
            "active",
            "succeeded",
            "failed",
            "log",
        ],
        "batch_item" => &["item_index", "model", "status", "log"],
        "artifact" => &[
            "artifact_index",
            "output_path",
            "mime_type",
            "width",
            "height",
        ],
        "diagnostic" => &["id", "severity", "code", "message", "path", "item_index"],
        "command" => &[
            "name", "scope", "risk", "requires", "writes", "input", "output", "errors",
        ],
        _ => &[],
    }
}

fn result_field_order(command: &str) -> &'static [&'static str] {
    match command {
        "runtime.status" => &["runtime_state"],
        "models.image.describe"
        | "models.video.describe"
        | "models.tts.describe"
        | "models.music.describe"
        | "models.sfx.describe" => &["arguments_schema", "manual_markdown"],
        "project.status" | "project.validate" => {
            &["project_root", "project_name", "errors", "warnings"]
        }
        "workbench.start" => &["frontend", "target", "outcome"],
        "workbench.url" => &["url"],
        _ => &[],
    }
}
