mod archive;
mod bootstrap;
mod commit;
mod manifest;
mod platform;
mod release;
mod service;
mod store;

pub use commit::{
    CommitPhase, InstalledDesktopIdentity, PendingCommit, ProductCommitCoordinator,
    ProductCommitError, ProductIdentity, ResumeIntent, ResumeTarget, RunningProductIdentity,
    UpdatePlatformAdapter,
};
pub use manifest::{
    ProductEntrypoints, ProductManifest, ProductManifestError, ProductManifestFile,
    ProductPlatform, ReleaseArchitecture, ReleaseAssetKind, ReleasePlatform, SignedManifestError,
    StagedDesktopAsset, StagedProductArchive, TrustedReleaseAsset, TrustedReleaseManifest,
    verify_official_signed_release_manifest,
};
pub use platform::NativeUpdatePlatform;
pub use release::{GitHubProductReleaseSource, ProductReleaseError, ProductReleaseSource};
pub use service::RuntimeProductService;
pub use store::{
    CommitPlatform, ProductStore, ProductStoreError, VerifiedDesktopInstaller,
    VerifiedRuntimeEntrypoint,
};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod windows_tests;
pub use archive::{ProductArchiveError, extract_product_archive};
pub use bootstrap::{
    ActivatedProduct, DesktopHostRegistration, ProductBootstrap, ProductBootstrapError,
    read_desktop_host_registration,
};
