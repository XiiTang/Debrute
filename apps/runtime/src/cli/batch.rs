#![allow(
    clippy::needless_pass_by_value,
    clippy::too_many_arguments,
    clippy::too_many_lines
)]

use std::{
    fs::{self, OpenOptions},
    io::{BufWriter, Read as _, Write as _},
    path::Path,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::{
    generation::{GenerationCancellation, GenerationKind, GenerationRequest},
    project::{
        ProjectUseKind, assert_project_tree_visible_mutation_path, normalize_project_relative_path,
        open_no_symlink_existing_project_file, resolve_no_symlink_project_path_for_write,
    },
    workbench::WorkbenchRuntimeServices,
};

use super::service::{
    CliCommandRequest, CliFailure, ensure_project_initialized, normalize_generation_error, ok,
    positive_u64, project_failure,
};

const DEFAULT_CONCURRENCY: usize = 4;
const DEFAULT_TIMEOUT_MS: u64 = 900_000;
const MAX_BATCH_SOURCE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone)]
struct BatchRequest {
    model: String,
    arguments: Map<String, Value>,
    timeout_ms: Option<u64>,
    output_path: Option<String>,
}

struct BatchCounters {
    done: AtomicUsize,
    active: AtomicUsize,
    ok: AtomicUsize,
    skipped: AtomicUsize,
    failed: AtomicUsize,
    next_progress_boundary: Mutex<usize>,
}

impl BatchCounters {
    fn new() -> Self {
        Self {
            done: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            ok: AtomicUsize::new(0),
            skipped: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
            next_progress_boundary: Mutex::new(10),
        }
    }

    fn snapshot(&self, total: usize) -> Value {
        json!({
            "total": total,
            "done": self.done.load(Ordering::Acquire),
            "active": self.active.load(Ordering::Acquire),
            "ok": self.ok.load(Ordering::Acquire),
            "skipped": self.skipped.load(Ordering::Acquire),
            "failed": self.failed.load(Ordering::Acquire)
        })
    }

    fn should_report(&self, total: usize) -> bool {
        let done = self.done.load(Ordering::Acquire);
        let percent = done.saturating_mul(100) / total;
        let mut boundary = self
            .next_progress_boundary
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if percent < *boundary {
            return false;
        }
        while *boundary <= percent {
            *boundary += 10;
        }
        true
    }
}

