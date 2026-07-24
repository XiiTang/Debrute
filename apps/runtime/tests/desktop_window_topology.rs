#![cfg(target_os = "macos")]

use std::{
    fs,
    io::Write,
    io::{BufRead, BufReader},
    os::unix::net::UnixStream,
    path::Path,
    sync::{Arc, Barrier, Weak},
    time::Duration,
};

use debrute_runtime::cli::RuntimeCliService;
use debrute_runtime::control::{
    ActivationIntent, ActivationOutcome, ClientMessage, ClientRole, ControlErrorCode, ControlEvent,
    ControlRequest, ControlResponse, DesktopOpenError, DesktopOpenResult, ProjectFrontend,
    RecentProject, RuntimeActivationService, RuntimeControlState, ServerMessage, WorkbenchRoute,
    encode_frame, read_server_frame, request_handshake, serve_control_connection,
};
use debrute_runtime::workbench::{
    RuntimeCliHttpService, WORKBENCH_CONNECTION_HEADER, WORKBENCH_SESSION_COOKIE,
    WorkbenchHttpServer, WorkbenchRuntimeServices,
};
use reqwest::{
    blocking::{Client, Response},
    header::{ACCEPT, COOKIE, ORIGIN, SET_COOKIE},
};
use serde_json::{Value, json};
use uuid::Uuid;

struct DesktopActivation {
    state: Weak<RuntimeControlState>,
}

impl RuntimeActivationService for DesktopActivation {
    fn activate(&self, intent: &ActivationIntent) -> Result<ActivationOutcome, ControlErrorCode> {
        let route = match intent {
            ActivationIntent::OpenDesktop => WorkbenchRoute::Root,
            ActivationIntent::OpenKnownProject {
                project_id,
                frontend: ProjectFrontend::Desktop,
            } => WorkbenchRoute::Project {
                project_id: project_id.clone(),
            },
            _ => return Err(ControlErrorCode::InvalidActivation),
        };
        match self
            .state
            .upgrade()
            .ok_or(ControlErrorCode::DesktopUnavailable)?
            .open_desktop_window(&route)
        {
            Ok(DesktopOpenResult::Opened) => Ok(ActivationOutcome::Opened),
            Ok(DesktopOpenResult::FocusedExisting) => Ok(ActivationOutcome::FocusedExisting),
            Err(DesktopOpenError::HostUnavailable | DesktopOpenError::Outbound(_)) => {
                Err(ControlErrorCode::DesktopUnavailable)
            }
        }
    }
}

#[test]
fn desktop_promotion_requires_the_initial_recent_project_projection() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(state.finish_startup());
    assert!(
        state.install_activation_service(Arc::new(DesktopActivation {
            state: Arc::downgrade(&state),
        }))
    );
    let (mut desktop, server_stream) = UnixStream::pair().expect("stream pair should open");
    desktop
        .set_read_timeout(Some(Duration::from_secs(1)))
        .expect("read should be bounded");
    let server_state = Arc::clone(&state);
    let server = std::thread::spawn(move || {
        serve_control_connection(server_stream, &server_state, 8)
            .expect("connection should close cleanly");
    });
    request_handshake(&mut desktop, ClientRole::Launcher).expect("handshake should succeed");
    send_request(
        &mut desktop,
        "promote",
        ControlRequest::Activate {
            intent: ActivationIntent::OpenDesktop,
        },
    );

    assert_eq!(
        read_server_frame(&mut desktop).expect("promotion rejection should arrive"),
        ServerMessage::response(
            "promote",
            ControlResponse::Rejected {
                code: ControlErrorCode::DesktopUnavailable,
            },
        )
    );
    drop(desktop);
    server.join().expect("server should finish");
}

