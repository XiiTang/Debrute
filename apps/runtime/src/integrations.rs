//! Closed optional-integration catalog and injectable state engine.

use std::{
    error::Error,
    fmt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;

const PROBE_TIMEOUT_MS: u64 = 10_000;
const OPERATION_TIMEOUT_MS: u64 = 300_000;
const STATUS_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationOperation {
    Install,
    Update,
    Uninstall,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedBackend {
    Brew(PathBuf),
    Winget(PathBuf),
    Uv(PathBuf),
    Pipx(PathBuf),
}

impl ResolvedBackend {
    fn id(&self) -> &'static str {
        match self {
            Self::Brew(_) => "brew",
            Self::Winget(_) => "winget",
            Self::Uv(_) => "uv",
            Self::Pipx(_) => "pipx",
        }
    }

    fn path(&self) -> &Path {
        match self {
            Self::Brew(path) | Self::Winget(path) | Self::Uv(path) | Self::Pipx(path) => path,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationBinary {
    pub id: &'static str,
    pub display_name: &'static str,
    pub names: &'static [&'static str],
    pub probe_args: &'static [&'static str],
    version_parser: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CatalogBackend {
    System {
        brew_package: &'static str,
        winget_package: &'static str,
    },
    Python {
        package: &'static str,
        repository: &'static str,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationCatalogItem {
    pub id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub binaries: Vec<IntegrationBinary>,
    backend: CatalogBackend,
}

#[derive(Debug, Clone)]
pub struct IntegrationCatalog {
    entries: Vec<IntegrationCatalogItem>,
}

impl IntegrationCatalog {
    #[must_use]
    pub fn bundled() -> Self {
        Self {
            entries: vec![
                IntegrationCatalogItem {
                    id: "ffmpeg",
                    display_name: "FFmpeg",
                    description: "Video and audio processing toolkit.",
                    category: "media",
                    binaries: vec![
                        binary("ffmpeg", "ffmpeg", &["ffmpeg"], &["-version"], "ffmpeg"),
                        binary("ffprobe", "ffprobe", &["ffprobe"], &["-version"], "ffmpeg"),
                    ],
                    backend: CatalogBackend::System {
                        brew_package: "ffmpeg",
                        winget_package: "Gyan.FFmpeg",
                    },
                },
                IntegrationCatalogItem {
                    id: "imagemagick",
                    display_name: "ImageMagick",
                    description: "Image conversion, composition, and filtering toolkit.",
                    category: "media",
                    binaries: vec![binary(
                        "magick",
                        "magick",
                        &["magick"],
                        &["-version"],
                        "imagemagick",
                    )],
                    backend: CatalogBackend::System {
                        brew_package: "imagemagick",
                        winget_package: "ImageMagick.ImageMagick",
                    },
                },
                IntegrationCatalogItem {
                    id: "mediainfo",
                    display_name: "MediaInfo",
                    description: "Media container and stream information reader.",
                    category: "media",
                    binaries: vec![binary(
                        "mediainfo",
                        "mediainfo",
                        &["mediainfo"],
                        &["--Version"],
                        "mediainfo",
                    )],
                    backend: CatalogBackend::System {
                        brew_package: "media-info",
                        winget_package: "MediaArea.MediaInfo",
                    },
                },
                IntegrationCatalogItem {
                    id: "exiftool",
                    display_name: "ExifTool",
                    description: "Image, audio, and video metadata reader and writer.",
                    category: "media",
                    binaries: vec![binary(
                        "exiftool",
                        "exiftool",
                        &["exiftool"],
                        &["-ver"],
                        "exiftool",
                    )],
                    backend: CatalogBackend::System {
                        brew_package: "exiftool",
                        winget_package: "OliverBetz.ExifTool",
                    },
                },
                IntegrationCatalogItem {
                    id: "remove-ai-watermarks",
                    display_name: "Remove AI Watermarks",
                    description: "Visible AI watermark removal and AI metadata cleanup CLI.",
                    category: "image-cleanup",
                    binaries: vec![binary(
                        "remove-ai-watermarks",
                        "remove-ai-watermarks",
                        &["remove-ai-watermarks"],
                        &["--version"],
                        "remove-ai-watermarks",
                    )],
                    backend: CatalogBackend::Python {
                        package: "remove-ai-watermarks",
                        repository: "git+https://github.com/wiltodelta/remove-ai-watermarks.git",
                    },
                },
            ],
        }
    }

    #[must_use]
    pub fn ids(&self) -> Vec<&'static str> {
        self.entries.iter().map(|entry| entry.id).collect()
    }

    #[must_use]
    pub fn get(&self, id: &str) -> Option<&IntegrationCatalogItem> {
        self.entries.iter().find(|entry| entry.id == id)
    }
}

fn binary(
    id: &'static str,
    display_name: &'static str,
    names: &'static [&'static str],
    probe_args: &'static [&'static str],
    version_parser: &'static str,
) -> IntegrationBinary {
    IntegrationBinary {
        id,
        display_name,
        names,
        probe_args,
        version_parser,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationCommand {
    pub backend: String,
    pub file: PathBuf,
    pub args: Vec<String>,
    pub timeout_ms: u64,
}

#[must_use]
pub fn build_operation_command(
    integration: &IntegrationCatalogItem,
    backend: &ResolvedBackend,
    operation: IntegrationOperation,
) -> Option<IntegrationCommand> {
    let args = match (&integration.backend, backend) {
        (CatalogBackend::System { brew_package, .. }, ResolvedBackend::Brew(_)) => vec![
            match operation {
                IntegrationOperation::Install => "install",
                IntegrationOperation::Update => "upgrade",
                IntegrationOperation::Uninstall => "uninstall",
            },
            "--formula",
            brew_package,
        ],
        (CatalogBackend::System { winget_package, .. }, ResolvedBackend::Winget(_)) => {
            let command = match operation {
                IntegrationOperation::Install => "install",
                IntegrationOperation::Update => "upgrade",
                IntegrationOperation::Uninstall => "uninstall",
            };
            let mut values = vec![command, "--id", winget_package, "--exact"];
            if operation != IntegrationOperation::Uninstall {
                values.extend(["--accept-source-agreements", "--accept-package-agreements"]);
            }
            values.push("--disable-interactivity");
            values
        }
        (
            CatalogBackend::Python {
                package,
                repository,
            },
            ResolvedBackend::Uv(_),
        ) => match operation {
            IntegrationOperation::Install => vec!["tool", "install", repository],
            IntegrationOperation::Update => vec!["tool", "upgrade", package],
            IntegrationOperation::Uninstall => vec!["tool", "uninstall", package],
        },
        (
            CatalogBackend::Python {
                package,
                repository,
            },
            ResolvedBackend::Pipx(_),
        ) => match operation {
            IntegrationOperation::Install => vec!["install", repository],
            IntegrationOperation::Update => vec!["upgrade", package],
            IntegrationOperation::Uninstall => vec!["uninstall", package],
        },
        _ => return None,
    };
    Some(IntegrationCommand {
        backend: backend.id().to_owned(),
        file: backend.path().to_owned(),
        args: args.into_iter().map(str::to_owned).collect(),
        timeout_ms: OPERATION_TIMEOUT_MS,
    })
}

fn build_query_command(
    integration: &IntegrationCatalogItem,
    backend: &ResolvedBackend,
    install_query: bool,
) -> Option<IntegrationCommand> {
    let CatalogBackend::System {
        brew_package,
        winget_package,
    } = &integration.backend
    else {
        return None;
    };
    let args = match backend {
        ResolvedBackend::Brew(_) if install_query => {
            vec!["info", "--json=v2", "--formula", brew_package]
        }
        ResolvedBackend::Brew(_) => {
            vec!["outdated", "--json=v2", "--formula", brew_package]
        }
        ResolvedBackend::Winget(_) if install_query => vec![
            "show",
            "--id",
            winget_package,
            "--exact",
            "--disable-interactivity",
        ],
        ResolvedBackend::Winget(_) => vec![
            "upgrade",
            "--id",
            winget_package,
            "--exact",
            "--disable-interactivity",
        ],
        ResolvedBackend::Uv(_) | ResolvedBackend::Pipx(_) => return None,
    };
    Some(IntegrationCommand {
        backend: backend.id().to_owned(),
        file: backend.path().to_owned(),
        args: args.into_iter().map(str::to_owned).collect(),
        timeout_ms: 20_000,
    })
}

fn package_name<'a>(
    integration: &'a IntegrationCatalogItem,
    backend: &ResolvedBackend,
) -> Result<&'a str, IntegrationError> {
    match (&integration.backend, backend) {
        (CatalogBackend::System { brew_package, .. }, ResolvedBackend::Brew(_)) => Ok(brew_package),
        (CatalogBackend::System { winget_package, .. }, ResolvedBackend::Winget(_)) => {
            Ok(winget_package)
        }
        _ => Err(IntegrationError::Parse(
            "Integration/backend package mismatch.".to_owned(),
        )),
    }
}

fn parse_install_query(
    backend: &str,
    integration: &IntegrationCatalogItem,
    stdout: &str,
) -> Result<ParsedPackageQuery, IntegrationError> {
    match backend {
        "brew" => {
            let value: serde_json::Value = serde_json::from_str(if stdout.is_empty() {
                r#"{"formulae":[]}"#
            } else {
                stdout
            })
            .map_err(|error| IntegrationError::Parse(error.to_string()))?;
            let latest_version = value
                .get("formulae")
                .and_then(serde_json::Value::as_array)
                .and_then(|entries| {
                    let CatalogBackend::System { brew_package, .. } = &integration.backend else {
                        return None;
                    };
                    entries
                        .iter()
                        .find(|entry| {
                            entry.get("name").and_then(serde_json::Value::as_str)
                                == Some(brew_package)
                        })
                        .or_else(|| entries.first())
                })
                .and_then(|entry| entry.get("versions"))
                .and_then(|versions| versions.get("stable"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            Ok(ParsedPackageQuery {
                latest_version,
                ..ParsedPackageQuery::default()
            })
        }
        "winget" => {
            let latest_version = stdout.lines().find_map(|line| {
                line.trim()
                    .strip_prefix("Version:")
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
            });
            Ok(ParsedPackageQuery {
                latest_version,
                ..ParsedPackageQuery::default()
            })
        }
        _ => Err(IntegrationError::Parse(format!(
            "Unknown integration backend: {backend}"
        ))),
    }
}

fn diagnostic(error_kind: &str) -> IntegrationDiagnostic {
    IntegrationDiagnostic {
        error_kind: Some(error_kind.to_owned()),
        ..IntegrationDiagnostic::default()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationDiagnostic {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_tail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_tail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub diagnostic: IntegrationDiagnostic,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub error_kind: Option<String>,
}

pub trait IntegrationProcessAdapter: Send + Sync {
    fn resolve_executable(
        &self,
        name: &str,
        env_path: &str,
        platform: Platform,
        path_ext: &str,
    ) -> Option<PathBuf>;

    fn run_probe(&self, file: &Path, args: &[String], timeout_ms: u64) -> ProbeResult;

    fn run_command(&self, command: &IntegrationCommand) -> CommandResult;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationBackendStatus {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationBinaryStatus {
    pub binary_id: String,
    pub display_name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe: Option<IntegrationDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub integration_id: String,
    pub display_name: String,
    pub description: String,
    pub category: String,
    pub status: String,
    pub summary: String,
    pub binaries: Vec<IntegrationBinaryStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_status: Option<IntegrationOperationStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationOperationStatus {
    pub backend_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    pub available_operations: Vec<IntegrationOperation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_diagnostic: Option<IntegrationDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationOperationInFlight {
    pub integration_id: String,
    pub operation: IntegrationOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationSettingsView {
    pub integrations: Vec<IntegrationStatus>,
    pub backends: Vec<IntegrationBackendStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_operation: Option<IntegrationOperationInFlight>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationOperationResult {
    pub ok: bool,
    pub integration_id: String,
    pub operation: IntegrationOperation,
    pub settings: IntegrationSettingsView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<IntegrationDiagnostic>,
}

pub struct ObservedIntegrationOperation<E> {
    pub result: IntegrationOperationResult,
    pub settled_observer_error: Option<E>,
}

#[derive(Debug)]
pub enum IntegrationObservationError<E> {
    Service(IntegrationError),
    Started(E),
}

impl<E> From<IntegrationError> for IntegrationObservationError<E> {
    fn from(error: IntegrationError) -> Self {
        Self::Service(error)
    }
}

pub struct IntegrationService {
    platform: Platform,
    env_path: String,
    path_ext: String,
    adapter: Arc<dyn IntegrationProcessAdapter>,
    catalog: IntegrationCatalog,
    scan_sequence: Mutex<u64>,
    cache: Mutex<Option<CachedIntegrationView>>,
    operation_gate: Mutex<()>,
    operation: Mutex<Option<IntegrationOperationInFlight>>,
}

struct CachedIntegrationView {
    generation: u64,
    created_at: Instant,
    view: IntegrationSettingsView,
}

impl IntegrationService {
    #[must_use]
    pub fn new(
        platform: Platform,
        env_path: impl Into<String>,
        path_ext: impl Into<String>,
        adapter: Arc<dyn IntegrationProcessAdapter>,
    ) -> Self {
        Self {
            platform,
            env_path: env_path.into(),
            path_ext: path_ext.into(),
            adapter,
            catalog: IntegrationCatalog::bundled(),
            scan_sequence: Mutex::new(0),
            cache: Mutex::new(None),
            operation_gate: Mutex::new(()),
            operation: Mutex::new(None),
        }
    }

    /// Returns the cached integration projection for at most thirty seconds,
    /// overlaid with the current in-flight operation.
    ///
    /// # Errors
    ///
    /// Returns [`IntegrationError`] only for poisoned in-process state.
    pub fn list_status(&self) -> Result<IntegrationSettingsView, IntegrationError> {
        let running_operation = self.running_operation()?;
        let cached = self
            .cache
            .lock()
            .map_err(|_| IntegrationError::StatePoisoned)?;
        if let Some(cached) = cached.as_ref()
            && cached.created_at.elapsed() < STATUS_CACHE_TTL
        {
            let mut view = cached.view.clone();
            view.running_operation = running_operation;
            return Ok(view);
        }
        drop(cached);
        self.rescan()
    }

    /// Probes every closed integration and installation backend once.
    ///
    /// # Errors
    ///
    /// Returns [`IntegrationError`] only for poisoned in-process state.
    pub fn rescan(&self) -> Result<IntegrationSettingsView, IntegrationError> {
        let generation = {
            let mut sequence = self
                .scan_sequence
                .lock()
                .map_err(|_| IntegrationError::StatePoisoned)?;
            *sequence = sequence
                .checked_add(1)
                .ok_or(IntegrationError::ScanGenerationExhausted)?;
            *sequence
        };
        let (system, system_view) = self.resolve_system_backend();
        let (python, python_view) = self.resolve_python_backend();
        let integrations = self
            .catalog
            .entries
            .iter()
            .map(|entry| self.inspect(entry, system.as_ref(), python.as_ref()))
            .collect();
        let base = IntegrationSettingsView {
            integrations,
            backends: vec![system_view, python_view],
            running_operation: None,
        };
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| IntegrationError::StatePoisoned)?;
        if cache
            .as_ref()
            .is_none_or(|cached| cached.generation <= generation)
        {
            *cache = Some(CachedIntegrationView {
                generation,
                created_at: Instant::now(),
                view: base.clone(),
            });
        }
        drop(cache);
        let mut view = base;
        view.running_operation = self.running_operation()?;
        Ok(view)
    }

    /// Runs one catalog-defined install/update/uninstall operation without
    /// retrying or accepting generic command input.
    ///
    /// # Errors
    ///
    /// Returns [`IntegrationError`] only when the in-process state lock is
    /// poisoned. Expected operation failures are returned as typed diagnostics.
    pub fn run_operation(
        &self,
        integration_id: &str,
        operation: IntegrationOperation,
    ) -> Result<IntegrationOperationResult, IntegrationError> {
        match self.run_operation_observed(
            integration_id,
            operation,
            |_| Ok::<(), std::convert::Infallible>(()),
            |_| Ok::<(), std::convert::Infallible>(()),
        ) {
            Ok(observed) => Ok(observed.result),
            Err(IntegrationObservationError::Service(error)) => Err(error),
            Err(IntegrationObservationError::Started(never)) => match never {},
        }
    }

    /// Runs an operation and exposes the in-flight state exactly once before
    /// process execution, allowing the Global stream to publish it.
    ///
    /// # Errors
    ///
    /// Returns [`IntegrationObservationError::Started`] before command
    /// execution when the started transition cannot be committed.
    pub fn run_operation_observed<E>(
        &self,
        integration_id: &str,
        operation: IntegrationOperation,
        on_started: impl FnOnce(&IntegrationSettingsView) -> Result<(), E>,
        on_settled: impl FnOnce(&IntegrationSettingsView) -> Result<(), E>,
    ) -> Result<ObservedIntegrationOperation<E>, IntegrationObservationError<E>> {
        let _gate = match self.operation_gate.try_lock() {
            Ok(gate) => gate,
            Err(std::sync::TryLockError::WouldBlock) => {
                return Ok(ObservedIntegrationOperation {
                    result: IntegrationOperationResult {
                        ok: false,
                        integration_id: integration_id.to_owned(),
                        operation,
                        settings: self.list_status()?,
                        diagnostic: Some(diagnostic("operation_already_running")),
                    },
                    settled_observer_error: None,
                });
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(IntegrationError::StatePoisoned.into());
            }
        };

        let command = match self.plan_operation(integration_id, operation) {
            Ok(command) => command,
            Err(diagnostic) => {
                return Ok(ObservedIntegrationOperation {
                    result: IntegrationOperationResult {
                        ok: false,
                        integration_id: integration_id.to_owned(),
                        operation,
                        settings: self.rescan()?,
                        diagnostic: Some(diagnostic),
                    },
                    settled_observer_error: None,
                });
            }
        };
        *self
            .operation
            .lock()
            .map_err(|_| IntegrationError::StatePoisoned)? = Some(IntegrationOperationInFlight {
            integration_id: integration_id.to_owned(),
            operation,
        });

        let started = match self.rescan() {
            Ok(started) => started,
            Err(error) => {
                self.clear_running_operation()?;
                return Err(IntegrationObservationError::Service(error));
            }
        };
        if let Err(error) = on_started(&started) {
            self.clear_running_operation()?;
            return Err(IntegrationObservationError::Started(error));
        }

        let command_result = self.adapter.run_command(&command);
        self.clear_running_operation()?;
        let settings = self.rescan()?;
        let settled_observer_error = on_settled(&settings).err();
        Ok(ObservedIntegrationOperation {
            result: IntegrationOperationResult {
                ok: command_result.ok,
                integration_id: integration_id.to_owned(),
                operation,
                settings,
                diagnostic: (!command_result.ok).then_some(command_result.diagnostic),
            },
            settled_observer_error,
        })
    }

    fn clear_running_operation(&self) -> Result<(), IntegrationError> {
        self.operation
            .lock()
            .map_err(|_| IntegrationError::StatePoisoned)?
            .take();
        Ok(())
    }

    fn running_operation(&self) -> Result<Option<IntegrationOperationInFlight>, IntegrationError> {
        self.operation
            .lock()
            .map_err(|_| IntegrationError::StatePoisoned)
            .map(|operation| operation.clone())
    }

    fn plan_operation(
        &self,
        integration_id: &str,
        operation: IntegrationOperation,
    ) -> Result<IntegrationCommand, IntegrationDiagnostic> {
        let Some(integration) = self.catalog.get(integration_id) else {
            return Err(diagnostic("integration_not_found"));
        };
        let (system, _) = self.resolve_system_backend();
        let (python, _) = self.resolve_python_backend();
        let backend = match integration.backend {
            CatalogBackend::System { .. } => system.as_ref(),
            CatalogBackend::Python { .. } => python.as_ref(),
        };
        let Some(backend) = backend else {
            let mut unavailable = diagnostic("backend_unavailable");
            unavailable.stderr_tail = Some(
                match integration.backend {
                    CatalogBackend::System { .. } => match self.platform {
                        Platform::MacOs => "Homebrew was not found on PATH.",
                        Platform::Windows => "winget was not found on PATH.",
                    },
                    CatalogBackend::Python { .. } => "uv or pipx was not found on PATH.",
                }
                .to_owned(),
            );
            return Err(unavailable);
        };
        let inspected = self.inspect(integration, system.as_ref(), python.as_ref());
        if !inspected
            .operation_status
            .as_ref()
            .is_some_and(|status| status.available_operations.contains(&operation))
        {
            return Err(diagnostic("operation_unavailable"));
        }
        build_operation_command(integration, backend, operation)
            .ok_or_else(|| diagnostic("command_unavailable"))
    }

    fn inspect(
        &self,
        integration: &IntegrationCatalogItem,
        system: Option<&ResolvedBackend>,
        python: Option<&ResolvedBackend>,
    ) -> IntegrationStatus {
        let binaries = integration
            .binaries
            .iter()
            .map(|binary| self.inspect_binary(binary))
            .collect::<Vec<_>>();
        let status = if binaries
            .iter()
            .any(|binary| binary.status == "probe_failed")
        {
            "probe_failed"
        } else if binaries.iter().any(|binary| binary.status == "not_found") {
            "not_found"
        } else {
            "ready"
        };
        let summary = match status {
            "ready" => "Ready.".to_owned(),
            "probe_failed" => format!(
                "{} probe failed.",
                first_binary_with_status(&binaries, "probe_failed").unwrap_or("A required binary")
            ),
            _ => format!(
                "{} is missing.",
                first_binary_with_status(&binaries, "not_found").unwrap_or("A required binary")
            ),
        };
        IntegrationStatus {
            integration_id: integration.id.to_owned(),
            display_name: integration.display_name.to_owned(),
            description: integration.description.to_owned(),
            category: integration.category.to_owned(),
            status: status.to_owned(),
            summary,
            binaries,
            operation_status: Some(self.operation_status(integration, status, system, python)),
        }
    }

    fn operation_status(
        &self,
        integration: &IntegrationCatalogItem,
        status: &str,
        system: Option<&ResolvedBackend>,
        python: Option<&ResolvedBackend>,
    ) -> IntegrationOperationStatus {
        match &integration.backend {
            CatalogBackend::System {
                brew_package,
                winget_package,
            } => self.system_operation_status(
                integration,
                status,
                system,
                brew_package,
                winget_package,
            ),
            CatalogBackend::Python { package, .. } => {
                Self::python_operation_status(status, python, package)
            }
        }
    }

    fn system_operation_status(
        &self,
        integration: &IntegrationCatalogItem,
        status: &str,
        backend: Option<&ResolvedBackend>,
        brew_package: &str,
        winget_package: &str,
    ) -> IntegrationOperationStatus {
        let package_name = match backend {
            Some(ResolvedBackend::Brew(_)) => Some(brew_package.to_owned()),
            Some(ResolvedBackend::Winget(_)) => Some(winget_package.to_owned()),
            _ => None,
        };
        let Some(backend) = backend else {
            return IntegrationOperationStatus {
                backend_kind: "system-package-manager".to_owned(),
                backend: Some(
                    match self.platform {
                        Platform::MacOs => "brew",
                        Platform::Windows => "winget",
                    }
                    .to_owned(),
                ),
                package_name,
                available_operations: Vec::new(),
                installed_version: None,
                latest_version: None,
                unavailable_reason: Some(
                    match self.platform {
                        Platform::MacOs => "Homebrew was not found on PATH.",
                        Platform::Windows => "winget was not found on PATH.",
                    }
                    .to_owned(),
                ),
                query_diagnostic: None,
            };
        };
        if !matches!(status, "not_found" | "ready") {
            return IntegrationOperationStatus {
                backend_kind: "system-package-manager".to_owned(),
                backend: Some(backend.id().to_owned()),
                package_name,
                available_operations: Vec::new(),
                installed_version: None,
                latest_version: None,
                unavailable_reason: Some(
                    "Integration operations require a ready detected integration.".to_owned(),
                ),
                query_diagnostic: None,
            };
        }
        let query = self.query_system_package(integration, backend, status);
        let available_operations = match status {
            "not_found" => vec![IntegrationOperation::Install],
            "ready" => {
                let mut operations = Vec::new();
                if query.as_ref().is_ok_and(|query| query.update_available) {
                    operations.push(IntegrationOperation::Update);
                }
                operations.push(IntegrationOperation::Uninstall);
                operations
            }
            _ => Vec::new(),
        };
        let (query, query_diagnostic) = match query {
            Ok(query) => (Some(query), None),
            Err(error) => (
                None,
                Some(IntegrationDiagnostic {
                    error_kind: Some("parse_error".to_owned()),
                    stderr_tail: Some(error.to_string()),
                    ..IntegrationDiagnostic::default()
                }),
            ),
        };
        IntegrationOperationStatus {
            backend_kind: "system-package-manager".to_owned(),
            backend: Some(backend.id().to_owned()),
            package_name,
            available_operations,
            installed_version: query
                .as_ref()
                .and_then(|value| value.installed_version.clone()),
            latest_version: query
                .as_ref()
                .and_then(|value| value.latest_version.clone()),
            unavailable_reason: query
                .as_ref()
                .and_then(|value| value.unavailable_reason.clone()),
            query_diagnostic: query
                .as_ref()
                .and_then(|value| value.query_diagnostic.clone())
                .or(query_diagnostic),
        }
    }

    fn python_operation_status(
        status: &str,
        backend: Option<&ResolvedBackend>,
        package: &str,
    ) -> IntegrationOperationStatus {
        let Some(backend) = backend else {
            return IntegrationOperationStatus {
                backend_kind: "python-cli-installer".to_owned(),
                backend: None,
                package_name: Some(package.to_owned()),
                available_operations: Vec::new(),
                installed_version: None,
                latest_version: None,
                unavailable_reason: Some("uv or pipx was not found on PATH.".to_owned()),
                query_diagnostic: None,
            };
        };
        let unavailable_reason = (!matches!(status, "not_found" | "ready"))
            .then(|| "Integration operations require a ready detected integration.".to_owned());
        IntegrationOperationStatus {
            backend_kind: "python-cli-installer".to_owned(),
            backend: Some(backend.id().to_owned()),
            package_name: Some(package.to_owned()),
            available_operations: match status {
                "not_found" => vec![IntegrationOperation::Install],
                "ready" => vec![
                    IntegrationOperation::Update,
                    IntegrationOperation::Uninstall,
                ],
                _ => Vec::new(),
            },
            installed_version: None,
            latest_version: None,
            unavailable_reason,
            query_diagnostic: None,
        }
    }

    fn query_system_package(
        &self,
        integration: &IntegrationCatalogItem,
        backend: &ResolvedBackend,
        status: &str,
    ) -> Result<ParsedPackageQuery, IntegrationError> {
        let Some(command) = build_query_command(integration, backend, status == "not_found") else {
            return Ok(ParsedPackageQuery::default());
        };
        let result = self.adapter.run_command(&command);
        let parse_failed_output =
            status == "not_found" || backend.id() != "brew" || result.stdout.trim().is_empty();
        if !result.ok && parse_failed_output {
            return Ok(ParsedPackageQuery {
                query_diagnostic: Some(result.diagnostic),
                ..ParsedPackageQuery::default()
            });
        }
        if status == "not_found" {
            return parse_install_query(backend.id(), integration, &result.stdout);
        }
        let package = package_name(integration, backend)?;
        parse_package_query(backend.id(), package, &result.stdout)
    }

    fn inspect_binary(&self, binary: &IntegrationBinary) -> IntegrationBinaryStatus {
        let Some(path) = binary.names.iter().find_map(|name| {
            self.adapter
                .resolve_executable(name, &self.env_path, self.platform, &self.path_ext)
        }) else {
            return IntegrationBinaryStatus {
                binary_id: binary.id.to_owned(),
                display_name: binary.display_name.to_owned(),
                status: "not_found".to_owned(),
                version: None,
                probe: None,
            };
        };
        let args = binary
            .probe_args
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>();
        let probe = self.adapter.run_probe(&path, &args, PROBE_TIMEOUT_MS);
        if !probe.ok {
            return IntegrationBinaryStatus {
                binary_id: binary.id.to_owned(),
                display_name: binary.display_name.to_owned(),
                status: "probe_failed".to_owned(),
                version: None,
                probe: Some(IntegrationDiagnostic {
                    exit_code: probe.exit_code,
                    error_kind: probe.error_kind,
                    stdout_tail: None,
                    stderr_tail: non_empty(probe.stderr),
                }),
            };
        }
        IntegrationBinaryStatus {
            binary_id: binary.id.to_owned(),
            display_name: binary.display_name.to_owned(),
            status: "ready".to_owned(),
            version: parse_version(binary.version_parser, &probe.stdout),
            probe: None,
        }
    }

    fn resolve_system_backend(&self) -> (Option<ResolvedBackend>, IntegrationBackendStatus) {
        let (name, backend, unavailable) = match self.platform {
            Platform::MacOs => ("brew", "brew", "Homebrew was not found on PATH."),
            Platform::Windows => ("winget", "winget", "winget was not found on PATH."),
        };
        let path =
            self.adapter
                .resolve_executable(name, &self.env_path, self.platform, &self.path_ext);
        let resolved = path.as_ref().map(|path| match self.platform {
            Platform::MacOs => ResolvedBackend::Brew(path.clone()),
            Platform::Windows => ResolvedBackend::Winget(path.clone()),
        });
        (
            resolved,
            IntegrationBackendStatus {
                kind: "system-package-manager".to_owned(),
                backend: Some(backend.to_owned()),
                available: path.is_some(),
                unavailable_reason: path.is_none().then(|| unavailable.to_owned()),
            },
        )
    }

    fn resolve_python_backend(&self) -> (Option<ResolvedBackend>, IntegrationBackendStatus) {
        for (name, constructor) in [
            ("uv", ResolvedBackend::Uv as fn(PathBuf) -> ResolvedBackend),
            (
                "pipx",
                ResolvedBackend::Pipx as fn(PathBuf) -> ResolvedBackend,
            ),
        ] {
            if let Some(path) =
                self.adapter
                    .resolve_executable(name, &self.env_path, self.platform, &self.path_ext)
            {
                return (
                    Some(constructor(path)),
                    IntegrationBackendStatus {
                        kind: "python-cli-installer".to_owned(),
                        backend: Some(name.to_owned()),
                        available: true,
                        unavailable_reason: None,
                    },
                );
            }
        }
        (
            None,
            IntegrationBackendStatus {
                kind: "python-cli-installer".to_owned(),
                backend: None,
                available: false,
                unavailable_reason: Some("uv or pipx was not found on PATH.".to_owned()),
            },
        )
    }
}

fn first_binary_with_status<'a>(
    binaries: &'a [IntegrationBinaryStatus],
    status: &str,
) -> Option<&'a str> {
    binaries
        .iter()
        .find(|binary| binary.status == status)
        .map(|binary| binary.display_name.as_str())
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedPackageQuery {
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub unavailable_reason: Option<String>,
    pub query_diagnostic: Option<IntegrationDiagnostic>,
}

/// Parses the closed package-manager query output.
///
/// # Errors
///
/// Returns [`IntegrationError::Parse`] for malformed Brew JSON or an unknown
/// backend id.
pub fn parse_package_query(
    backend: &str,
    package: &str,
    stdout: &str,
) -> Result<ParsedPackageQuery, IntegrationError> {
    match backend {
        "brew" => {
            let value: serde_json::Value = serde_json::from_str(if stdout.is_empty() {
                r#"{"formulae":[]}"#
            } else {
                stdout
            })
            .map_err(|error| IntegrationError::Parse(error.to_string()))?;
            let formula = value
                .get("formulae")
                .and_then(serde_json::Value::as_array)
                .and_then(|entries| {
                    entries.iter().find(|entry| {
                        entry.get("name").and_then(serde_json::Value::as_str) == Some(package)
                    })
                });
            Ok(ParsedPackageQuery {
                installed_version: formula
                    .and_then(|entry| entry.get("installed_versions"))
                    .and_then(serde_json::Value::as_array)
                    .and_then(|versions| versions.first())
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                latest_version: formula
                    .and_then(|entry| entry.get("current_version"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                update_available: formula.is_some(),
                unavailable_reason: None,
                query_diagnostic: None,
            })
        }
        "winget" => {
            let line = stdout.lines().find(|line| line.contains(package));
            let Some(line) = line else {
                return Ok(ParsedPackageQuery {
                    unavailable_reason: (!contains_no_upgrade(stdout)).then(|| {
                        "Package manager does not report this package as installed.".to_owned()
                    }),
                    ..ParsedPackageQuery::default()
                });
            };
            let columns = line
                .split("  ")
                .map(str::trim)
                .filter(|column| !column.is_empty())
                .collect::<Vec<_>>();
            let installed_version = columns.get(2).map(|value| (*value).to_owned());
            let latest_version = columns.get(3).map(|value| (*value).to_owned());
            Ok(ParsedPackageQuery {
                update_available: installed_version.is_some()
                    && latest_version.is_some()
                    && installed_version != latest_version,
                installed_version,
                latest_version,
                unavailable_reason: None,
                query_diagnostic: None,
            })
        }
        _ => Err(IntegrationError::Parse(format!(
            "Unknown integration backend: {backend}"
        ))),
    }
}

fn contains_no_upgrade(stdout: &str) -> bool {
    let lowercase = stdout.to_ascii_lowercase();
    ["no available upgrade", "no applicable update", "no upgrade"]
        .iter()
        .any(|value| lowercase.contains(value))
}

#[must_use]
pub fn parse_version(parser: &str, stdout: &str) -> Option<String> {
    if matches!(parser, "exiftool" | "mediainfo") {
        return stdout
            .split(|character: char| character.is_whitespace() || character == ':')
            .map(|token| token.trim_start_matches('v'))
            .find(|token| version_like(token))
            .map(str::to_owned);
    }
    if parser == "imagemagick" {
        return stdout
            .split_whitespace()
            .skip_while(|token| !token.eq_ignore_ascii_case("ImageMagick"))
            .nth(1)
            .filter(|token| version_like(token))
            .map(|value| value.trim_end_matches(',').to_owned());
    }
    let lowercase = stdout.to_ascii_lowercase();
    let offset = lowercase.find("version ")? + "version ".len();
    stdout[offset..]
        .split_whitespace()
        .next()
        .map(|value| value.trim_end_matches(',').to_owned())
}

fn version_like(value: &str) -> bool {
    let value = value.trim_matches(|character: char| {
        !character.is_ascii_alphanumeric() && character != '.' && character != '-'
    });
    value.contains('.')
        && value
            .chars()
            .next()
            .is_some_and(|value| value.is_ascii_digit())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IntegrationError {
    Parse(String),
    ScanGenerationExhausted,
    StatePoisoned,
}

impl fmt::Display for IntegrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(message) => formatter.write_str(message),
            Self::ScanGenerationExhausted => {
                formatter.write_str("Integration scan generation is exhausted.")
            }
            Self::StatePoisoned => formatter.write_str("Integration state lock is poisoned."),
        }
    }
}

impl Error for IntegrationError {}
