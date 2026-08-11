#![cfg(target_os = "macos")]

use std::os::unix::fs::PermissionsExt as _;
use std::{
    fs,
    io::{Read as _, Seek as _, SeekFrom, Write as _},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

use crate::control::{CONTROL_PROTOCOL, CONTROL_PROTOCOL_VERSION};
use base64::{Engine as _, engine::general_purpose::STANDARD};

use super::ProductInstallationCoordinator;
use super::commit::{
    CommitPhase, InstalledDesktopIdentity, ProductCommitCoordinator, ProductCommitError,
    ProductIdentity, ProductUpdateFailureStage, ResumeIntent, RunningProductIdentity,
    UpdatePlatformAdapter,
};
use super::manifest::{
    ProductEntrypoints, ProductManifest, ProductManifestFile, ProductPlatform, ReleaseArchitecture,
    ReleaseAssetKind, ReleasePlatform, StagedDesktopAsset, TrustedReleaseManifest,
    verify_signed_release_manifest,
};
use super::removal::{ProductRemovalExecutor, execute_removal_plan};
use super::store::{CommitPlatform, ProductStore};
use super::{InstalledProductLayout, ProductProjectionManager, ProductRemovalCoordinator};

fn desktop_resume() -> ResumeIntent {
    ResumeIntent::Desktop
}
use super::store::{VerifiedDesktopInstaller, VerifiedRuntimeEntrypoint};
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

const DESKTOP_ASSET_BYTES: &[u8] = b"desktop-installer";
const PRODUCT_ASSET_BYTES: &[u8] = b"product-seed-archive";

#[test]
fn installed_product_layout_closes_every_macos_owned_path_under_the_current_user() {
    let layout = InstalledProductLayout::for_roots(
        CommitPlatform::Macos,
        PathBuf::from("/Users/alice"),
        None,
    )
    .unwrap();

    assert_eq!(
        layout.debrute_home(),
        PathBuf::from("/Users/alice/.debrute")
    );
    assert_eq!(
        layout.product_root(),
        PathBuf::from("/Users/alice/.debrute/products")
    );
    assert_eq!(
        layout.bin_directory(),
        PathBuf::from("/Users/alice/.debrute/bin")
    );
    assert_eq!(
        layout.skills_directory(),
        PathBuf::from("/Users/alice/.agents/skills")
    );
    assert_eq!(
        layout.desktop_application(),
        PathBuf::from("/Users/alice/Applications/Debrute.app")
    );
    assert_eq!(
        layout.desktop_executable(),
        PathBuf::from("/Users/alice/Applications/Debrute.app/Contents/MacOS/Debrute")
    );
}

#[test]
fn installed_product_layout_uses_the_current_account_record() {
    use nix::unistd::{Uid, User};

    let account = User::from_uid(Uid::current())
        .unwrap()
        .expect("the test account should exist");
    let layout = InstalledProductLayout::for_current_user().unwrap();

    assert_eq!(layout.user_home(), account.dir);
}

#[test]
fn installed_product_layout_closes_every_windows_owned_path_under_local_app_data() {
    let layout = InstalledProductLayout::for_roots(
        CommitPlatform::Windows,
        PathBuf::from(r"C:\Users\Alice"),
        Some(PathBuf::from(r"C:\Users\Alice\AppData\Local")),
    )
    .unwrap();

    assert_eq!(
        layout.debrute_home(),
        PathBuf::from(r"C:\Users\Alice/.debrute")
    );
    assert_eq!(
        layout.desktop_application(),
        PathBuf::from(r"C:\Users\Alice\AppData\Local/Programs/Debrute")
    );
    assert_eq!(
        layout.desktop_executable(),
        PathBuf::from(r"C:\Users\Alice\AppData\Local/Programs/Debrute/Debrute.exe")
    );
}

#[test]
fn official_skill_projection_replaces_the_reserved_namespace_and_preserves_other_skills() {
    let root = std::env::temp_dir().join(format!("debrute-skills-test-{}", Uuid::new_v4()));
    let source = root.join("product-skills");
    let destination = root.join("home/.agents/skills");
    fs::create_dir_all(source.join("debrute-core")).unwrap();
    fs::create_dir_all(source.join("debrute-extra")).unwrap();
    fs::write(source.join("debrute-core/SKILL.md"), "current-core").unwrap();
    fs::write(source.join("debrute-extra/SKILL.md"), "current-extra").unwrap();
    fs::create_dir_all(destination.join("debrute-core")).unwrap();
    fs::create_dir_all(destination.join("unrelated-skill")).unwrap();
    fs::write(destination.join("debrute-core/SKILL.md"), "user-change").unwrap();
    fs::write(destination.join("unrelated-skill/SKILL.md"), "unrelated").unwrap();
    std::os::unix::fs::symlink(
        destination.join("unrelated-skill"),
        destination.join("debrute-symlink"),
    )
    .unwrap();

    ProductProjectionManager::publish_official_skills(&source, &destination).unwrap();

    assert_eq!(
        fs::read_to_string(destination.join("debrute-core/SKILL.md")).unwrap(),
        "current-core"
    );
    assert!(destination.join("debrute-extra/SKILL.md").is_file());
    assert!(!destination.join("debrute-symlink").exists());
    assert_eq!(
        fs::read_to_string(destination.join("unrelated-skill/SKILL.md")).unwrap(),
        "unrelated"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn invalid_official_skill_source_does_not_mutate_the_installed_namespace() {
    let root = std::env::temp_dir().join(format!("debrute-skills-test-{}", Uuid::new_v4()));
    let source = root.join("product-skills");
    let destination = root.join("home/.agents/skills");
    fs::create_dir_all(source.join("wrong-name")).unwrap();
    fs::write(source.join("wrong-name/SKILL.md"), "invalid").unwrap();
    fs::create_dir_all(destination.join("debrute-core")).unwrap();
    fs::write(destination.join("debrute-core/SKILL.md"), "installed").unwrap();

    assert!(ProductProjectionManager::publish_official_skills(&source, &destination).is_err());
    assert_eq!(
        fs::read_to_string(destination.join("debrute-core/SKILL.md")).unwrap(),
        "installed"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn official_skill_projection_repairs_and_removes_only_exact_transaction_residue() {
    let root = std::env::temp_dir().join(format!("debrute-skills-test-{}", Uuid::new_v4()));
    let source = root.join("product-skills");
    let destination = root.join("home/.agents/skills");
    fs::create_dir_all(source.join("debrute-core")).unwrap();
    fs::write(source.join("debrute-core/SKILL.md"), "current-core").unwrap();
    let stale = destination.join(format!(".debrute-projection-{}", Uuid::new_v4()));
    fs::create_dir_all(stale.join("retired/debrute-core")).unwrap();
    fs::create_dir_all(destination.join(".debrute-projection-not-a-uuid")).unwrap();

    ProductProjectionManager::publish_official_skills(&source, &destination).unwrap();

    assert!(!stale.exists());
    let removal_residue = destination.join(format!(".debrute-projection-{}", Uuid::new_v4()));
    fs::create_dir_all(removal_residue.join("staged")).unwrap();
    ProductProjectionManager::remove_official_skills(&destination).unwrap();

    assert!(!destination.join("debrute-core").exists());
    assert!(!removal_residue.exists());
    assert!(destination.join(".debrute-projection-not-a-uuid").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn macos_command_path_is_idempotent_and_removes_only_the_exact_debrute_blocks() {
    let root = std::env::temp_dir().join(format!("debrute-path-test-{}", Uuid::new_v4()));
    let home = root.join("home");
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join(".zprofile"), "export KEEP=1\n").unwrap();
    fs::write(home.join(".zshrc"), "alias keep=true").unwrap();
    let stale = home.join(format!(".debrute-shell-{}", Uuid::new_v4()));
    fs::write(&stale, "stale").unwrap();
    fs::write(home.join(".debrute-shell-not-a-uuid"), "unowned").unwrap();
    let bin = home.join(".debrute/bin");

    ProductProjectionManager::configure_macos_command_path(
        PathBuf::from("/bin/zsh").as_path(),
        &home,
        &bin,
    )
    .unwrap();

    assert!(!stale.exists());
    assert!(home.join(".debrute-shell-not-a-uuid").exists());
    ProductProjectionManager::configure_macos_command_path(
        PathBuf::from("/bin/zsh").as_path(),
        &home,
        &bin,
    )
    .unwrap();

    for file in [home.join(".zprofile"), home.join(".zshrc")] {
        let contents = fs::read_to_string(&file).unwrap();
        assert_eq!(
            contents.matches("# >>> Debrute managed PATH >>>").count(),
            1
        );
        assert!(contents.contains("case :\"$PATH\": in"));
        assert!(contents.contains("export PATH='"));
        assert!(contents.contains(".debrute/bin':\"$PATH\""));
    }

    let removal_residue = home.join(format!(".debrute-shell-{}", Uuid::new_v4()));
    fs::write(&removal_residue, "stale").unwrap();
    ProductProjectionManager::remove_macos_command_path(PathBuf::from("/bin/zsh").as_path(), &home)
        .unwrap();
    assert!(!removal_residue.exists());
    assert_eq!(
        fs::read_to_string(home.join(".zprofile")).unwrap(),
        "export KEEP=1\n"
    );
    assert_eq!(
        fs::read_to_string(home.join(".zshrc")).unwrap(),
        "alias keep=true"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn macos_product_removal_clears_managed_blocks_for_every_supported_shell() {
    let root = std::env::temp_dir().join(format!("debrute-path-test-{}", Uuid::new_v4()));
    let home = root.join("home");
    let layout =
        InstalledProductLayout::for_roots(CommitPlatform::Macos, home.clone(), None).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join(".bash_login"), "export KEEP_BASH=1\n").unwrap();
    let bin = home.join(".debrute/bin");

    for shell in ["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish"] {
        ProductProjectionManager::configure_macos_command_path(Path::new(shell), &home, &bin)
            .unwrap();
    }

    ProductProjectionManager::remove_command_path(&layout).unwrap();

    for path in [
        home.join(".zprofile"),
        home.join(".zshrc"),
        home.join(".bash_login"),
        home.join(".bashrc"),
        home.join(".config/fish/config.fish"),
    ] {
        assert!(
            !fs::read_to_string(path)
                .unwrap()
                .contains("Debrute managed PATH")
        );
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn bash_path_uses_the_first_login_startup_file_bash_will_read() {
    let root = std::env::temp_dir().join(format!("debrute-path-test-{}", Uuid::new_v4()));
    let home = root.join("home");
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join(".bash_login"), "export KEEP=1\n").unwrap();

    ProductProjectionManager::configure_macos_command_path(
        Path::new("/bin/bash"),
        &home,
        &home.join(".debrute/bin"),
    )
    .unwrap();

    assert!(
        fs::read_to_string(home.join(".bash_login"))
            .unwrap()
            .contains("Debrute managed PATH")
    );
    assert!(!home.join(".profile").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn fresh_macos_login_shell_resolves_the_managed_cli_exactly() {
    let root = std::env::temp_dir().join(format!("debrute-path-test-{}", Uuid::new_v4()));
    let home = root.join("home");
    let command = home.join(".debrute/bin/debrute");
    fs::create_dir_all(command.parent().unwrap()).unwrap();
    fs::write(&command, "#!/bin/sh\nexit 0\n").unwrap();
    let mut permissions = fs::metadata(&command).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&command, permissions).unwrap();

    ProductProjectionManager::configure_macos_command_path(
        PathBuf::from("/bin/zsh").as_path(),
        &home,
        command.parent().unwrap(),
    )
    .unwrap();

    ProductProjectionManager::verify_macos_command_resolution(
        PathBuf::from("/bin/zsh").as_path(),
        &home,
        &command,
    )
    .unwrap();

    let _ = fs::remove_dir_all(root);
}

#[test]
fn macos_command_projection_uses_the_account_login_shell() {
    use nix::unistd::{Uid, User};

    let expected = User::from_uid(Uid::current())
        .unwrap()
        .expect("the test account should exist")
        .shell;

    assert_eq!(
        ProductProjectionManager::current_login_shell().unwrap(),
        expected
    );
}

#[test]
fn malformed_macos_command_path_markers_fail_without_rewriting_the_file() {
    let root = std::env::temp_dir().join(format!("debrute-path-test-{}", Uuid::new_v4()));
    let home = root.join("home");
    fs::create_dir_all(&home).unwrap();
    let malformed = "export KEEP=1\n# >>> Debrute managed PATH >>>\n";
    fs::write(home.join(".zprofile"), malformed).unwrap();

    assert!(
        ProductProjectionManager::configure_macos_command_path(
            PathBuf::from("/bin/zsh").as_path(),
            &home,
            &home.join(".debrute/bin"),
        )
        .is_err()
    );
    assert_eq!(
        fs::read_to_string(home.join(".zprofile")).unwrap(),
        malformed
    );
    assert!(!home.join(".zshrc").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn fish_command_path_uses_native_fish_syntax() {
    let root = std::env::temp_dir().join(format!("debrute-path-test-{}", Uuid::new_v4()));
    let home = root.join("home");
    fs::create_dir_all(&home).unwrap();

    ProductProjectionManager::configure_macos_command_path(
        PathBuf::from("/opt/homebrew/bin/fish").as_path(),
        &home,
        &home.join(".debrute/bin"),
    )
    .unwrap();

    let contents = fs::read_to_string(home.join(".config/fish/config.fish")).unwrap();
    assert!(contents.contains("set -gx PATH '"));
    assert!(!contents.contains("export PATH="));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn product_removal_executor_deletes_the_whole_product_and_preserves_unowned_content() {
    let root = std::env::temp_dir().join(format!("debrute-removal-test-{}", Uuid::new_v4()));
    let home = root.join("home");
    let layout =
        InstalledProductLayout::for_roots(CommitPlatform::Macos, home.clone(), None).unwrap();
    fs::create_dir_all(layout.debrute_home().join("config")).unwrap();
    fs::write(
        layout.debrute_home().join("config/global_settings.json"),
        "settings",
    )
    .unwrap();
    fs::write(layout.debrute_home().join("config/secrets.json"), "secrets").unwrap();
    fs::write(layout.debrute_home().join("runtime.log"), "state").unwrap();
    fs::create_dir_all(layout.desktop_application()).unwrap();
    fs::create_dir_all(layout.skills_directory().join("debrute-core")).unwrap();
    fs::create_dir_all(layout.skills_directory().join("unrelated-skill")).unwrap();
    fs::write(
        layout.skills_directory().join("debrute-core/SKILL.md"),
        "owned",
    )
    .unwrap();
    fs::write(
        layout.skills_directory().join("unrelated-skill/SKILL.md"),
        "keep",
    )
    .unwrap();
    fs::create_dir_all(home.join("project/.debrute/feedback")).unwrap();
    fs::write(home.join("project/.debrute/feedback/item.json"), "project").unwrap();
    ProductProjectionManager::configure_macos_command_path(
        PathBuf::from("/bin/zsh").as_path(),
        &home,
        layout.bin_directory(),
    )
    .unwrap();

    ProductRemovalExecutor::new(layout.clone())
        .execute(None)
        .unwrap();

    assert!(!layout.debrute_home().exists());
    assert!(!layout.desktop_application().exists());
    assert!(!layout.skills_directory().join("debrute-core").exists());
    assert_eq!(
        fs::read_to_string(layout.skills_directory().join("unrelated-skill/SKILL.md")).unwrap(),
        "keep"
    );
    assert_eq!(
        fs::read_to_string(home.join("project/.debrute/feedback/item.json")).unwrap(),
        "project"
    );
    assert!(
        !fs::read_to_string(home.join(".zprofile"))
            .unwrap()
            .contains("Debrute managed PATH")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn product_removal_executor_restores_only_staged_settings_and_api_keys() {
    let root = std::env::temp_dir().join(format!("debrute-removal-test-{}", Uuid::new_v4()));
    let home = root.join("home");
    let staging = root.join("retained-config");
    let layout =
        InstalledProductLayout::for_roots(CommitPlatform::Macos, home.clone(), None).unwrap();
    fs::create_dir_all(layout.debrute_home().join("config")).unwrap();
    fs::write(layout.debrute_home().join("cache"), "delete").unwrap();
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("global_settings.json"), "settings").unwrap();
    fs::write(staging.join("secrets.json"), "secrets").unwrap();

    ProductRemovalExecutor::new(layout.clone())
        .execute(Some(&staging))
        .unwrap();

    assert_eq!(
        fs::read_to_string(layout.global_settings_file()).unwrap(),
        "settings"
    );
    assert_eq!(
        fs::read_to_string(layout.secrets_file()).unwrap(),
        "secrets"
    );
    assert_eq!(fs::read_dir(layout.debrute_home()).unwrap().count(), 1);
    assert!(!staging.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn product_removal_does_not_recreate_debrute_home_when_no_config_existed() {
    let root = std::env::temp_dir().join(format!("debrute-removal-test-{}", Uuid::new_v4()));
    let home = root.join("home");
    let staging = root.join("retained-config");
    let layout = InstalledProductLayout::for_roots(CommitPlatform::Macos, home, None).unwrap();
    fs::create_dir_all(layout.debrute_home()).unwrap();
    fs::write(layout.debrute_home().join("cache"), "delete").unwrap();
    fs::create_dir_all(&staging).unwrap();

    ProductRemovalExecutor::new(layout.clone())
        .execute(Some(&staging))
        .unwrap();

    assert!(!layout.debrute_home().exists());
    assert!(!staging.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn product_removal_keeps_desktop_until_retained_config_restore_succeeds() {
    let root = std::env::temp_dir().join(format!("debrute-removal-test-{}", Uuid::new_v4()));
    let home = root.join("home");
    let staging = root.join("retained-config");
    let layout = InstalledProductLayout::for_roots(CommitPlatform::Macos, home, None).unwrap();
    fs::create_dir_all(layout.debrute_home()).unwrap();
    fs::create_dir_all(layout.desktop_application()).unwrap();
    fs::create_dir_all(staging.join("global_settings.json")).unwrap();

    assert!(
        ProductRemovalExecutor::new(layout.clone())
            .execute(Some(&staging))
            .is_err()
    );

    assert!(layout.desktop_application().exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn product_removal_attempts_all_finalizer_cleanup_before_desktop_completion() {
    let root = std::env::temp_dir().join(format!("debrute-removal-test-{}", Uuid::new_v4()));
    let home = root.join("home");
    let layout = InstalledProductLayout::for_roots(CommitPlatform::Macos, home, None).unwrap();
    let capsule = root.join("runtime-capsule");
    let invalid_parent = root.join("transaction-parent-is-a-file");
    let transaction = invalid_parent.join("transaction");
    fs::create_dir_all(layout.debrute_home()).unwrap();
    fs::create_dir_all(layout.desktop_application()).unwrap();
    fs::create_dir_all(&capsule).unwrap();
    fs::write(&invalid_parent, "not a directory").unwrap();

    assert!(
        execute_removal_plan(
            &ProductRemovalExecutor::new(layout.clone()),
            None,
            &transaction,
            &capsule,
        )
        .is_err()
    );

    assert!(!capsule.exists());
    assert!(layout.desktop_application().exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn product_removal_coordinator_prepares_one_validated_runtime_closure_and_exact_config_stage() {
    let fixture = Fixture::new();
    let home = fixture.root.join("removal-home");
    let layout =
        InstalledProductLayout::for_roots(CommitPlatform::Macos, home.clone(), None).unwrap();
    let store = Arc::new(ProductStore::new(
        layout.product_root().to_owned(),
        CommitPlatform::Macos,
        ReleaseArchitecture::Arm64,
    ));
    let seed = fixture.write_seed("0.0.3", ReleaseArchitecture::Arm64);
    store.activate_desktop_seed(&seed).unwrap();
    fs::create_dir_all(layout.debrute_home().join("config")).unwrap();
    fs::write(layout.global_settings_file(), "settings").unwrap();
    fs::write(layout.secrets_file(), "secrets").unwrap();
    fs::write(
        layout.debrute_home().join("desktop-host.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "executable": layout.desktop_executable(),
            "arguments": []
        }))
        .unwrap(),
    )
    .unwrap();
    let runtime = layout
        .product_root()
        .join("current/runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime");

    let prepared = ProductRemovalCoordinator::new(layout.clone(), Arc::clone(&store), runtime)
        .prepare(true)
        .unwrap();

    assert!(prepared.plan_path().starts_with(layout.user_home()));
    assert!(prepared.runtime_entrypoint().is_file());
    assert_eq!(
        fs::read_to_string(
            prepared
                .retained_config()
                .unwrap()
                .join("global_settings.json")
        )
        .unwrap(),
        "settings"
    );
    assert_eq!(
        fs::read_to_string(prepared.retained_config().unwrap().join("secrets.json")).unwrap(),
        "secrets"
    );
    prepared.cancel().unwrap();
}

#[test]
fn signed_release_manifest_authenticates_exact_bytes_and_closed_asset_contract() {
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let bytes = release_manifest_bytes("0.0.4", false);
    let signature = STANDARD.encode(signing_key.sign(&bytes).to_bytes());

    let manifest =
        verify_signed_release_manifest(&bytes, &signature, signing_key.verifying_key().as_bytes())
            .expect("the exact signed manifest should be trusted");
    let asset = manifest
        .asset_for(
            ReleaseAssetKind::Desktop,
            ReleasePlatform::Macos,
            ReleaseArchitecture::Arm64,
        )
        .expect("the signed macOS arm64 asset should exist");
    assert_eq!(asset.name(), "debrute-installer-0.0.4-macos-arm64.dmg");

    let mut changed = bytes.clone();
    changed.push(b' ');
    assert!(
        verify_signed_release_manifest(
            &changed,
            &signature,
            signing_key.verifying_key().as_bytes(),
        )
        .is_err()
    );

    let duplicate_bytes = release_manifest_bytes("0.0.4", true);
    let duplicate_signature = STANDARD.encode(signing_key.sign(&duplicate_bytes).to_bytes());
    assert!(
        verify_signed_release_manifest(
            &duplicate_bytes,
            &duplicate_signature,
            signing_key.verifying_key().as_bytes(),
        )
        .is_err()
    );

    let mut open_value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    open_value["unexpected"] = json!(true);
    let open_bytes = serde_json::to_vec(&open_value).unwrap();
    let open_signature = STANDARD.encode(signing_key.sign(&open_bytes).to_bytes());
    assert!(
        verify_signed_release_manifest(
            &open_bytes,
            &open_signature,
            signing_key.verifying_key().as_bytes(),
        )
        .is_err()
    );
}

#[test]
fn complete_product_is_validated_and_materialized_before_it_can_be_selected() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");

    assert_eq!(
        fixture.store.current_version().unwrap().as_deref(),
        Some("0.0.3")
    );
    assert!(
        target
            .join("runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime")
            .is_file()
    );
    assert!(target.join("web/index.html").is_file());

    let manifest_path = target.join("product-manifest.json");
    let original_manifest = fs::read(&manifest_path).unwrap();
    let mut incompatible_manifest: serde_json::Value =
        serde_json::from_slice(&original_manifest).unwrap();
    incompatible_manifest["controlProtocolVersion"] = json!(CONTROL_PROTOCOL_VERSION + 1);
    fs::write(
        &manifest_path,
        serde_json::to_vec(&incompatible_manifest).unwrap(),
    )
    .unwrap();
    assert!(fixture.store.validate_version("0.0.4").is_err());
    fs::write(&manifest_path, original_manifest).unwrap();

    assert!(fixture.store.validate_version("0.0.4").is_ok());

    fs::write(target.join("web/index.html"), "tampered").unwrap();
    assert!(fixture.store.validate_version("0.0.4").is_err());
    assert_eq!(
        fixture.store.current_version().unwrap().as_deref(),
        Some("0.0.3")
    );
}

#[test]
fn running_product_validation_returns_the_one_authorized_manifest_derived_layout() {
    let fixture = Fixture::new();
    let active = fixture.bootstrap_product("0.0.3");
    let canonical_active = fs::canonicalize(&active).unwrap();
    let running = fixture.store.validate_running_product(&active).unwrap();

    assert_eq!(running.directory(), canonical_active);
    assert_eq!(running.version(), "0.0.3");

    let inactive = fixture.materialize_product("0.0.4");
    assert!(fixture.store.validate_running_product(&inactive).is_err());
    let external = fixture.root.join("external/0.0.3");
    fs::create_dir_all(&external).unwrap();
    assert!(fixture.store.validate_running_product(&external).is_err());
}

#[test]
fn current_never_advances_until_matching_desktop_is_installed() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let platform = RecordingPlatform::new(&fixture.root, "0.0.9");
    let coordinator = fixture.coordinator(platform.clone());
    coordinator
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();

    assert!(matches!(
        coordinator.continue_commit(),
        Err(ProductCommitError::DesktopVersionMismatch { .. })
    ));
    assert_eq!(
        fixture.store.current_version().unwrap().as_deref(),
        Some("0.0.3")
    );
    assert_eq!(
        fixture.store.pending().unwrap().unwrap().phase,
        CommitPhase::Staged
    );
}

#[test]
fn product_installer_reuses_commit_after_exact_desktop_is_already_installed() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let platform = RecordingPlatform::new(&fixture.root, "0.0.4").with_desktop_seed("0.0.4");
    let coordinator = fixture.coordinator(platform.clone());

    coordinator
        .begin_with_installed_desktop(&target, desktop_resume())
        .unwrap();
    let pending = fixture.store.pending().unwrap().unwrap();
    assert_eq!(pending.phase, CommitPhase::DesktopInstalled);
    assert!(pending.staged_desktop_asset().is_none());

    coordinator.continue_commit().unwrap();

    assert_eq!(platform.install_calls(), 0);
    assert_eq!(platform.launched_versions(), vec!["0.0.4"]);
    assert_eq!(
        fixture.store.current_version().unwrap().as_deref(),
        Some("0.0.4")
    );
}

#[test]
fn recovery_revalidates_the_persisted_installer_before_desktop_install() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let staged_asset = fixture.desktop_asset("0.0.4");
    let platform = RecordingPlatform::new(&fixture.root, "0.0.4");
    let coordinator = fixture.coordinator(platform.clone());
    coordinator
        .begin(&target, staged_asset.clone(), desktop_resume())
        .unwrap();
    fs::write(staged_asset.path(), "tampered installer").unwrap();

    assert!(coordinator.continue_commit().is_err());
    assert_eq!(
        fixture.store.current_version().unwrap().as_deref(),
        Some("0.0.3")
    );
    assert!(platform.launched_versions().is_empty());
    assert!(fixture.store.pending().is_err());
}

#[test]
fn one_pending_commit_recovers_forward_from_each_durable_phase() {
    for cut in [
        CommitPhase::Staged,
        CommitPhase::DesktopInstalled,
        CommitPhase::CurrentSelected,
    ] {
        let fixture = Fixture::new();
        fixture.bootstrap_product("0.0.3");
        let target = fixture.materialize_product("0.0.4");
        let platform = RecordingPlatform::new(&fixture.root, "0.0.4");
        let coordinator = fixture.coordinator(platform.clone());
        coordinator
            .begin(
                &target,
                fixture.desktop_asset("0.0.4"),
                ResumeIntent::Browser,
            )
            .unwrap();
        if cut != CommitPhase::Staged {
            coordinator.install_desktop().unwrap();
        }
        if cut == CommitPhase::CurrentSelected {
            fixture
                .coordinator(platform.with_desktop_seed("0.0.4"))
                .select_current()
                .unwrap();
        }

        let recovery_platform = match cut {
            CommitPhase::DesktopInstalled => platform.with_desktop_seed("0.0.4"),
            CommitPhase::Staged | CommitPhase::CurrentSelected => platform.with_runtime("0.0.3"),
            CommitPhase::RuntimeReady => unreachable!("covered by ready-resume recovery test"),
        };
        fixture
            .coordinator(recovery_platform)
            .continue_commit()
            .unwrap();

        assert_eq!(
            fixture.store.current_version().unwrap().as_deref(),
            Some("0.0.4")
        );
        assert_eq!(
            fixture.store.pending().unwrap().unwrap().phase,
            CommitPhase::CurrentSelected
        );
        assert_eq!(platform.launched_versions(), vec!["0.0.4"]);
    }
}

#[test]
fn unrelated_or_older_callers_cannot_continue_or_downgrade_a_pending_commit() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let platform = RecordingPlatform::new(&fixture.root, "0.0.4");
    let coordinator = fixture.coordinator(platform.clone());
    coordinator
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();

    assert!(matches!(
        fixture
            .coordinator(platform.with_desktop_seed("0.0.2"))
            .continue_commit(),
        Err(ProductCommitError::RecoveryIdentityDenied { .. })
    ));
    assert!(matches!(
        coordinator.begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume()),
        Err(ProductCommitError::PendingCommitExists)
    ));
    assert_eq!(
        fixture.store.current_version().unwrap().as_deref(),
        Some("0.0.3")
    );
}

#[test]
fn target_runtime_ready_resumes_then_removes_previous_and_pending() {
    let intents = [ResumeIntent::Desktop, ResumeIntent::Browser];
    for intent in intents {
        let fixture = Fixture::new();
        fixture.bootstrap_product("0.0.3");
        let target = fixture.materialize_product("0.0.4");
        let platform = RecordingPlatform::new(&fixture.root, "0.0.4");
        let coordinator = fixture.coordinator(platform.clone());
        coordinator
            .begin(&target, fixture.desktop_asset("0.0.4"), intent.clone())
            .unwrap();
        coordinator.continue_commit().unwrap();

        assert!(matches!(
            coordinator.complete_ready(),
            Err(ProductCommitError::TargetRuntimeNotReady { .. })
        ));
        fixture
            .coordinator(platform.with_runtime("0.0.4"))
            .complete_ready()
            .unwrap();

        assert!(fixture.store.pending().unwrap().is_none());
        assert!(!fixture.store.version_path("0.0.3").exists());
        assert!(fixture.store.version_path("0.0.4").exists());
        assert!(!fixture.store.root().join("updates/0.0.4").exists());
        assert_eq!(platform.resumed_intents(), vec![intent]);
    }
}

#[test]
fn ready_resume_failure_does_not_revoke_ready_or_block_cleanup() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let platform = RecordingPlatform::new_with_resume_failures(&fixture.root, "0.0.4", 1);
    let coordinator = fixture.coordinator(platform.clone());
    coordinator
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();
    coordinator.continue_commit().unwrap();

    let ready = fixture.coordinator(platform.with_runtime("0.0.4"));
    ready.complete_ready().unwrap();
    assert!(fixture.store.pending().unwrap().is_none());
    assert!(!fixture.store.version_path("0.0.3").exists());
    let attempts = platform.resume_attempt_ids();
    assert_eq!(attempts.len(), 1);
}

#[test]
fn post_ready_cleanup_failure_keeps_a_retryable_runtime_ready_transaction() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let platform = RecordingPlatform::new(&fixture.root, "0.0.4");
    let coordinator = fixture.coordinator(platform.clone());
    coordinator
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();
    coordinator.continue_commit().unwrap();
    let old_version = fixture.store.version_path("0.0.3");
    fs::remove_dir_all(&old_version).unwrap();
    fs::write(&old_version, "block cleanup").unwrap();

    let ready = fixture.coordinator(platform.with_runtime("0.0.4"));
    ready.complete_ready().unwrap();
    assert_eq!(
        fixture.store.pending().unwrap().unwrap().phase,
        CommitPhase::RuntimeReady
    );
    fs::remove_file(old_version).unwrap();

    ready.complete_ready().unwrap();
    assert!(fixture.store.pending().unwrap().is_none());
    assert_eq!(platform.resumed_intents(), vec![desktop_resume()]);
}

#[test]
fn forward_failure_record_is_bound_to_the_exact_pending_transaction() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let platform = RecordingPlatform::new(&fixture.root, "0.0.4");
    let coordinator = fixture.coordinator(platform);
    let transaction_id = coordinator
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();

    coordinator
        .record_failure(
            &transaction_id,
            ProductUpdateFailureStage::Committing,
            "Target Runtime failed before Ready.",
        )
        .unwrap();
    let failure = fixture
        .store
        .product_update_failure(&transaction_id)
        .unwrap();
    assert_eq!(failure.transaction_id, transaction_id);
    assert_eq!(failure.target_version, "0.0.4");
    assert_eq!(failure.stage, ProductUpdateFailureStage::Committing);
    assert_eq!(failure.message, "Target Runtime failed before Ready.");
    assert!(
        fixture
            .store
            .product_update_failure(&Uuid::new_v4().to_string())
            .is_err()
    );
}

#[test]
fn materialization_retry_adopts_the_exact_published_version() {
    let fixture = Fixture::new();
    let seed = fixture.write_seed("0.0.4", ReleaseArchitecture::Arm64);
    let first = fixture.store.materialize_seed(&seed).unwrap();
    let retried = fixture.store.materialize_seed(&seed).unwrap();

    assert_eq!(retried, first);
    assert_eq!(
        fixture
            .store
            .validate_version("0.0.4")
            .unwrap()
            .product_version,
        "0.0.4"
    );
}

#[test]
fn desktop_seed_preflight_uses_the_runtime_owned_immutable_product_contract() {
    let fixture = Fixture::new();
    let installed_seed = fixture.write_seed("0.0.3", ReleaseArchitecture::Arm64);
    fixture
        .store
        .activate_desktop_seed(&installed_seed)
        .unwrap();

    assert_eq!(
        fixture
            .store
            .preflight_desktop_seed(&installed_seed)
            .unwrap()
            .product_version(),
        "0.0.3"
    );

    let conflicting_seed = fixture.write_seed("0.0.4", ReleaseArchitecture::Arm64);
    rewrite_seed_identity(&conflicting_seed, "0.0.3", "changed-local-source");
    assert!(matches!(
        fixture.store.preflight_desktop_seed(&conflicting_seed),
        Err(super::store::ProductStoreError::MaterializedVersionConflict(version))
            if version == "0.0.3"
    ));
    assert_eq!(
        fs::read_to_string(fixture.store.version_path("0.0.3").join("web/index.html")).unwrap(),
        "web"
    );

    let older_seed = fixture.write_seed("0.0.2", ReleaseArchitecture::Arm64);
    fixture
        .store
        .activate_desktop_seed(&fixture.write_seed("0.0.4", ReleaseArchitecture::Arm64))
        .unwrap();
    assert!(matches!(
        fixture.store.preflight_desktop_seed(&older_seed),
        Err(super::store::ProductStoreError::DesktopSeedOlderThanCurrent { seed, current })
            if seed == "0.0.2" && current == "0.0.4"
    ));
}

#[test]
fn desktop_seed_preflight_rejects_an_active_product_commit() {
    let fixture = Fixture::new();
    let current_seed = fixture.write_seed("0.0.3", ReleaseArchitecture::Arm64);
    fixture.store.activate_desktop_seed(&current_seed).unwrap();
    let target = fixture.materialize_product("0.0.4");
    fixture
        .coordinator(RecordingPlatform::new(&fixture.root, "0.0.3"))
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();
    let pending = fixture.store.pending().unwrap().unwrap();
    let current = fixture.store.current_version().unwrap();

    assert!(matches!(
        fixture.store.preflight_desktop_seed(&current_seed),
        Err(super::store::ProductStoreError::ProductCommitInProgress)
    ));
    assert_eq!(fixture.store.pending().unwrap(), Some(pending));
    assert_eq!(fixture.store.current_version().unwrap(), current);
}

#[test]
fn product_entrypoint_and_architecture_contracts_are_closed() {
    let fixture = Fixture::new();
    let missing = fixture.write_seed("0.0.4", ReleaseArchitecture::Arm64);
    fs::remove_file(missing.join("runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime"))
        .unwrap();
    assert!(fixture.store.materialize_seed(&missing).is_err());

    let non_executable = fixture.write_seed("0.0.5", ReleaseArchitecture::Arm64);
    let runtime = non_executable.join("runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime");
    let mut permissions = fs::metadata(&runtime).unwrap().permissions();
    permissions.set_mode(0o644);
    fs::set_permissions(runtime, permissions).unwrap();
    assert!(fixture.store.materialize_seed(&non_executable).is_err());

    let wrong_architecture = fixture.write_seed("0.0.6", ReleaseArchitecture::X64);
    assert!(fixture.store.materialize_seed(&wrong_architecture).is_err());

    let unexpected_entrypoint = fixture.write_seed("0.0.7", ReleaseArchitecture::Arm64);
    let manifest_path = unexpected_entrypoint.join("product-manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["entrypoints"]["unexpectedEntrypoint"] = json!("unexpected/file");
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    assert!(
        fixture
            .store
            .materialize_seed(&unexpected_entrypoint)
            .is_err()
    );
}

#[test]
fn installed_target_is_adopted_without_reinstall_by_either_recovery_owner() {
    for desktop_seed in [false, true] {
        let fixture = Fixture::new();
        fixture.bootstrap_product("0.0.3");
        let target = fixture.materialize_product("0.0.4");
        let platform = RecordingPlatform::new(&fixture.root, "0.0.4");
        let running = if desktop_seed {
            platform.with_desktop_seed("0.0.4")
        } else {
            platform.with_runtime("0.0.3")
        };
        let coordinator = fixture.coordinator(running);
        coordinator
            .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
            .unwrap();

        coordinator.continue_commit().unwrap();

        assert_eq!(platform.install_calls(), 0);
        assert_eq!(
            fixture.store.current_version().unwrap().as_deref(),
            Some("0.0.4")
        );
    }
}

#[test]
fn same_version_with_wrong_full_identity_cannot_advance_or_complete_commit() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let platform = RecordingPlatform::new(&fixture.root, "0.0.4");
    let coordinator = fixture.coordinator(platform.clone());
    coordinator
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();

    let wrong_seed = ProductIdentity::new(
        "0.0.4".to_owned(),
        ProductPlatform::Windows,
        ReleaseArchitecture::X64,
        "wrong-control-protocol".to_owned(),
        CONTROL_PROTOCOL_VERSION,
        "0".repeat(64),
    );
    assert!(matches!(
        fixture
            .coordinator(platform.with_running(RunningProductIdentity::DesktopSeed(wrong_seed)))
            .continue_commit(),
        Err(ProductCommitError::RecoveryIdentityDenied { .. })
    ));
    assert_eq!(
        fixture.store.current_version().unwrap().as_deref(),
        Some("0.0.3")
    );

    coordinator.continue_commit().unwrap();
    let wrong_ready = ProductIdentity::new(
        "0.0.4".to_owned(),
        ProductPlatform::Macos,
        ReleaseArchitecture::Arm64,
        CONTROL_PROTOCOL.to_owned(),
        CONTROL_PROTOCOL_VERSION,
        "f".repeat(64),
    );
    assert!(matches!(
        fixture
            .coordinator(platform.with_running(RunningProductIdentity::Runtime(wrong_ready)))
            .complete_ready(),
        Err(ProductCommitError::TargetRuntimeNotReady { .. })
    ));
    assert!(fixture.store.version_path("0.0.3").exists());
}

#[test]
fn installed_desktop_must_match_the_complete_product_identity() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let platform = RecordingPlatform::new(&fixture.root, "0.0.4");
    let wrong = ProductIdentity::new(
        "0.0.4".to_owned(),
        ProductPlatform::Macos,
        ReleaseArchitecture::Arm64,
        CONTROL_PROTOCOL.to_owned(),
        CONTROL_PROTOCOL_VERSION,
        "0".repeat(64),
    );
    platform.set_installed(InstalledDesktopIdentity::new(wrong));
    let coordinator = fixture.coordinator(platform.clone());
    coordinator
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();

    assert!(matches!(
        coordinator.continue_commit(),
        Err(ProductCommitError::DesktopVersionMismatch { .. })
    ));
    assert_eq!(
        fixture.store.current_version().unwrap().as_deref(),
        Some("0.0.3")
    );
}

#[test]
fn recovery_reverifies_signed_evidence_instead_of_trusting_pending_fields() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let staged = fixture.desktop_asset("0.0.4");
    let coordinator = fixture.coordinator(RecordingPlatform::new(&fixture.root, "0.0.4"));
    coordinator
        .begin(&target, staged.clone(), desktop_resume())
        .unwrap();

    let pending_path = fixture.store.root().join("pending-commit/0-staged.json");
    let mut pending: serde_json::Value =
        serde_json::from_slice(&fs::read(&pending_path).unwrap()).unwrap();
    let forged = b"forged-installer";
    pending["entryCut"]["desktopAsset"]["releaseAsset"]["sha256"] = json!(hex_sha256(forged));
    pending["entryCut"]["desktopAsset"]["releaseAsset"]["sizeBytes"] = json!(forged.len());
    fs::write(&pending_path, serde_json::to_vec(&pending).unwrap()).unwrap();
    fs::write(staged.path(), forged).unwrap();

    assert!(fixture.store.pending().is_err());
    assert_eq!(
        fixture.store.current_version().unwrap().as_deref(),
        Some("0.0.3")
    );
}

#[test]
fn pending_state_rejects_gaps_and_oversize_documents() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let coordinator = fixture.coordinator(RecordingPlatform::new(&fixture.root, "0.0.4"));
    coordinator
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();
    let directory = fixture.store.root().join("pending-commit");
    fs::rename(
        directory.join("0-staged.json"),
        directory.join("1-desktop-installed.json"),
    )
    .unwrap();
    assert!(fixture.store.pending().is_err());
    fs::rename(
        directory.join("1-desktop-installed.json"),
        directory.join("0-staged.json"),
    )
    .unwrap();
    fs::write(directory.join("0-staged.json"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(fixture.store.pending().is_err());
}

#[test]
fn managed_product_state_refuses_symlinked_directories_and_lock_files() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.store.root()).unwrap();
    let outside = fixture.root.join("outside");
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, fixture.store.root().join("pending-commit")).unwrap();
    assert!(fixture.store.pending().is_err());
    fs::remove_file(fixture.store.root().join("pending-commit")).unwrap();
    fs::remove_file(fixture.store.root().join(".product.lock")).unwrap();
    std::os::unix::fs::symlink(
        fixture.root.join("outside-lock"),
        fixture.store.root().join(".product.lock"),
    )
    .unwrap();
    assert!(fixture.store.current_version().is_err());
}

#[test]
fn independent_store_instances_serialize_the_same_product_root() {
    let fixture = Fixture::new();
    let update_key = SigningKey::from_bytes(&[9; 32]).verifying_key();
    let second = ProductStore::new_with_update_public_key(
        fixture.store.root().to_path_buf(),
        CommitPlatform::Macos,
        ReleaseArchitecture::Arm64,
        *update_key.as_bytes(),
    );
    let first_guard = fixture.store.lock_transaction().unwrap();
    let (sender, receiver) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let _second_guard = second.lock_transaction().unwrap();
        sender.send(()).unwrap();
    });

    assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
    drop(first_guard);
    receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    thread.join().unwrap();
}

#[test]
fn resume_receipt_survives_both_sides_restarting_after_dispatch() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let platform = RecordingPlatform::new(&fixture.root, "0.0.4");
    let coordinator = fixture.coordinator(platform.clone());
    coordinator
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();
    coordinator.continue_commit().unwrap();
    platform.fail_next_resume_after_persist();
    let ready_platform = platform.with_runtime("0.0.4");
    let ready = fixture.coordinator(ready_platform.clone());
    ready.complete_ready().unwrap();
    assert_eq!(platform.resumed_intents(), vec![desktop_resume()]);
    assert!(fixture.store.pending().unwrap().is_none());
    let restarted_platform = ready_platform.restarted();
    assert_eq!(restarted_platform.resumed_intents(), vec![desktop_resume()]);
}

#[test]
fn native_resume_claim_is_durable_and_intent_bound() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let transaction_id = Uuid::new_v4().hyphenated().to_string();

    assert!(
        fixture
            .store
            .claim_resume(&transaction_id, &desktop_resume())
            .unwrap()
    );
    assert!(
        !fixture
            .store
            .claim_resume(&transaction_id, &desktop_resume())
            .unwrap()
    );

    let different_intent = ResumeIntent::Browser;
    assert!(
        fixture
            .store
            .claim_resume(&transaction_id, &different_intent)
            .is_err()
    );
}

#[test]
fn staged_install_failure_recovers_the_old_runtime_for_explicit_continuation() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    fixture
        .coordinator(RecordingPlatform::new(&fixture.root, "0.0.3"))
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();
    let home = fixture.root.join("installation-home");
    let layout = InstalledProductLayout::for_roots(CommitPlatform::Macos, home, None).unwrap();
    let installation = ProductInstallationCoordinator::new(Arc::clone(&fixture.store), layout);

    let activated = installation
        .recover_pending(&fixture.write_seed("0.0.3", ReleaseArchitecture::Arm64))
        .unwrap();

    assert_eq!(activated.product_version, "0.0.3");
    assert_eq!(
        fixture.store.pending().unwrap().unwrap().phase,
        CommitPhase::Staged
    );
}

#[test]
fn product_installer_preflight_accepts_only_the_exact_staged_transaction() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let transaction_id = fixture
        .coordinator(RecordingPlatform::new(&fixture.root, "0.0.4"))
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();
    let temporary = fixture.store.root().join("pending-commit/.tmp-in-flight");
    fs::write(&temporary, "in flight").unwrap();

    fixture
        .store
        .verify_pending_desktop_installer(&transaction_id)
        .unwrap();
    assert!(temporary.exists());
    assert!(
        fixture
            .store
            .verify_pending_desktop_installer(&Uuid::new_v4().to_string())
            .is_err()
    );
}

