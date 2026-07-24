#![cfg(target_os = "macos")]

use std::{
    io::Write,
    os::unix::net::UnixStream,
    sync::Arc,
    time::{Duration, Instant},
};

use debrute_runtime::control::{
    ActivationIntent, ActivationOutcome, ClientMessage, ClientRole, ControlErrorCode, ControlEvent,
    ControlRequest, ControlResponse, RuntimeActivationService, RuntimeControlState, RuntimeStatus,
    ServerMessage, encode_frame, read_server_frame, request_handshake, serve_control_connection,
};

struct BrowserActivation;

impl RuntimeActivationService for BrowserActivation {
    fn activate(&self, intent: &ActivationIntent) -> Result<ActivationOutcome, ControlErrorCode> {
        assert_eq!(intent, &ActivationIntent::OpenBrowser);
        Ok(ActivationOutcome::Opened)
    }
}

#[test]
fn server_executes_one_ready_activation() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(state.finish_startup());
    assert!(state.install_activation_service(Arc::new(BrowserActivation)));
    let (client_stream, server_stream) = UnixStream::pair().expect("stream pair should open");
    client_stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .expect("read should be bounded");
    let server = serve_in_thread(server_stream, Arc::clone(&state));
    let mut client = debrute_runtime::control::NativeControlClient::handshake(
        client_stream,
        ClientRole::Launcher,
    )
    .expect("handshake should succeed");
    assert_eq!(
        client
            .wait_ready_and_request_until(
                Instant::now() + Duration::from_secs(1),
                "activate-1",
                ControlRequest::Activate {
                    intent: ActivationIntent::OpenBrowser,
                },
            )
            .expect("activation should succeed"),
        ControlResponse::Activation {
            outcome: ActivationOutcome::Opened,
        }
    );
    drop(client);
    server.join().expect("server should finish");
}

#[test]
fn server_rejects_a_request_outside_the_wire_role() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(state.finish_startup());
    let (mut client, server_stream) = UnixStream::pair().expect("stream pair should open");
    client
        .set_read_timeout(Some(Duration::from_secs(1)))
        .expect("read should be bounded");
    let server = serve_in_thread(server_stream, Arc::clone(&state));
    request_handshake(&mut client, ClientRole::Launcher).expect("handshake should succeed");
    send_request(
        &mut client,
        "cli-auth",
        ControlRequest::CreateCliAuthorization,
    );
    assert_eq!(
        read_server_frame(&mut client).expect("response should arrive"),
        ServerMessage::response(
            "cli-auth",
            ControlResponse::Rejected {
                code: ControlErrorCode::RoleDenied,
            },
        )
    );
    drop(client);
    server.join().expect("server should finish");
}

#[test]
fn product_quit_responds_then_broadcasts_and_changes_lifecycle() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(state.finish_startup());
    let (mut client, server_stream) = UnixStream::pair().expect("stream pair should open");
    client
        .set_read_timeout(Some(Duration::from_secs(1)))
        .expect("read should be bounded");
    let server = serve_in_thread(server_stream, Arc::clone(&state));
    request_handshake(&mut client, ClientRole::Cli).expect("handshake should succeed");
    send_request(&mut client, "quit-1", ControlRequest::QuitProduct);
    assert_eq!(
        read_server_frame(&mut client).expect("quit response should arrive"),
        ServerMessage::response("quit-1", ControlResponse::Ok)
    );
    assert_eq!(
        read_server_frame(&mut client).expect("exit event should arrive"),
        ServerMessage::event(ControlEvent::ProductExiting)
    );
    assert_eq!(state.status(), RuntimeStatus::Exiting);
    drop(client);
    server.join().expect("server should finish");
}

fn serve_in_thread(
    stream: UnixStream,
    state: Arc<RuntimeControlState>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        serve_control_connection(stream, &state, 8).expect("connection should close cleanly");
    })
}

fn send_request(stream: &mut UnixStream, request_id: &str, request: ControlRequest) {
    stream
        .write_all(
            &encode_frame(&ClientMessage::request(request_id, request))
                .expect("request should encode"),
        )
        .expect("request should write");
}
