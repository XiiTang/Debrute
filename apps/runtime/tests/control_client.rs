#![cfg(target_os = "macos")]

use std::{io::Write, os::unix::net::UnixStream, time::Duration};

use debrute_runtime::control::{
    ActivationIntent, ActivationOutcome, ClientMessage, ClientRole, ControlRequest,
    ControlResponse, NativeControlClient, NativeControlClientError, RuntimeStatus, ServerMessage,
    encode_server_frame, read_frame, serve_handshake,
};

#[test]
fn client_polls_until_ready_then_sends_the_request_once() {
    let (client_stream, mut server_stream) = UnixStream::pair().expect("stream pair should open");
    client_stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .expect("client read should be bounded");
    let server = std::thread::spawn(move || {
        assert_eq!(
            serve_handshake(
                &mut server_stream,
                "runtime-instance",
                RuntimeStatus::Starting
            )
            .expect("handshake should succeed"),
            ClientRole::Launcher
        );
        for status in [RuntimeStatus::Starting, RuntimeStatus::Ready] {
            let ClientMessage::Request {
                request_id: actual,
                request: ControlRequest::Inspect,
            } = read_frame(&mut server_stream).expect("inspection should arrive")
            else {
                panic!("client must poll with inspection");
            };
            write_server_message(
                &mut server_stream,
                &ServerMessage::response(
                    actual,
                    ControlResponse::Inspection {
                        instance_id: "runtime-instance".to_owned(),
                        status,
                        executable_identity: None,
                    },
                ),
            );
        }
        assert_eq!(
            read_frame(&mut server_stream).expect("activation should arrive"),
            ClientMessage::request(
                "activate-1",
                ControlRequest::Activate {
                    intent: ActivationIntent::OpenBrowser,
                },
            )
        );
        write_server_message(
            &mut server_stream,
            &ServerMessage::response(
                "activate-1",
                ControlResponse::Activation {
                    outcome: ActivationOutcome::Opened,
                },
            ),
        );
    });

    let mut client = NativeControlClient::handshake(client_stream, ClientRole::Launcher)
        .expect("handshake should succeed");
    assert_eq!(
        client
            .wait_ready_and_request(
                "activate-1",
                ControlRequest::Activate {
                    intent: ActivationIntent::OpenBrowser,
                },
            )
            .expect("activation should complete"),
        ControlResponse::Activation {
            outcome: ActivationOutcome::Opened,
        }
    );
    server.join().expect("server should finish");
}

#[test]
fn inspection_is_available_while_starting() {
    let (client_stream, mut server_stream) = UnixStream::pair().expect("stream pair should open");
    let server = std::thread::spawn(move || {
        serve_handshake(
            &mut server_stream,
            "runtime-instance",
            RuntimeStatus::Starting,
        )
        .expect("handshake should succeed");
        assert_eq!(
            read_frame(&mut server_stream).expect("inspection should arrive"),
            ClientMessage::request("inspect-1", ControlRequest::Inspect)
        );
        write_server_message(
            &mut server_stream,
            &ServerMessage::response(
                "inspect-1",
                ControlResponse::Inspection {
                    instance_id: "runtime-instance".to_owned(),
                    status: RuntimeStatus::Starting,
                    executable_identity: None,
                },
            ),
        );
    });
    let mut client = NativeControlClient::handshake(client_stream, ClientRole::Cli)
        .expect("handshake should succeed");
    assert!(matches!(
        client.inspect("inspect-1"),
        Ok(ControlResponse::Inspection {
            status: RuntimeStatus::Starting,
            ..
        })
    ));
    server.join().expect("server should finish");
}

#[test]
fn client_does_not_replay_after_the_runtime_is_lost() {
    let (client_stream, mut server_stream) = UnixStream::pair().expect("stream pair should open");
    let server = std::thread::spawn(move || {
        serve_handshake(&mut server_stream, "runtime-instance", RuntimeStatus::Ready)
            .expect("handshake should succeed");
        let _ = read_frame(&mut server_stream).expect("request should arrive once");
    });
    let mut client = NativeControlClient::handshake(client_stream, ClientRole::Launcher)
        .expect("handshake should succeed");
    let error = client
        .inspect("inspect-1")
        .expect_err("closed runtime must be terminal");
    assert!(matches!(error, NativeControlClientError::RuntimeLost));
    assert!(matches!(
        client.inspect("inspect-2"),
        Err(NativeControlClientError::RuntimeLost)
    ));
    server.join().expect("server should finish");
}

#[test]
fn client_rejects_a_request_outside_its_role_before_writing() {
    let (client_stream, mut server_stream) = UnixStream::pair().expect("stream pair should open");
    server_stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .expect("probe should be bounded");
    let server = std::thread::spawn(move || {
        serve_handshake(&mut server_stream, "runtime-instance", RuntimeStatus::Ready)
            .expect("handshake should succeed");
        assert!(read_frame(&mut server_stream).is_err());
    });
    let mut client = NativeControlClient::handshake(client_stream, ClientRole::Launcher)
        .expect("handshake should succeed");
    assert!(matches!(
        client.wait_ready_and_request("cli-auth", ControlRequest::CreateCliAuthorization),
        Err(NativeControlClientError::Role(_))
    ));
    drop(client);
    server.join().expect("server should finish");
}

fn write_server_message(stream: &mut UnixStream, message: &ServerMessage) {
    stream
        .write_all(&encode_server_frame(message).expect("server frame should encode"))
        .expect("server frame should write");
}
