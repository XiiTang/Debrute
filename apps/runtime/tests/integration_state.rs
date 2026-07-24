use std::{
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
};

use debrute_runtime::integrations::{
    CommandResult, IntegrationCatalog, IntegrationCommand, IntegrationOperation,
    IntegrationProcessAdapter, IntegrationService, Platform, ProbeResult, ResolvedBackend,
    build_operation_command, parse_package_query, parse_version,
};

#[test]
fn catalog_and_probe_contract_is_closed() {
    let catalog = IntegrationCatalog::bundled();
    assert_eq!(
        catalog.ids(),
        [
            "ffmpeg",
            "imagemagick",
            "mediainfo",
            "exiftool",
            "remove-ai-watermarks"
        ]
    );
    assert_eq!(
        catalog.get("ffmpeg").expect("ffmpeg should exist").binaries[0].probe_args,
        ["-version"]
    );
    assert_eq!(
        catalog
            .get("mediainfo")
            .expect("mediainfo should exist")
            .binaries[0]
            .probe_args,
        ["--Version"]
    );
    assert_eq!(
        catalog
            .get("exiftool")
            .expect("exiftool should exist")
            .binaries[0]
            .probe_args,
        ["-ver"]
    );
}

#[test]
fn backend_commands_are_exact_and_never_generic() {
    let catalog = IntegrationCatalog::bundled();
    let ffmpeg = catalog.get("ffmpeg").expect("ffmpeg should exist");
    let remove = catalog
        .get("remove-ai-watermarks")
        .expect("remove-ai-watermarks should exist");

    assert_eq!(
        build_operation_command(
            ffmpeg,
            &ResolvedBackend::Brew(PathBuf::from("/opt/homebrew/bin/brew")),
            IntegrationOperation::Install,
        )
        .expect("brew install should be available")
        .args,
        ["install", "--formula", "ffmpeg"]
    );
    assert_eq!(
        build_operation_command(
            ffmpeg,
            &ResolvedBackend::Winget(PathBuf::from("winget.exe")),
            IntegrationOperation::Update,
        )
        .expect("winget update should be available")
        .args,
        [
            "upgrade",
            "--id",
            "Gyan.FFmpeg",
            "--exact",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--disable-interactivity"
        ]
    );
    assert_eq!(
        build_operation_command(
            remove,
            &ResolvedBackend::Uv(PathBuf::from("/usr/local/bin/uv")),
            IntegrationOperation::Install,
        )
        .expect("uv install should be available")
        .args,
        [
            "tool",
            "install",
            "git+https://github.com/wiltodelta/remove-ai-watermarks.git"
        ]
    );
}

#[test]
fn version_and_package_query_parsers_match_current_fixtures() {
    assert_eq!(
        parse_version("ffmpeg", "ffmpeg version 7.1 Copyright"),
        Some("7.1".to_owned())
    );
    assert_eq!(
        parse_version("imagemagick", "Version: ImageMagick 7.1.1-30 Q16"),
        Some("7.1.1-30".to_owned())
    );
    assert_eq!(
        parse_version("exiftool", "13.10\n"),
        Some("13.10".to_owned())
    );

    let brew = parse_package_query(
        "brew",
        "ffmpeg",
        r#"{"formulae":[{"name":"ffmpeg","installed_versions":["7.0"],"current_version":"7.1"}]}"#,
    )
    .expect("brew output should parse");
    assert_eq!(brew.installed_version.as_deref(), Some("7.0"));
    assert_eq!(brew.latest_version.as_deref(), Some("7.1"));
    assert!(brew.update_available);
}

#[test]
fn rescan_reports_all_integrations_and_closed_backend_state() {
    let adapter = Arc::new(MissingProcessAdapter);
    let service = IntegrationService::new(Platform::MacOs, "", "", adapter);
    let view = service.rescan();
    assert_eq!(view.integrations.len(), 5);
    assert!(
        view.integrations
            .iter()
            .all(|entry| entry.status == "not_found")
    );
    assert_eq!(view.backends.len(), 2);
    assert!(view.backends.iter().all(|backend| !backend.available));
    assert!(view.running_operation.is_none());
    let json = serde_json::to_value(&view).expect("integration view should serialize");
    assert!(json.get("runningOperation").is_none());
    assert!(json["backends"][0].get("backend").is_some());
    assert!(json["backends"][0].get("unavailableReason").is_some());
    assert!(
        json["integrations"][0]["binaries"][0]
            .get("version")
            .is_none()
    );
    assert!(
        json["integrations"][0]["binaries"][0]
            .get("probe")
            .is_none()
    );
}

