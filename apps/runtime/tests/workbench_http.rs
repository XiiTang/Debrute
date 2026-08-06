#![cfg(any(target_os = "macos", target_os = "windows"))]

use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use debrute_runtime::{
    cli::RuntimeCliService,
    control::RuntimeControlState,
    workbench::{
        RuntimeCliHttpService, WORKBENCH_CONNECTION_HEADER, WORKBENCH_SESSION_COOKIE,
        WorkbenchHttpServer, WorkbenchRuntimeServices,
    },
};
use reqwest::{
    blocking::{Client, Response},
    header::{ACCEPT, AUTHORIZATION, CACHE_CONTROL, COOKIE, ORIGIN, SET_COOKIE},
};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

const WORKBENCH_HTTP_TEST_TIMEOUT: Duration = Duration::from_mins(2);

#[test]
fn stable_assets_have_no_launch_credential_in_the_url() {
    let runtime = TestRuntime::start();
    let response = test_client()
        .get(format!(
            "{}/open?path=%2FUsers%2Fme%2FProject%20A",
            runtime.origin()
        ))
        .send()
        .expect("stable Workbench route should respond");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.url().path(), "/open");
    assert_eq!(
        response.url().query(),
        Some("path=%2FUsers%2Fme%2FProject%20A")
    );
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
    let client = test_client();
    for path in ["/", "/open", "/open?path=%2FUsers%2Fme%2FProject%20A"] {
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
        "/projects/project-1._~",
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
    let client = test_client();
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
    let client = test_client();
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
    let client = test_client();
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
    let revision = runtime.services().global().revision();

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
    assert_eq!(runtime.services().global().revision(), revision);
}

