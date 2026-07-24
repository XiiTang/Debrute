#![cfg(target_os = "windows")]

use std::{fs, path::PathBuf};

use sha2::{Digest as _, Sha256};
use uuid::Uuid;

use crate::control::{CONTROL_PROTOCOL, CONTROL_PROTOCOL_VERSION};

use super::{
    CommitPlatform, ProductEntrypoints, ProductManifest, ProductManifestFile, ProductPlatform,
    ProductStore, ReleaseArchitecture,
};

#[test]
fn windows_product_uses_closed_exe_entrypoints_and_retargets_one_junction() {
    let fixture = WindowsFixture::new();
    let old_seed = fixture.write_seed("0.0.3");
    fixture.store.activate_desktop_seed(&old_seed).unwrap();
    assert_eq!(
        fixture.store.current_version().unwrap().as_deref(),
        Some("0.0.3")
    );
    let target_seed = fixture.write_seed("0.0.4");
    let target = fixture.store.materialize_seed(&target_seed).unwrap();

    {
        let _transaction = fixture.store.lock_transaction().unwrap();
        fixture.store.select_current_unlocked(&target).unwrap();
    }

    assert_eq!(
        fixture.store.current_version().unwrap().as_deref(),
        Some("0.0.4")
    );
    assert!(fixture.store.root().join("current").is_dir());
}

#[test]
fn windows_verified_runtime_handle_denies_path_replacement_until_launch_consumes_it() {
    let fixture = WindowsFixture::new();
    let seed = fixture.write_seed("0.0.3");
    fixture.store.activate_desktop_seed(&seed).unwrap();
    let runtime = fixture
        .store
        .version_path("0.0.3")
        .join("runtime/debrute-runtime.exe");
    let replacement = runtime.with_extension("replacement.exe");
    fs::write(&replacement, b"replacement").unwrap();
    let verified = {
        let _transaction = fixture.store.lock_transaction().unwrap();
        fixture
            .store
            .open_verified_runtime_unlocked("0.0.3")
            .unwrap()
    };

    assert!(fs::rename(&replacement, &runtime).is_err());
    drop(verified);
    fs::rename(&replacement, &runtime).unwrap();
}

#[test]
fn windows_restart_reclaims_empty_directory_left_before_junction_creation() {
    let fixture = WindowsFixture::new();
    fs::create_dir_all(fixture.store.root()).unwrap();
    let abandoned = fixture
        .store
        .root()
        .join(format!(".current-{}", Uuid::new_v4()));
    fs::create_dir(&abandoned).unwrap();

    assert_eq!(fixture.store.current_version().unwrap(), None);
    assert!(!abandoned.exists());
}

struct WindowsFixture {
    root: PathBuf,
    store: ProductStore,
}

impl WindowsFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("debrute-windows-product-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let store = ProductStore::new(
            root.join("products"),
            CommitPlatform::Windows,
            ReleaseArchitecture::X64,
        );
        Self { root, store }
    }

    fn write_seed(&self, version: &str) -> PathBuf {
        let seed = self.root.join(format!("seed-{version}"));
        let files = [
            ("runtime/debrute-runtime.exe", "runtime"),
            ("web/index.html", "web"),
            ("runtime/debrute.exe", "cli"),
            ("skills/debrute-core/SKILL.md", "skills"),
            ("model-docs/models.json", "models"),
            ("native-workers/manifest.json", "worker"),
        ];
        let mut manifest_files = Vec::new();
        for (path, contents) in files {
            let destination = seed.join(path);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::write(destination, contents).unwrap();
            manifest_files.push(ProductManifestFile {
                path: path.to_owned(),
                size_bytes: contents.len() as u64,
                sha256: format!("{:x}", Sha256::digest(contents.as_bytes())),
            });
        }
        let manifest = ProductManifest {
            schema_version: 1,
            product: "debrute".to_owned(),
            product_version: version.to_owned(),
            control_protocol: CONTROL_PROTOCOL.to_owned(),
            control_protocol_version: CONTROL_PROTOCOL_VERSION,
            platform: ProductPlatform::Windows,
            architecture: ReleaseArchitecture::X64,
            entrypoints: ProductEntrypoints {
                runtime: "runtime/debrute-runtime.exe".to_owned(),
                web: "web/index.html".to_owned(),
                cli: "runtime/debrute.exe".to_owned(),
                skills: "skills/debrute-core/SKILL.md".to_owned(),
                model_docs: "model-docs/models.json".to_owned(),
                native_workers: "native-workers/manifest.json".to_owned(),
            },
            files: manifest_files,
        };
        fs::write(
            seed.join("product-manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        seed
    }
}

impl Drop for WindowsFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