#[test]
fn install_operation_is_catalog_checked_and_publishes_the_settled_state() {
    let adapter = Arc::new(RecordingProcessAdapter::default());
    let service = IntegrationService::new(Platform::MacOs, "", "", adapter.clone());
    let initial = service.rescan();
    let ffmpeg = initial
        .integrations
        .iter()
        .find(|entry| entry.integration_id == "ffmpeg")
        .expect("ffmpeg should exist");
    assert_eq!(
        ffmpeg
            .operation_status
            .as_ref()
            .expect("operation status should exist")
            .available_operations,
        [IntegrationOperation::Install]
    );

    let result =
        service.run_operation_observed("ffmpeg", IntegrationOperation::Install, |_| {}, |_| {});
    assert!(result.ok);
    assert_eq!(result.integration_id, "ffmpeg");
    assert_eq!(result.operation, IntegrationOperation::Install);
    assert!(service.list_status().running_operation.is_none());
    assert!(adapter.commands().iter().any(|command| {
        command.file == std::path::Path::new("/opt/homebrew/bin/brew")
            && command.args == ["install", "--formula", "ffmpeg"]
    }));
}

#[test]
fn list_status_caches_detection_until_an_explicit_rescan() {
    let adapter = Arc::new(RecordingProcessAdapter::default());
    let service = IntegrationService::new(Platform::MacOs, "", "", adapter.clone());

    let _first = service.list_status();
    let first_resolution_count = adapter.resolution_count();
    let _cached = service.list_status();
    assert_eq!(adapter.resolution_count(), first_resolution_count);

    let _rescanned = service.rescan();
    assert!(adapter.resolution_count() > first_resolution_count);
}

#[test]
fn an_older_scan_cannot_replace_a_newer_cached_result() {
    let adapter = Arc::new(OutOfOrderScanAdapter::default());
    let service = Arc::new(IntegrationService::new(
        Platform::MacOs,
        "",
        "",
        adapter.clone(),
    ));
    let older_service = Arc::clone(&service);
    let older = thread::spawn(move || older_service.rescan());
    adapter.wait_until_older_scan_started();

    let newer = service.rescan();
    assert!(
        newer
            .backends
            .iter()
            .any(|backend| backend.backend.as_deref() == Some("brew") && backend.available)
    );

    adapter.release_older_scan();
    let older = older.join().expect("older scan thread should join");
    assert!(older.backends.iter().all(|backend| !backend.available));

    let cached = service.list_status();
    assert!(
        cached
            .backends
            .iter()
            .any(|backend| backend.backend.as_deref() == Some("brew") && backend.available)
    );
}

#[test]
fn a_second_operation_is_rejected_while_the_first_command_is_running() {
    let adapter = Arc::new(BlockingProcessAdapter::default());
    let service = Arc::new(IntegrationService::new(
        Platform::MacOs,
        "",
        "",
        adapter.clone(),
    ));
    let first_service = Arc::clone(&service);
    let first = thread::spawn(move || {
        first_service.run_operation_observed(
            "ffmpeg",
            IntegrationOperation::Install,
            |_| {},
            |_| {},
        )
    });
    adapter.wait_until_install_started();

    let second =
        service.run_operation_observed("ffmpeg", IntegrationOperation::Install, |_| {}, |_| {});
    assert!(!second.ok);
    assert_eq!(
        second
            .diagnostic
            .as_ref()
            .and_then(|diagnostic| diagnostic.error_kind.as_deref()),
        Some("operation_already_running")
    );
    assert_eq!(
        service
            .list_status()
            .running_operation
            .as_ref()
            .map(|running| (running.integration_id.as_str(), running.operation,)),
        Some(("ffmpeg", IntegrationOperation::Install))
    );

    adapter.release_install();
    assert!(first.join().expect("first operation thread should join").ok);
    assert_eq!(adapter.install_count(), 1);
}

#[test]
fn a_second_operation_is_rejected_while_the_first_is_still_validating() {
    let adapter = Arc::new(BlockingValidationAdapter::default());
    let service = Arc::new(IntegrationService::new(
        Platform::MacOs,
        "",
        "",
        adapter.clone(),
    ));
    let _warm = service.list_status();
    adapter.enable_blocking();

    let first_service = Arc::clone(&service);
    let first = thread::spawn(move || {
        first_service.run_operation_observed(
            "ffmpeg",
            IntegrationOperation::Install,
            |_| {},
            |_| {},
        )
    });
    adapter.wait_until_validation_started();
    let second =
        service.run_operation_observed("ffmpeg", IntegrationOperation::Install, |_| {}, |_| {});
    assert_eq!(
        second
            .diagnostic
            .as_ref()
            .and_then(|diagnostic| diagnostic.error_kind.as_deref()),
        Some("operation_already_running")
    );

    adapter.release_validation();
    assert!(first.join().expect("first operation thread should join").ok);
}

