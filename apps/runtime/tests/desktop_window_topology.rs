#![cfg(target_os = "macos")]

use std::{
    os::unix::net::UnixStream,
    sync::{Arc, Weak},
    time::Duration,
};

use debrute_runtime::control::{
    ActivationFailure, ActivationIntent, ActivationOutcome, ClientMessage, ClientRole,
    ControlErrorCode, ControlEvent, ControlRequest, ControlResponse, DesktopOpenError,
    ProjectFrontend, RuntimeActivationService, RuntimeControlState, ServerMessage, WorkbenchRoute,
    encode_frame, read_server_frame, request_handshake, serve_control_connection,
};

struct DesktopActivation {
    state: Weak<RuntimeControlState>,
}

impl RuntimeActivationService for DesktopActivation {
    fn activate(
        &self,
        intent: &ActivationIntent,
        preferred_desktop_window_key: Option<&str>,
    ) -> Result<ActivationOutcome, ActivationFailure> {
        let state = self
            .state
            .upgrade()
            .ok_or(ControlErrorCode::DesktopUnavailable)?;
        match intent {
            ActivationIntent::OpenDesktop => match state.open_desktop_window() {
                Ok(()) => Ok(ActivationOutcome::Opened),
                Err(DesktopOpenError::HostUnavailable | DesktopOpenError::Outbound(_)) => {
                    Err(ControlErrorCode::DesktopUnavailable.into())
                }
            },
            ActivationIntent::OpenProject {
                project_root,
                frontend: ProjectFrontend::Desktop,
            } => state
                .request_desktop_project_open(project_root, preferred_desktop_window_key)
                .map(|()| ActivationOutcome::Opened)
                .map_err(|_| ControlErrorCode::DesktopUnavailable.into()),
            _ => Err(ControlErrorCode::InvalidActivation.into()),
        }
    }
}

#[test]
fn desktop_promotion_delivers_projection_and_one_root_window() {
    let state = ready_state(vec!["/projects/recent".to_owned()]);
    let (mut desktop, server) = connect_launcher(&state);

    send_request(
        &mut desktop,
        "promote",
        ControlRequest::Activate {
            intent: ActivationIntent::OpenDesktop,
            preferred_desktop_window_key: None,
        },
    );

    assert_eq!(
        read_server_frame(&mut desktop).expect("recent Projects should arrive"),
        ServerMessage::event(ControlEvent::DesktopRecentProjectsChanged {
            global_revision: 0,
            recent_project_roots: vec!["/projects/recent".to_owned()],
        })
    );
    let window_key = expect_open_event(&mut desktop, &WorkbenchRoute::Root);
    expect_activation(
        &mut desktop,
        "promote",
        ActivationOutcome::PromotedToDesktopHost,
    );

    send_request(
        &mut desktop,
        "close",
        ControlRequest::DesktopWindowClosed { window_key },
    );
    assert_eq!(
        read_server_frame(&mut desktop).expect("close response should arrive"),
        ServerMessage::response("close", ControlResponse::Ok)
    );

    drop(desktop);
    server.join().expect("server should finish");
}

#[test]
fn desktop_project_activation_forwards_the_raw_request_and_selected_source() {
    let state = ready_state(Vec::new());
    let (mut desktop, server) = connect_launcher(&state);
    send_request(
        &mut desktop,
        "promote",
        ControlRequest::Activate {
            intent: ActivationIntent::OpenDesktop,
            preferred_desktop_window_key: None,
        },
    );
    let _ = read_server_frame(&mut desktop).expect("recent Projects should arrive");
    let source_window_key = expect_open_event(&mut desktop, &WorkbenchRoute::Root);
    expect_activation(
        &mut desktop,
        "promote",
        ActivationOutcome::PromotedToDesktopHost,
    );

    let missing_root = "/projects/does-not-exist";
    send_request(
        &mut desktop,
        "project-from-source",
        ControlRequest::Activate {
            intent: ActivationIntent::OpenProject {
                project_root: missing_root.to_owned(),
                frontend: ProjectFrontend::Desktop,
            },
            preferred_desktop_window_key: Some(source_window_key.clone()),
        },
    );
    assert_eq!(
        read_server_frame(&mut desktop).expect("Project request should arrive"),
        ServerMessage::event(ControlEvent::DesktopProjectOpenRequested {
            project_root: missing_root.to_owned(),
            preferred_window_key: Some(source_window_key.clone()),
        })
    );
    expect_activation(
        &mut desktop,
        "project-from-source",
        ActivationOutcome::Opened,
    );

    send_request(
        &mut desktop,
        "project-without-source",
        ControlRequest::Activate {
            intent: ActivationIntent::OpenProject {
                project_root: "/projects/another".to_owned(),
                frontend: ProjectFrontend::Desktop,
            },
            preferred_desktop_window_key: None,
        },
    );
    assert_eq!(
        read_server_frame(&mut desktop).expect("Project request should arrive"),
        ServerMessage::event(ControlEvent::DesktopProjectOpenRequested {
            project_root: "/projects/another".to_owned(),
            preferred_window_key: None,
        })
    );
    expect_activation(
        &mut desktop,
        "project-without-source",
        ActivationOutcome::Opened,
    );

    drop(desktop);
    server.join().expect("server should finish");
}