#[test]
fn retired_pending_tombstone_replays_update_cleanup_after_restart() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let coordinator = fixture.coordinator(RecordingPlatform::new(&fixture.root, "0.0.4"));
    coordinator
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();
    let marker = fixture
        .store
        .root()
        .join(format!(".retired-pending-0.0.4--{}", Uuid::new_v4()));
    fs::rename(fixture.store.root().join("pending-commit"), &marker).unwrap();

    fixture.store.current_version().unwrap();

    assert!(!marker.exists());
    assert!(!fixture.store.root().join("updates/0.0.4").exists());
}

#[test]
fn abandoned_transaction_artifacts_are_reclaimed_after_restart() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let product_root = fixture.store.root();
    let staging = product_root.join(format!(".staging-0.0.4--{}", Uuid::new_v4()));
    fs::create_dir_all(staging.join("runtime")).unwrap();
    let update_directory = product_root.join("updates/0.0.4");
    fs::create_dir_all(&update_directory).unwrap();
    let asset = update_directory.join(format!(".asset-{}", Uuid::new_v4()));
    fs::write(&asset, b"partial installer").unwrap();
    let current = product_root.join(format!(".current-{}", Uuid::new_v4()));
    std::os::unix::fs::symlink("versions/0.0.3", &current).unwrap();
    let unrelated = product_root.join(".staging-not-a-managed-transaction");
    fs::create_dir(&unrelated).unwrap();
    let unrelated_retired_pending = product_root.join(".retired-pending-0.0.4--notes");
    fs::create_dir(&unrelated_retired_pending).unwrap();
    let unrelated_retired_update = product_root.join(".retired-update-not-managed");
    fs::create_dir(&unrelated_retired_update).unwrap();
    let noncanonical_uuid = Uuid::new_v4();
    let near_staging = product_root.join(format!(".staging-0.0.4--{}", noncanonical_uuid.simple()));
    fs::create_dir(&near_staging).unwrap();
    let near_current = product_root.join(format!(
        ".current-{}",
        noncanonical_uuid.hyphenated().to_string().to_uppercase()
    ));
    std::os::unix::fs::symlink("versions/0.0.3", &near_current).unwrap();
    let near_asset = update_directory.join(format!(".asset-{}", noncanonical_uuid.braced()));
    fs::write(&near_asset, b"unmanaged").unwrap();
    let near_retired_update = product_root.join(format!(
        ".retired-update-{}",
        noncanonical_uuid.hyphenated().to_string().to_uppercase()
    ));
    fs::create_dir(&near_retired_update).unwrap();

    let restarted = ProductStore::new(
        product_root.to_path_buf(),
        CommitPlatform::Macos,
        ReleaseArchitecture::Arm64,
    );
    assert_eq!(
        restarted.current_version().unwrap().as_deref(),
        Some("0.0.3")
    );

    assert!(!staging.exists());
    assert!(!asset.exists());
    assert!(!current.exists());
    assert!(unrelated.exists());
    assert!(unrelated_retired_pending.exists());
    assert!(unrelated_retired_update.exists());
    assert!(near_staging.exists());
    assert!(near_current.exists());
    assert!(near_asset.exists());
    assert!(near_retired_update.exists());
}

