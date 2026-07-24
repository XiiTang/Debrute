use std::{
    error::Error,
    fmt, fs, io,
    net::{Ipv4Addr, SocketAddr, TcpListener},
    path::PathBuf,
    sync::{Arc, mpsc},
    thread,
};

use tokio::{runtime::Builder, sync::oneshot};

use super::{
    CliAuthorizationVerifier, RuntimeCliHttpService, RuntimeProductHttpService,
    WorkbenchLaunchService, WorkbenchRuntimeServices, routing::workbench_router,
};

pub struct WorkbenchHttpServer {
    origin: String,
    launch_service: Arc<WorkbenchLaunchService>,
    terminal: mpsc::Receiver<WorkbenchHttpServerError>,
    shutdown: Option<oneshot::Sender<()>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl WorkbenchHttpServer {
    /// Binds one OS-assigned numeric loopback origin and starts serving assets
    /// and the closed Runtime route partitions.
    ///
    /// # Errors
    ///
    /// Returns [`WorkbenchHttpServerError`] when assets are absent, the loopback
    /// listener cannot bind, or the server thread/runtime cannot start.
    ///
    /// # Panics
    /// Panics if the Workbench HTTP server thread panics during startup.
    pub fn start<Authorization>(
        assets_directory: PathBuf,
        authorization: Arc<Authorization>,
        services: Arc<WorkbenchRuntimeServices>,
        cli: Arc<dyn RuntimeCliHttpService>,
        product: Option<Arc<dyn RuntimeProductHttpService>>,
    ) -> Result<Self, WorkbenchHttpServerError>
    where
        Authorization: CliAuthorizationVerifier + 'static,
    {
        let index_path = assets_directory.join("index.html");
        match fs::metadata(&index_path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Err(WorkbenchHttpServerError::MissingIndex(index_path)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(WorkbenchHttpServerError::MissingIndex(index_path));
            }
            Err(error) => return Err(WorkbenchHttpServerError::Io(error)),
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let origin = format!("http://127.0.0.1:{}", address.port());
        let launch_service = Arc::new(WorkbenchLaunchService::new(origin.clone()));
        let authorization: Arc<dyn CliAuthorizationVerifier> = authorization;
        let router = workbench_router(
            assets_directory,
            index_path,
            Arc::clone(&launch_service),
            authorization,
            services,
            cli,
            product,
        );
        let (startup_sender, startup_receiver) = mpsc::sync_channel(0);
        let (terminal_sender, terminal) = mpsc::sync_channel(1);
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let server_thread = thread::Builder::new()
            .name("debrute-workbench-http".to_owned())
            .spawn(move || {
                let runtime = match Builder::new_current_thread()
                    .enable_io()
                    .enable_time()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = startup_sender.send(Err(WorkbenchHttpServerError::Io(error)));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let listener = match tokio::net::TcpListener::from_std(listener) {
                        Ok(listener) => listener,
                        Err(error) => {
                            let _ = startup_sender.send(Err(WorkbenchHttpServerError::Io(error)));
                            return;
                        }
                    };
                    if startup_sender.send(Ok(())).is_err() {
                        return;
                    }
                    if let Err(error) = axum::serve(
                        listener,
                        router.into_make_service_with_connect_info::<SocketAddr>(),
                    )
                    .with_graceful_shutdown(async {
                        let _ = shutdown_receiver.await;
                    })
                    .await
                    {
                        let _ = terminal_sender.send(WorkbenchHttpServerError::Io(error));
                    }
                });
            })?;
        match startup_receiver.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                server_thread
                    .join()
                    .expect("Workbench HTTP server thread panicked");
                return Err(error);
            }
            Err(_) => {
                server_thread
                    .join()
                    .expect("Workbench HTTP server thread panicked");
                return Err(WorkbenchHttpServerError::StoppedUnexpectedly);
            }
        }
        Ok(Self {
            origin,
            launch_service,
            terminal,
            shutdown: Some(shutdown),
            thread: Some(server_thread),
        })
    }

    #[must_use]
    pub fn origin(&self) -> &str {
        &self.origin
    }

    #[must_use]
    pub fn launch_service(&self) -> Arc<WorkbenchLaunchService> {
        Arc::clone(&self.launch_service)
    }

    /// Reports a required Workbench listener failure without blocking.
    ///
    /// # Errors
    ///
    /// Returns the listener error, or [`WorkbenchHttpServerError::StoppedUnexpectedly`]
    /// when the server thread ended without reporting its cause.
    pub fn check_running(&self) -> Result<(), WorkbenchHttpServerError> {
        match self.terminal.try_recv() {
            Err(mpsc::TryRecvError::Empty) => Ok(()),
            Ok(error) => Err(error),
            Err(mpsc::TryRecvError::Disconnected) => {
                Err(WorkbenchHttpServerError::StoppedUnexpectedly)
            }
        }
    }

    /// Stops accepting new Workbench HTTP connections. Existing connections
    /// finish after their owning Runtime services cancel them.
    pub fn stop_accepting(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

impl Drop for WorkbenchHttpServer {
    fn drop(&mut self) {
        self.stop_accepting();
        if let Some(server_thread) = self.thread.take() {
            server_thread
                .join()
                .expect("Workbench HTTP server thread panicked");
        }
    }
}

#[derive(Debug)]
pub enum WorkbenchHttpServerError {
    Configuration(String),
    Io(io::Error),
    MissingIndex(PathBuf),
    StoppedUnexpectedly,
}

impl fmt::Display for WorkbenchHttpServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(message) => formatter.write_str(message),
            Self::Io(error) => write!(formatter, "Workbench HTTP server failed: {error}"),
            Self::MissingIndex(path) => {
                write!(
                    formatter,
                    "Workbench index asset is missing: {}",
                    path.display()
                )
            }
            Self::StoppedUnexpectedly => {
                formatter.write_str("Workbench HTTP server stopped unexpectedly")
            }
        }
    }
}

impl Error for WorkbenchHttpServerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Configuration(_) | Self::MissingIndex(_) | Self::StoppedUnexpectedly => None,
        }
    }
}

impl From<io::Error> for WorkbenchHttpServerError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
