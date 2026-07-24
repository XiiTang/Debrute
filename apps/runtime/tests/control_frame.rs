use debrute_runtime::control::{
    ActivationIntent, ActivationOutcome, CONTROL_PROTOCOL, CONTROL_PROTOCOL_VERSION, ClientMessage,
    ClientRole, ControlEvent, ControlRequest, ControlResponse, FrameDecodeError, FrameEncodeError,
    HandshakeRejection, MAX_CONTROL_FRAME_BYTES, PRODUCT_VERSION, ProjectFrontend, RuntimeStatus,
    ServerMessage, authorize_request, encode_frame, encode_server_frame, read_frame,
    read_server_frame, validate_handshake,
};
use std::io::Cursor;

#[test]
fn handshake_encodes_as_one_big_endian_length_prefixed_json_frame() {
    let message = ClientMessage::Handshake {
        protocol: CONTROL_PROTOCOL.to_owned(),
        protocol_version: CONTROL_PROTOCOL_VERSION,
        product_version: "0.0.3".to_owned(),
        role: ClientRole::Launcher,
    };

    let frame = encode_frame(&message).expect("handshake frame should encode");
    let payload = br#"{"type":"handshake","protocol":"debrute-control","protocol_version":2,"product_version":"0.0.3","role":"launcher"}"#;
    let mut expected = u32::try_from(payload.len())
        .expect("test payload length fits in u32")
        .to_be_bytes()
        .to_vec();
    expected.extend_from_slice(payload);

    assert_eq!(frame, expected);
}

#[test]
fn handshake_decodes_from_one_complete_frame() {
    let payload = br#"{"type":"handshake","protocol":"debrute-control","protocol_version":2,"product_version":"0.0.3","role":"cli"}"#;
    let frame = frame(payload);

    let message = read_frame(&mut Cursor::new(frame)).expect("complete handshake should decode");

    assert_eq!(
        message,
        ClientMessage::Handshake {
            protocol: "debrute-control".to_owned(),
            protocol_version: 2,
            product_version: "0.0.3".to_owned(),
            role: ClientRole::Cli,
        }
    );
}

#[test]
fn empty_payload_is_rejected() {
    let error =
        read_frame(&mut Cursor::new([0_u8; 4])).expect_err("empty payload must be rejected");

    assert!(matches!(error, FrameDecodeError::EmptyPayload));
}

#[test]
fn oversized_payload_is_rejected_from_its_header() {
    let oversized_length = u32::try_from(MAX_CONTROL_FRAME_BYTES + 1).unwrap();
    let error = read_frame(&mut Cursor::new(oversized_length.to_be_bytes()))
        .expect_err("oversized payload must be rejected before reading a body");

    assert!(matches!(
        error,
        FrameDecodeError::PayloadTooLarge {
            length,
            maximum: MAX_CONTROL_FRAME_BYTES,
        } if length == MAX_CONTROL_FRAME_BYTES + 1
    ));
}

#[test]
fn oversized_client_message_is_rejected_during_encoding() {
    let message = handshake("debrute-control", 2, &"x".repeat(MAX_CONTROL_FRAME_BYTES));
    let error = encode_frame(&message).expect_err("oversized message must not produce a frame");

    assert!(matches!(
        error,
        FrameEncodeError::PayloadTooLarge {
            length,
            maximum: MAX_CONTROL_FRAME_BYTES,
        } if length > MAX_CONTROL_FRAME_BYTES
    ));
}

#[test]
fn truncated_header_and_payload_are_rejected() {
    for bytes in [vec![0, 0], vec![0, 0, 0, 4, b'{', b'}']] {
        let error =
            read_frame(&mut Cursor::new(bytes)).expect_err("truncated frame must be rejected");
        assert!(matches!(error, FrameDecodeError::Read(_)));
    }
}

#[test]
fn non_utf8_payload_is_rejected() {
    let error = read_frame(&mut Cursor::new(frame(&[0xff])))
        .expect_err("non-UTF-8 payload must be rejected");

    assert!(matches!(error, FrameDecodeError::InvalidMessage(_)));
}

#[test]
fn trailing_json_value_is_rejected() {
    let payload = br#"{"type":"handshake","protocol":"debrute-control","protocol_version":2,"product_version":"0.0.3","role":"launcher"}{}"#;
    let error = read_frame(&mut Cursor::new(frame(payload)))
        .expect_err("a second JSON value inside one frame must be rejected");

    assert!(matches!(error, FrameDecodeError::InvalidMessage(_)));
}

#[test]
fn unknown_handshake_fields_are_rejected() {
    let payload = br#"{"type":"handshake","protocol":"debrute-control","protocol_version":2,"product_version":"0.0.3","role":"launcher","extra":true}"#;
    let error = read_frame(&mut Cursor::new(frame(payload)))
        .expect_err("unknown handshake fields must be rejected");

    assert!(matches!(error, FrameDecodeError::InvalidMessage(_)));
}

#[test]
fn unknown_client_roles_are_rejected_by_the_closed_decoder() {
    let payload = br#"{"type":"handshake","protocol":"debrute-control","protocol_version":2,"product_version":"0.0.3","role":"web"}"#;
    let error = read_frame(&mut Cursor::new(frame(payload)))
        .expect_err("unknown role must not decode as a current handshake");

    assert!(matches!(error, FrameDecodeError::InvalidMessage(_)));
}

