use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Barrier, Condvar, Mutex, mpsc},
    thread,
    time::Duration,
};

use debrute_runtime::global::{
    GlobalConfigStore, GlobalRuntimeChange, GlobalRuntimeService, GlobalSettingsError,
    ModelCatalog, api_key_preview,
};
use debrute_runtime::integrations::{
    CommandResult, IntegrationCommand, IntegrationOperation, IntegrationProcessAdapter,
    IntegrationService, Platform, ProbeResult,
};
use serde_json::json;
use uuid::Uuid;

#[test]
fn defaults_recent_projects_and_model_settings_match_the_final_global_contract() {
    let home = temporary_home("defaults");
    let catalog = ModelCatalog::bundled().expect("bundled model catalog should parse");
    let store = GlobalConfigStore::new(&home);

    let initial = store
        .read_view(&catalog)
        .expect("default settings should load");
    assert_eq!(initial.workbench.locale, "en");
    assert_eq!(initial.workbench.theme_preference, "system");
    assert_eq!(initial.workbench.default_frontend, "electron");
    assert!(initial.chrome.recent_projects.is_empty());
    assert!(initial.adobe_bridge.enabled);
    assert_eq!(initial.models.image.models.len(), 11);
    assert_eq!(initial.models.video.models.len(), 2);
    assert_eq!(initial.models.audio.models.len(), 16);

    for index in 0..14 {
        store
            .remember_recent_project(&format!("project-{index}"), &format!(" /projects/{index} "))
            .expect("recent Project should persist");
    }
    store
        .remember_recent_project("project-5", "/projects/5")
        .expect("duplicate should move to the front");
    let recent = store
        .read_view(&catalog)
        .expect("saved settings should load")
        .chrome
        .recent_projects;
    assert_eq!(recent.len(), 12);
    assert_eq!(recent[0].project_root, "/projects/5");
    assert_eq!(recent[1].project_root, "/projects/13");
    assert_eq!(
        recent
            .iter()
            .filter(|entry| entry.project_id == "project-5")
            .count(),
        1
    );

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn stable_project_id_cannot_be_remapped_to_another_recent_root() {
    let home = temporary_home("stable-project-id");
    let catalog = ModelCatalog::bundled().expect("bundled model catalog should parse");
    let store = GlobalConfigStore::new(&home);

    store
        .remember_recent_project("project-alpha", "/projects/alpha")
        .expect("initial stable Project mapping should persist");
    let error = store
        .remember_recent_project("project-alpha", "/projects/copied-alpha")
        .expect_err("one stable Project id must not move to another root");
    assert!(matches!(error, GlobalSettingsError::Validation(_)));

    let recent = store
        .read_view(&catalog)
        .expect("saved settings should remain readable")
        .chrome
        .recent_projects;
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].project_id, "project-alpha");
    assert_eq!(recent[0].project_root, "/projects/alpha");

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn patch_persists_normalized_settings_and_redacts_model_secrets() {
    let home = temporary_home("patch");
    let catalog = ModelCatalog::bundled().expect("bundled model catalog should parse");
    let store = GlobalConfigStore::new(&home);

    let result = store
        .patch(
            &json!({
                "workbench": {
                    "locale": "zh-CN",
                    "themePreference": "light",
                    "defaultFrontend": "browser"
                },
                "models": {
                    "image": {
                        "modelId": "gpt-image-2",
                        "setting": {
                            "baseUrlOverride": " https://images.example.test/v1 ",
                            "requestModelIdOverride": null,
                            "apiKey": " sk-image-123456fg "
                        }
                    }
                },
                "adobeBridge": { "enabled": false }
            }),
            &catalog,
        )
        .expect("valid patch should persist");
    assert!(result.changed);
    assert_eq!(result.view.workbench.locale, "zh-CN");
    assert!(!result.view.adobe_bridge.enabled);
    let model = result
        .view
        .models
        .image
        .models
        .iter()
        .find(|model| model.debrute_model_id == "gpt-image-2")
        .expect("catalog model should exist");
    assert_eq!(
        model.base_url_override.as_deref(),
        Some("https://images.example.test/v1")
    );
    assert!(model.api_key_set);
    assert_eq!(
        model.api_key_preview.as_deref(),
        Some("sk****************************fg")
    );

    let public_json = serde_json::to_string(&result.view).expect("view should serialize");
    assert!(!public_json.contains("sk-image-123456fg"));
    let settings = fs::read_to_string(home.join("config/global_settings.json"))
        .expect("settings should be written");
    assert!(settings.contains("\"defaultFrontend\": \"browser\""));
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
    let catalog = ModelCatalog::bundled().expect("bundled model catalog should parse");
    let store = GlobalConfigStore::new(&home);

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
                "models": {
                    "audio": {
                        "modelId": "missing-audio-model",
                        "setting": {
                            "baseUrlOverride": null,
                            "requestModelIdOverride": null
                        }
                    }
                }
            }),
            &catalog,
        )
        .expect_err("unknown model should fail");
    assert_eq!(
        unknown.to_string(),
        "Unknown audio model: missing-audio-model"
    );
    let padded = store
        .patch(
            &json!({
                "models": {
                    "image": {
                        "modelId": " gpt-image-2 ",
                        "setting": {
                            "baseUrlOverride": null,
                            "requestModelIdOverride": null
                        }
                    }
                }
            }),
            &catalog,
        )
        .expect_err("catalog validation must use the raw model id");
    assert_eq!(padded.to_string(), "Unknown image model:  gpt-image-2 ");
    assert!(!home.join("config/global_settings.json").exists());
    assert!(!home.join("config/secrets.json").exists());

    let malformed = store
        .patch(&json!({ "adobeBridge": { "enabled": "yes" } }), &catalog)
        .expect_err("invalid bridge setting should fail");
    assert!(matches!(malformed, GlobalSettingsError::Validation(_)));

    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn bundled_catalog_keeps_image_video_tts_music_and_sound_effect_as_closed_families() {
    let catalog = ModelCatalog::bundled().expect("bundled model catalog should parse");
    assert_eq!(catalog.images().len(), 11);
    assert_eq!(catalog.videos().len(), 2);
    assert_eq!(catalog.tts().len(), 9);
    assert_eq!(catalog.music().len(), 5);
    assert_eq!(catalog.sound_effects().len(), 2);
    assert!(catalog.contains_image("gpt-image-2"));
    assert!(catalog.contains_video("doubao-seedance-2-0-260128"));
    assert!(catalog.contains_audio("openai-gpt-4o-mini-tts"));
    assert!(!catalog.contains_audio("gpt-image-2"));
    let image = catalog
        .images()
        .iter()
        .find(|entry| entry.debrute_model_id == "gpt-image-2")
        .expect("full image catalog entry should exist");
    assert!(!image.choose_when.is_empty());
    assert!(image.arguments_schema.is_object());
    assert_eq!(image.request_example["input"]["model"], "gpt-image-2");

    assert_eq!(api_key_preview(None), (false, None));
    assert_eq!(
        api_key_preview(Some("short")),
        (true, Some("****".to_owned()))
    );
}