#[test]
fn unavailable_backends_return_the_existing_platform_diagnostic() {
    for (platform, integration_id, expected) in [
        (Platform::MacOs, "ffmpeg", "Homebrew was not found on PATH."),
        (Platform::Windows, "ffmpeg", "winget was not found on PATH."),
        (
            Platform::MacOs,
            "remove-ai-watermarks",
            "uv or pipx was not found on PATH.",
        ),
    ] {
        let service = IntegrationService::new(platform, "", "", Arc::new(MissingProcessAdapter));
        let result = service.run_operation_observed(
            integration_id,
            IntegrationOperation::Install,
            |_| {},
            |_| {},
        );
        assert_eq!(
            result
                .diagnostic
                .as_ref()
                .and_then(|diagnostic| diagnostic.error_kind.as_deref()),
            Some("backend_unavailable")
        );
        assert_eq!(
            result
                .diagnostic
                .as_ref()
                .and_then(|diagnostic| diagnostic.stderr_tail.as_deref()),
            Some(expected)
        );
    }
}

struct MissingProcessAdapter;

impl IntegrationProcessAdapter for MissingProcessAdapter {
    fn resolve_executable(
        &self,
        _name: &str,
        _env_path: &str,
        _platform: Platform,
        _path_ext: &str,
    ) -> Option<PathBuf> {
        None
    }

    fn run_probe(
        &self,
        _file: &std::path::Path,
        _args: &[String],
        _timeout_ms: u64,
    ) -> ProbeResult {
        panic!("missing executables must not be probed")
    }

    fn run_command(&self, _command: &IntegrationCommand) -> CommandResult {
        panic!("no integration operation was requested")
    }
}

#[derive(Default)]
struct OutOfOrderScanAdapter {
    state: Mutex<OutOfOrderScanState>,
    changed: Condvar,
}

#[derive(Default)]
struct OutOfOrderScanState {
    older_thread: Option<thread::ThreadId>,
    older_scan_started: bool,
    release_older_scan: bool,
}

impl OutOfOrderScanAdapter {
    fn wait_until_older_scan_started(&self) {
        let mut state = self.state.lock().expect("scan state should lock");
        while !state.older_scan_started {
            state = self
                .changed
                .wait(state)
                .expect("scan state should remain available");
        }
    }

    fn release_older_scan(&self) {
        let mut state = self.state.lock().expect("scan state should lock");
        state.release_older_scan = true;
        self.changed.notify_all();
    }
}

impl IntegrationProcessAdapter for OutOfOrderScanAdapter {
    fn resolve_executable(
        &self,
        name: &str,
        _env_path: &str,
        _platform: Platform,
        _path_ext: &str,
    ) -> Option<PathBuf> {
        let current_thread = thread::current().id();
        let mut state = self.state.lock().expect("scan state should lock");
        let older_thread = if let Some(older_thread) = state.older_thread {
            older_thread
        } else {
            state.older_thread = Some(current_thread);
            state.older_scan_started = true;
            self.changed.notify_all();
            while !state.release_older_scan {
                state = self
                    .changed
                    .wait(state)
                    .expect("scan state should remain available");
            }
            current_thread
        };
        if current_thread == older_thread {
            None
        } else {
            (name == "brew").then(|| PathBuf::from("/opt/homebrew/bin/brew"))
        }
    }

    fn run_probe(
        &self,
        _file: &std::path::Path,
        _args: &[String],
        _timeout_ms: u64,
    ) -> ProbeResult {
        panic!("missing integration binaries must not be probed")
    }

    fn run_command(&self, command: &IntegrationCommand) -> CommandResult {
        assert_eq!(command.args.first().map(String::as_str), Some("info"));
        CommandResult {
            ok: true,
            stdout: r#"{"formulae":[{"name":"ffmpeg","versions":{"stable":"7.1"}}]}"#.to_owned(),
            ..CommandResult::default()
        }
    }
}

#[derive(Default)]
struct RecordingProcessAdapter {
    commands: Mutex<Vec<IntegrationCommand>>,
    resolutions: AtomicUsize,
}

impl RecordingProcessAdapter {
    fn commands(&self) -> Vec<IntegrationCommand> {
        self.commands
            .lock()
            .expect("recording adapter should lock")
            .clone()
    }

    fn resolution_count(&self) -> usize {
        self.resolutions.load(Ordering::SeqCst)
    }
}

impl IntegrationProcessAdapter for RecordingProcessAdapter {
    fn resolve_executable(
        &self,
        name: &str,
        _env_path: &str,
        _platform: Platform,
        _path_ext: &str,
    ) -> Option<PathBuf> {
        self.resolutions.fetch_add(1, Ordering::SeqCst);
        match name {
            "brew" => Some(PathBuf::from("/opt/homebrew/bin/brew")),
            "uv" => Some(PathBuf::from("/usr/local/bin/uv")),
            _ => None,
        }
    }