#[test]
fn installer_and_runtime_adapters_consume_the_verified_open_file_identity() {
    let fixture = Fixture::new();
    fixture.bootstrap_product("0.0.3");
    let target = fixture.materialize_product("0.0.4");
    let platform = ReplacingPathPlatform::new(&fixture.root);
    let coordinator = ProductCommitCoordinator::new(Arc::clone(&fixture.store), platform.clone());
    coordinator
        .begin(&target, fixture.desktop_asset("0.0.4"), desktop_resume())
        .unwrap();

    coordinator.continue_commit().unwrap();

    assert_eq!(platform.installer_bytes(), DESKTOP_ASSET_BYTES);
    assert_eq!(platform.runtime_bytes(), b"runtime");
}

fn rewrite_seed_identity(seed: &std::path::Path, version: &str, web_contents: &str) {
    let manifest_path = seed.join("product-manifest.json");
    let mut manifest: ProductManifest =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest.product_version = version.to_owned();
    fs::write(seed.join("web/index.html"), web_contents).unwrap();
    let web = manifest
        .files
        .iter_mut()
        .find(|file| file.path == "web/index.html")
        .unwrap();
    web.size_bytes = web_contents.len() as u64;
    web.sha256 = format!("{:x}", Sha256::digest(web_contents.as_bytes()));
    fs::write(manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
}

fn release_manifest_bytes(version: &str, duplicate: bool) -> Vec<u8> {
    let desktop = json!({
        "kind": "desktop",
        "platform": "macos",
        "arch": "arm64",
        "name": format!("debrute-installer-{version}-macos-arm64.dmg"),
        "url": format!("https://github.com/xiitang/debrute/releases/download/v{version}/debrute-installer-{version}-macos-arm64.dmg"),
        "sha256": hex_sha256(DESKTOP_ASSET_BYTES),
        "sizeBytes": DESKTOP_ASSET_BYTES.len()
    });
    let product = json!({
        "kind": "product",
        "platform": "macos",
        "arch": "arm64",
        "name": format!("debrute-product-{version}-macos-arm64.zip"),
        "url": format!("https://github.com/xiitang/debrute/releases/download/v{version}/debrute-product-{version}-macos-arm64.zip"),
        "sha256": hex_sha256(PRODUCT_ASSET_BYTES),
        "sizeBytes": PRODUCT_ASSET_BYTES.len()
    });
    let assets = if duplicate {
        vec![desktop.clone(), desktop, product]
    } else {
        vec![desktop, product]
    };
    serde_json::to_vec(&json!({
        "schemaVersion": 1,
        "product": "debrute",
        "version": version,
        "releaseTag": format!("v{version}"),
        "publishedAt": "2026-07-15T00:00:00.000Z",
        "assets": assets
    }))
    .unwrap()
}

fn trusted_desktop_asset(version: &str) -> TrustedReleaseManifest {
    let signing_key = SigningKey::from_bytes(&[9; 32]);
    let bytes = release_manifest_bytes(version, false);
    let signature = STANDARD.encode(signing_key.sign(&bytes).to_bytes());
    let manifest: TrustedReleaseManifest =
        verify_signed_release_manifest(&bytes, &signature, signing_key.verifying_key().as_bytes())
            .unwrap();
    manifest
}

struct Fixture {
    root: PathBuf,
    store: Arc<ProductStore>,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("debrute-product-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let update_key = SigningKey::from_bytes(&[9; 32]).verifying_key();
        let store = Arc::new(ProductStore::new_with_update_public_key(
            root.join("products"),
            CommitPlatform::Macos,
            ReleaseArchitecture::Arm64,
            *update_key.as_bytes(),
        ));
        Self { root, store }
    }

    fn materialize_product(&self, version: &str) -> PathBuf {
        let seed = self.write_seed(version, ReleaseArchitecture::Arm64);
        self.store.materialize_seed(&seed).unwrap()
    }

    fn bootstrap_product(&self, version: &str) -> PathBuf {
        let seed = self.write_seed(version, ReleaseArchitecture::Arm64);
        self.store.activate_desktop_seed(&seed).unwrap()
    }

    fn write_seed(&self, version: &str, architecture: ReleaseArchitecture) -> PathBuf {
        let seed = self.root.join(format!("seed-{version}"));
        let files = [
            (
                "runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime",
                "runtime",
            ),
            ("web/index.html", "web"),
            ("runtime/debrute", "cli"),
            ("skills/debrute-core/SKILL.md", "skills"),
            ("native-workers/manifest.json", "worker"),
        ];
        let mut manifest_files = Vec::new();
        for (path, contents) in files {
            let destination = seed.join(path);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::write(&destination, contents).unwrap();
            if path.ends_with("/debrute-runtime") || path == "runtime/debrute" {
                let mut permissions = fs::metadata(&destination).unwrap().permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(&destination, permissions).unwrap();
            }
            manifest_files.push(ProductManifestFile {
                path: path.to_owned(),
                size_bytes: contents.len() as u64,
                sha256: hex_sha256(contents.as_bytes()),
            });
        }
        let manifest = ProductManifest {
            schema_version: 3,
            product: "debrute".to_owned(),
            product_version: version.to_owned(),
            control_protocol: CONTROL_PROTOCOL.to_owned(),
            control_protocol_version: CONTROL_PROTOCOL_VERSION,
            platform: ProductPlatform::Macos,
            architecture,
            entrypoints: ProductEntrypoints {
                runtime: "runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime".to_owned(),
                web: "web/index.html".to_owned(),
                cli: "runtime/debrute".to_owned(),
                skills: "skills/debrute-core/SKILL.md".to_owned(),
                native_workers: "native-workers/manifest.json".to_owned(),
            },
            files: manifest_files,
        };
        fs::write(
            seed.join("product-manifest.json"),
            format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
        )
        .unwrap();
        seed
    }

    fn desktop_asset(&self, version: &str) -> StagedDesktopAsset {
        let release_manifest = trusted_desktop_asset(version);
        let downloaded = self.root.join(format!("download-{version}"));
        fs::write(&downloaded, DESKTOP_ASSET_BYTES).unwrap();
        self.store
            .stage_desktop_asset(
                &release_manifest,
                ReleasePlatform::Macos,
                ReleaseArchitecture::Arm64,
                &downloaded,
            )
            .unwrap()
    }

    fn coordinator(
        &self,
        platform: RecordingPlatform,
    ) -> ProductCommitCoordinator<RecordingPlatform> {
        ProductCommitCoordinator::new(Arc::clone(&self.store), platform)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Clone)]
struct RecordingPlatform {
    state: Arc<Mutex<RecordingPlatformState>>,
    fixture_root: PathBuf,
    running: RunningProductIdentity,
}

struct RecordingPlatformState {
    installed: InstalledDesktopIdentity,
    install_calls: usize,
    launched_versions: Vec<String>,
    resume_receipts: PathBuf,
    resume_attempt_ids: Vec<String>,
    resume_failures_remaining: usize,
    resume_fail_after_persist_remaining: usize,
}

impl RecordingPlatform {
    fn new(root: &std::path::Path, installed_version: &str) -> Self {
        Self::new_with_resume_failures(root, installed_version, 0)
    }

    fn new_with_resume_failures(
        root: &std::path::Path,
        installed_version: &str,
        resume_failures: usize,
    ) -> Self {
        let resume_receipts = root.join("resume-receipts");
        Self {
            state: Arc::new(Mutex::new(RecordingPlatformState {
                installed: test_desktop_identity(root, installed_version),
                install_calls: 0,
                launched_versions: Vec::new(),
                resume_receipts,
                resume_attempt_ids: Vec::new(),
                resume_failures_remaining: resume_failures,
                resume_fail_after_persist_remaining: 0,
            })),
            fixture_root: root.to_path_buf(),
            running: RunningProductIdentity::Runtime(test_product_identity(root, "0.0.3")),
        }
    }

    fn with_runtime(&self, product_version: &str) -> Self {
        Self {
            state: Arc::clone(&self.state),
            fixture_root: self.fixture_root.clone(),
            running: RunningProductIdentity::Runtime(test_product_identity(
                &self.fixture_root,
                product_version,
            )),
        }
    }

    fn with_desktop_seed(&self, product_version: &str) -> Self {
        Self {
            state: Arc::clone(&self.state),
            fixture_root: self.fixture_root.clone(),
            running: RunningProductIdentity::DesktopSeed(test_product_identity(
                &self.fixture_root,
                product_version,
            )),
        }
    }

    fn with_running(&self, running: RunningProductIdentity) -> Self {
        Self {
            state: Arc::clone(&self.state),
            fixture_root: self.fixture_root.clone(),
            running,
        }
    }

    fn set_installed(&self, identity: InstalledDesktopIdentity) {
        self.state
            .lock()
            .expect("test Product platform lock poisoned")
            .installed = identity;
    }

    fn restarted(&self) -> Self {
        let state = self
            .state
            .lock()
            .expect("test Product platform lock poisoned");
        Self {
            state: Arc::new(Mutex::new(RecordingPlatformState {
                installed: state.installed.clone(),
                install_calls: 0,
                launched_versions: Vec::new(),
                resume_receipts: state.resume_receipts.clone(),
                resume_attempt_ids: Vec::new(),
                resume_failures_remaining: 0,
                resume_fail_after_persist_remaining: 0,
            })),
            fixture_root: self.fixture_root.clone(),
            running: self.running.clone(),
        }
    }

    fn launched_versions(&self) -> Vec<String> {
        self.state
            .lock()
            .expect("test Product platform lock poisoned")
            .launched_versions
            .clone()
    }

    fn resumed_intents(&self) -> Vec<ResumeIntent> {
        let directory = self
            .state
            .lock()
            .expect("test Product platform lock poisoned")
            .resume_receipts
            .clone();
        let mut receipts = match fs::read_dir(directory) {
            Ok(entries) => entries
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(error) => panic!("failed to read durable resume receipts: {error}"),
        };
        receipts.sort();
        receipts
            .into_iter()
            .map(|path| serde_json::from_slice(&fs::read(path).unwrap()).unwrap())
            .collect()
    }

    fn resume_attempt_ids(&self) -> Vec<String> {
        self.state
            .lock()
            .expect("test Product platform lock poisoned")
            .resume_attempt_ids
            .clone()
    }

    fn install_calls(&self) -> usize {
        self.state
            .lock()
            .expect("test Product platform lock poisoned")
            .install_calls
    }

    fn fail_next_resume_after_persist(&self) {
        self.state
            .lock()
            .expect("test Product platform lock poisoned")
            .resume_fail_after_persist_remaining = 1;
    }
}

impl super::commit::sealed::Sealed for RecordingPlatform {}

impl UpdatePlatformAdapter for RecordingPlatform {
    fn install_desktop(
        &self,
        _installer: VerifiedDesktopInstaller,
    ) -> Result<(), ProductCommitError> {
        self.state
            .lock()
            .expect("test Product platform lock poisoned")
            .install_calls += 1;
        Ok(())
    }

    fn installed_desktop_identity(&self) -> Result<InstalledDesktopIdentity, ProductCommitError> {
        Ok(self
            .state
            .lock()
            .expect("test Product platform lock poisoned")
            .installed
            .clone())
    }

    fn running_product_identity(&self) -> Result<RunningProductIdentity, ProductCommitError> {
        Ok(self.running.clone())
    }

    fn launch_runtime(
        &self,
        product_version: &str,
        _entrypoint: VerifiedRuntimeEntrypoint,
    ) -> Result<(), ProductCommitError> {
        self.state
            .lock()
            .expect("test Product platform lock poisoned")
            .launched_versions
            .push(product_version.to_owned());
        Ok(())
    }

    fn resume(
        &self,
        transaction_id: &str,
        intent: &ResumeIntent,
    ) -> Result<(), ProductCommitError> {
        let (directory, should_fail) = {
            let mut state = self
                .state
                .lock()
                .expect("test Product platform lock poisoned");
            state.resume_attempt_ids.push(transaction_id.to_owned());
            let should_fail = state.resume_failures_remaining > 0;
            state.resume_failures_remaining = state.resume_failures_remaining.saturating_sub(1);
            (state.resume_receipts.clone(), should_fail)
        };
        if should_fail {
            return Err(ProductCommitError::Platform(
                "injected resume failure".to_owned(),
            ));
        }
        fs::create_dir_all(&directory).unwrap();
        let destination = directory.join(format!("{transaction_id}.json"));
        let bytes = serde_json::to_vec(intent).unwrap();
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(mut file) => {
                file.write_all(&bytes).unwrap();
                file.sync_all().unwrap();
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = fs::read(&destination).unwrap();
                if existing != bytes {
                    return Err(ProductCommitError::Platform(
                        "resume transaction intent changed".to_owned(),
                    ));
                }
            }
            Err(error) => {
                return Err(ProductCommitError::Platform(error.to_string()));
            }
        }
        let mut state = self
            .state
            .lock()
            .expect("test Product platform lock poisoned");
        if state.resume_fail_after_persist_remaining > 0 {
            state.resume_fail_after_persist_remaining -= 1;
            return Err(ProductCommitError::Platform(
                "injected crash after durable resume dispatch".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
struct ReplacingPathPlatform {
    state: Arc<Mutex<ReplacingPathState>>,
    running: RunningProductIdentity,
}

struct ReplacingPathState {
    installed: InstalledDesktopIdentity,
    target_installed: InstalledDesktopIdentity,
    installer_bytes: Vec<u8>,
    runtime_bytes: Vec<u8>,
}

impl ReplacingPathPlatform {
    fn new(root: &std::path::Path) -> Self {
        Self {
            state: Arc::new(Mutex::new(ReplacingPathState {
                installed: test_desktop_identity(root, "0.0.3"),
                target_installed: test_desktop_identity(root, "0.0.4"),
                installer_bytes: Vec::new(),
                runtime_bytes: Vec::new(),
            })),
            running: RunningProductIdentity::Runtime(test_product_identity(root, "0.0.3")),
        }
    }

    fn installer_bytes(&self) -> Vec<u8> {
        self.state
            .lock()
            .expect("test Product platform lock poisoned")
            .installer_bytes
            .clone()
    }

    fn runtime_bytes(&self) -> Vec<u8> {
        self.state
            .lock()
            .expect("test Product platform lock poisoned")
            .runtime_bytes
            .clone()
    }
}

impl super::commit::sealed::Sealed for ReplacingPathPlatform {}

impl UpdatePlatformAdapter for ReplacingPathPlatform {
    fn install_desktop(
        &self,
        installer: VerifiedDesktopInstaller,
    ) -> Result<(), ProductCommitError> {
        let replacement = installer.path().with_extension("replacement");
        fs::write(&replacement, b"different installer at the same path").unwrap();
        fs::rename(&replacement, installer.path()).unwrap();
        let mut file = installer.file().try_clone().unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        let restored = installer.path().with_extension("restored");
        fs::write(&restored, DESKTOP_ASSET_BYTES).unwrap();
        fs::rename(&restored, installer.path()).unwrap();
        let mut state = self
            .state
            .lock()
            .expect("test Product platform lock poisoned");
        state.installer_bytes = bytes;
        state.installed = state.target_installed.clone();
        Ok(())
    }

    fn installed_desktop_identity(&self) -> Result<InstalledDesktopIdentity, ProductCommitError> {
        Ok(self
            .state
            .lock()
            .expect("test Product platform lock poisoned")
            .installed
            .clone())
    }

    fn running_product_identity(&self) -> Result<RunningProductIdentity, ProductCommitError> {
        Ok(self.running.clone())
    }

    fn launch_runtime(
        &self,
        _product_version: &str,
        entrypoint: VerifiedRuntimeEntrypoint,
    ) -> Result<(), ProductCommitError> {
        let replacement = entrypoint.path().with_extension("replacement");
        fs::write(&replacement, b"different runtime at the same path").unwrap();
        fs::rename(&replacement, entrypoint.path()).unwrap();
        let mut file = entrypoint.file().try_clone().unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        self.state
            .lock()
            .expect("test Product platform lock poisoned")
            .runtime_bytes = bytes;
        Ok(())
    }

    fn resume(
        &self,
        _transaction_id: &str,
        _intent: &ResumeIntent,
    ) -> Result<(), ProductCommitError> {
        Ok(())
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn test_product_identity(root: &std::path::Path, product_version: &str) -> ProductIdentity {
    let manifest_path = root
        .join("products/versions")
        .join(product_version)
        .join("product-manifest.json");
    match fs::read(&manifest_path) {
        Ok(bytes) => {
            let manifest: ProductManifest = serde_json::from_slice(&bytes).unwrap();
            ProductIdentity::new(
                manifest.product_version,
                manifest.platform,
                manifest.architecture,
                manifest.control_protocol,
                manifest.control_protocol_version,
                hex_sha256(&bytes),
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ProductIdentity::new(
            product_version.to_owned(),
            ProductPlatform::Macos,
            ReleaseArchitecture::Arm64,
            CONTROL_PROTOCOL.to_owned(),
            CONTROL_PROTOCOL_VERSION,
            "0".repeat(64),
        ),
        Err(error) => panic!("failed to inspect test product identity: {error}"),
    }
}

fn test_desktop_identity(
    root: &std::path::Path,
    product_version: &str,
) -> InstalledDesktopIdentity {
    InstalledDesktopIdentity::new(test_product_identity(root, product_version))
}