#[test]
fn runtime_shutdown_closes_a_live_workbench_stream_before_http_join() {
    let mut runtime = TestRuntime::start();
    let response = test_client()
        .post(format!("{}/api/workbench/connection", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(ACCEPT, "text/event-stream")
        .json(&json!({}))
        .send()
        .expect("connection should open");
    let mut events = SseEvents::new(response);
    assert_eq!(events.next()["type"], "connection.opened");
    assert_eq!(events.next()["type"], "global.snapshot");
    assert_eq!(
        events.next_of_type("product.changed")["type"],
        "product.changed"
    );
    assert_eq!(
        events.next_of_type("photoshop.state.changed")["type"],
        "photoshop.state.changed"
    );
    assert_eq!(
        events.next_of_type("activity.snapshot")["type"],
        "activity.snapshot"
    );

    runtime.services().close_workbench_connection_admission();
    runtime.server.stop_accepting();
    runtime.services().close_all_workbench_connections();
    runtime.server.join();
    drop(runtime);

    assert!(
        events
            .lines
            .all(|line| line.expect("remaining SSE line should read").is_empty())
    );
}

#[test]
fn closed_workbench_admission_rejects_late_connections_while_listener_drains() {
    let runtime = TestRuntime::start();
    runtime.services().close_workbench_connection_admission();

    let response = test_client()
        .post(format!("{}/api/workbench/connection", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(ACCEPT, "text/event-stream")
        .json(&json!({}))
        .send()
        .expect("late connection rejection should respond");

    assert_eq!(response.status().as_u16(), 503);
    assert_eq!(
        response
            .json::<Value>()
            .expect("late connection rejection should be JSON")["error"]["code"],
        "runtime_not_ready"
    );
}

#[test]
fn one_post_stream_bootstraps_global_state_and_binds_a_project() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("single-connection");
    let client = test_client();
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
        .header(COOKIE, &cookie_pair)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({ "projectRoot": project.root }))
        .send()
        .expect("Project open should complete");
    assert_eq!(open.status().as_u16(), 200);
    let body: Value = open.json().expect("Project open response should be JSON");
    assert_eq!(body["canonicalRoot"], project.canonical_root);
    assert!(body["bindingId"].as_str().is_some());
    assert!(body.get("snapshot").is_none());
    let bound = events.next_of_type("project.bound");
    assert_eq!(bound["type"], "project.bound");
    assert_eq!(bound["project"]["canonicalRoot"], project.canonical_root);
    assert_eq!(bound["project"]["bindingId"], body["bindingId"]);
    assert_eq!(
        bound["workingCopies"]["canonicalRoot"],
        project.canonical_root
    );
    assert_eq!(bound["workingCopies"]["text"], json!({}));
    assert_eq!(bound["workingCopies"]["feedback"], json!({}));
}

#[test]
fn activity_stream_is_runtime_global_keeps_history_and_clears_terminal_records_for_every_workbench()
{
    let runtime = TestRuntime::start();
    let project = runtime.create_project("activity-stream");
    let client = test_client();
    let (first_cookie, first_credential, mut first_events) =
        open_unbound_connection(&client, &runtime);
    assert_eq!(
        first_events.next_of_type("activity.snapshot"),
        json!({
            "type": "activity.snapshot",
            "activityRevision": 0,
            "records": []
        })
    );
    open_project(
        &client,
        &runtime,
        &project,
        &first_cookie,
        &first_credential,
    );
    assert_eq!(
        first_events.next_of_type("project.bound")["project"]["canonicalRoot"],
        project.canonical_root
    );

    let (second_cookie, second_credential, mut second_events) =
        open_unbound_connection(&client, &runtime);
    assert_eq!(
        second_events.next_of_type("activity.snapshot")["records"],
        json!([])
    );

    let report = client
        .post(format!(
            "{}/api/workbench/bindings/{}/activities/notices",
            runtime.origin(),
            project.binding_id()
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &first_cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &first_credential)
        .json(&json!({
            "kind": "canvas-operation-failed",
            "operation": "save-layout"
        }))
        .send()
        .expect("Project Activity report should complete");
    assert_eq!(report.status().as_u16(), 200);
    let activity_id = report.json::<Value>().expect("Activity report JSON")["activityId"]
        .as_str()
        .expect("Activity id")
        .to_owned();

    for event in [
        first_events.next_of_type("activity.upsert"),
        second_events.next_of_type("activity.upsert"),
    ] {
        assert_eq!(event["record"]["id"], activity_id);
        assert_eq!(event["record"]["source"], "canvas");
        assert_eq!(
            event["record"]["project"]["canonicalRoot"],
            project.canonical_root
        );
        assert_eq!(event["record"]["project"]["projectName"], "activity-stream");
        assert_eq!(
            event["record"]["message"]["kind"],
            "canvas-operation-failed"
        );
    }

    let (_third_cookie, _third_credential, mut third_events) =
        open_unbound_connection(&client, &runtime);
    let history = third_events.next_of_type("activity.snapshot");
    assert_eq!(history["records"].as_array().map(Vec::len), Some(1));
    assert_eq!(history["records"][0]["id"], activity_id);

    let clear = client
        .delete(format!("{}/api/activities", runtime.origin()))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &second_cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &second_credential)
        .send()
        .expect("Activity clear should complete");
    assert_eq!(clear.status().as_u16(), 200);
    assert_eq!(
        clear.json::<Value>().expect("Activity clear JSON"),
        json!({ "ok": true, "cleared": 1 })
    );
    for event in [
        first_events.next_of_type("activity.remove"),
        second_events.next_of_type("activity.remove"),
        third_events.next_of_type("activity.remove"),
    ] {
        assert_eq!(event["activityIds"], json!([activity_id]));
    }
}

#[test]
fn project_directory_load_publishes_only_the_requested_depth() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("shallow-directory-load");
    fs::create_dir_all(Path::new(&project.root).join("assets/deep"))
        .expect("nested Project directory should be created");
    fs::write(Path::new(&project.root).join("assets/cover.png"), "cover")
        .expect("nested Project file should be written");
    fs::write(
        Path::new(&project.root).join("assets/deep/notes.md"),
        "notes",
    )
    .expect("deep Project file should be written");
    let client = test_client();
    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);

    let bound = events.next_of_type("project.bound");
    let opened_project_tree = bound["project"]["snapshot"]["projectTree"]
        .as_array()
        .expect("bound Project Tree should be an array");
    assert!(
        opened_project_tree
            .iter()
            .any(|entry| entry["projectRelativePath"] == "assets")
    );
    assert!(
        !opened_project_tree
            .iter()
            .any(|entry| entry["projectRelativePath"] == "assets/cover.png")
    );

    let load = client
        .post(format!(
            "{}/api/workbench/bindings/{}/files/load-directory",
            runtime.origin(),
            project.binding_id()
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({ "projectRelativeDirectory": "assets" }))
        .send()
        .expect("Project directory load should complete");
    assert_eq!(load.status().as_u16(), 200);
    let body: Value = load
        .json()
        .expect("Project directory load should return JSON");
    assert_eq!(body["bindingId"], project.binding_id());
    let changed = events.next_of_type("project.changed");
    let loaded_project_tree = changed["snapshot"]["projectTree"]
        .as_array()
        .expect("changed Project Tree should be an array");
    assert!(
        loaded_project_tree
            .iter()
            .any(|entry| entry["projectRelativePath"] == "assets/cover.png")
    );
    assert!(
        loaded_project_tree
            .iter()
            .any(|entry| entry["projectRelativePath"] == "assets/deep")
    );
    assert!(
        !loaded_project_tree
            .iter()
            .any(|entry| entry["projectRelativePath"] == "assets/deep/notes.md")
    );
}

#[test]
fn replacement_publishes_the_prepared_project_and_releases_the_source_use() {
    let runtime = TestRuntime::start();
    let source = runtime.create_project("replacement-source");
    let target = runtime.create_project("replacement-target");
    let client = test_client();
    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &source, &cookie, &credential);
    let source_binding_id = source.binding_id();
    assert_eq!(
        events.next_of_type("project.bound")["project"]["canonicalRoot"],
        source.canonical_root
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
    let replacement = replacement
        .json::<Value>()
        .expect("replacement response should be JSON");
    assert_eq!(replacement["outcome"], "bound");
    assert_eq!(replacement["canonicalRoot"], target.canonical_root);
    let target_binding_id = replacement["bindingId"]
        .as_str()
        .expect("replacement should return a binding id")
        .to_owned();
    let bound = events.next_of_type("project.bound");
    assert_eq!(bound["project"]["canonicalRoot"], target.canonical_root);
    assert_eq!(bound["project"]["bindingId"], target_binding_id);
    assert_eq!(
        bound["workingCopies"]["canonicalRoot"],
        target.canonical_root
    );
    assert_eq!(bound["workingCopies"]["text"], json!({}));
    assert_eq!(bound["workingCopies"]["feedback"], json!({}));

    let stale_source_request = client
        .get(format!(
            "{}/api/workbench/bindings/{}/files/text/missing.txt",
            runtime.origin(),
            source_binding_id
        ))
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .send()
        .expect("stale source request should complete");
    assert_eq!(stale_source_request.status().as_u16(), 403);
    assert!(
        runtime
            .services()
            .projects()
            .get(Path::new(&source.canonical_root))
            .is_err()
    );
    assert!(
        runtime
            .services()
            .projects()
            .get(Path::new(&target.canonical_root))
            .is_ok()
    );
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
    let first_revision = media_revision(&first_file);
    let second_revision = media_revision(&second_file);
    let client = test_client();

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
    let first_binding_id = first_project.binding_id();
    open_project(
        &client,
        &runtime,
        &second_project,
        &cookie,
        &second_credential,
    );
    let second_binding_id = second_project.binding_id();
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
            "{}/api/workbench/bindings/{}/files/text/first.txt",
            runtime.origin(),
            first_binding_id
        ))
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &second_credential)
        .send()
        .expect("cross-connection request should complete");
    assert_eq!(wrong_connection.status().as_u16(), 403);

    for (binding_id, path, revision, expected) in [
        (&first_binding_id, "first.txt", &first_revision, "first tab"),
        (
            &second_binding_id,
            "second.txt",
            &second_revision,
            "second tab",
        ),
    ] {
        let media = client
            .get(format!(
                "{}/api/workbench/bindings/{binding_id}/files/raw/{path}?v={revision}",
                runtime.origin(),
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
            "{}/api/workbench/bindings/{}/files/text/first.txt",
            runtime.origin(),
            first_binding_id
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
    let client = test_client();
    let (cookie, credential, _events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);

    for path in [
        format!(
            "/api/workbench/bindings/{}/files/raw/image.png",
            project.binding_id()
        ),
        format!(
            "/api/workbench/bindings/{}/canvas-image-preview?w=64&path=&sourceRevision=revision",
            project.binding_id()
        ),
        format!(
            "/api/workbench/bindings/{}/canvas-text-preview?w=64&path=image.png&targetIdentity=",
            project.binding_id()
        ),
        format!(
            "/api/workbench/bindings/{}/canvas-video-preview?w=64&frameTimeMs=0&path=image.png&sourceRevision=revision",
            project.binding_id()
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
fn image_previews_are_private_immutable_and_still_reject_stale_revisions() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("image-preview-cache-contract");
    let image_path = Path::new(&project.root).join("image.png");
    image::RgbaImage::new(8, 4)
        .save(&image_path)
        .expect("image fixture should be written");
    let revision = media_revision(&image_path);
    let client = test_client();
    let (cookie, credential, _events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);

    let response = client
        .get(format!(
            "{}/api/workbench/bindings/{}/canvas-image-preview?w=8&path=image.png&sourceRevision={revision}",
            runtime.origin(),
            project.binding_id()
        ))
        .header(COOKIE, &cookie)
        .send()
        .expect("image preview request should complete");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response
            .headers()
            .get(CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("private, max-age=31536000, immutable")
    );

    let stale = client
        .get(format!(
            "{}/api/workbench/bindings/{}/canvas-image-preview?w=8&path=image.png&sourceRevision=stale",
            runtime.origin(),
            project.binding_id()
        ))
        .header(COOKIE, &cookie)
        .send()
        .expect("stale image preview request should complete");
    assert_ne!(stale.status().as_u16(), 200);
    assert_eq!(
        stale
            .json::<Value>()
            .expect("stale response should be JSON")["error"]["code"],
        "canvas_preview_revision_mismatch"
    );
}

#[test]
fn project_path_entries_reject_unknown_fields_at_the_http_boundary() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("project-path-entry-contract");
    let fixture = Path::new(&project.root).join("note.txt");
    fs::write(&fixture, "note").expect("text fixture should be written");
    let client = test_client();
    let (cookie, credential, _events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);

    let response = client
        .post(format!(
            "{}/api/workbench/bindings/{}/files/batch/delete-permanently",
            runtime.origin(),
            project.binding_id()
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({
            "entries": [{
                "projectRelativePath": "note.txt",
                "kind": "file",
                "unexpectedField": true
            }]
        }))
        .send()
        .expect("invalid Project path entry should complete");

    assert_eq!(response.status().as_u16(), 400);
    let body: Value = response.json().expect("error should be JSON");
    assert_eq!(body["error"]["code"], "invalid_json");
    assert!(fixture.exists());
}

#[test]
fn canvas_state_patch_accepts_one_complete_sparse_patch() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("canvas-state-patch");
    fs::write(Path::new(&project.root).join("note.txt"), "note")
        .expect("text fixture should be written");
    let client = test_client();
    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);
    assert_eq!(
        events.next_of_type("project.bound")["type"],
        "project.bound"
    );
    let endpoint = format!(
        "{}/api/workbench/bindings/{}/canvas/state",
        runtime.origin(),
        project.binding_id()
    );

    let response = client
        .patch(&endpoint)
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({
            "expandedDirectories": [],
            "nodeStateUpdates": [{
                "projectRelativePath": "note.txt",
                "manualLayout": {
                    "x": 10,
                    "y": 20,
                    "width": 320,
                    "height": 180
                }
            }],
            "occlusionOrder": ["note.txt"]
        }))
        .send()
        .expect("Canvas state patch should complete");
    assert_eq!(response.status().as_u16(), 200);

    let changed = events.next_of_type("project.changed");
    let canvas = &changed["snapshot"]["canvasWorkspace"]["workspace"];
    assert_eq!(
        canvas["nodeStates"]["note.txt"]["manualLayout"],
        json!({ "x": 10.0, "y": 20.0, "width": 320.0, "height": 180.0 })
    );
    assert_eq!(canvas["occlusionOrder"], json!(["note.txt"]));

    let invalid = client
        .patch(endpoint)
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, cookie)
        .header(WORKBENCH_CONNECTION_HEADER, credential)
        .json(&json!({ "unexpectedField": true }))
        .send()
        .expect("invalid Canvas state patch should complete");
    assert_eq!(invalid.status().as_u16(), 400);
    assert_eq!(
        invalid.json::<Value>().expect("error should be JSON")["error"]["code"],
        "invalid_json"
    );
}