#[test]
fn recent_project_projection_ignores_stale_revisions_without_a_delivery_result() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    let current_projects = vec![RecentProject {
        project_id: "project-2".to_owned(),
        project_root: "/projects/current".to_owned(),
    }];
    state.set_recent_projects(2, current_projects.clone());
    state.set_recent_projects(
        2,
        vec![RecentProject {
            project_id: "project-equal".to_owned(),
            project_root: "/projects/equal".to_owned(),
        }],
    );
    state.set_recent_projects(
        1,
        vec![RecentProject {
            project_id: "project-1".to_owned(),
            project_root: "/projects/stale".to_owned(),
        }],
    );
    assert!(state.finish_startup());
    assert!(
        state.install_activation_service(Arc::new(DesktopActivation {
            state: Arc::downgrade(&state),
        }))
    );

    let (mut desktop, server_stream) = UnixStream::pair().expect("stream pair should open");
    desktop
        .set_read_timeout(Some(Duration::from_secs(1)))
        .expect("read should be bounded");
    let server_state = Arc::clone(&state);
    let server = std::thread::spawn(move || {
        serve_control_connection(server_stream, &server_state, 8)
            .expect("connection should close cleanly");
    });
    request_handshake(&mut desktop, ClientRole::Launcher).expect("handshake should succeed");
    send_request(
        &mut desktop,
        "promote",
        ControlRequest::Activate {
            intent: ActivationIntent::OpenDesktop,
        },
    );

    assert_eq!(
        read_server_frame(&mut desktop).expect("recent projects should arrive"),
        ServerMessage::event(ControlEvent::DesktopRecentProjectsChanged {
            global_revision: 2,
            recent_projects: current_projects,
        })
    );
    let _ = expect_open_event(&mut desktop, &WorkbenchRoute::Root);
    expect_activation(
        &mut desktop,
        "promote",
        ActivationOutcome::PromotedToDesktopHost,
    );

    drop(desktop);
    server.join().expect("server should finish");
}

#[test]
fn desktop_promotion_and_projection_update_enqueue_monotonic_revisions() {
    for iteration in 0..64 {
        let state = Arc::new(RuntimeControlState::new(format!(
            "runtime-instance-{iteration}"
        )));
        state.set_recent_projects(0, Vec::new());
        assert!(state.finish_startup());
        assert!(
            state.install_activation_service(Arc::new(DesktopActivation {
                state: Arc::downgrade(&state),
            }))
        );

        let (mut desktop, server_stream) = UnixStream::pair().expect("stream pair should open");
        desktop
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("read should be bounded");
        let server_state = Arc::clone(&state);
        let server = std::thread::spawn(move || {
            serve_control_connection(server_stream, &server_state, 8)
                .expect("connection should close cleanly");
        });
        request_handshake(&mut desktop, ClientRole::Launcher).expect("handshake should succeed");

        let start = Arc::new(Barrier::new(3));
        let mut promotion_stream = desktop.try_clone().expect("promotion stream should clone");
        let promotion_start = Arc::clone(&start);
        let promotion = std::thread::spawn(move || {
            promotion_start.wait();
            send_request(
                &mut promotion_stream,
                "promote",
                ControlRequest::Activate {
                    intent: ActivationIntent::OpenDesktop,
                },
            );
        });
        let update_state = Arc::clone(&state);
        let update_start = Arc::clone(&start);
        let update = std::thread::spawn(move || {
            update_start.wait();
            update_state.set_recent_projects(
                1,
                vec![RecentProject {
                    project_id: "project-1".to_owned(),
                    project_root: "/projects/current".to_owned(),
                }],
            );
        });
        start.wait();
        promotion.join().expect("promotion request should finish");
        update.join().expect("projection update should finish");

        let mut revisions = Vec::new();
        let mut opened = false;
        let mut activated = false;
        while !opened || !activated || !revisions.contains(&1) {
            match read_server_frame(&mut desktop).expect("Desktop message should arrive") {
                ServerMessage::Event {
                    event:
                        ControlEvent::DesktopRecentProjectsChanged {
                            global_revision, ..
                        },
                } => revisions.push(global_revision),
                ServerMessage::Event {
                    event: ControlEvent::DesktopWindowOpenRequested { .. },
                } => opened = true,
                ServerMessage::Response {
                    request_id,
                    response:
                        ControlResponse::Activation {
                            outcome: ActivationOutcome::PromotedToDesktopHost,
                        },
                } if request_id == "promote" => activated = true,
                message => panic!("unexpected Desktop message: {message:?}"),
            }
        }
        assert!(
            revisions == [1] || revisions == [0, 1],
            "projection revisions must be monotonic, got {revisions:?}"
        );

        drop(desktop);
        server.join().expect("server should finish");
    }
}

