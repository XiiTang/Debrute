#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use std::{error::Error, ffi::OsString, process::ExitCode};

#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::{
    fs, io,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
use debrute_runtime::control::endpoint::{MacOsControlEndpoint, MacOsControlOwner};
#[cfg(target_os = "windows")]
use debrute_runtime::control::endpoint::{WindowsControlEndpoint, WindowsControlOwner};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use debrute_runtime::{
    cli::RuntimeCliService,
    control::{
        ActivationIntent, ActivationOutcome, CONTROL_OUTBOUND_QUEUE_CAPACITY, ClientRole,
        ControlErrorCode, ControlRequest, DesktopOpenError, NativeControlClient, ProjectFrontend,
        RuntimeActionError, RuntimeActivationService, RuntimeControlState, WorkbenchRoute,
        endpoint::{
            ControlEndpointAdapter, ControlEndpointOwnerAdapter, EndpointClaim, EndpointError,
        },
        serve_control_connection,
    },
    login::require_stable_runtime_entrypoint,
    product::{
        CommitPhase, CommitPlatform, DesktopHostRegistration, NativeUpdatePlatform,
        ProductBootstrap, ProductCommitCoordinator, ProductCommitError, ProductStore,
        ProductUpdateFailureStage, ReleaseArchitecture, ReleasePlatform, ResumeIntent,
        RuntimeProductService, launch_product_update_failure, read_desktop_host_registration,
    },
    project::{
        NATIVE_TRASH_WORKER_COMMAND, initialize_raster_preview_engine, run_native_trash_worker,
    },
    workbench::{
        RuntimeCliHttpService, RuntimeProductHttpService, WorkbenchHttpServer,
        WorkbenchRuntimeServices, build_project_workbench_url,
    },
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use uuid::Uuid;

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod tray;

#[cfg(any(target_os = "macos", target_os = "windows"))]
const STARTUP_WAIT: Duration = Duration::from_secs(5);
#[cfg(any(target_os = "macos", target_os = "windows"))]
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(any(target_os = "macos", target_os = "windows"))]
const RUNTIME_READY_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(any(target_os = "macos", target_os = "windows"))]
const SUPERVISION_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(any(target_os = "macos", target_os = "windows"))]
const WEB_ASSETS_DIRECTORY_ENV: &str = "DEBRUTE_RUNTIME_WEB_ASSETS_DIR";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const DESKTOP_ENTRYPOINT_ENV: &str = "DEBRUTE_DESKTOP_ENTRYPOINT";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const DESKTOP_ARGUMENTS_ENV: &str = "DEBRUTE_DESKTOP_ARGUMENTS_JSON";

#[cfg(target_os = "macos")]
type PlatformControlEndpoint = MacOsControlEndpoint;
#[cfg(target_os = "macos")]
type PlatformControlOwner = MacOsControlOwner;
#[cfg(target_os = "windows")]
type PlatformControlEndpoint = WindowsControlEndpoint;
#[cfg(target_os = "windows")]
type PlatformControlOwner = WindowsControlOwner;