pub(super) fn run_image_batch(
    services: Arc<WorkbenchRuntimeServices>,
    request: &CliCommandRequest,
    sender: &mpsc::Sender<Value>,
) -> Result<Value, CliFailure> {
    let project_root = request.project_root.as_deref().ok_or_else(|| {
        CliFailure::new(
            "missing_argument",
            "generate.image-batch requires projectRoot.",
        )
    })?;
    ensure_project_initialized(project_root)?;
    let opened = services
        .projects()
        .open_project(project_root, ProjectUseKind::Operation)
        .map_err(project_failure)?;
    let project_root = opened.session.root();
    let source = batch_source(project_root, request)?;
    let requests = parse_requests(&source)?;
    if requests.is_empty() {
        return Err(CliFailure::new(
            "invalid_input",
            "Image model batch must include at least one request.",
        ));
    }
    let concurrency = request
        .options
        .get("concurrency")
        .map_or(Ok(DEFAULT_CONCURRENCY), |raw| {
            positive_usize(raw, "--concurrency")
        })?;
    let timeout_ms = request
        .options
        .get("timeout-ms")
        .map(|raw| positive_u64(raw, "--timeout-ms"))
        .transpose()?
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    let log_relative = visible_output_path(request, "log")?;
    let summary_relative = request
        .options
        .get("summary")
        .map(|_| visible_output_path(request, "summary"))
        .transpose()?;
    let log_path = prepare_output_path(project_root, &log_relative)?;
    let summary_path = summary_relative
        .as_ref()
        .map(|relative| prepare_output_path(project_root, relative))
        .transpose()?;
    let log = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&log_path)
        .map_err(|error| CliFailure::new("project_invalid", error.to_string()))?;
    let writer = Arc::new(Mutex::new(BufWriter::new(log)));
    let writer_error = Arc::new(Mutex::new(None::<String>));
    let counters = Arc::new(BatchCounters::new());
    let next = Arc::new(AtomicUsize::new(0));
    let total = requests.len();
    let started = Instant::now();

    send_progress(
        sender,
        request,
        json!({
            "total": total,
            "done": 0,
            "ok": 0,
            "failed": 0,
            "skipped": 0,
            "active": 0,
            "timeout_ms": timeout_ms,
            "log": log_relative,
            "concurrency": concurrency,
            "summary": summary_relative
        }),
    )?;

    thread::scope(|scope| {
        for _ in 0..concurrency.min(total) {
            let requests = &requests;
            let services = Arc::clone(&services);
            let next = Arc::clone(&next);
            let counters = Arc::clone(&counters);
            let writer = Arc::clone(&writer);
            let writer_error = Arc::clone(&writer_error);
            let sender = sender.clone();
            let command = request.command.clone();
            scope.spawn(move || {
                loop {
                    let index = next.fetch_add(1, Ordering::AcqRel);
                    let Some(batch_request) = requests.get(index) else {
                        return;
                    };
                    counters.active.fetch_add(1, Ordering::AcqRel);
                    let result = run_item(
                        &services,
                        project_root,
                        batch_request,
                        index + 1,
                        timeout_ms,
                        request
                            .options
                            .get("overwrite-existing")
                            .is_some_and(|value| value == "true"),
                    );
                    counters.active.fetch_sub(1, Ordering::AcqRel);
                    match result.get("status").and_then(Value::as_str) {
                        Some("ok") => {
                            counters.ok.fetch_add(1, Ordering::AcqRel);
                        }
                        Some("skipped") => {
                            counters.skipped.fetch_add(1, Ordering::AcqRel);
                        }
                        _ => {
                            counters.failed.fetch_add(1, Ordering::AcqRel);
                        }
                    }
                    counters.done.fetch_add(1, Ordering::AcqRel);
                    if let Ok(line) = serde_json::to_string(&result) {
                        let mut writer = writer.lock().unwrap_or_else(PoisonError::into_inner);
                        if let Err(error) = writeln!(writer, "{line}") {
                            let mut stored =
                                writer_error.lock().unwrap_or_else(PoisonError::into_inner);
                            if stored.is_none() {
                                *stored = Some(error.to_string());
                            }
                        }
                    }
                    if counters.should_report(total) {
                        let _ = sender.blocking_send(json!({
                            "type": "progress",
                            "command": command,
                            "fields": counters.snapshot(total)
                        }));
                    }
                }
            });
        }
    });
    if let Some(error) = writer_error
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
    {
        return Err(CliFailure::new("project_invalid", error));
    }
    writer
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .flush()
        .map_err(|error| CliFailure::new("project_invalid", error.to_string()))?;
    let duration_seconds = round_seconds(started.elapsed());
    let mut summary = Map::from_iter([
        ("total".to_owned(), Value::from(total)),
        (
            "okCount".to_owned(),
            Value::from(counters.ok.load(Ordering::Acquire)),
        ),
        (
            "skippedCount".to_owned(),
            Value::from(counters.skipped.load(Ordering::Acquire)),
        ),
        (
            "failedCount".to_owned(),
            Value::from(counters.failed.load(Ordering::Acquire)),
        ),
        ("durationSeconds".to_owned(), Value::from(duration_seconds)),
        ("concurrency".to_owned(), Value::from(concurrency)),
        ("logPath".to_owned(), Value::String(log_relative.clone())),
    ]);
    if let Some(summary_relative) = &summary_relative {
        summary.insert(
            "summaryPath".to_owned(),
            Value::String(summary_relative.clone()),
        );
    }
    let summary = Value::Object(summary);
    if let Some(path) = summary_path {
        let mut content = serde_json::to_string_pretty(&summary)
            .map_err(|error| CliFailure::new("internal_error", error.to_string()))?;
        content.push('\n');
        fs::write(path, content)
            .map_err(|error| CliFailure::new("project_invalid", error.to_string()))?;
    }
    Ok(ok(
        &request.command,
        json!({
            "total": total,
            "ok": counters.ok.load(Ordering::Acquire),
            "failed": counters.failed.load(Ordering::Acquire),
            "skipped": counters.skipped.load(Ordering::Acquire),
            "log": log_relative,
            "concurrency": concurrency,
            "duration_seconds": duration_seconds,
            "summary": summary_relative
        }),
    ))
}

