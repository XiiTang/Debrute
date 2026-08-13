//! Workbench Terminal Hub admission, synchronization, control, and transport lifetime.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::mpsc,
};

use crate::terminal::{
    TERMINAL_PROTOCOL_VERSION, TerminalClientFrame, TerminalEvent, TerminalObservation,
    TerminalServerFrame, TerminalService,
};

use super::{
    WorkbenchConnectionRegistry,
    websocket::{
        MAX_WEBSOCKET_FRAME_BYTES, WebSocketMessage, read_message, read_text, write_close,
        write_pong, write_text,
    },
};

const TERMINAL_HUB_BIND_TIMEOUT: Duration = Duration::from_secs(5);
const TERMINAL_HUB_OUTBOUND_CAPACITY: usize = 64;
const TERMINAL_HUB_AUXILIARY_RESERVE_TIMEOUT: Duration = Duration::from_secs(5);
const TERMINAL_HUB_WRITER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
#[cfg(not(test))]
const TERMINAL_HUB_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const TERMINAL_HUB_WRITE_TIMEOUT: Duration = Duration::from_millis(50);

pub(super) async fn run<IO>(
    io: IO,
    connections: Arc<WorkbenchConnectionRegistry>,
    terminals: TerminalService,
    browser_session: String,
    binding_id: String,
    canonical_root: String,
) where
    IO: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(io);
    let first = tokio::time::timeout(
        TERMINAL_HUB_BIND_TIMEOUT,
        read_text(&mut reader, MAX_WEBSOCKET_FRAME_BYTES),
    )
    .await;
    let Ok(Ok(Some(first))) = first else {
        let _ = write_close(&mut writer).await;
        return;
    };
    let Ok(TerminalClientFrame::Bind {
        protocol_version,
        connection_credential,
    }) = serde_json::from_str::<TerminalClientFrame>(&first)
    else {
        let _ = write_close(&mut writer).await;
        return;
    };
    if protocol_version != TERMINAL_PROTOCOL_VERSION {
        let _ = write_close(&mut writer).await;
        return;
    }
    let Some(mut project_lifetime) = connections.subscribe_project_lifetime(
        &browser_session,
        &connection_credential,
        &binding_id,
    ) else {
        let _ = write_close(&mut writer).await;
        return;
    };
    let observer_id = uuid::Uuid::new_v4().to_string();
    let topology = match terminals.subscribe_topology(&canonical_root) {
        Ok(topology) => topology,
        Err(_) => {
            let _ = write_close(&mut writer).await;
            return;
        }
    };
    let observations = Arc::new(Mutex::new(HashMap::<String, Arc<AtomicBool>>::new()));
    let (sender, receiver) =
        mpsc::channel::<TerminalOutboundMessage>(TERMINAL_HUB_OUTBOUND_CAPACITY);
    let outbound_loss = Arc::new(tokio::sync::Notify::new());
    let sync = TerminalServerFrame::Sync {
        protocol_version: TERMINAL_PROTOCOL_VERSION,
        topology_revision: topology.snapshot.revision,
        sessions: topology.snapshot.sessions.clone(),
    };
    if write_terminal_frame(&mut writer, &sync).await.is_err() {
        return;
    }
    let mut writer_task = tokio::spawn(run_terminal_writer(
        writer,
        receiver,
        Arc::clone(&outbound_loss),
    ));
    let topology_sender = sender.clone();
    let topology_outbound_loss = Arc::clone(&outbound_loss);
    let topology_stop = Arc::new(AtomicBool::new(false));
    let topology_thread_stop = Arc::clone(&topology_stop);
    thread::spawn(move || {
        while !topology_thread_stop.load(Ordering::Acquire) {
            match topology.recv_timeout(Duration::from_millis(100)) {
                Ok(snapshot) => {
                    if topology_sender
                        .try_send(TerminalOutboundMessage::Frame(
                            TerminalServerFrame::Topology {
                                topology_revision: snapshot.revision,
                                sessions: snapshot.sessions,
                            },
                        ))
                        .is_err()
                    {
                        topology_outbound_loss.notify_one();
                        return;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    topology_outbound_loss.notify_one();
                    return;
                }
            }
        }
    });
    loop {
        tokio::select! {
            incoming = read_message(&mut reader, MAX_WEBSOCKET_FRAME_BYTES) => {
                let incoming = match incoming {
                    Ok(Some(WebSocketMessage::Text(incoming))) => incoming,
                    Ok(Some(WebSocketMessage::Ping(payload))) => {
                        if !send_terminal_outbound(
                            &sender,
                            TerminalOutboundMessage::Pong(payload),
                        ).await { break; }
                        continue;
                    }
                    Ok(Some(WebSocketMessage::Pong)) => continue,
                    Ok(Some(WebSocketMessage::Close) | None) | Err(_) => break,
                };
                let frame = match serde_json::from_str::<TerminalClientFrame>(&incoming) {
                    Ok(frame) => frame,
                    Err(error) => {
                        let frame = terminal_protocol_error(
                            None,
                            None,
                            "terminal_frame_invalid",
                            error.to_string(),
                        );
                        let _ = send_terminal_outbound(
                            &sender,
                            TerminalOutboundMessage::Frame(frame),
                        ).await;
                        break;
                    }
                };
                if handle_terminal_client_frame(
                    &terminals,
                    &canonical_root,
                    &observer_id,
                    frame,
                    &sender,
                    &observations,
                    &outbound_loss,
                ).await == TerminalClientFrameOutcome::CloseHub {
                    break;
                }
            }
            () = outbound_loss.notified() => break,
            _ = project_lifetime.recv() => break,
        }
    }
    topology_stop.store(true, Ordering::Release);
    for stop in observations
        .lock()
        .expect("Terminal observation registry lock poisoned")
        .values()
    {
        stop.store(true, Ordering::Release);
    }
    let _ = terminals.detach_attachment(&canonical_root, &observer_id);
    let _ = tokio::time::timeout(
        TERMINAL_HUB_WRITER_SHUTDOWN_TIMEOUT,
        sender.send(TerminalOutboundMessage::Close),
    )
    .await;
    drop(sender);
    if tokio::time::timeout(TERMINAL_HUB_WRITER_SHUTDOWN_TIMEOUT, &mut writer_task)
        .await
        .is_err()
    {
        writer_task.abort();
        let _ = writer_task.await;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalClientFrameOutcome {
    Continue,
    CloseHub,
}

enum TerminalOutboundMessage {
    Frame(TerminalServerFrame),
    Pong(Vec<u8>),
    Close,
}

async fn handle_terminal_client_frame(
    terminals: &TerminalService,
    canonical_root: &str,
    observer_id: &str,
    frame: TerminalClientFrame,
    sender: &mpsc::Sender<TerminalOutboundMessage>,
    observations: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    outbound_loss: &Arc<tokio::sync::Notify>,
) -> TerminalClientFrameOutcome {
    match frame {
        TerminalClientFrame::Bind { .. } => {
            let _ = send_terminal_outbound(
                sender,
                TerminalOutboundMessage::Frame(terminal_protocol_error(
                    None,
                    None,
                    "terminal_already_bound",
                    "Terminal hub is already bound.",
                )),
            )
            .await;
            TerminalClientFrameOutcome::CloseHub
        }
        TerminalClientFrame::Observe { terminal_id } => {
            if observations
                .lock()
                .expect("Terminal observation registry lock poisoned")
                .contains_key(&terminal_id)
            {
                return TerminalClientFrameOutcome::Continue;
            }
            let Some(permit) = reserve_terminal_control_outbound(sender).await else {
                return TerminalClientFrameOutcome::CloseHub;
            };
            let observation = match terminals.observe(canonical_root, &terminal_id, observer_id) {
                Ok(observation) => observation,
                Err(error) => {
                    permit.send(TerminalOutboundMessage::Frame(terminal_protocol_error(
                        None,
                        Some(terminal_id.clone()),
                        error.code(),
                        error.to_string(),
                    )));
                    return TerminalClientFrameOutcome::Continue;
                }
            };
            permit.send(TerminalOutboundMessage::Frame(
                TerminalServerFrame::Observed {
                    session: Box::new(observation.session.clone()),
                    checkpoint: observation.checkpoint.clone(),
                },
            ));
            spawn_terminal_observation(
                terminal_id,
                observation,
                sender.clone(),
                Arc::clone(observations),
                Arc::clone(outbound_loss),
            );
            TerminalClientFrameOutcome::Continue
        }
        TerminalClientFrame::Unobserve { terminal_id } => {
            if let Some(stop) = observations
                .lock()
                .expect("Terminal observation registry lock poisoned")
                .remove(&terminal_id)
            {
                stop.store(true, Ordering::Release);
            }
            TerminalClientFrameOutcome::Continue
        }
        TerminalClientFrame::Input {
            request_id,
            terminal_id,
            sequence,
            data,
        } => {
            execute_terminal_control(sender, || {
                match terminals.write_input(
                    canonical_root,
                    &terminal_id,
                    observer_id,
                    sequence,
                    data,
                ) {
                    Ok(acknowledged) => TerminalServerFrame::InputAck {
                        request_id,
                        terminal_id: terminal_id.clone(),
                        sequence: acknowledged,
                    },
                    Err(error) => terminal_protocol_error(
                        Some(request_id),
                        Some(terminal_id.clone()),
                        error.code(),
                        error.to_string(),
                    ),
                }
            })
            .await
        }
        TerminalClientFrame::Resize {
            request_id,
            terminal_id,
            cols,
            rows,
        } => {
            execute_terminal_control(sender, || {
                match terminals.resize(canonical_root, &terminal_id, observer_id, cols, rows) {
                    Ok(session) => TerminalServerFrame::Resized {
                        request_id,
                        session,
                    },
                    Err(error) => terminal_protocol_error(
                        Some(request_id),
                        Some(terminal_id.clone()),
                        error.code(),
                        error.to_string(),
                    ),
                }
            })
            .await
        }
    }
}

async fn execute_terminal_control(
    sender: &mpsc::Sender<TerminalOutboundMessage>,
    operation: impl FnOnce() -> TerminalServerFrame,
) -> TerminalClientFrameOutcome {
    let Some(permit) = reserve_terminal_control_outbound(sender).await else {
        return TerminalClientFrameOutcome::CloseHub;
    };
    let response = operation();
    permit.send(TerminalOutboundMessage::Frame(response));
    TerminalClientFrameOutcome::Continue
}

async fn reserve_terminal_control_outbound(
    sender: &mpsc::Sender<TerminalOutboundMessage>,
) -> Option<mpsc::OwnedPermit<TerminalOutboundMessage>> {
    sender.clone().reserve_owned().await.ok()
}

async fn reserve_terminal_auxiliary_outbound(
    sender: &mpsc::Sender<TerminalOutboundMessage>,
) -> Option<mpsc::OwnedPermit<TerminalOutboundMessage>> {
    tokio::time::timeout(
        TERMINAL_HUB_AUXILIARY_RESERVE_TIMEOUT,
        sender.clone().reserve_owned(),
    )
    .await
    .ok()?
    .ok()
}

async fn send_terminal_outbound(
    sender: &mpsc::Sender<TerminalOutboundMessage>,
    message: TerminalOutboundMessage,
) -> bool {
    let Some(permit) = reserve_terminal_auxiliary_outbound(sender).await else {
        return false;
    };
    permit.send(message);
    true
}

async fn run_terminal_writer<Writer>(
    mut writer: Writer,
    mut receiver: mpsc::Receiver<TerminalOutboundMessage>,
    outbound_loss: Arc<tokio::sync::Notify>,
) where
    Writer: AsyncWrite + Unpin,
{
    while let Some(message) = receiver.recv().await {
        let closing = matches!(message, TerminalOutboundMessage::Close);
        let result = tokio::time::timeout(TERMINAL_HUB_WRITE_TIMEOUT, async {
            match message {
                TerminalOutboundMessage::Frame(frame) => {
                    write_terminal_frame(&mut writer, &frame).await
                }
                TerminalOutboundMessage::Pong(payload) => write_pong(&mut writer, &payload).await,
                TerminalOutboundMessage::Close => write_close(&mut writer).await,
            }
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            outbound_loss.notify_one();
            return;
        }
        if closing {
            return;
        }
    }
}

fn spawn_terminal_observation(
    terminal_id: String,
    observation: TerminalObservation,
    sender: mpsc::Sender<TerminalOutboundMessage>,
    observations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    outbound_loss: Arc<tokio::sync::Notify>,
) {
    let stop = Arc::new(AtomicBool::new(false));
    observations
        .lock()
        .expect("Terminal observation registry lock poisoned")
        .insert(terminal_id.clone(), Arc::clone(&stop));
    thread::spawn(move || {
        while !stop.load(Ordering::Acquire) {
            match observation.recv_timeout(Duration::from_millis(100)) {
                Ok(event) => {
                    if sender
                        .try_send(TerminalOutboundMessage::Frame(terminal_event_frame(event)))
                        .is_err()
                    {
                        outbound_loss.notify_one();
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let mut registry = observations
            .lock()
            .expect("Terminal observation registry lock poisoned");
        if registry
            .get(&terminal_id)
            .is_some_and(|current| Arc::ptr_eq(current, &stop))
        {
            registry.remove(&terminal_id);
        }
    });
}

fn terminal_event_frame(event: TerminalEvent) -> TerminalServerFrame {
    match event {
        TerminalEvent::Output {
            terminal_id,
            sequence,
            data_base64,
        } => TerminalServerFrame::Output {
            terminal_id,
            sequence,
            data_base64,
        },
        TerminalEvent::Status(session) => TerminalServerFrame::Status { session },
        TerminalEvent::Exit {
            terminal_id,
            exit_code,
            signal,
        } => TerminalServerFrame::Exit {
            terminal_id,
            exit_code,
            signal,
        },
        TerminalEvent::Error {
            terminal_id,
            code,
            message,
        } => TerminalServerFrame::Error {
            request_id: None,
            terminal_id: Some(terminal_id),
            code,
            message,
        },
    }
}

fn terminal_protocol_error(
    request_id: Option<u64>,
    terminal_id: Option<String>,
    code: impl Into<String>,
    message: impl Into<String>,
) -> TerminalServerFrame {
    TerminalServerFrame::Error {
        request_id,
        terminal_id,
        code: code.into(),
        message: message.into(),
    }
}

async fn write_terminal_frame<Writer>(
    writer: &mut Writer,
    frame: &TerminalServerFrame,
) -> std::io::Result<()>
where
    Writer: AsyncWrite + Unpin,
{
    let text = serde_json::to_string(frame)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_text(writer, &text).await
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, sync::Arc};

    use serde_json::{Value, json};
    use tokio::{
        io::{AsyncReadExt as _, AsyncWriteExt as _, DuplexStream},
        sync::mpsc,
    };
    use uuid::Uuid;

    use super::*;
    use crate::workbench::ProjectBindingCommit;
    use crate::{
        project::{
            CanvasFeedbackArtifacts, DefaultProjectNodeAdapter, ProjectPreviewService,
            ProjectSessionRegistry, ProjectUseKind,
        },
        terminal::{
            TERMINAL_PROTOCOL_VERSION, TerminalClientFrame, TerminalServerFrame,
            TerminalSessionStatus, TerminalSessionView,
        },
    };

    struct HubFixture {
        root: PathBuf,
        registry: ProjectSessionRegistry,
        connections: Arc<WorkbenchConnectionRegistry>,
        terminals: TerminalService,
        browser_session: String,
        binding_id: String,
        canonical_root: String,
        credential: String,
    }

    impl HubFixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("debrute-terminal-hub-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&root).expect("Terminal Hub fixture should exist");
            let previews = Arc::new(ProjectPreviewService::new_for_test());
            let feedback = Arc::new(
                CanvasFeedbackArtifacts::new(previews)
                    .expect("Terminal Hub feedback scheduler should start"),
            );
            let registry = ProjectSessionRegistry::new(
                root.join("home"),
                Arc::new(DefaultProjectNodeAdapter),
                feedback,
            );
            let opened = registry
                .open_project(&root, ProjectUseKind::Workbench)
                .expect("Terminal Hub Project should open");
            let canonical_root = opened.session.canonical_root().to_owned();
            let browser_session = "browser-1".to_owned();
            let binding_id = "project-1".to_owned();
            let connections = Arc::new(WorkbenchConnectionRegistry::new());
            let (events, _event_receiver) = mpsc::channel::<Value>(4);
            let (connection, _connection_closed) = connections
                .open(browser_session.clone(), None, events)
                .expect("Workbench connection should open");
            connections
                .bind_project(
                    &connection.credential,
                    0,
                    ProjectBindingCommit {
                        binding_id: binding_id.clone(),
                        canonical_root: canonical_root.clone(),
                        project_use: opened.project_use,
                        bound_event: json!({"type": "project.bound"}),
                    },
                )
                .expect("Terminal Hub Project should bind");
            let terminals = TerminalService::new(registry.clone());
            Self {
                root,
                registry,
                connections,
                terminals,
                browser_session,
                binding_id,
                canonical_root,
                credential: connection.credential,
            }
        }

        fn start(&self) -> (DuplexStream, tokio::task::JoinHandle<()>) {
            self.start_with_capacity(64 * 1024)
        }

        fn start_with_capacity(
            &self,
            capacity: usize,
        ) -> (DuplexStream, tokio::task::JoinHandle<()>) {
            let (client, server) = tokio::io::duplex(capacity);
            let task = tokio::spawn(run(
                server,
                Arc::clone(&self.connections),
                self.terminals.clone(),
                self.browser_session.clone(),
                self.binding_id.clone(),
                self.canonical_root.clone(),
            ));
            (client, task)
        }

        fn create_terminal(&self) -> TerminalSessionView {
            self.terminals
                .create(&self.canonical_root, "")
                .expect("fixture Terminal should start")
        }

        fn finish(self) {
            self.connections.close_all();
            drop(self.terminals);
            self.registry
                .close()
                .expect("fixture registry should close");
            std::fs::remove_dir_all(self.root).expect("fixture should be removed");
        }
    }

    #[tokio::test]
    async fn bind_syncs_topology_without_observing_sessions() {
        let fixture = HubFixture::new();
        let terminal = fixture.create_terminal();
        let (mut client, task) = fixture.start();
        bind(&fixture, &mut client).await;

        assert!(matches!(
            read_server_frame(&mut client).await,
            TerminalServerFrame::Sync {
                protocol_version: TERMINAL_PROTOCOL_VERSION,
                topology_revision: 1,
                sessions,
            } if sessions == vec![terminal.clone()]
        ));

        write_client_json(
            &mut client,
            &TerminalClientFrame::Input {
                request_id: 9,
                terminal_id: terminal.id.clone(),
                sequence: 1,
                data: String::new(),
            },
        )
        .await;
        assert!(matches!(
            read_server_frame(&mut client).await,
            TerminalServerFrame::Error {
                request_id: Some(9),
                terminal_id: Some(terminal_id),
                code,
                ..
            } if terminal_id == terminal.id && code == "terminal_not_observed"
        ));

        write_client_frame(&mut client, 0x8, &[]).await;
        task.await.expect("Terminal Hub task should finish");
        fixture.finish();
    }

    #[tokio::test]
    async fn bind_admission_rejects_missing_non_bind_wrong_version_and_stale_credential() {
        for frame in [
            None,
            Some(TerminalClientFrame::Observe {
                terminal_id: "terminal-1".to_owned(),
            }),
            Some(TerminalClientFrame::Bind {
                protocol_version: TERMINAL_PROTOCOL_VERSION + 1,
                connection_credential: "unused".to_owned(),
            }),
            Some(TerminalClientFrame::Bind {
                protocol_version: TERMINAL_PROTOCOL_VERSION,
                connection_credential: "stale".to_owned(),
            }),
        ] {
            let fixture = HubFixture::new();
            let (mut client, task) = fixture.start();
            if let Some(frame) = frame {
                write_client_json(&mut client, &frame).await;
            }
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(6), read_server_message(&mut client))
                    .await
                    .expect("rejected Bind should close promptly"),
                (0x8, Vec::new())
            );
            task.await.expect("rejected Terminal Hub should finish");
            fixture.finish();
        }
    }

    #[tokio::test]
    async fn observation_barrier_precedes_input_and_resize_results() {
        let fixture = HubFixture::new();
        let terminal = fixture.create_terminal();
        let (mut client, task) = fixture.start();
        bind(&fixture, &mut client).await;
        assert!(matches!(
            read_server_frame(&mut client).await,
            TerminalServerFrame::Sync { sessions, .. } if sessions == vec![terminal.clone()]
        ));

        write_client_json(
            &mut client,
            &TerminalClientFrame::Observe {
                terminal_id: terminal.id.clone(),
            },
        )
        .await;
        assert!(matches!(
            read_server_frame(&mut client).await,
            TerminalServerFrame::Observed {
                session,
                checkpoint,
            } if *session == terminal && checkpoint.terminal_id == terminal.id
        ));

        write_client_json(
            &mut client,
            &TerminalClientFrame::Input {
                request_id: 11,
                terminal_id: terminal.id.clone(),
                sequence: 1,
                data: String::new(),
            },
        )
        .await;
        assert!(matches!(
            read_server_frame(&mut client).await,
            TerminalServerFrame::InputAck {
                request_id: 11,
                terminal_id,
                sequence: 1,
            } if terminal_id == terminal.id
        ));

        write_client_json(
            &mut client,
            &TerminalClientFrame::Resize {
                request_id: 12,
                terminal_id: terminal.id.clone(),
                cols: 100,
                rows: 40,
            },
        )
        .await;
        let mut status_observed = false;
        let mut resized = None;
        while !status_observed || resized.is_none() {
            match read_server_frame(&mut client).await {
                TerminalServerFrame::Status { session } if session.id == terminal.id => {
                    status_observed = true;
                }
                TerminalServerFrame::Resized {
                    request_id: 12,
                    session,
                } => resized = Some(session),
                _ => {}
            }
        }
        assert!(
            status_observed,
            "Observed must precede the deterministic resize status event"
        );
        let resized = resized.expect("correlated resize result should arrive");
        assert_eq!(resized.id, terminal.id);
        assert_eq!((resized.cols, resized.rows), (100, 40));

        write_client_frame(&mut client, 0x8, &[]).await;
        task.await.expect("Terminal Hub task should finish");
        fixture.finish();
    }

    #[tokio::test]
    async fn project_lifetime_ends_the_hub_without_ending_its_terminal() {
        let fixture = HubFixture::new();
        let terminal = fixture.create_terminal();
        let (mut client, task) = fixture.start();
        bind(&fixture, &mut client).await;
        let _sync = read_server_frame(&mut client).await;
        write_client_json(
            &mut client,
            &TerminalClientFrame::Observe {
                terminal_id: terminal.id.clone(),
            },
        )
        .await;
        assert!(matches!(
            read_server_frame(&mut client).await,
            TerminalServerFrame::Observed { session, .. } if session.id == terminal.id
        ));
        write_client_json(
            &mut client,
            &TerminalClientFrame::Input {
                request_id: 13,
                terminal_id: terminal.id.clone(),
                sequence: 1,
                data: String::new(),
            },
        )
        .await;
        assert!(matches!(
            read_server_frame(&mut client).await,
            TerminalServerFrame::InputAck {
                request_id: 13,
                sequence: 1,
                ..
            }
        ));

        fixture.connections.close(&fixture.credential);
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("Project lifetime should end the Terminal Hub")
            .expect("Terminal Hub task should finish");
        let topology = fixture
            .terminals
            .subscribe_topology(&fixture.canonical_root)
            .expect("Terminal authority should remain available");
        assert_eq!(topology.snapshot.sessions, vec![terminal]);
        fixture.finish();
    }

    #[tokio::test]
    async fn malformed_post_bind_frame_reports_error_then_closes() {
        let fixture = HubFixture::new();
        let (mut client, task) = fixture.start();
        bind(&fixture, &mut client).await;
        let _sync = read_server_frame(&mut client).await;

        write_client_frame(&mut client, 0x1, b"{").await;
        assert!(matches!(
            read_server_frame(&mut client).await,
            TerminalServerFrame::Error { code, .. } if code == "terminal_frame_invalid"
        ));
        assert_eq!(read_server_message(&mut client).await, (0x8, Vec::new()));
        task.await.expect("malformed Terminal Hub should finish");
        fixture.finish();
    }

    #[tokio::test]
    async fn ping_receives_a_matching_pong() {
        let fixture = HubFixture::new();
        let (mut client, task) = fixture.start();
        bind(&fixture, &mut client).await;
        let _sync = read_server_frame(&mut client).await;

        write_client_frame(&mut client, 0x9, b"alive").await;
        assert_eq!(
            read_server_message(&mut client).await,
            (0xA, b"alive".to_vec())
        );

        write_client_frame(&mut client, 0x8, &[]).await;
        task.await.expect("Terminal Hub task should finish");
        fixture.finish();
    }

    #[tokio::test]
    async fn stalled_outbound_transport_ends_the_hub() {
        let fixture = HubFixture::new();
        let (mut client, task) = fixture.start_with_capacity(512);
        bind(&fixture, &mut client).await;
        let _sync = read_server_frame(&mut client).await;

        let flooding = tokio::spawn(async move {
            for _ in 0..128 {
                if try_write_client_frame(&mut client, 0x9, &[b'x'; 125])
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("stalled outbound transport should end the Terminal Hub")
            .expect("Terminal Hub task should finish");
        flooding.await.expect("ping flood task should finish");
        fixture.finish();
    }

    #[tokio::test]
    async fn terminal_control_reserves_response_capacity_before_side_effect() {
        let (sender, mut receiver) = mpsc::channel(1);
        sender
            .try_send(TerminalOutboundMessage::Frame(
                TerminalServerFrame::Topology {
                    topology_revision: 0,
                    sessions: Vec::new(),
                },
            ))
            .unwrap();
        let side_effect_executed = Arc::new(AtomicBool::new(false));
        let operation_marker = Arc::clone(&side_effect_executed);

        let outcome = {
            let handling = execute_terminal_control(&sender, move || {
                operation_marker.store(true, Ordering::Release);
                TerminalServerFrame::Resized {
                    request_id: 7,
                    session: terminal_session("terminal-1", 100, 40),
                }
            });
            tokio::pin!(handling);
            assert!(
                tokio::time::timeout(Duration::from_millis(25), &mut handling)
                    .await
                    .is_err(),
                "control handling should wait until its response slot is reserved"
            );
            assert!(!side_effect_executed.load(Ordering::Acquire));
            assert!(matches!(
                receiver.recv().await,
                Some(TerminalOutboundMessage::Frame(
                    TerminalServerFrame::Topology { .. }
                ))
            ));
            handling.as_mut().await
        };
        assert_eq!(outcome, TerminalClientFrameOutcome::Continue);
        assert!(side_effect_executed.load(Ordering::Acquire));
        assert!(matches!(
            receiver.recv().await,
            Some(TerminalOutboundMessage::Frame(
                TerminalServerFrame::Resized {
                    request_id: 7,
                    session,
                }
            )) if session.id == "terminal-1" && session.cols == 100 && session.rows == 40
        ));
    }

    #[tokio::test]
    async fn terminal_control_skips_side_effect_when_writer_is_gone() {
        let (sender, receiver) = mpsc::channel(1);
        drop(receiver);
        let side_effect_executed = Arc::new(AtomicBool::new(false));
        let operation_marker = Arc::clone(&side_effect_executed);

        let outcome = execute_terminal_control(&sender, move || {
            operation_marker.store(true, Ordering::Release);
            TerminalServerFrame::Resized {
                request_id: 8,
                session: terminal_session("terminal-2", 120, 50),
            }
        })
        .await;

        assert_eq!(outcome, TerminalClientFrameOutcome::CloseHub);
        assert!(!side_effect_executed.load(Ordering::Acquire));
    }

    async fn bind(fixture: &HubFixture, client: &mut DuplexStream) {
        write_client_json(
            client,
            &TerminalClientFrame::Bind {
                protocol_version: TERMINAL_PROTOCOL_VERSION,
                connection_credential: fixture.credential.clone(),
            },
        )
        .await;
    }

    async fn write_client_json(client: &mut DuplexStream, frame: &TerminalClientFrame) {
        write_client_frame(
            client,
            0x1,
            serde_json::to_string(frame).unwrap().as_bytes(),
        )
        .await;
    }

    async fn write_client_frame(stream: &mut DuplexStream, opcode: u8, payload: &[u8]) {
        try_write_client_frame(stream, opcode, payload)
            .await
            .expect("client frame should write");
    }

    async fn try_write_client_frame(
        stream: &mut DuplexStream,
        opcode: u8,
        payload: &[u8],
    ) -> std::io::Result<()> {
        assert!(payload.len() < 126);
        let mask = [0x12, 0x34, 0x56, 0x78];
        let mut frame = vec![
            0x80 | opcode,
            0x80 | u8::try_from(payload.len()).expect("fixture payload should be short"),
        ];
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % mask.len()]),
        );
        stream.write_all(&frame).await
    }

    fn terminal_session(id: &str, cols: u16, rows: u16) -> TerminalSessionView {
        TerminalSessionView {
            id: id.to_owned(),
            title: "Terminal".to_owned(),
            cwd_project_relative_path: String::new(),
            cols,
            rows,
            status: TerminalSessionStatus::Running,
            exit_code: None,
            signal: None,
            created_at: "2026-07-30T00:00:00Z".to_owned(),
            updated_at: "2026-07-30T00:00:00Z".to_owned(),
        }
    }

    async fn read_server_frame(stream: &mut DuplexStream) -> TerminalServerFrame {
        let (opcode, payload) = read_server_message(stream).await;
        assert_eq!(opcode, 0x1);
        serde_json::from_slice(&payload).expect("server frame should be valid JSON")
    }

    async fn read_server_message(stream: &mut DuplexStream) -> (u8, Vec<u8>) {
        let first = stream.read_u8().await.expect("server opcode should arrive");
        let second = stream.read_u8().await.expect("server length should arrive");
        assert_eq!(first & 0x80, 0x80);
        assert_eq!(second & 0x80, 0);
        let length = match second & 0x7f {
            126 => usize::from(
                stream
                    .read_u16()
                    .await
                    .expect("medium length should arrive"),
            ),
            127 => usize::try_from(stream.read_u64().await.expect("large length should arrive"))
                .expect("server frame should fit memory"),
            length => usize::from(length),
        };
        let mut payload = vec![0; length];
        stream
            .read_exact(&mut payload)
            .await
            .expect("server payload should arrive");
        (first & 0x0f, payload)
    }
}