#[test]
fn working_copy_survives_connection_close_and_clears_without_retention() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("working-copy");
    let client = test_client();

    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);
    assert_eq!(
        events.next_of_type("project.bound")["type"],
        "project.bound"
    );
    let put = client
        .put(format!(
            "{}/api/workbench/bindings/{}/working-copies/text/draft.md",
            runtime.origin(),
            project.binding_id()
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
    let restored = events.next_of_type("project.bound");
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
            "{}/api/workbench/bindings/{}/working-copies/text/draft.md",
            runtime.origin(),
            project.binding_id()
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
        events.next_of_type("project.bound")["workingCopies"],
        json!({
            "canonicalRoot": project.canonical_root,
            "text": {},
            "feedback": {}
        })
    );
}

#[test]
fn feedback_working_copies_are_independent_by_stable_item_id() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("feedback-working-copies");
    let client = test_client();
    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);
    assert_eq!(
        events.next_of_type("project.bound")["type"],
        "project.bound"
    );

    for (item_id, project_relative_path, comment) in [
        ("feedback-a", "images/a.png", "First local value"),
        ("feedback-b", "images/b.png", "Second local value"),
    ] {
        let response = client
            .put(format!(
                "{}/api/workbench/bindings/{}/working-copies/feedback/{item_id}",
                runtime.origin(),
                project.binding_id()
            ))
            .header(ORIGIN, runtime.origin())
            .header(COOKIE, &cookie)
            .header(WORKBENCH_CONNECTION_HEADER, &credential)
            .json(&json!({
                "itemId": item_id,
                "createdAt": "2026-07-23T00:00:00.000Z",
                "projectRelativePath": project_relative_path,
                "kind": "comment",
                "scope": "node",
                "comment": comment
            }))
            .send()
            .expect("Feedback Working Copy put should complete");
        assert_eq!(response.status().as_u16(), 200);
    }
    drop(events);

    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);
    let restored = events.next_of_type("project.bound");
    assert_eq!(
        restored["workingCopies"]["feedback"],
        json!({
            "feedback-a": {
                "itemId": "feedback-a",
                "createdAt": "2026-07-23T00:00:00.000Z",
                "projectRelativePath": "images/a.png",
                "kind": "comment",
                "scope": "node",
                "comment": "First local value"
            },
            "feedback-b": {
                "itemId": "feedback-b",
                "createdAt": "2026-07-23T00:00:00.000Z",
                "projectRelativePath": "images/b.png",
                "kind": "comment",
                "scope": "node",
                "comment": "Second local value"
            }
        })
    );

    let cleared = client
        .delete(format!(
            "{}/api/workbench/bindings/{}/working-copies/feedback/feedback-a",
            runtime.origin(),
            project.binding_id()
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
        events.next_of_type("project.bound")["workingCopies"]["feedback"],
        json!({
            "feedback-b": {
                "itemId": "feedback-b",
                "createdAt": "2026-07-23T00:00:00.000Z",
                "projectRelativePath": "images/b.png",
                "kind": "comment",
                "scope": "node",
                "comment": "Second local value"
            }
        })
    );
}

