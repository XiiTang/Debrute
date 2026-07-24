#![cfg(target_os = "macos")]

use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::Arc,
};

use debrute_runtime::{
    control::{RuntimeControlState, RuntimeStatus},
    workbench::{
        WORKBENCH_CONNECTION_HEADER, WORKBENCH_SESSION_COOKIE, WorkbenchHttpServer,
        WorkbenchRuntimeServices,
    },
};
use reqwest::{
    blocking::{Client, Response},
    header::{ACCEPT, AUTHORIZATION, COOKIE, ORIGIN, SET_COOKIE},
};
use serde_json::{Value, json};
use uuid::Uuid;

#[test]
fn stable_assets_have_no_launch_credential_in_the_url() {
    let runtime = TestRuntime::start();
    let response = Client::new()
        .get(format!("{}/projects/project-1", runtime.origin()))
        .send()
        .expect("stable Workbench route should respond");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.url().path(), "/projects/project-1");
    assert!(response.url().query().is_none());
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-cache")
    );
}

#[test]
fn workbench_connection_requires_exact_origin_and_rejects_bearer_auth() {
    let runtime = TestRuntime::start();
    let client = Client::new();
    let missing_origin = client
        .post(format!("{}/api/workbench/connection", runtime.origin()))
        .header(ACCEPT, "text/event-stream")
        .json(&json!({}))
        .send()
        .expect("request should complete");
    assert_eq!(missing_origin.status().as_u16(), 403);

    let bearer = client
        .post(format!("{}/api/workbench/connection", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(ACCEPT, "text/event-stream")
        .header(AUTHORIZATION, "Bearer forbidden")
        .json(&json!({}))
        .send()
        .expect("request should complete");
    assert_eq!(bearer.status().as_u16(), 403);
}

#[test]
fn runtime_shutdown_closes_a_live_workbench_stream_before_http_join() {
    let mut runtime = TestRuntime::start();
    let response = Client::new()
        .post(format!("{}/api/workbench/connection", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(ACCEPT, "text/event-stream")
        .json(&json!({}))
        .send()
        .expect("connection should open");
    let mut events = SseEvents::new(response);
    assert_eq!(events.next()["type"], "connection.opened");
    assert_eq!(events.next()["type"], "global.snapshot");

    runtime.server.stop_accepting();
    runtime.services.close_all_workbench_connections();
    drop(runtime);

    assert!(
        events
            .lines
            .all(|line| line.expect("remaining SSE line should read").is_empty())
    );
}

#[test]
fn one_post_stream_bootstraps_global_state_and_binds_a_project() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("single-connection");
    let client = Client::new();
    let response = client
        .post(format!("{}/api/workbench/connection", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(ACCEPT, "text/event-stream")
        .json(&json!({}))
        .send()
        .expect("connection should open");
    assert_eq!(response.status().as_u16(), 200);
    let cookie = response
        .headers()
        .get(SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .expect("connection should establish an HttpOnly session")
        .to_owned();
    assert!(cookie.starts_with(&format!("{WORKBENCH_SESSION_COOKIE}=")));
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
    let cookie_pair = cookie
        .split(';')
        .next()
        .expect("cookie should contain its value")
        .to_owned();
    let mut events = SseEvents::new(response);
    let opened = events.next();
    assert_eq!(opened["type"], "connection.opened");
    let credential = opened["connectionCredential"]
        .as_str()
        .expect("connection credential should be present")
        .to_owned();
    assert!(!credential.is_empty());
    assert_eq!(events.next()["type"], "global.snapshot");

    let open = client
        .post(format!("{}/api/projects/open", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, cookie_pair)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({ "projectRoot": project.root }))
        .send()
        .expect("Project open should complete");
    assert_eq!(open.status().as_u16(), 200);
    let body: Value = open.json().expect("Project open response should be JSON");
    assert_eq!(body["projectId"], project.id);
    assert!(body.get("snapshot").is_none());
    let bound = events.next();
    assert_eq!(bound["type"], "project.bound");
    assert_eq!(bound["project"]["projectId"], project.id);
    assert_eq!(
        bound["workingCopies"],
        json!({"text": {}, "feedback": null})
    );
}

#[test]
fn working_copy_survives_connection_close_and_clears_without_retention() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("working-copy");
    let client = Client::new();

    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);
    assert_eq!(events.next()["type"], "project.bound");
    let put = client
        .put(format!(
            "{}/api/projects/{}/working-copies/text/draft.md",
            runtime.origin(),
            project.id
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({
            "content": "unsaved full value",
            "language": "markdown",
            "baseRevision": "revision-1"
        }))
        .send()
        .expect("Working Copy put should complete");
    assert_eq!(put.status().as_u16(), 200);
    drop(events);

    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);
    let restored = events.next();
    assert_eq!(
        restored["workingCopies"]["text"]["draft.md"],
        json!({
            "projectRelativePath": "draft.md",
            "content": "unsaved full value",
            "language": "markdown",
            "baseRevision": "revision-1"
        })
    );
    let cleared = client
        .delete(format!(
            "{}/api/projects/{}/working-copies/text/draft.md",
            runtime.origin(),
            project.id
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .send()
        .expect("Working Copy clear should complete");
    assert_eq!(cleared.status().as_u16(), 204);
    drop(events);

    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);
    assert_eq!(
        events.next()["workingCopies"],
        json!({"text": {}, "feedback": null})
    );
}

fn open_unbound_connection(client: &Client, runtime: &TestRuntime) -> (String, String, SseEvents) {
    let response = client
        .post(format!("{}/api/workbench/connection", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(ACCEPT, "text/event-stream")
        .json(&json!({}))
        .send()
        .expect("connection should open");
    let cookie = response
        .headers()
        .get(SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .expect("session cookie should be present")
        .split(';')
        .next()
        .expect("cookie should contain a value")
        .to_owned();
    let mut events = SseEvents::new(response);
    let opened = events.next();
    let credential = opened["connectionCredential"]
        .as_str()
        .expect("connection credential should be present")
        .to_owned();
    assert_eq!(events.next()["type"], "global.snapshot");
    (cookie, credential, events)
}

fn open_project(
    client: &Client,
    runtime: &TestRuntime,
    project: &TestProject,
    cookie: &str,
    credential: &str,
) {
    let response = client
        .post(format!("{}/api/projects/open", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, cookie)
        .header(WORKBENCH_CONNECTION_HEADER, credential)
        .json(&json!({ "projectRoot": project.root }))
        .send()
        .expect("Project open should complete");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response.json::<Value>().expect("response should be JSON"),
        json!({"outcome": "bound", "projectId": project.id})
    );
}

struct SseEvents {
    lines: std::io::Lines<BufReader<Response>>,
}

impl SseEvents {
    fn new(response: Response) -> Self {
        Self {
            lines: BufReader::new(response).lines(),
        }
    }

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

struct TestRuntime {
    root: PathBuf,
    server: WorkbenchHttpServer,
    services: Arc<WorkbenchRuntimeServices>,
}

impl TestRuntime {
    fn start() -> Self {
        let root = std::env::temp_dir().join(format!("dbrt-http-{}", Uuid::new_v4()));
        let assets = root.join("assets");
        fs::create_dir_all(&assets).expect("assets should be created");
        fs::write(assets.join("index.html"), "<main>Debrute Workbench</main>")
            .expect("index should be written");
        let state = Arc::new(RuntimeControlState::new(
            "runtime-instance",
            RuntimeStatus::Starting,
        ));
        let services = WorkbenchRuntimeServices::compose(root.join("home"), Arc::clone(&state))
            .expect("Runtime services should compose");
        let server = WorkbenchHttpServer::start_with_runtime(
            assets,
            Arc::clone(&state),
            Arc::clone(&services),
        )
        .expect("Workbench HTTP server should start");
        state
            .install_workbench(server.launch_service())
            .expect("Workbench authority should install");
        state.set_status(RuntimeStatus::Ready);
        Self {
            root,
            server,
            services,
        }
    }

    fn origin(&self) -> &str {
        self.server.origin()
    }

    fn create_project(&self, name: &str) -> TestProject {
        let id = Uuid::new_v4().to_string();
        let root = self.root.join(name);
        fs::create_dir_all(root.join(".debrute/canvases"))
            .expect("Project metadata directory should be created");
        write_json(
            &root.join(".debrute/project.json"),
            &json!({
                "project": {
                    "id": id,
                    "name": name,
                    "createdAt": "2026-07-18T00:00:00.000Z",
                    "updatedAt": "2026-07-18T00:00:00.000Z"
                }
            }),
        );
        write_json(
            &root.join(".debrute/canvases/index.json"),
            &json!({ "canvasOrder": [] }),
        );
        TestProject {
            id,
            root: root.to_string_lossy().into_owned(),
        }
    }
}

impl Drop for TestRuntime {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct TestProject {
    id: String,
    root: String,
}

fn write_json(path: &Path, value: &Value) {
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(value).unwrap()),
    )
    .expect("JSON fixture should be written");
}
