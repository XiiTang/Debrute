use std::{error::Error, fmt};

use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRecordError(&'static str);

impl fmt::Display for AgentRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl Error for AgentRecordError {}

/// Renders one terminal CLI result using the stable unversioned Agent Record protocol.
///
/// # Errors
/// Returns an error when the result envelope or a field is not in the closed
/// primitive Agent Record shape.
pub fn agent_record(result: &Value) -> Result<String, AgentRecordError> {
    let object = result
        .as_object()
        .ok_or(AgentRecordError("CLI result must be an object."))?;
    let status = string_field(object, "status")?;
    let command = string_field(object, "command")?;
    let mut lines = match status {
        "ok" => vec![format!(
            "debrute ok cmd={}",
            format_value(&Value::String(command.to_owned()))?
        )],
        "error" => {
            let code = string_field(object, "code")?;
            let mut lines = vec![format!(
                "debrute error cmd={} code={}",
                format_value(&Value::String(command.to_owned()))?,
                format_value(&Value::String(code.to_owned()))?
            )];
            if let Some(log) = object.get("log").filter(|value| !value.is_null()) {
                lines.push(format!("log={}", format_value(log)?));
            }
            lines
        }
        _ => return Err(AgentRecordError("CLI result status is invalid.")),
    };
    if let Some(records) = object.get("records") {
        for record in records
            .as_array()
            .ok_or(AgentRecordError("CLI records must be an array."))?
        {
            let record = record
                .as_object()
                .ok_or(AgentRecordError("CLI record must be an object."))?;
            let name = string_field(record, "name")?;
            let fields = object_field(record, "fields")?;
            lines.push(format!(
                "{name}{}",
                format_fields(fields, record_field_order(name))?
            ));
        }
    }
    if let Some(fields) = object.get("fields") {
        let fields = fields
            .as_object()
            .ok_or(AgentRecordError("CLI fields must be an object."))?;
        for (key, value) in ordered_fields(fields, result_field_order(command)) {
            if !value.is_null() {
                lines.push(format!("{key}={}", format_value(value)?));
            }
        }
    }
    Ok(lines.join("\n"))
}

/// Renders one streaming progress block using the stable Agent Record protocol.
///
/// # Errors
/// Returns an error when progress fields are not a primitive object.
pub fn progress_record(command: &str, fields: &Value) -> Result<String, AgentRecordError> {
    let fields = fields
        .as_object()
        .ok_or(AgentRecordError("CLI progress fields must be an object."))?;
    let event = string_field(fields, "event")?;
    let mut lines = vec![format!(
        "debrute progress cmd={} event={}",
        format_value(&Value::String(command.to_owned()))?,
        format_value(&Value::String(event.to_owned()))?
    )];
    if let Some(records) = fields.get("records") {
        for record in records
            .as_array()
            .ok_or(AgentRecordError("CLI progress records must be an array."))?
        {
            let record = record
                .as_object()
                .ok_or(AgentRecordError("CLI progress record must be an object."))?;
            let name = string_field(record, "name")?;
            let record_fields = object_field(record, "fields")?;
            lines.push(format!(
                "{name}{}",
                format_fields(record_fields, record_field_order(name))?
            ));
        }
    }
    Ok(lines.join("\n"))
}

fn format_fields(
    fields: &Map<String, Value>,
    priority: &[&str],
) -> Result<String, AgentRecordError> {
    let pairs = ordered_fields(fields, priority)
        .into_iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| Ok(format!("{key}={}", format_value(value)?)))
        .collect::<Result<Vec<_>, AgentRecordError>>()?;
    Ok(if pairs.is_empty() {
        String::new()
    } else {
        format!(" {}", pairs.join(" "))
    })
}

fn ordered_fields<'a>(
    fields: &'a Map<String, Value>,
    priority: &[&str],
) -> Vec<(&'a str, &'a Value)> {
    let mut output = Vec::with_capacity(fields.len());
    for key in priority {
        if let Some((field_key, value)) = fields.get_key_value(*key) {
            output.push((field_key.as_str(), value));
        }
    }
    for (key, value) in fields {
        if !priority.contains(&key.as_str()) {
            output.push((key.as_str(), value));
        }
    }
    output
}

fn format_value(value: &Value) -> Result<String, AgentRecordError> {
    match value {
        Value::Null => Ok("null".to_owned()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => {
            let escaped = escape_value(value);
            Ok(if needs_quotes(&escaped) {
                format!("\"{escaped}\"")
            } else {
                escaped
            })
        }
        Value::Array(_) | Value::Object(_) => {
            Err(AgentRecordError("CLI field values must be primitive."))
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

fn string_field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, AgentRecordError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(AgentRecordError("CLI result string field is missing."))
}

fn object_field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a Map<String, Value>, AgentRecordError> {
    object
        .get(key)
        .and_then(Value::as_object)
        .ok_or(AgentRecordError("CLI result object field is missing."))
}

fn record_field_order(name: &str) -> &'static [&'static str] {
    match name {
        "model" => &["id", "kind", "parameters"],
        "official_doc" => &["urls", "snapshot", "captured_at"],
        "operation" => &[
            "id",
            "model_kind",
            "project_root",
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
            "role",
            "project_relative_path",
            "mime_type",
            "width",
            "height",
        ],
        "diagnostic" => &["id", "severity", "code", "message", "path"],
        "command" => &[
            "name", "scope", "risk", "requires", "writes", "input", "output", "errors",
        ],
        _ => &[],
    }
}

fn result_field_order(command: &str) -> &'static [&'static str] {
    match command {
        "runtime.status" | "runtime.doctor" => &[
            "runtime_state",
            "native_tray",
            "runtime_instance",
            "diagnostics",
        ],
        "project.init" | "project.status" | "project.validate" => &[
            "project_root",
            "project_name",
            "canvases",
            "errors",
            "warnings",
        ],
        "workbench.start" => &["frontend", "target", "outcome"],
        _ => &[],
    }
}