#[test]
fn global_runtime_publishes_one_monotonic_event_per_effective_change() {
    let home = temporary_home("runtime-events");
    let service = GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled().expect("bundled model catalog should parse"),
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
    assert!(!service.install_observer(Arc::new(|_| {})));

    let initial = service.settings_get().expect("global settings should load");
    assert_eq!(initial.integrations.integrations.len(), 5);
    assert_eq!(service.revision(), 0);
    service
        .settings_save(&json!({ "workbench": { "locale": "zh-CN" } }))
        .expect("effective patch should save");
    service
        .settings_save(&json!({ "workbench": { "locale": "zh-CN" } }))
        .expect("no-op patch should succeed");
    service
        .remember_recent_project("project-alpha", "/projects/alpha")
        .expect("recent Project should persist");
    service
        .integrations_rescan()
        .expect("explicit integration rescan should publish");

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
            if entries.len() == 1
                && entries[0].project_id == "project-alpha"
                && entries[0].project_root == "/projects/alpha"
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
fn recent_project_startup_snapshot_does_not_probe_integrations() {
    let home = temporary_home("startup-recents");
    let adapter = Arc::new(BlockingScanAdapter::default());
    let service = GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled().expect("bundled model catalog should parse"),
        IntegrationService::new(Platform::MacOs, "", "", adapter.clone()),
    );

    let recent = service
        .recent_projects_snapshot()
        .expect("startup recent Projects should load");

    assert!(recent.is_empty());
    assert!(!adapter.started());
    fs::remove_dir_all(home).expect("temporary home should be removed");
}

#[test]
fn global_event_dispatch_stays_ordered_while_the_first_observer_call_is_blocked() {
    let home = temporary_home("ordered-dispatch");
    let service = Arc::new(GlobalRuntimeService::new(
        GlobalConfigStore::new(&home),
        ModelCatalog::bundled().expect("bundled model catalog should parse"),
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
        ModelCatalog::bundled().expect("bundled model catalog should parse"),
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
    service
        .remember_recent_project("project-alpha", "/projects/alpha")
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
            .remember_recent_project("project-beta", "/projects/beta")
            .expect("remember should commit")
    });
    barrier.wait();
    assert!(clear.join().expect("clear thread should join"));
    assert!(remember.join().expect("remember thread should join"));

    let disk_projects = service
        .settings_get()
        .expect("settings should remain readable")
        .chrome
        .recent_projects;
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
        ModelCatalog::bundled().expect("bundled model catalog should parse"),
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
    service
        .settings_get()
        .expect("integration cache should load");

    let unknown = service
        .integrations_run_operation("missing", IntegrationOperation::Install)
        .expect("unknown operation should return a typed result");
    assert_eq!(
        unknown
            .diagnostic
            .as_ref()
            .and_then(|diagnostic| diagnostic.error_kind.as_deref()),
        Some("integration_not_found")
    );
    let unavailable = service
        .integrations_run_operation("ffmpeg", IntegrationOperation::Install)
        .expect("unavailable backend should return a typed result");
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
        ModelCatalog::bundled().expect("bundled model catalog should parse"),
        IntegrationService::new(Platform::MacOs, "", "", adapter.clone()),
    ));
    let scan_service = Arc::clone(&service);
    let scan = thread::spawn(move || {
        scan_service
            .settings_get()
            .expect("settings scan should complete after release")
    });
    adapter.wait_until_started();

    let recent_service = Arc::clone(&service);
    let (recent_done, recent_completion) = mpsc::sync_channel(1);
    let recent = thread::spawn(move || {
        let result = recent_service.remember_recent_project("project-alpha", "/projects/alpha");
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
    let view = scan.join().expect("scan thread should join");
    assert_eq!(
        view.chrome.recent_projects,
        [debrute_runtime::global::RecentProjectEntry {
            project_id: "project-alpha".to_owned(),
            project_root: "/projects/alpha".to_owned(),
        }]
    );
    fs::remove_dir_all(home).expect("temporary home should be removed");
}

struct MissingAdapter;

impl IntegrationProcessAdapter for MissingAdapter {
    fn resolve_executable(
        &self,
        _name: &str,
        _env_path: &str,
        _platform: Platform,
        _path_ext: &str,
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
        _env_path: &str,
        _platform: Platform,
        _path_ext: &str,
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