fn run_item(
    services: &WorkbenchRuntimeServices,
    project_root: &Path,
    request: &BatchRequest,
    index: usize,
    batch_timeout_ms: u64,
    overwrite_existing: bool,
) -> Value {
    let base = || {
        let mut fields = Map::from_iter([
            ("index".to_owned(), Value::from(index)),
            ("model".to_owned(), Value::String(request.model.clone())),
        ]);
        if let Some(output_path) = &request.output_path {
            fields.insert("outputPath".to_owned(), Value::String(output_path.clone()));
        }
        fields
    };
    if !overwrite_existing
        && request
            .output_path
            .as_deref()
            .is_some_and(|path| project_file_has_content(project_root, path))
    {
        let mut result = base();
        result.insert("status".to_owned(), Value::String("skipped".to_owned()));
        result.insert(
            "reason".to_owned(),
            Value::String("output_exists".to_owned()),
        );
        return Value::Object(result);
    }
    let started = Instant::now();
    let timeout_ms = request.timeout_ms.unwrap_or(batch_timeout_ms);
    let generation_request = GenerationRequest {
        model: request.model.clone(),
        arguments: request.arguments.clone(),
        timeout_ms: Some(timeout_ms),
    };
    match services.generation().execute(
        project_root,
        GenerationKind::Image,
        &generation_request,
        &GenerationCancellation::default(),
    ) {
        Ok(success) => {
            let mut result = base();
            result.insert("status".to_owned(), Value::String("ok".to_owned()));
            result.insert(
                "durationSeconds".to_owned(),
                Value::from(round_seconds(started.elapsed())),
            );
            result.insert(
                "artifacts".to_owned(),
                serde_json::to_value(success.artifacts)
                    .expect("Generation artifacts must be JSON-serializable"),
            );
            Value::Object(result)
        }
        Err(error) => {
            let mut result = base();
            result.insert("status".to_owned(), Value::String("failed".to_owned()));
            result.insert(
                "durationSeconds".to_owned(),
                Value::from(round_seconds(started.elapsed())),
            );
            result.insert(
                "error".to_owned(),
                json!({
                    "code": normalize_generation_error(GenerationKind::Image, error.code()),
                    "message": error.message()
                }),
            );
            Value::Object(result)
        }
    }
}

fn batch_source(project_root: &Path, request: &CliCommandRequest) -> Result<String, CliFailure> {
    let (label, relative) = match (
        request.options.get("manifest"),
        request.options.get("input-jsonl"),
    ) {
        (Some(path), None) => ("manifest", path),
        (None, Some(path)) => ("input-jsonl", path),
        _ => {
            return Err(CliFailure::new(
                "invalid_input",
                "generate.image-batch requires exactly one of --manifest or --input-jsonl.",
            ));
        }
    };
    let relative = normalize_project_relative_path(relative).map_err(project_failure)?;
    let file =
        open_no_symlink_existing_project_file(project_root, &relative).map_err(project_failure)?;
    if file
        .metadata()
        .map_err(|error| CliFailure::new("project_invalid", error.to_string()))?
        .len()
        > MAX_BATCH_SOURCE_BYTES
    {
        return Err(CliFailure::new(
            "invalid_input",
            format!("--{label} exceeds the maximum size."),
        ));
    }
    let mut content = String::new();
    file.take(MAX_BATCH_SOURCE_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|error| CliFailure::new("invalid_input", error.to_string()))?;
    Ok(if label == "manifest" {
        let value = serde_json::from_str::<Value>(&content)
            .map_err(|_| CliFailure::new("invalid_input", "--manifest must be valid JSON."))?;
        let requests = value
            .get("requests")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                CliFailure::new("invalid_input", "manifest.requests must be an array.")
            })?;
        requests
            .iter()
            .map(|request| serde_json::to_string(request).expect("JSON serializes"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        content
    })
}

