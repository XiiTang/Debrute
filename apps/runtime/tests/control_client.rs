#![cfg(target_os = "macos")]

use std::{
    io::{self, Cursor, Read, Write},
    os::unix::net::UnixStream,
    sync::mpsc,
    time::{Duration, Instant},
};

use debrute_runtime::control::{
    ActivationIntent, ActivationOutcome, ClientMessage, ClientRole, ControlRequest,
    ControlResponse, ControlTransport, NativeControlClient, NativeControlClientError,
    RuntimeStatus, ServerMessage, encode_server_frame, read_frame, serve_handshake,
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
            .wait_ready_and_request_until(
                Instant::now() + Duration::from_secs(1),
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
        client.wait_ready_and_request_until(
            Instant::now() + Duration::from_secs(1),
            "cli-auth",
            ControlRequest::CreateCliAuthorization,
        ),
        Err(NativeControlClientError::Role(_))
    ));
    drop(client);
    server.join().expect("server should finish");
}

#[test]
fn bounded_handshake_preserves_its_transport_timeout() {
    let (client_stream, _server_stream) = UnixStream::pair().expect("stream pair should open");
    let Err(error) = NativeControlClient::handshake_and_clear_timeouts(
        client_stream,
        ClientRole::Launcher,
        Instant::now() + Duration::from_millis(20),
    ) else {
        panic!("stalled handshake should time out");
    };
    assert!(error.is_handshake_timeout());
    assert!(!matches!(
        error,
        NativeControlClientError::RuntimeReadyTimeout
    ));
}

#[test]
fn ready_handshake_returned_after_the_absolute_deadline_is_not_observed() {
    let response = encode_server_frame(&ServerMessage::handshake_accepted(
        "runtime-instance",
        RuntimeStatus::Ready,
    ))
    .expect("handshake response should encode");
    let stream = LateHandshakeStream {
        response: Cursor::new(response),
        delay: Duration::from_millis(40),
        delayed: false,
    };
    assert!(matches!(
        NativeControlClient::handshake_and_clear_timeouts(
            stream,
            ClientRole::Launcher,
            Instant::now() + Duration::from_millis(20),
        ),
        Err(NativeControlClientError::HandshakeDeadlineExceeded)
    ));
}

#[test]
fn ready_observed_by_handshake_retires_the_original_deadline() {
    let (client_stream, mut server_stream) = UnixStream::pair().expect("stream pair should open");
    let server = std::thread::spawn(move || {
        serve_handshake(&mut server_stream, "runtime-instance", RuntimeStatus::Ready)
            .expect("handshake should succeed");
        assert_eq!(
            read_frame(&mut server_stream).expect("activation should arrive"),
            ClientMessage::request(
                "activate-after-deadline",
                ControlRequest::Activate {
                    intent: ActivationIntent::OpenBrowser,
                },
            )
        );
        write_server_message(
            &mut server_stream,
            &ServerMessage::response(
                "activate-after-deadline",
                ControlResponse::Activation {
                    outcome: ActivationOutcome::Opened,
                },
            ),
        );
    });
    let mut client = NativeControlClient::handshake(client_stream, ClientRole::Launcher)
        .expect("handshake should succeed");
    let deadline = Instant::now() + Duration::from_millis(20);
    std::thread::sleep(Duration::from_millis(40));
    assert!(matches!(
        client.wait_ready_and_request_until(
            deadline,
            "activate-after-deadline",
            ControlRequest::Activate {
                intent: ActivationIntent::OpenBrowser,
            },
        ),
        Ok(ControlResponse::Activation {
            outcome: ActivationOutcome::Opened
        })
    ));
    server.join().expect("server should finish");
}