#[test]
fn launcher_is_promoted_then_project_open_focus_and_close_are_single_instance() {
    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    state.set_recent_projects(0, Vec::new());
    assert!(state.finish_startup());
    assert!(
        state.install_activation_service(Arc::new(DesktopActivation {
            state: Arc::downgrade(&state),
        }))
    );
    let (mut desktop, server_stream) = UnixStream::pair().expect("stream pair should open");
    desktop
        .set_read_timeout(Some(Duration::from_secs(1)))
        .expect("read should be bounded");
    let server_state = Arc::clone(&state);
    let server = std::thread::spawn(move || {
        serve_control_connection(server_stream, &server_state, 8)
            .expect("connection should close cleanly");
    });
    request_handshake(&mut desktop, ClientRole::Launcher).expect("handshake should succeed");

    send_request(
        &mut desktop,
        "promote",
        ControlRequest::Activate {
            intent: ActivationIntent::OpenDesktop,
        },
    );
    assert!(matches!(
        read_server_frame(&mut desktop).expect("recent projects should arrive"),
        ServerMessage::Event {
            event: ControlEvent::DesktopRecentProjectsChanged { .. }
        }
    ));
    let root_window = expect_open_event(&mut desktop, &WorkbenchRoute::Root);
    assert_eq!(
        read_server_frame(&mut desktop).expect("promotion response should arrive"),
        ServerMessage::response(
            "promote",
            ControlResponse::Activation {
                outcome: ActivationOutcome::PromotedToDesktopHost,
            },
        )
    );

    let project_route = WorkbenchRoute::Project {
        project_id: "project-1".to_owned(),
    };
    send_project_activation(&mut desktop, "open-project", "project-1");
    let project_window = expect_open_event(&mut desktop, &project_route);
    expect_activation(&mut desktop, "open-project", ActivationOutcome::Opened);

    send_project_activation(&mut desktop, "focus-project", "project-1");
    assert_eq!(
        read_server_frame(&mut desktop).expect("focus event should arrive"),
        ServerMessage::event(ControlEvent::DesktopWindowFocusRequested {
            window_key: project_window.clone(),
        })
    );
    expect_activation(
        &mut desktop,
        "focus-project",
        ActivationOutcome::FocusedExisting,
    );

    send_request(
        &mut desktop,
        "close-project",
        ControlRequest::DesktopWindowClosed {
            window_key: project_window,
        },
    );
    assert_eq!(
        read_server_frame(&mut desktop).expect("close response should arrive"),
        ServerMessage::response("close-project", ControlResponse::Ok)
    );
    send_request(
        &mut desktop,
        "close-root",
        ControlRequest::DesktopWindowClosed {
            window_key: root_window,
        },
    );
    assert_eq!(
        read_server_frame(&mut desktop).expect("close response should arrive"),
        ServerMessage::response("close-root", ControlResponse::Ok)
    );

    drop(desktop);
    server.join().expect("server should finish");
}