#[test]
fn canvas_feedback_set_mark_is_one_atomic_node_batch_contract() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("feedback-set-mark");
    let project_root = Path::new(&project.root);
    fs::create_dir_all(project_root.join("assets")).expect("directory node should be created");
    fs::create_dir_all(project_root.join("fake.png"))
        .expect("extension-shaped directory node should be created");
    fs::write(project_root.join("cover.png"), b"image").expect("file node should be created");
    let client = test_client();
    let (cookie, credential, mut events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);
    assert_eq!(
        events.next_of_type("project.bound")["type"],
        "project.bound"
    );
    let endpoint = format!(
        "{}/api/workbench/bindings/{}/canvas-feedback",
        runtime.origin(),
        project.binding_id()
    );
    let session = (&*cookie, &*credential);
    assert_canvas_feedback_mark_batch(&client, &runtime, &endpoint, session);
    let accepted_feedback =
        add_canvas_feedback_node_comments(&client, &runtime, &endpoint, session);
    assert_canvas_feedback_invalid_targets_preserve(
        &client,
        &runtime,
        &endpoint,
        session,
        &accepted_feedback,
    );
}

fn assert_canvas_feedback_mark_batch(
    client: &Client,
    runtime: &TestRuntime,
    endpoint: &str,
    session: (&str, &str),
) {
    let set_mark = json!({
        "operation": "set-mark",
        "projectRelativePaths": ["", "assets", "cover.png"],
        "mark": "important",
        "selected": true
    });
    let response = patch_canvas_feedback(client, runtime, endpoint, session, &set_mark);
    let response_status = response.status().as_u16();
    let response_body = response.text().expect("response body should be readable");
    assert_eq!(response_status, 200, "{response_body}");
    assert_eq!(
        serde_json::from_str::<Value>(&response_body).expect("response should be JSON")["projectRevision"],
        2
    );

    let feedback = read_canvas_feedback(client, runtime, endpoint, session);
    assert_eq!(feedback["entries"][""]["marks"], json!(["important"]));
    assert_eq!(feedback["entries"]["assets"]["marks"], json!(["important"]));
    assert_eq!(
        feedback["entries"]["cover.png"]["marks"],
        json!(["important"])
    );

    let no_op = patch_canvas_feedback(client, runtime, endpoint, session, &set_mark);
    assert_eq!(no_op.status().as_u16(), 200);
    assert_eq!(
        no_op.json::<Value>().expect("response should be JSON")["projectRevision"],
        2
    );
}