fn parse_requests(content: &str) -> Result<Vec<BatchRequest>, CliFailure> {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .enumerate()
        .map(|(index, line)| {
            let value = serde_json::from_str::<Value>(line).map_err(|_| {
                CliFailure::new(
                    "invalid_input",
                    format!("--input-jsonl line {} must be valid JSON.", index + 1),
                )
            })?;
            let object = value.as_object().ok_or_else(|| {
                CliFailure::new(
                    "invalid_input",
                    "Image model batch request must be a JSON object.",
                )
            })?;
            let model = object
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .ok_or_else(|| {
                    CliFailure::new(
                        "invalid_input",
                        "Image model batch request must include string field \"model\".",
                    )
                })?
                .to_owned();
            let arguments = object
                .get("arguments")
                .and_then(Value::as_object)
                .cloned()
                .ok_or_else(|| {
                    CliFailure::new("invalid_input", "request.arguments must be a JSON object.")
                })?;
            let timeout_ms = object
                .get("timeoutMs")
                .map(|value| {
                    value.as_u64().filter(|value| *value > 0).ok_or_else(|| {
                        CliFailure::new(
                            "invalid_input",
                            "Image model batch request timeoutMs must be a positive integer.",
                        )
                    })
                })
                .transpose()?;
            let output_path = arguments
                .get("output_path")
                .and_then(Value::as_str)
                .or_else(|| object.get("outputPath").and_then(Value::as_str))
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_owned);
            Ok(BatchRequest {
                model,
                arguments,
                timeout_ms,
                output_path,
            })
        })
        .collect()
}

fn visible_output_path(request: &CliCommandRequest, key: &str) -> Result<String, CliFailure> {
    let raw = request
        .options
        .get(key)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliFailure::new("missing_argument", format!("--{key} is required.")))?;
    assert_project_tree_visible_mutation_path(raw).map_err(|_| {
        CliFailure::new(
            "invalid_input",
            format!("--{key} must be a project-relative path."),
        )
    })
}

fn prepare_output_path(
    project_root: &Path,
    relative: &str,
) -> Result<std::path::PathBuf, CliFailure> {
    let path = resolve_no_symlink_project_path_for_write(project_root, relative)
        .map_err(project_failure)?;
    let parent = path
        .parent()
        .ok_or_else(|| CliFailure::new("invalid_input", "Batch output path has no parent."))?;
    fs::create_dir_all(parent)
        .map_err(|error| CliFailure::new("project_invalid", error.to_string()))?;
    resolve_no_symlink_project_path_for_write(project_root, relative).map_err(project_failure)
}

fn project_file_has_content(project_root: &Path, relative: &str) -> bool {
    let Ok(relative) = normalize_project_relative_path(relative) else {
        return false;
    };
    open_no_symlink_existing_project_file(project_root, &relative)
        .and_then(|file| file.metadata().map_err(Into::into))
        .is_ok_and(|metadata| metadata.len() > 0)
}

fn positive_usize(raw: &str, label: &str) -> Result<usize, CliFailure> {
    raw.parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            CliFailure::new(
                "invalid_input",
                format!("{label} must be a positive integer."),
            )
        })
}

fn send_progress(
    sender: &mpsc::Sender<Value>,
    request: &CliCommandRequest,
    fields: Value,
) -> Result<(), CliFailure> {
    sender
        .blocking_send(json!({
            "type": "progress", "command": request.command, "fields": fields
        }))
        .map_err(|_| CliFailure::new("internal_error", "CLI stream closed before batch progress."))
}

fn round_seconds(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 100.0).round() / 100.0
}