#[test]
fn desktop_route_tracks_in_window_replacement_and_web_preemption() {
    let root = std::env::temp_dir().join(format!("dbrt-desktop-route-{}", Uuid::new_v4()));
    let assets = root.join("assets");
    fs::create_dir_all(&assets).expect("assets should be created");
    fs::write(assets.join("index.html"), "<main>Debrute</main>").expect("index should be written");
    let project_root = root.join("project");
    let project_id = Uuid::new_v4().to_string();
    fs::create_dir_all(project_root.join(".debrute/canvases"))
        .expect("Project metadata directory should be created");
    write_json(
        &project_root.join(".debrute/project.json"),
        &json!({
            "project": {
                "id": project_id,
                "name": "Desktop route",
                "createdAt": "2026-07-18T00:00:00.000Z",
                "updatedAt": "2026-07-18T00:00:00.000Z"
            }
        }),
    );
    write_json(
        &project_root.join(".debrute/canvases/index.json"),
        &json!({"canvasOrder": []}),
    );

    let state = Arc::new(RuntimeControlState::new("runtime-instance"));
    assert!(
        state.install_activation_service(Arc::new(DesktopActivation {
            state: Arc::downgrade(&state),
        }))
    );
    let services = WorkbenchRuntimeServices::compose(root.join("home"), Arc::clone(&state))
        .expect("Runtime services should compose");
    let cli: Arc<dyn RuntimeCliHttpService> = Arc::new(RuntimeCliService::new(
        Arc::clone(services.models()),
        Arc::clone(services.global()),
        services.projects().clone(),
        Arc::clone(services.generated_assets()),
        Arc::clone(services.model_operations()),
        None,
        None,
    ));
    let http = WorkbenchHttpServer::start(assets, Arc::clone(&state), services, cli, None)
        .expect("Workbench server should start");
    state
        .install_workbench(http.launch_service())
        .expect("Workbench authority should install");
    assert!(state.finish_startup());

    let (mut desktop, server_stream) = UnixStream::pair().expect("stream pair should open");
    desktop
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read should be bounded");
    let server_state = Arc::clone(&state);
    let server = std::thread::spawn(move || {
        serve_control_connection(server_stream, &server_state, 8)
            .expect("connection should close cleanly");
    });
    request_handshake(&mut desktop, ClientRole::Launcher).expect("handshake should succeed");

    let mut binding = bind_desktop_project(
        &mut desktop,
        http.origin(),
        &state,
        &project_root,
        &project_id,
    );
    preempt_desktop_project(
        &mut desktop,
        http.origin(),
        &state,
        &project_root,
        &project_id,
        &mut binding,
    );

    drop(binding.events);
    drop(desktop);
    server.join().expect("server should finish");
    drop(http);
    let _ = fs::remove_dir_all(root);
}

struct DesktopProjectBinding {
    client: Client,
    events: HttpSseEvents,
    window_key: String,
}

fn bind_desktop_project(
    desktop: &mut UnixStream,
    origin: &str,
    state: &RuntimeControlState,
    project_root: &Path,
    project_id: &str,
) -> DesktopProjectBinding {
    send_request(
        desktop,
        "promote",
        ControlRequest::Activate {
            intent: ActivationIntent::OpenDesktop,
        },
    );
    let _ = read_server_frame(desktop).expect("recent projects should arrive");
    let window_key = expect_open_event(desktop, &WorkbenchRoute::Root);
    expect_activation(desktop, "promote", ActivationOutcome::PromotedToDesktopHost);
    send_request(
        desktop,
        "ticket",
        ControlRequest::CreateDesktopLaunchTicket {
            window_key: window_key.clone(),
        },
    );
    let ServerMessage::Response {
        request_id,
        response:
            ControlResponse::DesktopLaunchTicket {
                ticket,
                theme_preference,
                ..
            },
    } = read_server_frame(desktop).expect("ticket response should arrive")
    else {
        panic!("expected Desktop launch ticket");
    };
    assert_eq!(request_id, "ticket");
    assert_eq!(theme_preference, "system");

    let client = Client::new();
    let (cookie, credential, mut events) =
        open_http_connection(&client, origin, &json!({"desktopLaunchTicket": ticket}));
    open_http_project(
        &client,
        origin,
        project_root,
        project_id,
        &cookie,
        &credential,
    );
    assert_eq!(events.next()["type"], "project.bound");
    assert!(matches!(
        state.open_desktop_window(&WorkbenchRoute::Project {
            project_id: project_id.to_owned(),
        }),
        Ok(DesktopOpenResult::FocusedExisting)
    ));
    expect_control_focus(desktop, &window_key);

    DesktopProjectBinding {
        client,
        events,
        window_key,
    }
}

