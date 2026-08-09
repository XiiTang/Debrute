use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Barrier, Condvar, Mutex, mpsc},
    thread,
    time::Duration,
};

use debrute_runtime::global::{
    GlobalConfigStore, GlobalRuntimeChange, GlobalRuntimeService, GlobalSettingsError,
};
use debrute_runtime::integrations::{
    CommandResult, IntegrationCommand, IntegrationOperation, IntegrationProcessAdapter,
    IntegrationService, Platform, ProbeResult,
};
use debrute_runtime::models::ModelCatalog;
use serde_json::json;
use uuid::Uuid;

#[test]
fn defaults_and_recent_projects_match_the_final_global_contract() {
    let home = temporary_home("defaults");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);

    let initial = store
        .read_view(&catalog)
        .expect("default settings should load");
    assert_eq!(initial.workbench.locale, "en");
    assert_eq!(initial.workbench.theme_preference, "system");
    assert_eq!(
        serde_json::to_value(&initial.canvas).expect("Canvas settings should serialize"),
        json!({
            "hierarchyEdgesVisible": true,
            "textAppearance": {
                "fontId": "noto-sans-mono-cjk-sc",
                "fontSizePx": 12.0,
                "lineHeightRatio": 1.4,
                "fontWeight": 400,
                "letterSpacingPx": 0.0,
                "ligatures": true
            }
        })
    );
    assert!(initial.chrome.recent_project_roots.is_empty());
    assert!(!initial.plugins.photoshop.enabled);
    for index in 0..14 {
        let root = project_root(&home, &index.to_string());
        store
            .remember_recent_project(&root, &catalog)
            .expect("recent Project should persist");
    }
    let project_five = project_root(&home, "5");
    store
        .remember_recent_project(&project_five, &catalog)
        .expect("duplicate should move to the front");
    let recent = store
        .read_view(&catalog)
        .expect("saved settings should load")
        .chrome
        .recent_project_roots;
    assert_eq!(recent.len(), 12);
    assert_eq!(recent[0], project_five);
    assert_eq!(recent[1], project_root(&home, "13"));
    assert_eq!(
        recent.iter().filter(|root| **root == project_five).count(),
        1
    );

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn photoshop_plugin_enablement_is_one_closed_default_off_global_setting() {
    let home = temporary_home("photoshop-plugin-setting");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);

    let enabled = store
        .patch(
            &json!({ "plugins": { "photoshop": { "enabled": true } } }),
            &catalog,
        )
        .expect("Photoshop Integration should enable");
    assert!(enabled.changed);
    assert!(enabled.view.plugins.photoshop.enabled);
    drop(store);
    let store = GlobalConfigStore::new(&home);
    assert!(
        store
            .read_view(&catalog)
            .expect("Photoshop Integration setting should survive store reconstruction")
            .plugins
            .photoshop
            .enabled
    );

    let no_op = store
        .patch(
            &json!({ "plugins": { "photoshop": { "enabled": true } } }),
            &catalog,
        )
        .expect("repeated enable should be idempotent");
    assert!(!no_op.changed);

    for invalid in [
        json!({ "plugins": {} }),
        json!({ "plugins": { "photoshop": {} } }),
        json!({ "plugins": { "photoshop": { "enabled": "yes" } } }),
        json!({ "plugins": { "photoshop": { "enabled": true, "extra": true } } }),
        json!({ "plugins": { "illustrator": { "enabled": true } } }),
        json!({ "adobeBridge": { "enabled": true } }),
    ] {
        assert!(matches!(
            store.patch(&invalid, &catalog),
            Err(GlobalSettingsError::Validation(_))
        ));
    }

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn canvas_text_appearance_is_one_complete_validated_global_setting() {
    let home = temporary_home("canvas-text-appearance");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);

    let result = store
        .patch(
            &json!({
                "canvas": {
                    "textAppearance": {
                        "fontId": "jetbrains-mono",
                        "fontSizePx": 15.5,
                        "lineHeightRatio": 1.35,
                        "fontWeight": 600,
                        "letterSpacingPx": -0.2,
                        "ligatures": false
                    }
                }
            }),
            &catalog,
        )
        .expect("complete Canvas text appearance should persist");

    assert_eq!(
        serde_json::to_value(&result.view.canvas).expect("Canvas settings should serialize"),
        json!({
            "hierarchyEdgesVisible": true,
            "textAppearance": {
                "fontId": "jetbrains-mono",
                "fontSizePx": 15.5,
                "lineHeightRatio": 1.35,
                "fontWeight": 600,
                "letterSpacingPx": -0.2,
                "ligatures": false
            }
        })
    );

    for invalid in [
        json!({ "canvas": { "textAppearance": { "fontId": "lilex" } } }),
        canvas_text_appearance_patch_with("fontId", json!("system-font")),
        canvas_text_appearance_patch_with("fontSizePx", json!(5.5)),
        canvas_text_appearance_patch_with("fontSizePx", json!(12.25)),
        canvas_text_appearance_patch_with("lineHeightRatio", json!(1.234)),
        canvas_text_appearance_patch_with("fontWeight", json!(901)),
        canvas_text_appearance_patch_with("letterSpacingPx", json!(0.15)),
        canvas_text_appearance_patch_with("unexpectedField", json!(true)),
    ] {
        assert!(matches!(
            store.patch(&invalid, &catalog),
            Err(GlobalSettingsError::Validation(_))
        ));
    }

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn canvas_hierarchy_edge_visibility_is_one_global_boolean_setting() {
    let home = temporary_home("canvas-hierarchy-edge-visibility");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);

    let hidden = store
        .patch(
            &json!({ "canvas": { "hierarchyEdgesVisible": false } }),
            &catalog,
        )
        .expect("Canvas hierarchy edges should hide");
    assert!(hidden.changed);
    assert!(!hidden.view.canvas.hierarchy_edges_visible);

    let reopened_store = GlobalConfigStore::new(&home);
    assert!(
        !reopened_store
            .read_view(&catalog)
            .expect("persisted Canvas hierarchy edge visibility should reload")
            .canvas
            .hierarchy_edges_visible
    );

    let repeated = store
        .patch(
            &json!({ "canvas": { "hierarchyEdgesVisible": false } }),
            &catalog,
        )
        .expect("repeating Canvas hierarchy edge visibility should be valid");
    assert!(!repeated.changed);

    let shown = store
        .patch(
            &json!({ "canvas": { "hierarchyEdgesVisible": true } }),
            &catalog,
        )
        .expect("Canvas hierarchy edges should show");
    assert!(shown.changed);
    assert!(shown.view.canvas.hierarchy_edges_visible);

    for invalid in [
        json!({ "canvas": {} }),
        json!({ "canvas": { "hierarchyEdgesVisible": "false" } }),
        json!({ "canvas": { "hierarchyEdgesVisible": false, "unexpectedField": true } }),
    ] {
        assert!(matches!(
            store.patch(&invalid, &catalog),
            Err(GlobalSettingsError::Validation(_))
        ));
    }

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