fn add_canvas_feedback_node_comments(
    client: &Client,
    runtime: &TestRuntime,
    endpoint: &str,
    session: (&str, &str),
) -> Value {
    for (path, item_id, expected_revision) in
        [("assets", "directory-comment", 3), ("", "root-comment", 4)]
    {
        let comment = patch_canvas_feedback(
            client,
            runtime,
            endpoint,
            session,
            &json!({
                "operation": "add-item",
                "projectRelativePath": path,
                "item": {
                    "id": item_id,
                    "createdAt": "2026-08-01T00:00:00.000Z",
                    "kind": "comment",
                    "scope": "node",
                    "comment": "Node comment"
                }
            }),
        );
        let status = comment.status().as_u16();
        let body = comment
            .text()
            .expect("Feedback comment response should be readable");
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            serde_json::from_str::<Value>(&body).expect("response should be JSON")["projectRevision"],
            expected_revision
        );
    }

    let accepted_feedback = read_canvas_feedback(client, runtime, endpoint, session);
    assert_eq!(
        accepted_feedback["entries"]["assets"]["items"][0]["scope"],
        "node"
    );
    assert_eq!(
        accepted_feedback["entries"][""]["items"][0]["scope"],
        "node"
    );
    accepted_feedback
}

fn assert_canvas_feedback_invalid_targets_preserve(
    client: &Client,
    runtime: &TestRuntime,
    endpoint: &str,
    session: (&str, &str),
    accepted_feedback: &Value,
) {
    let missing_target = patch_canvas_feedback(
        client,
        runtime,
        endpoint,
        session,
        &json!({
            "operation": "set-mark",
            "projectRelativePaths": ["cover.png", "missing.png"],
            "mark": "like",
            "selected": true
        }),
    );
    assert_eq!(missing_target.status().as_u16(), 400);

    let spatial_directory = patch_canvas_feedback(
        client,
        runtime,
        endpoint,
        session,
        &json!({
            "operation": "add-item",
            "projectRelativePath": "fake.png",
            "item": {
                "id": "directory-pin",
                "createdAt": "2026-08-01T00:00:00.000Z",
                "kind": "pin",
                "scope": "node",
                "geometry": { "type": "point", "x": 0.5, "y": 0.5 },
                "comment": "invalid"
            }
        }),
    );
    assert_eq!(spatial_directory.status().as_u16(), 400);

    let after_rejections = read_canvas_feedback(client, runtime, endpoint, session);
    assert_eq!(&after_rejections, accepted_feedback);
}