fn preempt_desktop_project(
    desktop: &mut UnixStream,
    origin: &str,
    state: &RuntimeControlState,
    project_root: &Path,
    project_id: &str,
    binding: &mut DesktopProjectBinding,
) {
    assert!(matches!(
        state.open_desktop_window(&WorkbenchRoute::Root),
        Ok(DesktopOpenResult::Opened)
    ));
    let second_window = expect_control_open(desktop, &WorkbenchRoute::Root);
    send_request(
        desktop,
        "second-ticket",
        ControlRequest::CreateDesktopLaunchTicket {
            window_key: second_window,
        },
    );
    let ServerMessage::Response {
        response: ControlResponse::DesktopLaunchTicket { ticket, .. },
        ..
    } = read_server_frame(desktop).expect("second ticket should arrive")
    else {
        panic!("expected second Desktop launch ticket");
    };
    let (second_cookie, second_credential, second_events) = open_http_connection(
        &binding.client,
        origin,
        &json!({"desktopLaunchTicket": ticket}),
    );
    assert_eq!(
        open_http_project_response(
            &binding.client,
            origin,
            project_root,
            &second_cookie,
            &second_credential,
        ),
        json!({
            "outcome": "focused_existing_desktop",
            "projectId": project_id
        })
    );
    expect_control_focus(desktop, &binding.window_key);

    let (web_cookie, web_credential, mut web_events) =
        open_http_connection(&binding.client, origin, &json!({}));
    open_http_project(
        &binding.client,
        origin,
        project_root,
        project_id,
        &web_cookie,
        &web_credential,
    );
    assert_eq!(web_events.next()["type"], "project.bound");
    loop {
        if binding.events.next()["type"] == "project.preempted" {
            break;
        }
    }
    assert!(matches!(
        state.open_desktop_window(&WorkbenchRoute::Project {
            project_id: project_id.to_owned(),
        }),
        Ok(DesktopOpenResult::Opened)
    ));
    let opened_window = expect_control_open(
        desktop,
        &WorkbenchRoute::Project {
            project_id: project_id.to_owned(),
        },
    );
    assert_ne!(opened_window, binding.window_key);

    desktop_open_here_preempts_web(
        desktop,
        origin,
        project_id,
        opened_window,
        &binding.client,
        &mut web_events,
    );

    drop(web_events);
    drop(second_events);
}

fn desktop_open_here_preempts_web(
    desktop: &mut UnixStream,
    origin: &str,
    project_id: &str,
    window_key: String,
    client: &Client,
    web_events: &mut HttpSseEvents,
) {
    send_request(
        desktop,
        "web-owner-ticket",
        ControlRequest::CreateDesktopLaunchTicket { window_key },
    );
    let ServerMessage::Response {
        response: ControlResponse::DesktopLaunchTicket { ticket, .. },
        ..
    } = read_server_frame(desktop).expect("Desktop ticket should arrive")
    else {
        panic!("expected Desktop launch ticket");
    };
    let (desktop_cookie, desktop_credential, mut desktop_events) = open_http_connection(
        client,
        origin,
        &json!({
            "desktopLaunchTicket": ticket,
            "requestedProjectId": project_id
        }),
    );
    let conflict = desktop_events.next();
    assert_eq!(conflict["type"], "project.open_failed");
    assert_eq!(conflict["error"]["code"], "project_owned_by_web");

    let open_here = client
        .post(format!("{origin}/api/projects/open"))
        .header(ORIGIN, origin)
        .header(COOKIE, desktop_cookie)
        .header(WORKBENCH_CONNECTION_HEADER, desktop_credential)
        .json(&json!({ "projectId": project_id, "forceOpenHere": true }))
        .send()
        .expect("Open Here should complete");
    assert_eq!(open_here.status().as_u16(), 200);
    assert_eq!(desktop_events.next()["type"], "project.bound");
    loop {
        if web_events.next()["type"] == "project.preempted" {
            break;
        }
    }
}

struct HttpSseEvents {
    lines: std::io::Lines<BufReader<Response>>,
}

impl HttpSseEvents {
    fn next(&mut self) -> Value {
        loop {
            let line = self
                .lines
                .next()
                .expect("SSE stream should remain open")
                .expect("SSE line should read");
            if let Some(data) = line.strip_prefix("data:") {
                return serde_json::from_str(data.trim()).expect("SSE data should be JSON");
            }
        }
    }
}