fn canvas_text_appearance_patch_with(field: &str, value: serde_json::Value) -> serde_json::Value {
    let mut patch = json!({
        "canvas": {
            "textAppearance": {
                "fontId": "lilex",
                "fontSizePx": 12.0,
                "lineHeightRatio": 1.4,
                "fontWeight": 400,
                "letterSpacingPx": 0.0,
                "ligatures": true
            }
        }
    });
    patch["canvas"]["textAppearance"][field] = value;
    patch
}

#[test]
fn distinct_canonical_roots_are_independent_recent_projects() {
    let home = temporary_home("canonical-roots");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);
    let alpha = project_root(&home, "alpha");
    let copied_alpha = project_root(&home, "copied-alpha");

    store
        .remember_recent_project(&alpha, &catalog)
        .expect("first canonical root should persist");
    store
        .remember_recent_project(&copied_alpha, &catalog)
        .expect("second canonical root should persist independently");

    let recent = store
        .read_view(&catalog)
        .expect("saved settings should remain readable")
        .chrome
        .recent_project_roots;
    assert_eq!(recent, vec![copied_alpha, alpha]);

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn patch_persists_canonical_settings_and_redacts_model_secrets() {
    let home = temporary_home("patch");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);

    let result = store
        .patch(
            &json!({
                "workbench": {
                    "locale": "zh-CN",
                    "themePreference": "light"
                },
                "modelSetting": {
                    "modelId": "gpt-image-2",
                    "setting": {
                        "baseUrlOverride": "https://images.example.test/v1",
                        "requestModelIdOverride": null,
                        "apiKey": "sk-image-123456fg"
                    }
                }
            }),
            &catalog,
        )
        .expect("valid patch should persist");
    assert!(result.changed);
    assert_eq!(result.view.workbench.locale, "zh-CN");
    let model = result
        .view
        .models
        .image
        .iter()
        .find(|model| model.debrute_model_id == "gpt-image-2")
        .expect("catalog model should exist");
    assert_eq!(
        model.base_url_override.as_deref(),
        Some("https://images.example.test/v1")
    );
    assert!(model.api_key_set);

    let public_json = serde_json::to_string(&result.view).expect("view should serialize");
    assert!(!public_json.contains("sk-image-123456fg"));
    assert!(!public_json.contains("apiKeyPreview"));
    let settings = fs::read_to_string(home.join("config/global_settings.json"))
        .expect("settings should be written");
    assert!(!settings.contains("sk-image-123456fg"));
    let secrets = fs::read_to_string(home.join("config/secrets.json"))
        .expect("secrets should be written separately");
    assert!(secrets.contains("sk-image-123456fg"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(home.join("config/secrets.json"))
                .expect("secret metadata should exist")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn invalid_and_unknown_model_patches_are_rejected_without_partial_writes() {
    let home = temporary_home("invalid");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);

    for input in [
        json!({}),
        json!({ "workbench": {} }),
        json!({ "unexpectedField": true }),
        json!({ "workbench": { "unexpectedField": true } }),
    ] {
        assert!(matches!(
            store.patch(&input, &catalog),
            Err(GlobalSettingsError::Validation(_))
        ));
    }

    let invalid = store
        .patch(&json!({ "workbench": { "locale": "fr" } }), &catalog)
        .expect_err("invalid locale should fail");
    assert_eq!(
        invalid.to_string(),
        "Workbench locale must be \"en\" or \"zh-CN\"."
    );
    let unknown = store
        .patch(
            &json!({
                "modelSetting": {
                    "modelId": "missing-audio-model",
                    "setting": {
                        "baseUrlOverride": null,
                        "requestModelIdOverride": null
                    }
                }
            }),
            &catalog,
        )
        .expect_err("unknown model should fail");
    assert_eq!(unknown.to_string(), "Unknown model: missing-audio-model");
    let padded = store
        .patch(
            &json!({
                "modelSetting": {
                    "modelId": " gpt-image-2 ",
                    "setting": {
                        "baseUrlOverride": null,
                        "requestModelIdOverride": null
                    }
                }
            }),
            &catalog,
        )
        .expect_err("catalog validation must use the raw model id");
    assert_eq!(
        padded.to_string(),
        "Model id must be a canonical non-empty string."
    );
    assert!(!home.join("config/global_settings.json").exists());
    assert!(!home.join("config/secrets.json").exists());

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn persisted_global_files_are_closed_and_are_never_repaired_on_read() {
    let home = temporary_home("strict-persistence");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);
    store
        .patch(
            &json!({
                "workbench": { "locale": "zh-CN" },
                "modelSetting": {
                    "modelId": "gpt-image-2",
                    "setting": {
                        "baseUrlOverride": "https://images.example.test/v1",
                        "requestModelIdOverride": null,
                        "apiKey": "  sk-opaque  "
                    }
                }
            }),
            &catalog,
        )
        .expect("canonical model patch should persist");

    let settings_path = home.join("config/global_settings.json");
    let secrets_path = home.join("config/secrets.json");
    let settings_source = fs::read_to_string(&settings_path).expect("settings should exist");
    let secrets_source = fs::read_to_string(&secrets_path).expect("secrets should exist");
    assert!(secrets_source.contains("  sk-opaque  "));

    let mut settings: serde_json::Value =
        serde_json::from_str(&settings_source).expect("settings should parse as JSON");
    settings["unexpectedField"] = json!(true);
    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).expect("settings should serialize"),
    )
    .expect("invalid settings fixture should write");
    assert!(matches!(
        store.read_view(&catalog),
        Err(GlobalSettingsError::Json(_))
    ));

    fs::write(&settings_path, &settings_source).expect("settings fixture should restore");
    let mut settings: serde_json::Value =
        serde_json::from_str(&settings_source).expect("settings should parse as JSON");
    let models = settings["models"]
        .as_array_mut()
        .expect("model configs should be an array");
    models.push(models[0].clone());
    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).expect("settings should serialize"),
    )
    .expect("duplicate settings fixture should write");
    assert!(matches!(
        store.read_view(&catalog),
        Err(GlobalSettingsError::Validation(_))
    ));

    fs::write(&settings_path, &settings_source).expect("settings fixture should restore");
    let mut secrets: serde_json::Value =
        serde_json::from_str(&secrets_source).expect("secrets should parse as JSON");
    secrets["modelApiKeys"]["gpt-image-2"] = json!("");
    fs::write(
        &secrets_path,
        serde_json::to_string_pretty(&secrets).expect("secrets should serialize"),
    )
    .expect("empty secret fixture should write");
    assert!(matches!(
        store.read_view(&catalog),
        Err(GlobalSettingsError::Validation(_))
    ));

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn global_runtime_publishes_one_monotonic_event_per_effective_change() {
    let home = temporary_home("runtime-events");
    let service = GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled(),
        IntegrationService::new(Platform::MacOs, "", "", Arc::new(MissingAdapter)),
    );
    let alpha = project_root(&home, "alpha");
    let events = Arc::new(Mutex::new(Vec::new()));
    let observer_events = Arc::clone(&events);
    assert!(service.install_observer(Arc::new(move |event| {
        observer_events
            .lock()
            .expect("event recorder should lock")
            .push(event);
    })));
    assert!(!service.install_observer(Arc::new(|_| {})));

    service.settings_get().expect("global settings should load");
    assert_eq!(service.revision(), 0);
    service
        .settings_save(&json!({ "workbench": { "locale": "zh-CN" } }))
        .expect("effective patch should save");
    service
        .settings_save(&json!({ "workbench": { "locale": "zh-CN" } }))
        .expect("no-op patch should succeed");
    service
        .remember_recent_project(&alpha)
        .expect("recent Project should persist");
    service.integrations_rescan();

    let events = events.lock().expect("event recorder should lock");
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].revision, 1);
    assert!(matches!(
        events[0].change,
        GlobalRuntimeChange::GlobalSettingsChanged(_)
    ));
    assert_eq!(events[1].revision, 2);
    assert!(matches!(
        events[1].change,
        GlobalRuntimeChange::RecentProjectsChanged(ref entries)
            if entries == &[alpha]
    ));
    assert_eq!(events[2].revision, 3);
    assert!(matches!(
        events[2].change,
        GlobalRuntimeChange::IntegrationsChanged(_)
    ));

    drop(events);
    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn model_api_key_reveal_returns_the_exact_secret_without_publishing_global_state() {
    let home = temporary_home("api-key-reveal");
    let service = GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled(),
        IntegrationService::new(Platform::MacOs, "", "", Arc::new(MissingAdapter)),
    );
    let events = Arc::new(Mutex::new(Vec::new()));
    let observer_events = Arc::clone(&events);
    assert!(service.install_observer(Arc::new(move |event| {
        observer_events
            .lock()
            .expect("event recorder should lock")
            .push(event);
    })));
    let exact_api_key = "  密钥🔑 \n";
    service
        .settings_save(&json!({
            "modelSetting": {
                "modelId": "gpt-image-2",
                "setting": {
                    "baseUrlOverride": null,
                    "requestModelIdOverride": null,
                    "apiKey": exact_api_key
                }
            }
        }))
        .expect("model API key should persist");
    events.lock().expect("event recorder should lock").clear();
    let revision = service.revision();

    assert_eq!(
        service
            .reveal_model_api_key("gpt-image-2")
            .expect("configured model API key should reveal"),
        exact_api_key
    );
    assert_eq!(service.revision(), revision);
    assert!(
        events
            .lock()
            .expect("event recorder should lock")
            .is_empty()
    );
    assert!(service.reveal_model_api_key("openai-tts-1").is_err());
    assert!(service.reveal_model_api_key("unknown-model").is_err());

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn global_snapshot_captures_product_projection_at_its_revision_barrier() {
    let home = temporary_home("product-snapshot-barrier");
    let service = GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled(),
        IntegrationService::new(Platform::MacOs, "", "", Arc::new(MissingAdapter)),
    );

    service.publish_product_changed(json!({ "update": { "type": "checking" } }));
    let (snapshot_revision, _, product) = service
        .sync_snapshot()
        .expect("global snapshot should load");
    service.publish_product_changed(json!({ "update": { "type": "available" } }));

    assert_eq!(snapshot_revision, 1);
    assert_eq!(product, Some(json!({ "update": { "type": "checking" } })));
    assert_eq!(service.revision(), 2);

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn desktop_presentation_startup_snapshot_does_not_probe_integrations() {
    let home = temporary_home("startup-recents");
    let adapter = Arc::new(BlockingScanAdapter::default());
    let service = GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled(),
        IntegrationService::new(Platform::MacOs, "", "", adapter.clone()),
    );

    let (recent, theme) = service
        .desktop_presentation_snapshot()
        .expect("startup Desktop presentation should load");

    assert!(recent.is_empty());
    assert_eq!(theme, "system");
    assert!(!adapter.started());
    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn workbench_global_settings_snapshot_does_not_probe_integrations() {
    let home = temporary_home("workbench-global-snapshot");
    let adapter = Arc::new(BlockingScanAdapter::default());
    let service = Arc::new(GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled(),
        IntegrationService::new(Platform::MacOs, "", "", adapter.clone()),
    ));
    let (finished_tx, finished_rx) = mpsc::channel();
    let snapshot_service = Arc::clone(&service);
    let snapshot = thread::spawn(move || {
        let result = snapshot_service.sync_snapshot();
        finished_tx
            .send(())
            .expect("snapshot completion should be observed");
        result
    });

    let completed_without_probe = finished_rx.recv_timeout(Duration::from_millis(100)).is_ok();
    let integration_probe_started = adapter.started();
    adapter.release();
    let (_, settings, _) = snapshot
        .join()
        .expect("snapshot thread should join")
        .expect("global settings snapshot should load");

    assert!(
        completed_without_probe,
        "Global settings must not wait for Integration discovery"
    );
    assert!(
        !integration_probe_started,
        "Global settings must not start Integration discovery"
    );
    assert!(
        serde_json::to_value(settings)
            .expect("Global settings should serialize")
            .get("integrations")
            .is_none(),
        "Integration discovery is an independent Runtime projection"
    );
    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn global_event_dispatch_stays_ordered_while_the_first_observer_call_is_blocked() {
    let home = temporary_home("ordered-dispatch");
    let service = Arc::new(GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled(),
        IntegrationService::new(Platform::MacOs, "", "", Arc::new(MissingAdapter)),
    ));
    let events = Arc::new(Mutex::new(Vec::new()));
    let gate = Arc::new((Mutex::new((false, false)), Condvar::new()));
    let observer_events = Arc::clone(&events);
    let observer_gate = Arc::clone(&gate);
    assert!(service.install_observer(Arc::new(move |event| {
        observer_events
            .lock()
            .expect("event recorder should lock")
            .push(event);
        if observer_events
            .lock()
            .expect("event recorder should lock")
            .len()
            == 1
        {
            let (state, changed) = &*observer_gate;
            let mut state = state.lock().expect("dispatch gate should lock");
            state.0 = true;
            changed.notify_all();
            while !state.1 {
                state = changed
                    .wait(state)
                    .expect("dispatch gate should remain available");
            }
        }
    })));

    let first_service = Arc::clone(&service);
    let first = thread::spawn(move || {
        first_service
            .settings_save(&json!({ "workbench": { "locale": "zh-CN" } }))
            .expect("first settings commit should succeed");
    });
    {
        let (state, changed) = &*gate;
        let mut state = state.lock().expect("dispatch gate should lock");
        while !state.0 {
            state = changed
                .wait(state)
                .expect("dispatch gate should remain available");
        }
    }
    let second_service = Arc::clone(&service);
    let (second_done, second_completion) = mpsc::sync_channel(1);
    let second = thread::spawn(move || {
        second_service
            .settings_save(&json!({ "workbench": { "themePreference": "dark" } }))
            .expect("second settings commit should succeed");
        second_done
            .send(())
            .expect("second completion should be observable");
    });
    assert!(matches!(
        second_completion.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    {
        let (state, changed) = &*gate;
        let mut state = state.lock().expect("dispatch gate should lock");
        state.1 = true;
        changed.notify_all();
    }
    first.join().expect("first settings thread should join");
    second.join().expect("second settings thread should join");
    second_completion
        .recv_timeout(Duration::from_secs(1))
        .expect("second mutation should complete after observer release");

    let events = events.lock().expect("event recorder should lock");
    assert_eq!(
        events
            .iter()
            .map(|event| event.revision)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    let GlobalRuntimeChange::GlobalSettingsChanged(last) = &events[1].change else {
        panic!("second event should be the settings commit");
    };
    assert_eq!(last.workbench.locale, "zh-CN");
    assert_eq!(last.workbench.theme_preference, "dark");
    drop(events);
    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn concurrent_recent_project_mutations_end_with_the_committed_snapshot() {
    let home = temporary_home("recent-linearization");
    let service = Arc::new(GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled(),
        IntegrationService::new(Platform::MacOs, "", "", Arc::new(MissingAdapter)),
    ));
    let events = Arc::new(Mutex::new(Vec::new()));
    let observer_events = Arc::clone(&events);
    assert!(service.install_observer(Arc::new(move |event| {
        observer_events
            .lock()
            .expect("event recorder should lock")
            .push(event);
    })));
    let alpha = project_root(&home, "alpha");
    let beta = project_root(&home, "beta");
    service
        .remember_recent_project(&alpha)
        .expect("seed Project should persist");
    events.lock().expect("event recorder should lock").clear();

    let barrier = Arc::new(Barrier::new(3));
    let clear_service = Arc::clone(&service);
    let clear_barrier = Arc::clone(&barrier);
    let clear = thread::spawn(move || {
        clear_barrier.wait();
        clear_service
            .clear_recent_projects()
            .expect("clear should commit")
    });
    let remember_service = Arc::clone(&service);
    let remember_barrier = Arc::clone(&barrier);
    let remember = thread::spawn(move || {
        remember_barrier.wait();
        remember_service
            .remember_recent_project(&beta)
            .expect("remember should commit")
    });
    barrier.wait();
    assert!(clear.join().expect("clear thread should join"));
    assert!(remember.join().expect("remember thread should join"));

    let disk_projects = service
        .settings_get()
        .expect("settings should remain readable")
        .chrome
        .recent_project_roots;
    let events = events.lock().expect("event recorder should lock");
    assert_eq!(events.len(), 2);
    let GlobalRuntimeChange::RecentProjectsChanged(event_projects) = &events[1].change else {
        panic!("last event should be a recent-Projects commit");
    };
    assert_eq!(event_projects, &disk_projects);
    drop(events);
    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn rejected_integration_operations_do_not_publish_transition_events() {
    let home = temporary_home("rejected-integration");
    let service = GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled(),
        IntegrationService::new(Platform::MacOs, "", "", Arc::new(MissingAdapter)),
    );
    service.integrations_rescan();
    let events = Arc::new(Mutex::new(Vec::new()));
    let observer_events = Arc::clone(&events);
    assert!(service.install_observer(Arc::new(move |event| {
        observer_events
            .lock()
            .expect("event recorder should lock")
            .push(event);
    })));
    let unknown = service.integrations_run_operation("missing", IntegrationOperation::Install);
    assert_eq!(
        unknown
            .diagnostic
            .as_ref()
            .and_then(|diagnostic| diagnostic.error_kind.as_deref()),
        Some("integration_not_found")
    );
    let unavailable = service.integrations_run_operation("ffmpeg", IntegrationOperation::Install);
    assert_eq!(
        unavailable
            .diagnostic
            .as_ref()
            .and_then(|diagnostic| diagnostic.stderr_tail.as_deref()),
        Some("Homebrew was not found on PATH.")
    );
    assert!(
        events
            .lock()
            .expect("event recorder should lock")
            .is_empty()
    );

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn an_external_integration_scan_does_not_block_recent_project_commits() {
    let home = temporary_home("scan-outside-commit");
    let adapter = Arc::new(BlockingScanAdapter::default());
    let service = Arc::new(GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled(),
        IntegrationService::new(Platform::MacOs, "", "", adapter.clone()),
    ));
    let scan_service = Arc::clone(&service);
    let scan = thread::spawn(move || scan_service.integrations_rescan());
    adapter.wait_until_started();

    let alpha = project_root(&home, "alpha");
    let expected_alpha = alpha.clone();
    let recent_service = Arc::clone(&service);
    let (recent_done, recent_completion) = mpsc::sync_channel(1);
    let recent = thread::spawn(move || {
        let result = recent_service.remember_recent_project(&alpha);
        recent_done
            .send(result)
            .expect("recent mutation result should be observable");
    });
    assert!(
        recent_completion
            .recv_timeout(Duration::from_millis(250))
            .expect("recent mutation must not wait for external scan")
            .expect("recent mutation should succeed")
    );

    adapter.release();
    recent.join().expect("recent thread should join");
    scan.join().expect("scan thread should join");
    let view = service
        .settings_get()
        .expect("settings should remain readable after Integration discovery");
    assert_eq!(view.chrome.recent_project_roots, [expected_alpha]);
    fs::remove_dir_all(home).expect("temporary home should be removed");
}

struct MissingAdapter;

impl IntegrationProcessAdapter for MissingAdapter {
    fn resolve_executable(
        &self,
        _name: &str,
        _env_path: &std::ffi::OsStr,
        _platform: Platform,
        _path_ext: &std::ffi::OsStr,
    ) -> Option<PathBuf> {
        None
    }

    fn run_probe(
        &self,
        _file: &std::path::Path,
        _args: &[String],
        _timeout_ms: u64,
    ) -> ProbeResult {
        panic!("missing executables must not be probed")
    }

    fn run_command(&self, _command: &IntegrationCommand) -> CommandResult {
        panic!("no integration operation was requested")
    }
}

#[derive(Default)]
struct BlockingScanAdapter {
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}

impl BlockingScanAdapter {
    fn started(&self) -> bool {
        self.state.lock().expect("scan state should lock").0
    }

    fn wait_until_started(&self) {
        let mut state = self.state.lock().expect("scan state should lock");
        while !state.0 {
            state = self
                .changed
                .wait(state)
                .expect("scan state should remain available");
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().expect("scan state should lock");
        state.1 = true;
        self.changed.notify_all();
    }
}

impl IntegrationProcessAdapter for BlockingScanAdapter {
    fn resolve_executable(
        &self,
        _name: &str,
        _env_path: &std::ffi::OsStr,
        _platform: Platform,
        _path_ext: &std::ffi::OsStr,
    ) -> Option<PathBuf> {
        let mut state = self.state.lock().expect("scan state should lock");
        state.0 = true;
        self.changed.notify_all();
        while !state.1 {
            state = self
                .changed
                .wait(state)
                .expect("scan state should remain available");
        }
        None
    }

    fn run_probe(
        &self,
        _file: &std::path::Path,
        _args: &[String],
        _timeout_ms: u64,
    ) -> ProbeResult {
        panic!("missing executables must not be probed")
    }

    fn run_command(&self, _command: &IntegrationCommand) -> CommandResult {
        panic!("missing backends must not run commands")
    }
}

fn temporary_home(label: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("debrute-runtime-global-{label}-{}", Uuid::new_v4()));
    fs::create_dir_all(&path).expect("temporary home should be created");
    path
}

fn project_root(home: &Path, name: &str) -> String {
    home.join("projects")
        .join(name)
        .to_string_lossy()
        .into_owned()
}