#[test]
fn handshake_requires_exact_protocol_and_product_versions() {
    assert_eq!(PRODUCT_VERSION, "0.0.3");
    assert_eq!(
        validate_handshake(&handshake("debrute-control", 2, "0.0.3")),
        Ok(ClientRole::Launcher)
    );
    assert_eq!(
        validate_handshake(&handshake("other-control", 2, "0.0.3")),
        Err(HandshakeRejection::IncompatibleProtocol)
    );
    assert_eq!(
        validate_handshake(&handshake("debrute-control", 1, "0.0.3")),
        Err(HandshakeRejection::IncompatibleProtocolVersion)
    );
    assert_eq!(
        validate_handshake(&handshake("debrute-control", 2, "0.0.4")),
        Err(HandshakeRejection::IncompatibleProductVersion)
    );
}

#[test]
fn runtime_encodes_and_decodes_closed_handshake_responses() {
    let accepted = ServerMessage::handshake_accepted("runtime-instance", RuntimeStatus::Ready);
    let accepted_frame = encode_server_frame(&accepted).expect("accepted handshake should encode");
    let accepted_payload = br#"{"type":"handshake_accepted","instance_id":"runtime-instance","protocol_version":2,"product_version":"0.0.3","status":"ready"}"#;
    assert_eq!(accepted_frame, frame(accepted_payload));
    assert_eq!(
        read_server_frame(&mut Cursor::new(accepted_frame))
            .expect("accepted handshake should decode"),
        accepted
    );

    let rejected =
        ServerMessage::handshake_rejected(HandshakeRejection::IncompatibleProductVersion);
    let rejected_frame = encode_server_frame(&rejected).expect("rejected handshake should encode");
    let rejected_payload =
        br#"{"type":"handshake_rejected","reason":"incompatible_product_version"}"#;
    assert_eq!(rejected_frame, frame(rejected_payload));
    assert_eq!(
        read_server_frame(&mut Cursor::new(rejected_frame))
            .expect("rejected handshake should decode"),
        rejected
    );
}

#[test]
fn control_requests_are_closed_and_role_authorized() {
    let ensure = ClientMessage::request(
        "request-1",
        ControlRequest::Activate {
            intent: ActivationIntent::EnsureRuntime,
        },
    );
    let ensure_frame = encode_frame(&ensure).expect("Control request should encode");
    let payload = br#"{"type":"request","request_id":"request-1","request":{"command":"activate","intent":{"kind":"ensure_runtime"}}}"#;

    assert_eq!(ensure_frame, self::frame(payload));
    assert_eq!(
        read_frame(&mut Cursor::new(ensure_frame)).expect("Control request should decode"),
        ensure
    );
    assert_eq!(
        authorize_request(
            ClientRole::Cli,
            &ControlRequest::Activate {
                intent: ActivationIntent::EnsureRuntime,
            }
        ),
        Ok(())
    );
    assert_eq!(
        authorize_request(
            ClientRole::Cli,
            &ControlRequest::Activate {
                intent: ActivationIntent::OpenBrowser,
            }
        ),
        Ok(())
    );
    let project = ClientMessage::request(
        "request-project",
        ControlRequest::Activate {
            intent: ActivationIntent::OpenProject {
                project_root: "/tmp/project".to_owned(),
                frontend: ProjectFrontend::Browser,
            },
        },
    );
    assert_eq!(
        encode_frame(&project).expect("Project activation should encode"),
        frame(br#"{"type":"request","request_id":"request-project","request":{"command":"activate","intent":{"kind":"open_project","project_root":"/tmp/project","frontend":"browser"}}}"#)
    );
    assert!(
        authorize_request(
            ClientRole::Launcher,
            &ControlRequest::CreateCliAuthorization
        )
        .is_err()
    );
    assert_eq!(
        authorize_request(ClientRole::Cli, &ControlRequest::CreateCliAuthorization),
        Ok(())
    );
    let launch = ControlRequest::CreateDesktopLaunchTicket {
        window_key: "window-1".to_owned(),
    };
    assert_eq!(authorize_request(ClientRole::Launcher, &launch), Ok(()));
    assert!(authorize_request(ClientRole::Cli, &launch).is_err());
    let desktop_closed = ControlRequest::DesktopWindowClosed {
        window_key: "window-1".to_owned(),
    };
    assert_eq!(
        authorize_request(ClientRole::Launcher, &desktop_closed),
        Ok(())
    );
    assert!(authorize_request(ClientRole::Cli, &desktop_closed).is_err());
}

#[test]
fn control_responses_and_lifecycle_events_have_closed_frames() {
    let response = ServerMessage::response(
        "request-1",
        ControlResponse::Activation {
            outcome: ActivationOutcome::Ensured,
        },
    );
    let response_frame = encode_server_frame(&response).expect("Control response should encode");
    assert_eq!(
        response_frame,
        frame(
            br#"{"type":"response","request_id":"request-1","response":{"result":"activation","outcome":"ensured"}}"#
        )
    );
    assert_eq!(
        read_server_frame(&mut Cursor::new(response_frame))
            .expect("Control response should decode"),
        response
    );

    let event = ServerMessage::event(ControlEvent::ProductExiting);
    let event_frame = encode_server_frame(&event).expect("Control event should encode");
    assert_eq!(
        event_frame,
        frame(br#"{"type":"event","event":{"event":"product_exiting"}}"#)
    );
    assert_eq!(
        read_server_frame(&mut Cursor::new(event_frame)).expect("Control event should decode"),
        event
    );
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = u32::try_from(payload.len()).unwrap().to_be_bytes().to_vec();
    frame.extend_from_slice(payload);
    frame
}

fn handshake(protocol: &str, protocol_version: u32, product_version: &str) -> ClientMessage {
    ClientMessage::Handshake {
        protocol: protocol.to_owned(),
        protocol_version,
        product_version: product_version.to_owned(),
        role: ClientRole::Launcher,
    }
}