fn main() -> ExitCode {
    install_runtime_panic_abort_hook();
    let command = std::env::args_os().nth(1);
    if command.as_deref() == Some(std::ffi::OsStr::new(NATIVE_TRASH_WORKER_COMMAND)) {
        let arguments = std::env::args_os().skip(2).collect::<Vec<_>>();
        return match run_native_trash_worker(&arguments) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("Debrute Runtime failed: {error}");
                ExitCode::FAILURE
            }
        };
    }
    #[cfg(target_os = "windows")]
    if let Some(result) = debrute_runtime::terminal::run_windows_terminal_bootstrap() {
        match result {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("Debrute Terminal bootstrap failed: {error}");
                return ExitCode::FAILURE;
            }
        }
    }
    let result = if command.as_deref() == Some(std::ffi::OsStr::new("bootstrap")) {
        let arguments = std::env::args_os().skip(2).collect::<Vec<_>>();
        run_bootstrap(&arguments)
    } else if command.as_deref() == Some(std::ffi::OsStr::new("preflight-desktop-seed")) {
        let arguments = std::env::args_os().skip(2).collect::<Vec<_>>();
        run_preflight_desktop_seed(&arguments)
    } else if command.as_deref() == Some(std::ffi::OsStr::new("complete-product-update")) {
        let arguments = std::env::args_os().skip(2).collect::<Vec<_>>();
        run_complete_product_update(&arguments)
    } else if command.as_deref() == Some(std::ffi::OsStr::new("read-product-update-failure")) {
        let arguments = std::env::args_os().skip(2).collect::<Vec<_>>();
        run_read_product_update_failure(&arguments)
    } else {
        let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
        run(&arguments)
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if is_target_runtime_update_command(command.as_deref())
                && let Err(report_error) = report_target_runtime_update_failure(error.as_ref())
            {
                eprintln!(
                    "Debrute could not publish the Product-update failure surface: {report_error}"
                );
            }
            eprintln!("Debrute Runtime failed: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn is_target_runtime_update_command(command: Option<&std::ffi::OsStr>) -> bool {
    std::env::var_os("DEBRUTE_COMPLETE_PRODUCT_UPDATE").is_some()
        && matches!(
            command,
            Some(value)
                if value == "--stable-runtime-entrypoint"
                    || value == "complete-product-update"
        )
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn report_target_runtime_update_failure(
    error: &(dyn Error + 'static),
) -> Result<(), Box<dyn Error>> {
    let Some(expected_version) = std::env::var_os("DEBRUTE_COMPLETE_PRODUCT_UPDATE") else {
        return Ok(());
    };
    let expected_version = expected_version
        .into_string()
        .map_err(|_| "Product completion version must be UTF-8")?;
    let debrute_home = debrute_home()?;
    let store = ProductStore::new(
        debrute_home.join("products"),
        current_commit_platform(),
        current_release_architecture()?,
    );
    let pending = store
        .pending()?
        .ok_or("Target Runtime failure has no pending Product update")?;
    if pending.target_version != expected_version {
        return Err("Target Runtime failure does not match the pending Product version".into());
    }
    if pending.phase != CommitPhase::CurrentSelected {
        return Ok(());
    }
    let desktop = desktop_host_from_environment()?
        .or(read_desktop_host_registration(&debrute_home)?)
        .ok_or("Target Runtime failure has no registered Desktop host")?;
    persist_and_launch_product_update_failure(
        &store,
        &desktop,
        &pending.transaction_id,
        ProductUpdateFailureStage::Committing,
        format!("Target Runtime did not become Ready: {error}"),
    )
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn persist_and_launch_product_update_failure(
    store: &ProductStore,
    desktop: &DesktopHostRegistration,
    transaction_id: &str,
    stage: ProductUpdateFailureStage,
    message: String,
) -> Result<(), Box<dyn Error>> {
    store.record_product_update_failure(transaction_id, stage, message)?;
    launch_product_update_failure(desktop, transaction_id)?;
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run_preflight_desktop_seed(arguments: &[OsString]) -> Result<(), Box<dyn Error>> {
    let parsed = SeedPreflightArguments::parse(arguments)?;
    let store = ProductStore::new(
        parsed.product_root,
        current_commit_platform(),
        current_release_architecture()?,
    );
    let identity = store.preflight_desktop_seed(&parsed.seed)?;
    println!("product_version={}", identity.product_version());
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run_read_product_update_failure(arguments: &[OsString]) -> Result<(), Box<dyn Error>> {
    let [
        product_root_flag,
        product_root,
        transaction_flag,
        transaction_id,
    ] = arguments
    else {
        return Err(
            "Product update failure probe requires --product-root PATH --transaction-id ID".into(),
        );
    };
    if product_root_flag != "--product-root" || transaction_flag != "--transaction-id" {
        return Err(
            "Product update failure probe requires --product-root PATH --transaction-id ID".into(),
        );
    }
    let product_root = PathBuf::from(product_root);
    if !product_root.is_absolute() {
        return Err("Product update failure product root must be absolute".into());
    }
    let transaction_id = transaction_id
        .to_str()
        .ok_or("Product update failure transaction ID must be UTF-8")?;
    let store = ProductStore::new(
        product_root,
        current_commit_platform(),
        current_release_architecture()?,
    );
    println!(
        "{}",
        serde_json::to_string(&store.product_update_failure(transaction_id)?)?
    );
    Ok(())
}

fn install_runtime_panic_abort_hook() {
    let report = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        report(panic);
        std::process::abort();
    }));
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run(arguments: &[OsString]) -> Result<(), Box<dyn Error>> {
    let stable_runtime_entrypoint = stable_runtime_entrypoint(arguments)?;
    let ready_deadline = Instant::now() + RUNTIME_READY_TIMEOUT;
    let endpoint = platform_control_endpoint()?;
    match endpoint.claim_or_connect(STARTUP_WAIT, HANDSHAKE_TIMEOUT)? {
        EndpointClaim::Owner(owner) => {
            let state = Arc::new(RuntimeControlState::new_with_executable_identity(
                Uuid::new_v4().to_string(),
                runtime_executable_identity(),
            ));
            serve_owned_runtime(owner, &state, &endpoint, &stable_runtime_entrypoint)
        }
        EndpointClaim::Existing(connection) => {
            let mut client = NativeControlClient::handshake_and_clear_timeouts(
                connection,
                ClientRole::Launcher,
                ready_deadline,
            )?;
            let _response = client.wait_ready_and_request_until(
                ready_deadline,
                Uuid::new_v4().to_string(),
                ControlRequest::Activate {
                    intent: ActivationIntent::EnsureRuntime,
                    preferred_desktop_window_key: None,
                },
            )?;
            Ok(())
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run_bootstrap(arguments: &[OsString]) -> Result<(), Box<dyn Error>> {
    let parsed = BootstrapArguments::parse(arguments)?;
    let debrute_home = parsed
        .product_root
        .parent()
        .ok_or("Product root must have a parent")?
        .to_owned();
    let user_home = debrute_home
        .parent()
        .ok_or("Debrute home must have a parent")?;
    let store = Arc::new(ProductStore::new(
        parsed.product_root,
        current_commit_platform(),
        current_release_architecture()?,
    ));
    let bootstrap = ProductBootstrap::new(
        Arc::clone(&store),
        parsed.bin_directory,
        user_home.join(".agents/skills"),
        debrute_home,
    );
    let stable_runtime_entrypoint = bootstrap.stable_runtime_entrypoint();
    let activated = bootstrap.activate(&parsed.seed, parsed.desktop.as_ref())?;
    if let Some(pending) = store.pending()? {
        if pending.phase == CommitPhase::Staged && activated.product_version == pending.from_version
        {
            // The prior native install failed before its durable boundary.
            // Start the still-current Runtime and require an explicit update
            // request to continue; bootstrap must not retry the operation.
        } else {
            let desktop = parsed
                .desktop
                .clone()
                .ok_or("Pending Product recovery requires the installed Desktop identity")?;
            let failure_desktop = desktop.clone();
            let platform = NativeUpdatePlatform::for_desktop_seed(
                Arc::clone(&store),
                &parsed.seed,
                desktop,
                stable_runtime_entrypoint.clone(),
                Arc::new(|_, _| {
                    Err(debrute_runtime::product::ProductCommitError::Platform(
                        "Bootstrap process cannot dispatch a Ready continuation".to_owned(),
                    ))
                }),
            )?;
            if pending.phase == CommitPhase::RuntimeReady {
                if let Err(error) = platform.launch_selected_runtime(&pending.target_version) {
                    persist_and_launch_product_update_failure(
                        &store,
                        &failure_desktop,
                        &pending.transaction_id,
                        ProductUpdateFailureStage::RuntimeReady,
                        format!("Ready Product could not relaunch its selected Runtime: {error}"),
                    )?;
                    return Err(error.into());
                }
                return Ok(());
            }
            let coordinator = ProductCommitCoordinator::new(Arc::clone(&store), platform);
            if let Err(error) = coordinator.continue_commit() {
                persist_and_launch_product_update_failure(
                    &store,
                    &failure_desktop,
                    &pending.transaction_id,
                    ProductUpdateFailureStage::Committing,
                    format!("Pending Product recovery could not continue: {error}"),
                )?;
                return Err(error.into());
            }
            return Ok(());
        }
    }
    let mut command = Command::new(&activated.runtime_entrypoint);
    #[cfg(target_os = "windows")]
    command
        .arg("--stable-runtime-entrypoint")
        .arg(&stable_runtime_entrypoint);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env(WEB_ASSETS_DIRECTORY_ENV, &activated.web_assets)
        .env("DEBRUTE_ACTIVE_PRODUCT_DIR", &activated.directory);
    if let Some(desktop) = parsed.desktop {
        command.env(DESKTOP_ENTRYPOINT_ENV, desktop.executable).env(
            DESKTOP_ARGUMENTS_ENV,
            serde_json::to_string(&desktop.arguments)?,
        );
    }
    command.spawn()?;
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run_complete_product_update(arguments: &[OsString]) -> Result<(), Box<dyn Error>> {
    let [version_flag, version, entrypoint_flag, entrypoint] = arguments else {
        return Err("Product update completion requires --product-version VERSION --stable-runtime-entrypoint PATH".into());
    };
    if version_flag != "--product-version" {
        return Err("Product update completion requires --product-version".into());
    }
    let version = version
        .to_str()
        .ok_or("Product update version must be UTF-8")?;
    semver::Version::parse(version)?;
    let stable_runtime_entrypoint =
        stable_runtime_entrypoint(&[entrypoint_flag.clone(), entrypoint.clone()])?;
    // This is ownership handoff, not an automatic operation retry: the target
    // process waits only for the old Runtime to release the one Control owner.
    let deadline = std::time::Instant::now() + Duration::from_mins(2);
    let endpoint = platform_control_endpoint()?;
    loop {
        match endpoint.claim_or_connect(Duration::from_millis(100), HANDSHAKE_TIMEOUT) {
            Ok(EndpointClaim::Owner(owner)) => {
                let state = Arc::new(RuntimeControlState::new_with_executable_identity(
                    Uuid::new_v4().to_string(),
                    runtime_executable_identity(),
                ));
                return serve_owned_runtime(owner, &state, &endpoint, &stable_runtime_entrypoint);
            }
            Ok(EndpointClaim::Existing(connection)) => drop(connection),
            Err(EndpointError::StartupTimedOut) => {}
            Err(error) => return Err(error.into()),
        }
        if std::time::Instant::now() >= deadline {
            return Err("Timed out waiting for the previous Runtime to release Control".into());
        }
        thread::sleep(SUPERVISION_POLL_INTERVAL);
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn runtime_executable_identity() -> Option<String> {
    let metadata = std::fs::metadata(std::env::current_exe().ok()?).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(format!("{}:{}", metadata.len(), modified.as_nanos()))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct BootstrapArguments {
    seed: PathBuf,
    product_root: PathBuf,
    bin_directory: PathBuf,
    desktop: Option<DesktopHostRegistration>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct SeedPreflightArguments {
    seed: PathBuf,
    product_root: PathBuf,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SeedPreflightArguments {
    fn parse(arguments: &[OsString]) -> Result<Self, Box<dyn Error>> {
        let mut seed = None;
        let mut product_root = None;
        let mut index = 0;
        while index < arguments.len() {
            let flag = arguments[index]
                .to_str()
                .ok_or("Product seed preflight option names must be UTF-8")?;
            let value = arguments
                .get(index + 1)
                .ok_or_else(|| format!("Product seed preflight option {flag} requires a value"))?;
            match flag {
                "--seed" => seed = Some(PathBuf::from(value)),
                "--product-root" => product_root = Some(PathBuf::from(value)),
                _ => {
                    return Err(format!("Unsupported Product seed preflight option: {flag}").into());
                }
            }
            index += 2;
        }
        let seed = seed.ok_or("Product seed preflight requires --seed")?;
        let product_root = product_root.ok_or("Product seed preflight requires --product-root")?;
        if !seed.is_absolute() || !product_root.is_absolute() {
            return Err("Product seed preflight paths must be absolute".into());
        }
        Ok(Self { seed, product_root })
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl BootstrapArguments {
    fn parse(arguments: &[OsString]) -> Result<Self, Box<dyn Error>> {
        let mut seed = None;
        let mut product_root = None;
        let mut bin_directory = None;
        let mut desktop_entrypoint = None;
        let mut desktop_arguments = Vec::new();
        let mut index = 0;
        while index < arguments.len() {
            let flag = arguments[index]
                .to_str()
                .ok_or("Bootstrap option names must be UTF-8")?;
            let value = arguments
                .get(index + 1)
                .ok_or_else(|| format!("Bootstrap option {flag} requires a value"))?;
            match flag {
                "--seed" => seed = Some(PathBuf::from(value)),
                "--product-root" => product_root = Some(PathBuf::from(value)),
                "--bin-directory" => bin_directory = Some(PathBuf::from(value)),
                "--desktop-entrypoint" => desktop_entrypoint = Some(PathBuf::from(value)),
                "--desktop-arguments-json" => {
                    desktop_arguments = serde_json::from_str(
                        value
                            .to_str()
                            .ok_or("Desktop arguments JSON must be UTF-8")?,
                    )?;
                }
                _ => return Err(format!("Unsupported Product bootstrap option: {flag}").into()),
            }
            index += 2;
        }
        let seed = seed.ok_or("Product bootstrap requires --seed")?;
        let product_root = product_root.ok_or("Product bootstrap requires --product-root")?;
        let bin_directory = bin_directory.ok_or("Product bootstrap requires --bin-directory")?;
        if !seed.is_absolute() || !product_root.is_absolute() || !bin_directory.is_absolute() {
            return Err("Product bootstrap paths must be absolute".into());
        }
        if desktop_entrypoint.is_none() && !desktop_arguments.is_empty() {
            return Err("Desktop arguments require --desktop-entrypoint".into());
        }
        let desktop = desktop_entrypoint.map(|executable| DesktopHostRegistration {
            executable,
            arguments: desktop_arguments,
        });
        Ok(Self {
            seed,
            product_root,
            bin_directory,
            desktop,
        })
    }
}

#[cfg(target_os = "macos")]
const fn current_commit_platform() -> CommitPlatform {
    CommitPlatform::Macos
}

#[cfg(target_os = "windows")]
const fn current_commit_platform() -> CommitPlatform {
    CommitPlatform::Windows
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn current_release_architecture() -> io::Result<ReleaseArchitecture> {
    match std::env::consts::ARCH {
        "aarch64" => Ok(ReleaseArchitecture::Arm64),
        "x86_64" => Ok(ReleaseArchitecture::X64),
        architecture => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("Unsupported Product architecture: {architecture}"),
        )),
    }
}

#[cfg(target_os = "macos")]
const fn current_release_platform() -> ReleasePlatform {
    ReleasePlatform::Macos
}

#[cfg(target_os = "windows")]
const fn current_release_platform() -> ReleasePlatform {
    ReleasePlatform::Windows
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn active_product_directory(debrute_home: &std::path::Path) -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("DEBRUTE_ACTIVE_PRODUCT_DIR").map(PathBuf::from)
        && runtime_matches_product_directory(&configured)
    {
        return Some(configured);
    }
    let current = debrute_home.join("products/current");
    runtime_matches_product_directory(&current).then_some(current)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn runtime_matches_product_directory(directory: &std::path::Path) -> bool {
    if !directory.join("product-manifest.json").is_file() {
        return false;
    }
    let runtime = directory.join(product_runtime_relative_path());
    let Ok(current_executable) = std::env::current_exe().and_then(fs::canonicalize) else {
        return false;
    };
    fs::canonicalize(runtime).is_ok_and(|product_runtime| product_runtime == current_executable)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
const fn product_runtime_relative_path() -> &'static str {
    if cfg!(target_os = "windows") {
        "runtime/debrute-runtime.exe"
    } else {
        "runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime"
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn desktop_host_from_environment() -> Result<Option<DesktopHostRegistration>, io::Error> {
    let Some(executable) = std::env::var_os(DESKTOP_ENTRYPOINT_ENV).map(PathBuf::from) else {
        return Ok(None);
    };
    let arguments = match std::env::var(DESKTOP_ARGUMENTS_ENV) {
        Ok(value) => serde_json::from_str::<Vec<String>>(&value).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{DESKTOP_ARGUMENTS_ENV} must be a JSON array of strings: {error}"),
            )
        })?,
        Err(std::env::VarError::NotPresent) => Vec::new(),
        Err(error) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{DESKTOP_ARGUMENTS_ENV} is invalid: {error}"),
            ));
        }
    };
    Ok(Some(DesktopHostRegistration {
        executable,
        arguments,
    }))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn serve_owned_runtime(
    owner: PlatformControlOwner,
    state: &Arc<RuntimeControlState>,
    endpoint: &PlatformControlEndpoint,
    stable_runtime_entrypoint: &std::path::Path,
) -> Result<(), Box<dyn Error>> {
    let stop_accepting = Arc::new(AtomicBool::new(false));
    let service_state = Arc::clone(state);
    let service_stop_accepting = Arc::clone(&stop_accepting);
    let service_endpoint = endpoint.clone();
    let service_stable_runtime_entrypoint = stable_runtime_entrypoint.to_owned();
    let result = tray::run(state, stable_runtime_entrypoint, move || {
        run_runtime_services(
            owner,
            &service_state,
            &service_stop_accepting,
            &service_endpoint,
            &service_stable_runtime_entrypoint,
        )
    });
    state.close_connections();
    result.map_err(|error| -> Box<dyn Error> { error })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn stable_runtime_entrypoint(arguments: &[OsString]) -> Result<PathBuf, Box<dyn Error>> {
    let [flag, path] = arguments else {
        return Err("Runtime requires --stable-runtime-entrypoint PATH".into());
    };
    if flag != "--stable-runtime-entrypoint" {
        return Err("Runtime requires --stable-runtime-entrypoint".into());
    }
    require_stable_runtime_entrypoint(PathBuf::from(path)).map_err(Into::into)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run_runtime_services(
    owner: PlatformControlOwner,
    state: &Arc<RuntimeControlState>,
    stop_accepting: &Arc<AtomicBool>,
    endpoint: &PlatformControlEndpoint,
    stable_runtime_entrypoint: &std::path::Path,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let (endpoint_failure_sender, endpoint_failure_receiver) = mpsc::sync_channel(1);
    let accept_worker = spawn_control_accept_worker(
        owner,
        Arc::clone(state),
        Arc::clone(stop_accepting),
        endpoint_failure_sender,
    )?;
    let mut shutdown_services = None;
    let mut shutdown_workbench = None;

    let service_result = (|| {
        initialize_raster_preview_engine().map_err(io::Error::other)?;
        let debrute_home = debrute_home()?;
        let active_product = active_product_directory(&debrute_home);
        let runtime_services = WorkbenchRuntimeServices::compose(&debrute_home, Arc::clone(state))
            .map_err(|error| io::Error::other(error.message))?;
        shutdown_services = Some(Arc::clone(&runtime_services));
        let assets_directory = std::env::var_os(WEB_ASSETS_DIRECTORY_ENV)
            .map(PathBuf::from)
            .or_else(|| active_product.as_ref().map(|product| product.join("web")))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("{WEB_ASSETS_DIRECTORY_ENV} is required"),
                )
            })?;
        let mut product: Option<Arc<dyn RuntimeProductHttpService>> = None;
        let mut product_scheduler: Option<Arc<RuntimeProductService>> = None;
        let mut update_platform = None;
        if let Some(active_product) = active_product.as_ref() {
            let store = Arc::new(ProductStore::new(
                debrute_home.join("products"),
                current_commit_platform(),
                current_release_architecture()?,
            ));
            let current_version = store.current_version()?.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "Active Product has no current version",
                )
            })?;
            let running_product = fs::canonicalize(active_product)?;
            let running_version = running_product
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Active Product version directory is invalid",
                    )
                })?
                .to_owned();
            let pending = store.pending()?;
            let running_identity_is_valid = current_version == running_version
                || pending.as_ref().is_some_and(|pending| {
                    matches!(
                        pending.phase,
                        CommitPhase::CurrentSelected | CommitPhase::RuntimeReady
                    ) && pending.from_version == running_version
                        && pending.target_version == current_version
                });
            if !running_identity_is_valid {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Running Product identity does not match current or its pending recovery",
                )
                .into());
            }
            let desktop = match desktop_host_from_environment()? {
                Some(desktop) => Some(desktop),
                None => read_desktop_host_registration(&debrute_home)?,
            }
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "Packaged Product has no Desktop host registration",
                )
            })?;
            let resume_state = Arc::clone(state);
            let native = NativeUpdatePlatform::for_runtime(
                Arc::clone(&store),
                &running_version,
                desktop,
                stable_runtime_entrypoint.to_owned(),
                Arc::new(move |transaction_id, intent| {
                    resume_product_surface(transaction_id, intent, &resume_state)
                }),
            )?;
            let product_service = RuntimeProductService::official(
                running_version,
                current_release_platform(),
                current_release_architecture()?,
                debrute_home.clone(),
                Arc::clone(&store),
                native.clone(),
                Arc::clone(state),
                Arc::clone(runtime_services.global()),
            )
            .map_err(|error| io::Error::other(error.message))?;
            product_scheduler = Some(Arc::clone(&product_service));
            product = Some(product_service);
            update_platform = Some((store, native));
        }
        let cli: Arc<dyn RuntimeCliHttpService> = Arc::new(RuntimeCliService::new(
            Arc::clone(runtime_services.models()),
            Arc::clone(runtime_services.global()),
            runtime_services.projects().clone(),
            Arc::clone(runtime_services.provenance()),
            Arc::clone(runtime_services.model_operations()),
            active_product.clone(),
        ));
        shutdown_workbench = Some(WorkbenchHttpServer::start(
            assets_directory,
            Arc::clone(state),
            Arc::clone(&runtime_services),
            cli,
            product,
        )?);
        let workbench = shutdown_workbench
            .as_mut()
            .expect("Workbench HTTP server was just installed");
        state.install_workbench(workbench.launch_service())?;
        let activation: Arc<dyn RuntimeActivationService> = Arc::new(PlatformRuntimeActivation {
            state: Arc::clone(state),
            desktop_launch: Mutex::new(()),
        });
        if !state.install_activation_service(activation) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Runtime activation service was already installed",
            )
            .into());
        }
        workbench.check_running()?;
        let requested_completion = std::env::var_os("DEBRUTE_COMPLETE_PRODUCT_UPDATE")
            .map(|expected_version| {
                expected_version.into_string().map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Product completion version must be UTF-8",
                    )
                })
            })
            .transpose()?;
        let recovered_completion = if let Some((store, _)) = update_platform.as_ref() {
            store
                .pending()?
                .filter(|pending| {
                    matches!(
                        pending.phase,
                        CommitPhase::CurrentSelected | CommitPhase::RuntimeReady
                    )
                })
                .map(|pending| pending.target_version)
        } else {
            None
        };
        if let Some(expected_version) = requested_completion.or(recovered_completion) {
            if semver::Version::parse(&expected_version).is_err() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Product completion version is invalid",
                )
                .into());
            }
            let (store, native) = update_platform.as_ref().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "Product completion requires an active Product",
                )
            })?;
            let current = store.current_version()?.ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "Current Product is missing")
            })?;
            if current != expected_version {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Product completion version does not match current",
                )
                .into());
            }
            let user_home = debrute_home.parent().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "Debrute home has no user home")
            })?;
            ProductBootstrap::new(
                Arc::clone(store),
                debrute_home.join("bin"),
                user_home.join(".agents/skills"),
                debrute_home.clone(),
            )
            .finalize_current(None)?;
            if state.finish_startup() {
                let completion = ProductCommitCoordinator::new(Arc::clone(store), native.clone())
                    .complete_ready();
                match completion {
                    Ok(()) => {
                        if let Some(product) = &product_scheduler {
                            product.mark_startup_ready();
                        }
                    }
                    Err(error) => {
                        eprintln!(
                            "Debrute Product Ready finalization failed and remains retryable: {error}"
                        );
                        let reached_ready = match store.pending() {
                            Ok(None) => true,
                            Ok(Some(pending)) => pending.phase == CommitPhase::RuntimeReady,
                            Err(_) => false,
                        };
                        if let Some(product) = &product_scheduler {
                            if reached_ready {
                                product.mark_startup_ready();
                            } else {
                                product.mark_startup_failure(
                                    expected_version.clone(),
                                    error.to_string(),
                                );
                            }
                        }
                    }
                }
            }
        } else {
            state.finish_startup();
        }

        loop {
            workbench.check_running()?;
            if let Some(product) = &product_scheduler {
                product.poll_automatic_discovery();
            }
            if state.is_stopping() {
                return Ok(());
            }
            match endpoint_failure_receiver.recv_timeout(SUPERVISION_POLL_INTERVAL) {
                Ok(endpoint_error) => return Err(endpoint_error.into()),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "Debrute Control accept loop stopped without an error",
                    )
                    .into());
                }
            }
        }
    })();

    if let Some(runtime_services) = shutdown_services.as_ref() {
        runtime_services.close_workbench_connection_admission();
    }
    if let Some(workbench) = shutdown_workbench.as_mut() {
        workbench.stop_accepting();
    }
    if let Some(runtime_services) = shutdown_services.as_ref() {
        runtime_services.close_all_workbench_connections();
    }
    if let Some(workbench) = shutdown_workbench.as_mut() {
        workbench.join();
    }
    drop(shutdown_workbench.take());
    if let Some(runtime_services) = shutdown_services.take() {
        runtime_services.finish_workbench_connection_closer();
        runtime_services.shutdown_owned_work();
        drop(runtime_services);
    }

    stop_accepting.store(true, Ordering::Release);
    if !stop_control_accept_worker(endpoint, &accept_worker) {
        return Err("Debrute Control accept worker did not stop".into());
    }
    accept_worker
        .join()
        .expect("Debrute Control accept worker panicked");
    service_result
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn resume_product_surface(
    _transaction_id: &str,
    intent: &ResumeIntent,
    state: &Arc<RuntimeControlState>,
) -> Result<(), ProductCommitError> {
    match intent {
        ResumeIntent::Browser => state
            .activate_intent(&ActivationIntent::OpenBrowser, None)
            .map(|_| ())
            .map_err(|error| {
                ProductCommitError::Platform(format!("browser resume failed: {error:?}"))
            }),
        ResumeIntent::Desktop => state
            .activate_intent(&ActivationIntent::OpenDesktop, None)
            .map(|_| ())
            .map_err(|error| {
                ProductCommitError::Platform(format!("Desktop resume failed: {error:?}"))
            }),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
struct PlatformRuntimeActivation {
    state: Arc<RuntimeControlState>,
    desktop_launch: Mutex<()>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl RuntimeActivationService for PlatformRuntimeActivation {
    fn activate(
        &self,
        intent: &ActivationIntent,
        preferred_desktop_window_key: Option<&str>,
    ) -> Result<ActivationOutcome, ControlErrorCode> {
        match intent {
            ActivationIntent::EnsureRuntime => Ok(ActivationOutcome::Ensured),
            ActivationIntent::OpenDesktop => self.open_desktop(),
            ActivationIntent::OpenBrowser => self.open_browser(&WorkbenchRoute::Root),
            ActivationIntent::OpenProject {
                project_root,
                frontend,
            } => match frontend {
                ProjectFrontend::Desktop => {
                    self.open_desktop_project(project_root, preferred_desktop_window_key)
                }
                ProjectFrontend::Browser => self.open_browser_project(project_root),
            },
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl PlatformRuntimeActivation {
    fn open_desktop_project(
        &self,
        project_root: &str,
        preferred_window_key: Option<&str>,
    ) -> Result<ActivationOutcome, ControlErrorCode> {
        let _launch = self
            .desktop_launch
            .lock()
            .expect("Desktop launch lock poisoned");
        if !self.state.has_desktop_host() {
            Self::launch_desktop_host(Some(project_root))?;
            return Ok(ActivationOutcome::Opened);
        }
        self.state
            .request_desktop_project_open(project_root, preferred_window_key)
            .map(|()| ActivationOutcome::Opened)
            .map_err(|_| ControlErrorCode::DesktopUnavailable)
    }

    fn open_desktop(&self) -> Result<ActivationOutcome, ControlErrorCode> {
        let _launch = self
            .desktop_launch
            .lock()
            .expect("Desktop launch lock poisoned");
        match self.state.open_desktop_window() {
            Err(DesktopOpenError::HostUnavailable) => {
                Self::launch_desktop_host(None)?;
                Ok(ActivationOutcome::Opened)
            }
            Ok(()) => Ok(ActivationOutcome::Opened),
            Err(DesktopOpenError::Outbound(_)) => Err(ControlErrorCode::DesktopUnavailable),
        }
    }

    fn launch_desktop_host(initial_project_root: Option<&str>) -> Result<(), ControlErrorCode> {
        let configured = if let Some(desktop) =
            desktop_host_from_environment().map_err(|_| ControlErrorCode::DesktopUnavailable)?
        {
            Some(desktop)
        } else {
            let home = debrute_home().map_err(|_| ControlErrorCode::DesktopUnavailable)?;
            read_desktop_host_registration(&home)
                .map_err(|_| ControlErrorCode::DesktopUnavailable)?
        }
        .ok_or(ControlErrorCode::DesktopUnavailable)?;
        let entrypoint = configured.executable;
        let mut arguments = configured.arguments;
        if let Some(project_root) = initial_project_root {
            arguments.push(format!("--debrute-project-root={project_root}"));
        }
        Command::new(entrypoint)
            .args(&arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|_| ControlErrorCode::DesktopUnavailable)
    }

    fn open_browser(&self, target: &WorkbenchRoute) -> Result<ActivationOutcome, ControlErrorCode> {
        let url = self.workbench_url(target)?;
        Self::open_browser_url(&url)
    }

    fn open_browser_project(
        &self,
        requested_project_root: &str,
    ) -> Result<ActivationOutcome, ControlErrorCode> {
        let root_url = self.workbench_url(&WorkbenchRoute::Root)?;
        let url = build_project_workbench_url(&root_url, requested_project_root)
            .map_err(|_| ControlErrorCode::InvalidActivation)?;
        Self::open_browser_url(&url)
    }

    fn open_browser_url(url: &str) -> Result<ActivationOutcome, ControlErrorCode> {
        open_url(url)
            .map(|()| ActivationOutcome::Opened)
            .map_err(|_| ControlErrorCode::InvalidActivation)
    }

    fn workbench_url(&self, route: &WorkbenchRoute) -> Result<String, ControlErrorCode> {
        self.state
            .workbench_url(route)
            .map_err(|error| match error {
                RuntimeActionError::RuntimeNotReady { .. } => ControlErrorCode::RuntimeStarting,
                RuntimeActionError::WorkbenchUnavailable
                | RuntimeActionError::WorkbenchLaunch(_) => ControlErrorCode::InvalidActivation,
            })
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn spawn_control_accept_worker(
    owner: PlatformControlOwner,
    state: Arc<RuntimeControlState>,
    stop_accepting: Arc<AtomicBool>,
    failure_sender: mpsc::SyncSender<EndpointError>,
) -> io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("debrute-control-accept".to_owned())
        .spawn(move || {
            while !stop_accepting.load(Ordering::Acquire) {
                let connection = match owner.accept_current_user(HANDSHAKE_TIMEOUT) {
                    Ok(connection) => connection,
                    Err(EndpointError::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(SUPERVISION_POLL_INTERVAL);
                        continue;
                    }
                    Err(
                        error @ (EndpointError::PeerUserMismatch { .. }
                        | EndpointError::PeerSidMismatch),
                    ) => {
                        eprintln!("Debrute Control peer rejected: {error}");
                        continue;
                    }
                    Err(error) => {
                        let _ = failure_sender.send(error);
                        return;
                    }
                };
                if stop_accepting.load(Ordering::Acquire) {
                    return;
                }
                let peer_state = Arc::clone(&state);
                thread::spawn(move || {
                    if let Err(error) = serve_control_connection(
                        connection,
                        &peer_state,
                        CONTROL_OUTBOUND_QUEUE_CAPACITY,
                    ) {
                        eprintln!("Debrute Control connection closed: {error}");
                    }
                });
            }
        })
}

#[cfg(target_os = "macos")]
fn platform_control_endpoint() -> Result<PlatformControlEndpoint, EndpointError> {
    Ok(MacOsControlEndpoint::for_current_user())
}

#[cfg(target_os = "windows")]
fn platform_control_endpoint() -> Result<PlatformControlEndpoint, EndpointError> {
    WindowsControlEndpoint::for_current_user()
}

#[cfg(target_os = "macos")]
fn debrute_home() -> io::Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".debrute"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "User home is unavailable"))
}

#[cfg(target_os = "windows")]
fn debrute_home() -> io::Result<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|home| home.join(".debrute"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "User profile is unavailable"))
}

#[cfg(target_os = "macos")]
fn open_url(url: &str) -> io::Result<()> {
    let status = Command::new("/usr/bin/open").arg(url).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "open exited with status {status}"
        )))
    }
}

#[cfg(target_os = "windows")]
fn open_url(url: &str) -> io::Result<()> {
    // Explorer hands URLs to the registered browser but may still exit with code 1.
    // A successfully spawned process is therefore the Windows commit boundary.
    Command::new("explorer.exe").arg(url).spawn().map(|_| ())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn stop_control_accept_worker(
    endpoint: &PlatformControlEndpoint,
    worker: &thread::JoinHandle<()>,
) -> bool {
    let deadline = std::time::Instant::now() + STARTUP_WAIT;
    while !worker.is_finished() && std::time::Instant::now() < deadline {
        let _ = endpoint.wake_accept();
        thread::sleep(SUPERVISION_POLL_INTERVAL);
    }
    worker.is_finished()
}
