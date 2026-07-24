#![cfg(target_os = "macos")]

use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::Arc,
};

use debrute_runtime::{
    cli::RuntimeCliService,
    control::RuntimeControlState,
    project::project_file_revision_from_metadata,
    workbench::{
        RuntimeCliHttpService, WORKBENCH_CONNECTION_HEADER, WORKBENCH_SESSION_COOKIE,
        WorkbenchHttpServer, WorkbenchRuntimeServices,
    },
};
use reqwest::{
    Method,
    blocking::{Client, Response},
    header::{ACCEPT, AUTHORIZATION, CACHE_CONTROL, COOKIE, ORIGIN, SET_COOKIE},
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
fn packaged_workbench_serves_only_the_closed_page_routes() {
    let runtime = TestRuntime::start();
    let client = Client::new();
    for path in [
        "/",
        "/open",
        "/open?path=%2FUsers%2Fme%2FProject%20A",
        "/projects/project-1._~",
    ] {
        let response = client
            .get(format!("{}{path}", runtime.origin()))
            .send()
            .expect("valid Workbench page should respond");
        assert_eq!(response.status().as_u16(), 200, "{path}");
    }
    for path in [
        "/settings",
        "/?view=canvas",
        "/open/",
        "/open?path=",
        "/open?path=%FF",
        "/open?path=%2Ftmp&path=%2Fother",
        "/projects/project-1/",
        "/projects/project-1/files/a",
        "/projects/project%201",
        "/projects/project-1?view=canvas",
        "/index.html",
    ] {
        let response = client
            .get(format!("{}{path}", runtime.origin()))
            .send()
            .expect("invalid Workbench page should respond");
        assert_eq!(response.status().as_u16(), 404, "{path}");
    }
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
fn source_runtime_has_no_product_http_routes() {
    let runtime = TestRuntime::start();
    let client = Client::new();
    let (cookie, credential, _events) = open_unbound_connection(&client, &runtime);
    let response = client
        .get(format!("{}/api/runtime/product", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, cookie)
        .header(WORKBENCH_CONNECTION_HEADER, credential)
        .send()
        .expect("missing Product route should respond");
    assert_eq!(response.status().as_u16(), 404);
}

#[test]
fn model_api_key_reveal_is_authenticated_non_cacheable_and_not_published() {
    let runtime = TestRuntime::start();
    let client = Client::new();
    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    let exact_api_key = "  密钥🔑 \n";
    let save = client
        .patch(format!("{}/api/settings/global", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({
            "modelSetting": {
                "modelId": "gpt-image-2",
                "setting": {
                    "baseUrlOverride": null,
                    "requestModelIdOverride": null,
                    "apiKey": exact_api_key
                }
            }
        }))
        .send()
        .expect("model API key save should complete");
    assert_eq!(save.status().as_u16(), 200);
    let settings_event = events.next_of_type("globalSettings.changed");
    let event_json = settings_event.to_string();
    assert!(!event_json.contains(exact_api_key));
    assert!(!event_json.contains("apiKeyPreview"));
    let revision = runtime.services.global().revision();

    let unauthorized = client
        .post(format!(
            "{}/api/settings/models/api-key/reveal",
            runtime.origin()
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .json(&json!({ "modelId": "gpt-image-2" }))
        .send()
        .expect("unauthorized reveal should complete");
    assert_eq!(unauthorized.status().as_u16(), 403);

    let reveal = client
        .post(format!(
            "{}/api/settings/models/api-key/reveal",
            runtime.origin()
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({ "modelId": "gpt-image-2" }))
        .send()
        .expect("authorized reveal should complete");
    assert_eq!(reveal.status().as_u16(), 200);
    assert_eq!(
        reveal
            .headers()
            .get(CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    assert_eq!(
        reveal.json::<Value>().expect("reveal should return JSON"),
        json!({ "apiKey": exact_api_key })
    );
    assert_eq!(runtime.services.global().revision(), revision);
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
    assert_eq!(bound["workingCopies"], json!({"text": {}, "feedback": {}}));
}

#[test]
fn replacement_publishes_the_prepared_project_and_releases_the_source_use() {
    let runtime = TestRuntime::start();
    let source = runtime.create_project("replacement-source");
    let target = runtime.create_project("replacement-target");
    let client = Client::new();
    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &source, &cookie, &credential);
    assert_eq!(
        events.next_of_type("project.bound")["project"]["projectId"],
        source.id
    );

    let replacement = client
        .post(format!("{}/api/projects/replace", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({ "projectRoot": target.root }))
        .send()
        .expect("Project replacement should complete");
    assert_eq!(replacement.status().as_u16(), 200);
    assert_eq!(
        replacement
            .json::<Value>()
            .expect("replacement response should be JSON"),
        json!({"outcome": "bound", "projectId": target.id})
    );
    let bound = events.next_of_type("project.bound");
    assert_eq!(bound["project"]["projectId"], target.id);
    assert_eq!(bound["workingCopies"], json!({"text": {}, "feedback": {}}));

    let stale_source_request = client
        .get(format!(
            "{}/api/projects/{}/files/text/missing.txt",
            runtime.origin(),
            source.id
        ))
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .send()
        .expect("stale source request should complete");
    assert_eq!(stale_source_request.status().as_u16(), 403);
    assert!(runtime.services.projects().get(&source.id).is_err());
    assert!(runtime.services.projects().get(&target.id).is_ok());
}

#[test]
fn ordinary_browser_tabs_share_one_session_without_sharing_connection_authority() {
    let runtime = TestRuntime::start();
    let first_project = runtime.create_project("first-tab");
    let second_project = runtime.create_project("second-tab");
    let first_file = Path::new(&first_project.root).join("first.txt");
    let second_file = Path::new(&second_project.root).join("second.txt");
    fs::write(&first_file, b"first tab").expect("first file should be written");
    fs::write(&second_file, b"second tab").expect("second file should be written");
    let first_revision = project_file_revision_from_metadata(
        &fs::metadata(&first_file).expect("first metadata should read"),
    )
    .expect("first revision should resolve");
    let second_revision = project_file_revision_from_metadata(
        &fs::metadata(&second_file).expect("second metadata should read"),
    )
    .expect("second revision should resolve");
    let client = Client::new();

    let (cookie, first_credential, mut first_events) = open_unbound_connection(&client, &runtime);
    let (second_cookie, second_credential, mut second_events) =
        open_unbound_connection_with_cookie(&client, &runtime, Some(&cookie));
    assert_eq!(second_cookie, cookie);
    open_project(
        &client,
        &runtime,
        &first_project,
        &cookie,
        &first_credential,
    );
    open_project(
        &client,
        &runtime,
        &second_project,
        &cookie,
        &second_credential,
    );
    assert_eq!(
        first_events.next_of_type("project.bound")["type"],
        "project.bound"
    );
    assert_eq!(
        second_events.next_of_type("project.bound")["type"],
        "project.bound"
    );

    let wrong_connection = client
        .get(format!(
            "{}/api/projects/{}/files/text/first.txt",
            runtime.origin(),
            first_project.id
        ))
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &second_credential)
        .send()
        .expect("cross-connection request should complete");
    assert_eq!(wrong_connection.status().as_u16(), 403);

    for (project, path, revision, expected) in [
        (&first_project, "first.txt", &first_revision, "first tab"),
        (
            &second_project,
            "second.txt",
            &second_revision,
            "second tab",
        ),
    ] {
        let media = client
            .get(format!(
                "{}/api/projects/{}/files/raw/{path}?v={revision}",
                runtime.origin(),
                project.id
            ))
            .header(COOKIE, &cookie)
            .send()
            .expect("passive media request should complete");
        assert_eq!(media.status().as_u16(), 200);
        assert_eq!(media.text().expect("media should read"), expected);
    }

    drop(second_events);
    let first_still_live = client
        .get(format!(
            "{}/api/projects/{}/files/text/first.txt",
            runtime.origin(),
            first_project.id
        ))
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &first_credential)
        .send()
        .expect("first connection request should complete");
    assert_eq!(first_still_live.status().as_u16(), 200);
}

#[test]
fn passive_media_routes_reject_missing_or_empty_identity_values() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("media-query-contract");
    fs::write(Path::new(&project.root).join("image.png"), b"fixture")
        .expect("fixture should be written");
    let client = Client::new();
    let (cookie, credential, _events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);

    for path in [
        format!("/api/projects/{}/files/raw/image.png", project.id),
        format!(
            "/api/projects/{}/canvas-image-preview?w=64&path=&v=revision",
            project.id
        ),
        format!(
            "/api/projects/{}/canvas-text-preview?w=64&path=image.png&fingerprint=fingerprint",
            project.id
        ),
        format!(
            "/api/projects/{}/canvas-video-preview?w=64&t=0&path=image.png&videoRevision=revision&canvasId=canvas-1",
            project.id
        ),
    ] {
        let response = client
            .get(format!("{}{path}", runtime.origin()))
            .header(COOKIE, &cookie)
            .send()
            .expect("invalid passive media request should complete");
        assert_eq!(response.status().as_u16(), 400, "{path}");
        let body: Value = response.json().expect("error should be JSON");
        assert_eq!(body["error"]["code"], "invalid_input", "{path}");
    }
}

#[test]
fn canvas_mutation_routes_require_exact_non_empty_collections() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("canvas-mutation-contract");
    fs::write(Path::new(&project.root).join("note.txt"), "note")
        .expect("text fixture should be written");
    let client = Client::new();
    let (cookie, credential, _events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);

    let canvas_id = create_canvas(&client, &runtime, &project, &cookie, &credential);
    let layout_url = format!(
        "{}/api/projects/{}/canvases/{canvas_id}/node-layouts",
        runtime.origin(),
        project.id
    );
    let reset_url = format!(
        "{}/api/projects/{}/canvases/{canvas_id}/reset-layout",
        runtime.origin(),
        project.id
    );
    for (body, expected_code) in [
        (json!({}), "invalid_json"),
        (json!({ "nodeLayouts": [] }), "invalid_input"),
        (
            json!({
                "nodeLayouts": [{
                    "projectRelativePath": "note.txt",
                    "x": 0,
                    "y": 0,
                    "unexpectedField": true
                }]
            }),
            "invalid_json",
        ),
    ] {
        assert_canvas_mutation_error(
            &client,
            &runtime,
            Method::PATCH,
            &layout_url,
            (&cookie, &credential),
            &body,
            expected_code,
        );
    }

    for (body, expected_code) in [
        (json!({ "pathRules": {} }), "invalid_json"),
        (
            json!({ "pathRules": { "paths": ["image.png"] } }),
            "invalid_json",
        ),
        (
            json!({ "pathRules": { "paths": [], "globs": [] } }),
            "invalid_input",
        ),
    ] {
        assert_canvas_mutation_error(
            &client,
            &runtime,
            Method::POST,
            &reset_url,
            (&cookie, &credential),
            &body,
            expected_code,
        );
    }
}

#[test]
fn canvas_media_state_routes_require_exact_non_empty_collections() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("canvas-media-state-contract");
    let client = Client::new();
    let (cookie, credential, _events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);

    let canvas_id = create_canvas(&client, &runtime, &project, &cookie, &credential);
    let video_url = format!(
        "{}/api/projects/{}/canvases/{canvas_id}/video-playback",
        runtime.origin(),
        project.id
    );
    let text_url = format!(
        "{}/api/projects/{}/canvases/{canvas_id}/text-viewport",
        runtime.origin(),
        project.id
    );
    for (url, body, expected_code) in [
        (&video_url, json!({ "updates": [] }), "invalid_input"),
        (
            &video_url,
            json!({
                "updates": [{
                    "projectRelativePath": "clip.mp4",
                    "currentTimeSeconds": 0,
                    "unexpectedField": true
                }]
            }),
            "invalid_json",
        ),
        (&text_url, json!({ "updates": [] }), "invalid_input"),
        (
            &text_url,
            json!({
                "updates": [{
                    "projectRelativePath": "note.txt",
                    "scrollTop": 0,
                    "scrollLeft": 0,
                    "unexpectedField": true
                }]
            }),
            "invalid_json",
        ),
    ] {
        assert_canvas_mutation_error(
            &client,
            &runtime,
            Method::PATCH,
            url,
            (&cookie, &credential),
            &body,
            expected_code,
        );
    }
}

#[test]
fn canvas_layout_and_selective_reset_accept_exact_current_inputs() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("canvas-layout-contract");
    fs::write(Path::new(&project.root).join("note.txt"), "note")
        .expect("text fixture should be written");
    let client = Client::new();
    let (cookie, credential, _events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);

    let canvas_id = create_canvas(&client, &runtime, &project, &cookie, &credential);
    let layout_url = format!(
        "{}/api/projects/{}/canvases/{canvas_id}/node-layouts",
        runtime.origin(),
        project.id
    );
    let reset_url = format!(
        "{}/api/projects/{}/canvases/{canvas_id}/reset-layout",
        runtime.origin(),
        project.id
    );

    let add = client
        .post(format!(
            "{}/api/projects/{}/canvases/{canvas_id}/canvas-map/project-paths",
            runtime.origin(),
            project.id
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({ "projectRelativePath": "note.txt" }))
        .send()
        .expect("Canvas Map add should complete");
    assert_eq!(add.status().as_u16(), 200);

    let layout = client
        .patch(&layout_url)
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({
            "nodeLayouts": [{
                "projectRelativePath": "note.txt",
                "x": 10,
                "y": 20
            }]
        }))
        .send()
        .expect("exact Canvas layout request should complete");
    assert_eq!(layout.status().as_u16(), 200);

    let reset = client
        .post(&reset_url)
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({
            "pathRules": {
                "paths": ["note.txt"],
                "globs": []
            }
        }))
        .send()
        .expect("exact selective Canvas reset request should complete");
    assert_eq!(reset.status().as_u16(), 200);
}

fn assert_canvas_mutation_error(
    client: &Client,
    runtime: &TestRuntime,
    method: Method,
    url: &str,
    session: (&str, &str),
    body: &Value,
    expected_code: &str,
) {
    let response = client
        .request(method, url)
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, session.0)
        .header(WORKBENCH_CONNECTION_HEADER, session.1)
        .json(body)
        .send()
        .expect("invalid Canvas mutation request should complete");
    assert_eq!(response.status().as_u16(), 400);
    assert_eq!(
        response
            .json::<Value>()
            .expect("Canvas mutation error should be JSON")["error"]["code"],
        expected_code
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
        json!({"text": {}, "feedback": {}})
    );
}

#[test]
fn feedback_working_copies_are_independent_by_stable_item_id() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("feedback-working-copies");
    let client = Client::new();
    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);
    assert_eq!(events.next()["type"], "project.bound");

    for (item_id, project_relative_path, comment) in [
        ("feedback-a", "images/a.png", "First local value"),
        ("feedback-b", "images/b.png", "Second local value"),
    ] {
        let response = client
            .put(format!(
                "{}/api/projects/{}/working-copies/feedback/{item_id}",
                runtime.origin(),
                project.id
            ))
            .header(ORIGIN, runtime.origin())
            .header(COOKIE, &cookie)
            .header(WORKBENCH_CONNECTION_HEADER, &credential)
            .json(&json!({
                "itemId": item_id,
                "createdAt": "2026-07-23T00:00:00.000Z",
                "projectRelativePath": project_relative_path,
                "kind": "comment",
                "scope": "file",
                "comment": comment
            }))
            .send()
            .expect("Feedback Working Copy put should complete");
        assert_eq!(response.status().as_u16(), 200);
    }
    drop(events);

    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);
    let restored = events.next();
    assert_eq!(
        restored["workingCopies"]["feedback"],
        json!({
            "feedback-a": {
                "itemId": "feedback-a",
                "createdAt": "2026-07-23T00:00:00.000Z",
                "projectRelativePath": "images/a.png",
                "kind": "comment",
                "scope": "file",
                "comment": "First local value"
            },
            "feedback-b": {
                "itemId": "feedback-b",
                "createdAt": "2026-07-23T00:00:00.000Z",
                "projectRelativePath": "images/b.png",
                "kind": "comment",
                "scope": "file",
                "comment": "Second local value"
            }
        })
    );

    let cleared = client
        .delete(format!(
            "{}/api/projects/{}/working-copies/feedback/feedback-a",
            runtime.origin(),
            project.id
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .send()
        .expect("Feedback Working Copy clear should complete");
    assert_eq!(cleared.status().as_u16(), 204);
    drop(events);

    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);
    assert_eq!(
        events.next()["workingCopies"]["feedback"],
        json!({
            "feedback-b": {
                "itemId": "feedback-b",
                "createdAt": "2026-07-23T00:00:00.000Z",
                "projectRelativePath": "images/b.png",
                "kind": "comment",
                "scope": "file",
                "comment": "Second local value"
            }
        })
    );
}

