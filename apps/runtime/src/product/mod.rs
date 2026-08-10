mod archive;
mod commit;
mod installation;
mod layout;
mod manifest;
mod platform;
mod projections;
mod release;
mod removal;
mod service;
mod store;

pub use commit::{
    CommitPhase, InstalledDesktopIdentity, PendingCommit, ProductCommitCoordinator,
    ProductCommitError, ProductIdentity, ProductUpdateFailure, ProductUpdateFailureStage,
    ResumeIntent, RunningProductIdentity, UpdatePlatformAdapter,
};
pub use layout::{InstalledProductLayout, ProductLayoutError};
pub use manifest::{
    CanvasVideoRuntimeDependency, ProductEntrypoints, ProductManifest, ProductManifestError,
    ProductManifestFile, ProductPlatform, ProductRuntimeDependencies, ReleaseArchitecture,
    ReleaseAssetKind, ReleasePlatform, SignedManifestError, StagedDesktopAsset,
    StagedProductArchive, TrustedReleaseAsset, TrustedReleaseManifest,
    verify_official_signed_release_manifest,
};
pub use platform::{NativeUpdatePlatform, launch_product_update_failure};
pub use projections::{ProductProjectionError, ProductProjectionManager};
pub use release::{GitHubProductReleaseSource, ProductReleaseError, ProductReleaseSource};
pub use removal::{ProductRemovalCoordinator, ProductRemovalError, finalize_product_removal};
pub use service::RuntimeProductService;
pub use store::{
    CommitPlatform, ProductStore, ProductStoreError, ValidatedRunningProduct,
    VerifiedDesktopInstaller, VerifiedRuntimeEntrypoint,
};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod windows_tests;
pub use archive::{ProductArchiveError, extract_product_archive};
pub use installation::{
    ActivatedProduct, DesktopHostRegistration, ProductInstallationCoordinator,
    ProductInstallationError, read_desktop_host_registration,
};