fn patch_canvas_feedback(
    client: &Client,
    runtime: &TestRuntime,
    endpoint: &str,
    session: (&str, &str),
    body: &Value,
) -> Response {
    client
        .patch(endpoint)
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, session.0)
        .header(WORKBENCH_CONNECTION_HEADER, session.1)
        .json(body)
        .send()
        .expect("Canvas feedback mutation should complete")
}

fn read_canvas_feedback(
    client: &Client,
    runtime: &TestRuntime,
    endpoint: &str,
    session: (&str, &str),
) -> Value {
    client
        .get(endpoint)
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, session.0)
        .header(WORKBENCH_CONNECTION_HEADER, session.1)
        .send()
        .expect("Canvas feedback read should complete")
        .json::<Value>()
        .expect("Canvas feedback should be JSON")
}

#[test]
fn video_preview_probe_and_ensure_use_frame_source_identity() {
    let runtime = TestRuntime::start();
    let project = runtime.create_project("video-preview-sources");
    let project_root = Path::new(&project.root);
    fs::create_dir_all(project_root.join("media")).expect("media directory should be created");
    let video = project_root.join("media/clip.mp4");
    fs::write(&video, b"video").expect("video fixture should be written");
    let source_revision = media_revision(&video);
    let client = test_client();
    let (cookie, credential, _events) = open_unbound_connection(&client, &runtime);
    open_project(&client, &runtime, &project, &cookie, &credential);

    let response = client
        .post(format!(
            "{}/api/workbench/bindings/{}/canvas-video-previews/probe",
            runtime.origin(),
            project.binding_id()
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({
            "targets": [{
                "projectRelativePath": "media/clip.mp4",
                "sourceRevision": source_revision,
                "frameTimeMs": 0
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
    assert_eq!(body["sources"]["media/clip.mp4"]["status"], "needs-source");
    assert_eq!(
        body["sources"]["media/clip.mp4"]["canonicalSourceIdentity"],
        "frame-v1--ms-0"
    );

    let response = client
        .post(format!(
            "{}/api/workbench/bindings/{}/canvas-video-previews/ensure",
            runtime.origin(),
            project.binding_id()
        ))
        .header(ORIGIN, runtime.origin())
        .header(COOKIE, &cookie)
        .header(WORKBENCH_CONNECTION_HEADER, &credential)
        .json(&json!({
            "target": {
                "projectRelativePath": "media/clip.mp4",
                "sourceRevision": source_revision,
                "frameTimeMs": 0
            },
            "canonicalSourceIdentity": "stale-source-key"
        }))
        .send()
        .expect("video preview Ensure request should complete");

    assert_eq!(response.status().as_u16(), 200);
    let body: Value = response
        .json()
        .expect("video preview Ensure response should be JSON");
    assert_eq!(body["status"], "source-changed");
}

fn open_unbound_connection(client: &Client, runtime: &TestRuntime) -> (String, String, SseEvents) {
    open_unbound_connection_with_cookie(client, runtime, None)
}

fn test_client() -> Client {
    Client::builder()
        .timeout(WORKBENCH_HTTP_TEST_TIMEOUT)
        .build()
        .expect("Workbench HTTP test client should build")
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
    let body = response.json::<Value>().expect("response should be JSON");
    assert_eq!(body["outcome"], "bound");
    assert_eq!(body["canonicalRoot"], project.canonical_root);
    let binding_id = body["bindingId"]
        .as_str()
        .expect("bound response should contain a binding id")
        .to_owned();
    *project.binding_id.lock().unwrap() = Some(binding_id);
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
    services: Option<Arc<WorkbenchRuntimeServices>>,
}

impl TestRuntime {
    fn start() -> Self {
        let root = std::env::temp_dir().join(format!("dbrt-http-{}", Uuid::new_v4()));
        let assets = root.join("assets");
        fs::create_dir_all(&assets).expect("assets should be created");
        fs::write(assets.join("index.html"), "<main>Debrute Workbench</main>")
            .expect("index should be written");
        let state = Arc::new(RuntimeControlState::new("runtime-instance"));
        let services = WorkbenchRuntimeServices::compose_for_integration_tests(
            root.join("home"),
            Arc::clone(&state),
        )
        .expect("Runtime services should compose");
        let cli: Arc<dyn RuntimeCliHttpService> = Arc::new(RuntimeCliService::new(
            Arc::clone(services.models()),
            Arc::clone(services.global()),
            services.projects().clone(),
            Arc::clone(services.provenance()),
            Arc::clone(services.model_operations()),
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
            services: Some(services),
        }
    }

    fn origin(&self) -> &str {
        self.server.origin()
    }

    fn services(&self) -> &WorkbenchRuntimeServices {
        self.services
            .as_deref()
            .expect("test Runtime services should remain live")
    }

    fn create_project(&self, name: &str) -> TestProject {
        let root = self.root.join(name);
        fs::create_dir_all(&root).expect("Project directory should be created");
        let canonical_root = fs::canonicalize(&root)
            .expect("Project root should canonicalize")
            .to_string_lossy()
            .into_owned();
        TestProject {
            root: root.to_string_lossy().into_owned(),
            canonical_root,
            binding_id: Mutex::new(None),
        }
    }
}

impl Drop for TestRuntime {
    fn drop(&mut self) {
        let Some(services) = self.services.take() else {
            return;
        };
        services.close_workbench_connection_admission();
        self.server.stop_accepting();
        services.close_all_workbench_connections();
        self.server.join();
        services.finish_workbench_connection_closer();
        services.shutdown_owned_work();
        drop(services);
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct TestProject {
    root: String,
    canonical_root: String,
    binding_id: Mutex<Option<String>>,
}

impl TestProject {
    fn binding_id(&self) -> String {
        self.binding_id
            .lock()
            .unwrap()
            .clone()
            .expect("Project should already be bound")
    }
}

fn media_revision(path: &Path) -> String {
    let bytes = fs::read(path).expect("media fixture should read");
    format!("sha256:{:x}", Sha256::digest(bytes))
}