#[test]
fn ready_observed_by_inspection_retires_the_original_deadline() {
    let (client_stream, mut server_stream) = UnixStream::pair().expect("stream pair should open");
    let server = std::thread::spawn(move || {
        serve_handshake(
            &mut server_stream,
            "runtime-instance",
            RuntimeStatus::Starting,
        )
        .expect("handshake should succeed");
        let ClientMessage::Request {
            request_id,
            request: ControlRequest::Inspect,
        } = read_frame(&mut server_stream).expect("inspection should arrive")
        else {
            panic!("client must inspect Starting Runtime");
        };
        write_server_message(
            &mut server_stream,
            &ServerMessage::response(
                request_id,
                ControlResponse::Inspection {
                    instance_id: "runtime-instance".to_owned(),
                    status: RuntimeStatus::Ready,
                    executable_identity: None,
                },
            ),
        );
        for request_id in ["activate-before-deadline", "activate-after-deadline"] {
            assert_eq!(
                read_frame(&mut server_stream).expect("activation should arrive"),
                ClientMessage::request(
                    request_id,
                    ControlRequest::Activate {
                        intent: ActivationIntent::OpenBrowser,
                    },
                )
            );
            write_server_message(
                &mut server_stream,
                &ServerMessage::response(
                    request_id,
                    ControlResponse::Activation {
                        outcome: ActivationOutcome::Opened,
                    },
                ),
            );
        }
    });
    let mut client = NativeControlClient::handshake(client_stream, ClientRole::Launcher)
        .expect("handshake should succeed");
    let deadline = Instant::now() + Duration::from_millis(100);
    for request_id in ["activate-before-deadline", "activate-after-deadline"] {
        assert!(matches!(
            client.wait_ready_and_request_until(
                deadline,
                request_id,
                ControlRequest::Activate {
                    intent: ActivationIntent::OpenBrowser,
                },
            ),
            Ok(ControlResponse::Activation {
                outcome: ActivationOutcome::Opened
            })
        ));
        std::thread::sleep(Duration::from_millis(120));
    }
    server.join().expect("server should finish");
}

#[test]
fn ready_deadline_expires_without_sending_the_gated_request() {
    let (client_stream, mut server_stream) = UnixStream::pair().expect("stream pair should open");
    let (count_sender, count_receiver) = mpsc::channel();
    let server = std::thread::spawn(move || {
        serve_handshake(
            &mut server_stream,
            "runtime-instance",
            RuntimeStatus::Starting,
        )
        .expect("handshake should succeed");
        let mut inspections = 0;
        while let Ok(ClientMessage::Request {
            request_id,
            request: ControlRequest::Inspect,
        }) = read_frame(&mut server_stream)
        {
            inspections += 1;
            write_server_message(
                &mut server_stream,
                &ServerMessage::response(
                    request_id,
                    ControlResponse::Inspection {
                        instance_id: "runtime-instance".to_owned(),
                        status: RuntimeStatus::Starting,
                        executable_identity: None,
                    },
                ),
            );
        }
        count_sender.send(inspections).expect("count should send");
    });

    let mut client = NativeControlClient::handshake(client_stream, ClientRole::Launcher)
        .expect("handshake should succeed");
    assert!(matches!(
        client.wait_ready_and_request_until(
            Instant::now() + Duration::from_millis(80),
            "activate-never",
            ControlRequest::Activate {
                intent: ActivationIntent::OpenBrowser,
            },
        ),
        Err(NativeControlClientError::RuntimeReadyTimeout)
    ));
    drop(client);
    server.join().expect("server should finish");
    assert!(count_receiver.recv().expect("count should arrive") > 0);
}

#[test]
fn product_quit_is_sent_directly_while_runtime_is_starting() {
    let (client_stream, mut server_stream) = UnixStream::pair().expect("stream pair should open");
    let server = std::thread::spawn(move || {
        serve_handshake(
            &mut server_stream,
            "runtime-instance",
            RuntimeStatus::Starting,
        )
        .expect("handshake should succeed");
        assert_eq!(
            read_frame(&mut server_stream).expect("Product Quit should arrive"),
            ClientMessage::request("quit-1", ControlRequest::QuitProduct)
        );
        write_server_message(
            &mut server_stream,
            &ServerMessage::response("quit-1", ControlResponse::Ok),
        );
    });
    let mut client = NativeControlClient::handshake(client_stream, ClientRole::Cli)
        .expect("handshake should succeed");
    assert_eq!(
        client
            .quit_product("quit-1")
            .expect("Product Quit should complete"),
        ControlResponse::Ok
    );
    server.join().expect("server should finish");
}

fn write_server_message(stream: &mut UnixStream, message: &ServerMessage) {
    stream
        .write_all(&encode_server_frame(message).expect("server frame should encode"))
        .expect("server frame should write");
}

#[derive(Clone)]
struct LateHandshakeStream {
    response: Cursor<Vec<u8>>,
    delay: Duration,
    delayed: bool,
}

impl Read for LateHandshakeStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if !self.delayed {
            std::thread::sleep(self.delay);
            self.delayed = true;
        }
        self.response.read(buffer)
    }
}

impl Write for LateHandshakeStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl ControlTransport for LateHandshakeStream {
    fn set_io_timeout(&mut self, _timeout: Option<Duration>) -> io::Result<()> {
        Ok(())
    }

    fn clear_handshake_timeouts(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn try_clone_transport(&self) -> io::Result<Self> {
        Ok(self.clone())
    }

    fn shutdown_transport(&self) {}
}