fn open_http_connection(
    client: &Client,
    origin: &str,
    body: &Value,
) -> (String, String, HttpSseEvents) {
    let response = client
        .post(format!("{origin}/api/workbench/connection"))
        .header(ORIGIN, origin)
        .header(ACCEPT, "text/event-stream")
        .json(body)
        .send()
        .expect("Workbench connection should open");
    assert_eq!(response.status().as_u16(), 200);
    let cookie = response
        .headers()
        .get(SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .expect("session cookie should exist")
        .split(';')
        .next()
        .expect("cookie should have a value")
        .to_owned();
    assert!(cookie.starts_with(&format!("{WORKBENCH_SESSION_COOKIE}=")));
    let mut events = HttpSseEvents {
        lines: BufReader::new(response).lines(),
    };
    let opened = events.next();
    let credential = opened["connectionCredential"]
        .as_str()
        .expect("credential should exist")
        .to_owned();
    assert_eq!(events.next()["type"], "global.snapshot");
    (cookie, credential, events)
}

fn open_http_project(
    client: &Client,
    origin: &str,
    project_root: &Path,
    project_id: &str,
    cookie: &str,
    credential: &str,
) {
    assert_eq!(
        open_http_project_response(client, origin, project_root, cookie, credential),
        json!({"outcome": "bound", "projectId": project_id})
    );
}

fn open_http_project_response(
    client: &Client,
    origin: &str,
    project_root: &Path,
    cookie: &str,
    credential: &str,
) -> Value {
    let response = client
        .post(format!("{origin}/api/projects/open"))
        .header(ORIGIN, origin)
        .header(COOKIE, cookie)
        .header(WORKBENCH_CONNECTION_HEADER, credential)
        .json(&json!({"projectRoot": project_root.to_string_lossy()}))
        .send()
        .expect("Project open should complete");
    let status = response.status().as_u16();
    let body = response.text().expect("response body should read");
    assert_eq!(status, 200, "Project open failed: {body}");
    serde_json::from_str(&body).expect("response should be JSON")
}

fn expect_control_focus(stream: &mut UnixStream, window_key: &str) {
    loop {
        if let ServerMessage::Event {
            event: ControlEvent::DesktopWindowFocusRequested { window_key: actual },
        } = read_server_frame(stream).expect("Control event should arrive")
        {
            assert_eq!(actual, window_key);
            return;
        }
    }
}

fn expect_control_open(stream: &mut UnixStream, route: &WorkbenchRoute) -> String {
    loop {
        if let ServerMessage::Event {
            event:
                ControlEvent::DesktopWindowOpenRequested {
                    window_key,
                    route: actual,
                },
        } = read_server_frame(stream).expect("Control event should arrive")
        {
            assert_eq!(&actual, route);
            return window_key;
        }
    }
}

fn write_json(path: &Path, value: &Value) {
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(value).unwrap()),
    )
    .expect("JSON fixture should be written");
}

fn send_project_activation(stream: &mut UnixStream, request_id: &str, project_id: &str) {
    send_request(
        stream,
        request_id,
        ControlRequest::Activate {
            intent: ActivationIntent::OpenKnownProject {
                project_id: project_id.to_owned(),
                frontend: ProjectFrontend::Desktop,
            },
        },
    );
}

fn expect_open_event(stream: &mut UnixStream, route: &WorkbenchRoute) -> String {
    let ServerMessage::Event {
        event:
            ControlEvent::DesktopWindowOpenRequested {
                window_key,
                route: actual,
            },
    } = read_server_frame(stream).expect("open event should arrive")
    else {
        panic!("expected Desktop open event");
    };
    assert_eq!(&actual, route);
    window_key
}

fn expect_activation(stream: &mut UnixStream, request_id: &str, outcome: ActivationOutcome) {
    assert_eq!(
        read_server_frame(stream).expect("activation response should arrive"),
        ServerMessage::response(request_id, ControlResponse::Activation { outcome })
    );
}

fn send_request(stream: &mut UnixStream, request_id: &str, request: ControlRequest) {
    stream
        .write_all(
            &encode_frame(&ClientMessage::request(request_id, request))
                .expect("request should encode"),
        )
        .expect("request should write");
}
