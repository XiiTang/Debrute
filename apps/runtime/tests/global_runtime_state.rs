use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Barrier, Condvar, Mutex, mpsc},
    thread,
    time::Duration,
};

use debrute_runtime::global::{
    GlobalConfigStore, GlobalRuntimeChange, GlobalRuntimeService, GlobalSettingsError,
    GlobalSettingsMutation,
};
use debrute_runtime::login::MemoryStartAtLoginSetting;
use debrute_runtime::models::ModelCatalog;
use serde_json::{Value, json};
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
    assert!(!initial.integrations.photoshop.enabled);
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
fn photoshop_integration_enablement_is_one_closed_default_off_global_setting() {
    let home = temporary_home("photoshop-integration-setting");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);

    let enabled = store
        .mutate(
            &mutation(json!({ "operation": "set-photoshop-integration-enabled", "enabled": true })),
            &catalog,
        )
        .expect("Photoshop Integration should enable");
    assert!(enabled.changed);
    assert!(enabled.view.integrations.photoshop.enabled);
    drop(store);
    let store = GlobalConfigStore::new(&home);
    assert!(
        store
            .read_view(&catalog)
            .expect("Photoshop Integration setting should survive store reconstruction")
            .integrations
            .photoshop
            .enabled
    );

    let no_op = store
        .mutate(
            &mutation(json!({ "operation": "set-photoshop-integration-enabled", "enabled": true })),
            &catalog,
        )
        .expect("repeated enable should be idempotent");
    assert!(!no_op.changed);

    for invalid in [
        json!({ "operation": "set-photoshop-plugin-enabled", "enabled": true }),
        json!({ "integrations": {} }),
        json!({ "integrations": { "photoshop": {} } }),
        json!({ "integrations": { "photoshop": { "enabled": "yes" } } }),
        json!({ "integrations": { "photoshop": { "enabled": true, "extra": true } } }),
        json!({ "integrations": { "illustrator": { "enabled": true } } }),
    ] {
        assert!(serde_json::from_value::<GlobalSettingsMutation>(invalid).is_err());
    }

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn canvas_text_appearance_is_one_complete_validated_global_setting() {
    let home = temporary_home("canvas-text-appearance");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);

    let result = store
        .mutate(
            &mutation(json!({
                "operation": "set-canvas-text-appearance",
                "textAppearance": {
                        "fontId": "jetbrains-mono",
                        "fontSizePx": 15.5,
                        "lineHeightRatio": 1.35,
                        "fontWeight": 600,
                        "letterSpacingPx": -0.2,
                        "ligatures": false
                }
            })),
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
        if let Ok(mutation) = serde_json::from_value::<GlobalSettingsMutation>(invalid) {
            assert!(matches!(
                store.mutate(&mutation, &catalog),
                Err(GlobalSettingsError::Validation(_))
            ));
        }
    }

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn canvas_hierarchy_edge_visibility_is_one_global_boolean_setting() {
    let home = temporary_home("canvas-hierarchy-edge-visibility");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);

    let hidden = store
        .mutate(
            &mutation(json!({ "operation": "set-hierarchy-edges-visible", "hierarchyEdgesVisible": false })),
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
        .mutate(
            &mutation(json!({ "operation": "set-hierarchy-edges-visible", "hierarchyEdgesVisible": false })),
            &catalog,
        )
        .expect("repeating Canvas hierarchy edge visibility should be valid");
    assert!(!repeated.changed);

    let shown = store
        .mutate(
            &mutation(json!({ "operation": "set-hierarchy-edges-visible", "hierarchyEdgesVisible": true })),
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
        assert!(serde_json::from_value::<GlobalSettingsMutation>(invalid).is_err());
    }

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn runtime_owns_feedback_name_unicode_validation() {
    let home = temporary_home("feedback-name-validation");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);
    let longest_valid_name = "👨‍👩‍👧‍👦".repeat(32);
    let initial_catalog_len = store
        .read_view(&catalog)
        .expect("default Feedback settings should load")
        .feedback
        .catalog
        .len();

    store
        .mutate(
            &mutation(json!({
                "operation": "create-feedback-mark",
                "name": longest_valid_name,
                "icon": "circle"
            })),
            &catalog,
        )
        .expect("Runtime should accept 32 Unicode grapheme clusters");

    let too_long = store
        .mutate(
            &mutation(json!({
                "operation": "create-feedback-mark",
                "name": "👨‍👩‍👧‍👦".repeat(33),
                "icon": "circle"
            })),
            &catalog,
        )
        .expect_err("Runtime should reject more than 32 Unicode grapheme clusters");
    assert_eq!(
        too_long.to_string(),
        "Feedback name must contain 1–32 Unicode grapheme clusters."
    );

    let forbidden_control = store
        .mutate(
            &mutation(json!({
                "operation": "create-feedback-mark",
                "name": "hidden\u{202e}reorder",
                "icon": "circle"
            })),
            &catalog,
        )
        .expect_err("Runtime should reject forbidden Feedback name controls");
    assert_eq!(
        forbidden_control.to_string(),
        "Feedback name contains a forbidden control character."
    );

    let settings = store
        .read_view(&catalog)
        .expect("valid Feedback settings should remain readable");
    assert_eq!(settings.feedback.catalog.len(), initial_catalog_len + 1);
    assert!(
        settings
            .feedback
            .catalog
            .iter()
            .any(|entry| entry.name == longest_valid_name)
    );

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

fn canvas_text_appearance_patch_with(field: &str, value: serde_json::Value) -> serde_json::Value {
    let mut patch = json!({
        "operation": "set-canvas-text-appearance",
        "textAppearance": {
                "fontId": "lilex",
                "fontSizePx": 12.0,
                "lineHeightRatio": 1.4,
                "fontWeight": 400,
                "letterSpacingPx": 0.0,
                "ligatures": true
        }
    });
    patch["textAppearance"][field] = value;
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
fn mutations_persist_canonical_settings_and_redact_model_secrets() {
    let home = temporary_home("patch");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);

    store
        .mutate(
            &mutation(json!({ "operation": "set-locale", "locale": "zh-CN" })),
            &catalog,
        )
        .expect("locale mutation should persist");
    store
        .mutate(
            &mutation(json!({ "operation": "set-theme-preference", "themePreference": "light" })),
            &catalog,
        )
        .expect("theme mutation should persist");
    let result = store
        .mutate(
            &mutation(json!({
                "operation": "save-model-setting",
                "modelId": "gpt-image-2",
                "setting": {
                    "baseUrlOverride": "https://images.example.test/v1",
                    "requestModelIdOverride": null,
                    "apiKey": "sk-image-123456fg"
                }
            })),
            &catalog,
        )
        .expect("valid model mutation should persist");
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
fn malformed_intents_and_unknown_models_are_rejected_without_partial_writes() {
    let home = temporary_home("invalid");
    let catalog = ModelCatalog::bundled();
    let store = GlobalConfigStore::new(&home);

    for input in [
        json!({}),
        json!({ "workbench": {} }),
        json!({ "unexpectedField": true }),
        json!({ "workbench": { "unexpectedField": true } }),
        json!({
            "operation": "save-model-setting",
            "modelId": "gpt-image-2",
            "setting": { "baseUrlOverride": null }
        }),
    ] {
        assert!(serde_json::from_value::<GlobalSettingsMutation>(input).is_err());
    }

    let invalid = store
        .mutate(
            &mutation(json!({ "operation": "set-locale", "locale": "fr" })),
            &catalog,
        )
        .expect_err("invalid locale should fail");
    assert_eq!(
        invalid.to_string(),
        "Workbench locale must be \"en\" or \"zh-CN\"."
    );
    let unknown = store
        .mutate(
            &mutation(json!({
                "operation": "save-model-setting",
                "modelId": "missing-audio-model",
                "setting": {
                    "baseUrlOverride": null,
                    "requestModelIdOverride": null
                }
            })),
            &catalog,
        )
        .expect_err("unknown model should fail");
    assert_eq!(unknown.to_string(), "Unknown model: missing-audio-model");
    let padded = store
        .mutate(
            &mutation(json!({
                "operation": "save-model-setting",
                "modelId": " gpt-image-2 ",
                "setting": {
                    "baseUrlOverride": null,
                    "requestModelIdOverride": null
                }
            })),
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
        .mutate(
            &mutation(json!({
                "operation": "save-model-setting",
                "modelId": "gpt-image-2",
                "setting": {
                    "baseUrlOverride": "https://images.example.test/v1",
                    "requestModelIdOverride": null,
                    "apiKey": "  sk-opaque  "
                }
            })),
            &catalog,
        )
        .expect("canonical model patch should persist");

    let settings_path = home.join("config/global_settings.json");
    let secrets_path = home.join("config/secrets.json");
    let settings_source = fs::read_to_string(&settings_path).expect("settings should exist");
    let secrets_source = fs::read_to_string(&secrets_path).expect("secrets should exist");
    assert!(secrets_source.contains("  sk-opaque  "));

    let mut old_plugin_settings: serde_json::Value =
        serde_json::from_str(&settings_source).expect("settings should parse as JSON");
    let integrations = old_plugin_settings
        .as_object_mut()
        .expect("settings should be an object")
        .remove("integrations")
        .expect("settings should contain Integrations");
    old_plugin_settings["plugins"] = integrations;
    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&old_plugin_settings)
            .expect("old Plugin settings should serialize"),
    )
    .expect("old Plugin settings fixture should write");
    assert!(matches!(
        store.read_view(&catalog),
        Err(GlobalSettingsError::Json(_))
    ));

    fs::write(&settings_path, &settings_source).expect("settings fixture should restore");
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
    let service = global_runtime_service(&home);
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
        .settings_mutate(&mutation(
            json!({ "operation": "set-locale", "locale": "zh-CN" }),
        ))
        .expect("effective patch should save");
    service
        .settings_mutate(&mutation(
            json!({ "operation": "set-locale", "locale": "zh-CN" }),
        ))
        .expect("no-op patch should succeed");
    service
        .remember_recent_project(&alpha)
        .expect("recent Project should persist");
    let events = events.lock().expect("event recorder should lock");
    assert_eq!(events.len(), 2);
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
    drop(events);
    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn start_at_login_uses_native_state_and_the_ordered_global_settings_projection() {
    let home = temporary_home("start-at-login");
    let native = Arc::new(MemoryStartAtLoginSetting::new(false));
    let service = GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled(),
        native,
    );
    let events = Arc::new(Mutex::new(Vec::new()));
    let observer_events = Arc::clone(&events);
    assert!(service.install_observer(Arc::new(move |event| {
        observer_events.lock().unwrap().push(event);
    })));

    assert!(!service.settings_get().unwrap().runtime.start_at_login);
    let enabled = service
        .settings_mutate(&mutation(json!({
            "operation": "set-start-at-login",
            "enabled": true
        })))
        .expect("native Start at Login should enable");
    assert!(enabled.runtime.start_at_login);
    assert!(!home.join("config/global_settings.json").exists());

    let recorded = events.lock().unwrap();
    assert_eq!(recorded.len(), 1);
    let GlobalRuntimeChange::GlobalSettingsChanged(settings) = &recorded[0].change else {
        panic!("Start at Login should publish the complete Global Settings projection");
    };
    assert!(settings.runtime.start_at_login);
    drop(recorded);

    service
        .settings_mutate(&mutation(json!({
            "operation": "set-start-at-login",
            "enabled": true
        })))
        .expect("repeated Start at Login should be idempotent");
    assert_eq!(events.lock().unwrap().len(), 1);
    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn model_api_key_reveal_returns_the_exact_secret_without_publishing_global_state() {
    let home = temporary_home("api-key-reveal");
    let service = global_runtime_service(&home);
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
        .settings_mutate(&mutation(json!({
            "operation": "save-model-setting",
            "modelId": "gpt-image-2",
            "setting": {
                "baseUrlOverride": null,
                "requestModelIdOverride": null,
                "apiKey": exact_api_key
            }
        })))
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
    let service = global_runtime_service(&home);

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
fn global_event_dispatch_stays_ordered_while_the_first_observer_call_is_blocked() {
    let home = temporary_home("ordered-dispatch");
    let service = global_runtime_service(&home);
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
            .settings_mutate(&mutation(
                json!({ "operation": "set-locale", "locale": "zh-CN" }),
            ))
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
            .settings_mutate(&mutation(
                json!({ "operation": "set-theme-preference", "themePreference": "dark" }),
            ))
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
    let service = global_runtime_service(&home);
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

fn global_runtime_service(home: &Path) -> Arc<GlobalRuntimeService> {
    GlobalRuntimeService::new(
        GlobalConfigStore::new(home),
        ModelCatalog::bundled(),
        Arc::new(MemoryStartAtLoginSetting::new(false)),
    )
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

fn mutation(value: Value) -> GlobalSettingsMutation {
    serde_json::from_value(value).expect("fixture should be a valid Global Settings intent")
}