#[test]
fn recent_project_projection_ignores_stale_revisions() {
    let state = ready_state(Vec::new());
    let (mut desktop, server) = connect_launcher(&state);
    send_request(
        &mut desktop,
        "promote",
        ControlRequest::Activate {
            intent: ActivationIntent::OpenDesktop,
            preferred_desktop_window_key: None,
        },
    );
    let _ = read_server_frame(&mut desktop).expect("initial projection should arrive");
    let _ = expect_open_event(&mut desktop, &WorkbenchRoute::Root);
    expect_activation(
        &mut desktop,
        "promote",
        ActivationOutcome::PromotedToDesktopHost,
    );

    state.set_recent_projects(2, vec!["/projects/new".to_owned()]);
    state.set_recent_projects(1, vec!["/projects/stale".to_owned()]);
    assert_eq!(
        read_server_frame(&mut desktop).expect("new projection should arrive"),
        ServerMessage::event(ControlEvent::DesktopRecentProjectsChanged {
            global_revision: 2,
            recent_project_roots: vec!["/projects/new".to_owned()],
        })
    );

    drop(desktop);
    server.join().expect("server should finish");
}

fn ready_state(recent_project_roots: Vec<String>) -> Arc<RuntimeControlState> {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    state.set_recent_projects(0, recent_project_roots);
    assert!(state.finish_startup());
    assert!(
        state.install_activation_service(Arc::new(DesktopActivation {
            state: Arc::downgrade(&state),
        }))
    );
    state
}

fn connect_launcher(state: &Arc<RuntimeControlState>) -> (UnixStream, std::thread::JoinHandle<()>) {
    let (mut desktop, server_stream) = UnixStream::pair().expect("stream pair should open");
    desktop
        .set_read_timeout(Some(Duration::from_secs(1)))
        .expect("read should be bounded");
    let server_state = Arc::clone(state);
    let server = std::thread::spawn(move || {
        serve_control_connection(server_stream, &server_state, 8)
            .expect("connection should close cleanly");
    });
    request_handshake(&mut desktop, ClientRole::Launcher).expect("handshake should succeed");
    (desktop, server)
}

fn expect_open_event(stream: &mut UnixStream, route: &WorkbenchRoute) -> String {
    let ServerMessage::Event {
        event:
            ControlEvent::DesktopWindowOpenRequested {
                window_key,
                route: opened_route,
            },
    } = read_server_frame(stream).expect("Desktop open event should arrive")
    else {
        panic!("expected Desktop open event");
    };
    assert_eq!(&opened_route, route);
    window_key
}

fn expect_activation(stream: &mut UnixStream, request_id: &str, outcome: ActivationOutcome) {
    assert_eq!(
        read_server_frame(stream).expect("activation response should arrive"),
        ServerMessage::response(request_id, ControlResponse::Activation { outcome })
    );
}

fn send_request(stream: &mut UnixStream, request_id: &str, request: ControlRequest) {
    let frame =
        encode_frame(&ClientMessage::request(request_id, request)).expect("request should encode");
    std::io::Write::write_all(stream, &frame).expect("request should write");
}