#[test]
fn video_preview_sources_are_keyed_by_project_path() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("video-preview-sources");
    let project_root = Path::new(&project.root);
    fs::create_dir_all(project_root.join("media")).expect("media directory should be created");
    let video = project_root.join("media/clip.mp4");
    fs::write(&video, b"video").expect("video fixture should be written");
    image::RgbaImage::new(8, 4)
        .save(project_root.join("media/clip.poster.png"))
        .expect("poster fixture should be written");
    let video_revision = project_file_revision_from_metadata(
        &fs::metadata(&video).expect("video metadata should read"),
    )
    .expect("video revision should resolve");
    let client = Client::new();
    let (cookie, credential, _events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);

    let response = client
        .post(format!(
            "{}/api/projects/{}/canvas-video-previews/sources",
            runtime.origin(),
            project.id
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({
            "canvasId": "canvas-1",
            "targets": [{
                "projectRelativePath": "media/clip.mp4",
                "videoRevision": video_revision,
                "currentTimeSeconds": 0
            }]
        }))
        .send()
        .expect("video preview source request should complete");

    assert_eq!(response.status().as_u16(), 200);
    let body: Value = response
        .json()
        .expect("video preview source response should be JSON");
    assert!(body["sources"].is_object());
    assert_eq!(
        body["sources"]["media/clip.mp4"]["projectRelativePath"],
        "media/clip.mp4"
    );
    assert_eq!(body["sources"]["media/clip.mp4"]["status"], "available");
    assert_eq!(body["sources"]["media/clip.mp4"]["sourceWidth"], 8);
}