    fn run_probe(
        &self,
        _file: &std::path::Path,
        _args: &[String],
        _timeout_ms: u64,
    ) -> ProbeResult {
        panic!("missing integration binaries must not be probed")
    }

    fn run_command(&self, command: &IntegrationCommand) -> CommandResult {
        self.commands
            .lock()
            .expect("recording adapter should lock")
            .push(command.clone());
        if command.args.first().is_some_and(|value| value == "info") {
            return CommandResult {
                ok: true,
                stdout: r#"{"formulae":[{"name":"ffmpeg","versions":{"stable":"7.1"}}]}"#
                    .to_owned(),
                ..CommandResult::default()
            };
        }
        CommandResult {
            ok: true,
            ..CommandResult::default()
        }
    }
}

#[derive(Default)]
struct BlockingProcessAdapter {
    state: Mutex<BlockingProcessState>,
    changed: Condvar,
}

#[derive(Default)]
struct BlockingProcessState {
    started: bool,
    released: bool,
    count: usize,
}

impl BlockingProcessAdapter {
    fn wait_until_install_started(&self) {
        let mut state = self.state.lock().expect("blocking state should lock");
        while !state.started {
            state = self
                .changed
                .wait(state)
                .expect("blocking state should remain available");
        }
    }

    fn release_install(&self) {
        let mut state = self.state.lock().expect("blocking state should lock");
        state.released = true;
        self.changed.notify_all();
    }

    fn install_count(&self) -> usize {
        self.state.lock().expect("blocking state should lock").count
    }
}

impl IntegrationProcessAdapter for BlockingProcessAdapter {
    fn resolve_executable(
        &self,
        name: &str,
        _env_path: &str,
        _platform: Platform,
        _path_ext: &str,
    ) -> Option<PathBuf> {
        match name {
            "brew" => Some(PathBuf::from("/opt/homebrew/bin/brew")),
            _ => None,
        }
    }

    fn run_probe(
        &self,
        _file: &std::path::Path,
        _args: &[String],
        _timeout_ms: u64,
    ) -> ProbeResult {
        panic!("missing integration binaries must not be probed")
    }

    fn run_command(&self, command: &IntegrationCommand) -> CommandResult {
        if command.args.first().is_some_and(|value| value == "info") {
            return CommandResult {
                ok: true,
                stdout: r#"{"formulae":[{"name":"ffmpeg","versions":{"stable":"7.1"}}]}"#
                    .to_owned(),
                ..CommandResult::default()
            };
        }
        if command.args.first().is_some_and(|value| value == "install") {
            let mut state = self.state.lock().expect("blocking state should lock");
            state.started = true;
            state.count += 1;
            self.changed.notify_all();
            while !state.released {
                state = self
                    .changed
                    .wait(state)
                    .expect("blocking state should remain available");
            }
        }
        CommandResult {
            ok: true,
            ..CommandResult::default()
        }
    }
}

#[derive(Default)]
struct BlockingValidationAdapter {
    blocking: AtomicBool,
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}

impl BlockingValidationAdapter {
    fn enable_blocking(&self) {
        self.blocking.store(true, Ordering::SeqCst);
    }

    fn wait_until_validation_started(&self) {
        let mut state = self.state.lock().expect("validation state should lock");
        while !state.0 {
            state = self
                .changed
                .wait(state)
                .expect("validation state should remain available");
        }
    }

    fn release_validation(&self) {
        let mut state = self.state.lock().expect("validation state should lock");
        state.1 = true;
        self.changed.notify_all();
    }
}

impl IntegrationProcessAdapter for BlockingValidationAdapter {
    fn resolve_executable(
        &self,
        name: &str,
        _env_path: &str,
        _platform: Platform,
        _path_ext: &str,
    ) -> Option<PathBuf> {
        if name == "brew" && self.blocking.load(Ordering::SeqCst) {
            let mut state = self.state.lock().expect("validation state should lock");
            state.0 = true;
            self.changed.notify_all();
            while !state.1 {
                state = self
                    .changed
                    .wait(state)
                    .expect("validation state should remain available");
            }
        }
        (name == "brew").then(|| PathBuf::from("/opt/homebrew/bin/brew"))
    }

    fn run_probe(
        &self,
        _file: &std::path::Path,
        _args: &[String],
        _timeout_ms: u64,
    ) -> ProbeResult {
        panic!("missing integration binaries must not be probed")
    }

    fn run_command(&self, command: &IntegrationCommand) -> CommandResult {
        if command.args.first().is_some_and(|value| value == "info") {
            return CommandResult {
                ok: true,
                stdout: r#"{"formulae":[{"name":"ffmpeg","versions":{"stable":"7.1"}}]}"#
                    .to_owned(),
                ..CommandResult::default()
            };
        }
        CommandResult {
            ok: true,
            ..CommandResult::default()
        }
    }
}