fn open_unbound_connection(client: &Client, runtime: &TestRuntime) -> (String, String, SseEvents) {
    open_unbound_connection_with_cookie(client, runtime, None)
}

fn open_unbound_connection_with_cookie(
    client: &Client,
    runtime: &TestRuntime,
    cookie: Option<&str>,
) -> (String, String, SseEvents) {
    let mut request = client
        .post(format!("{}/api/workbench/connection", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(ACCEPT, "text/event-stream");
    if let Some(cookie) = cookie {
        request = request.header(COOKIE, cookie);
    }
    let response = request
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

fn create_canvas(
    client: &Client,
    runtime: &TestRuntime,
    project: &TestProject,
    cookie: &str,
    credential: &str,
) -> String {
    let response = client
        .post(format!(
            "{}/api/projects/{}/canvases",
            runtime.origin(),
            project.id
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, cookie)
        .header(WORKBENCH_CONNECTION_HEADER, credential)
        .json(&json!({}))
        .send()
        .expect("Canvas create should complete");
    assert_eq!(response.status().as_u16(), 200);
    response
        .json::<Value>()
        .expect("Canvas create response should be JSON")["activeCanvasId"]
        .as_str()
        .expect("created Canvas id should be present")
        .to_owned()
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

    fn next_of_type(&mut self, expected: &str) -> Value {
        loop {
            let event = self.next();
            if event["type"] == expected {
                return event;
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
        let state = Arc::new(RuntimeControlState::new("runtime-instance"));
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
        let server = WorkbenchHttpServer::start(
            assets,
            Arc::clone(&state),
            Arc::clone(&services),
            cli,
            None,
        )
        .expect("Workbench HTTP server should start");
        state
            .install_workbench(server.launch_service())
            .expect("Workbench authority should install");
        assert!(state.finish_startup());
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
