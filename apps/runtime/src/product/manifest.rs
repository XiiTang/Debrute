use std::{
    collections::HashSet,
    error::Error,
    fmt,
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};

use crate::control::{CONTROL_PROTOCOL, CONTROL_PROTOCOL_VERSION};

pub const PRODUCT_MANIFEST_NAME: &str = "product-manifest.json";
pub const RELEASE_MANIFEST_NAME: &str = "debrute-update-manifest.json";
pub const RELEASE_SIGNATURE_NAME: &str = "debrute-update-manifest.json.sig";
const PRODUCT_NAME: &str = "debrute";
const RELEASE_PRODUCT_NAME: &str = "debrute";
const GITHUB_RELEASE_ROOT: &str = "https://github.com/xiitang/debrute/releases/download";
const RELEASE_MANIFEST_MAX_BYTES: usize = 256 * 1024;
const RELEASE_SIGNATURE_MAX_BYTES: usize = 8 * 1024;
pub const DEBRUTE_UPDATE_PUBLIC_KEY_BYTES: [u8; 32] = [
    0x89, 0x80, 0xf0, 0x44, 0x85, 0x9c, 0x90, 0xb3, 0xdd, 0x6b, 0x01, 0x3d, 0x01, 0xbb, 0x0e, 0x4b,
    0x89, 0xa3, 0x0e, 0x70, 0xe3, 0xf6, 0xfb, 0x13, 0x7e, 0xfc, 0x8b, 0x10, 0x59, 0xef, 0x5a, 0x51,
];
const REQUIRED_PRODUCT_COMPONENTS: [&str; 5] =
    ["runtime", "web", "skills", "model-docs", "native-workers"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductManifest {
    pub schema_version: u32,
    pub product: String,
    pub product_version: String,
    pub control_protocol: String,
    pub control_protocol_version: u32,
    pub platform: ProductPlatform,
    pub architecture: ReleaseArchitecture,
    pub entrypoints: ProductEntrypoints,
    pub files: Vec<ProductManifestFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProductPlatform {
    Macos,
    Windows,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductEntrypoints {
    pub runtime: String,
    pub web: String,
    pub cli: String,
    pub skills: String,
    pub model_docs: String,
    pub native_workers: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductManifestFile {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

impl ProductManifest {
    pub(crate) fn validate_contract(&self) -> Result<(), ProductManifestError> {
        if self.schema_version != 1 {
            return Err(ProductManifestError::InvalidSchemaVersion(
                self.schema_version,
            ));
        }
        if self.product != PRODUCT_NAME {
            return Err(ProductManifestError::InvalidProduct(self.product.clone()));
        }
        validate_release_version(&self.product_version)?;
        if self.control_protocol != CONTROL_PROTOCOL
            || self.control_protocol_version != CONTROL_PROTOCOL_VERSION
        {
            return Err(ProductManifestError::IncompatibleControlProtocol {
                protocol: self.control_protocol.clone(),
                version: self.control_protocol_version,
            });
        }
        if self.files.is_empty() {
            return Err(ProductManifestError::EmptyFiles);
        }
        let mut paths = HashSet::new();
        let mut present_components = HashSet::new();
        for file in &self.files {
            validate_product_path(&file.path)?;
            if !paths.insert(file.path.clone()) {
                return Err(ProductManifestError::DuplicateFile(file.path.clone()));
            }
            if file.size_bytes == 0 {
                return Err(ProductManifestError::InvalidFileSize(file.path.clone()));
            }
            if !is_lower_hex_sha256(&file.sha256) {
                return Err(ProductManifestError::InvalidSha256(file.path.clone()));
            }
            if let Some(component) = file.path.split('/').next() {
                present_components.insert(component);
            }
        }
        for component in REQUIRED_PRODUCT_COMPONENTS {
            if !present_components.contains(component) {
                return Err(ProductManifestError::MissingComponent(component.to_owned()));
            }
        }
        let expected = match self.platform {
            ProductPlatform::Macos => ProductEntrypoints {
                runtime: "runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime".to_owned(),
                web: "web/index.html".to_owned(),
                cli: "runtime/debrute".to_owned(),
                skills: "skills/debrute-core/SKILL.md".to_owned(),
                model_docs: "model-docs/models.json".to_owned(),
                native_workers: "native-workers/manifest.json".to_owned(),
            },
            ProductPlatform::Windows => ProductEntrypoints {
                runtime: "runtime/debrute-runtime.exe".to_owned(),
                web: "web/index.html".to_owned(),
                cli: "runtime/debrute.exe".to_owned(),
                skills: "skills/debrute-core/SKILL.md".to_owned(),
                model_docs: "model-docs/models.json".to_owned(),
                native_workers: "native-workers/manifest.json".to_owned(),
            },
        };
        if self.entrypoints != expected {
            return Err(ProductManifestError::InvalidEntrypoints);
        }
        for entrypoint in [
            &self.entrypoints.runtime,
            &self.entrypoints.web,
            &self.entrypoints.cli,
            &self.entrypoints.skills,
            &self.entrypoints.model_docs,
            &self.entrypoints.native_workers,
        ] {
            if !paths.contains(entrypoint) {
                return Err(ProductManifestError::MissingEntrypoint(entrypoint.clone()));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleasePlatform {
    Macos,
    Windows,
    Linux,
}

impl ReleasePlatform {
    fn as_str(self) -> &'static str {
        match self {
            Self::Macos => "macos",
            Self::Windows => "windows",
            Self::Linux => "linux",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Macos => "dmg",
            Self::Windows => "exe",
            Self::Linux => "AppImage",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseArchitecture {
    Arm64,
    X64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseAssetKind {
    Desktop,
    Product,
}

impl ReleaseArchitecture {
    fn as_str(self) -> &'static str {
        match self {
            Self::Arm64 => "arm64",
            Self::X64 => "x64",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseManifestWire {
    schema_version: u32,
    product: String,
    version: String,
    release_tag: String,
    published_at: String,
    assets: Vec<ReleaseAssetWire>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseAssetWire {
    kind: ReleaseAssetKind,
    platform: ReleasePlatform,
    #[serde(rename = "arch")]
    architecture: ReleaseArchitecture,
    name: String,
    url: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedReleaseManifest {
    version: String,
    published_at: String,
    assets: Vec<TrustedReleaseAsset>,
    manifest_bytes: Vec<u8>,
    signature_text: String,
}

impl TrustedReleaseManifest {
    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub fn published_at(&self) -> &str {
        &self.published_at
    }

    #[must_use]
    pub fn asset_for(
        &self,
        kind: ReleaseAssetKind,
        platform: ReleasePlatform,
        architecture: ReleaseArchitecture,
    ) -> Option<&TrustedReleaseAsset> {
        self.assets.iter().find(|asset| {
            asset.kind == kind && asset.platform == platform && asset.architecture == architecture
        })
    }

    pub(crate) fn manifest_bytes(&self) -> &[u8] {
        &self.manifest_bytes
    }

    pub(crate) fn signature_text(&self) -> &str {
        &self.signature_text
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedReleaseAsset {
    pub(crate) kind: ReleaseAssetKind,
    pub(crate) platform: ReleasePlatform,
    #[serde(rename = "arch")]
    pub(crate) architecture: ReleaseArchitecture,
    pub(crate) name: String,
    pub(crate) url: String,
    pub(crate) sha256: String,
    pub(crate) size_bytes: u64,
}

impl TrustedReleaseAsset {
    pub(crate) fn restore(
        kind: ReleaseAssetKind,
        platform: ReleasePlatform,
        architecture: ReleaseArchitecture,
        name: String,
        url: String,
        sha256: String,
        size_bytes: u64,
    ) -> Self {
        Self {
            kind,
            platform,
            architecture,
            name,
            url,
            sha256,
            size_bytes,
        }
    }

    #[must_use]
    pub fn kind(&self) -> ReleaseAssetKind {
        self.kind
    }

    #[must_use]
    pub fn platform(&self) -> ReleasePlatform {
        self.platform
    }

    #[must_use]
    pub fn architecture(&self) -> ReleaseArchitecture {
        self.architecture
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    #[must_use]
    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    #[must_use]
    pub fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    pub(crate) fn matches_product_version(&self, version: &str) -> bool {
        let expected_name = match self.kind {
            ReleaseAssetKind::Desktop => format!(
                "debrute-desktop-{version}-{}-{}.{}",
                self.platform.as_str(),
                self.architecture.as_str(),
                self.platform.extension()
            ),
            ReleaseAssetKind::Product => format!(
                "debrute-product-{version}-{}-{}.zip",
                self.platform.as_str(),
                self.architecture.as_str()
            ),
        };
        self.name == expected_name
            && self.url == format!("{GITHUB_RELEASE_ROOT}/v{version}/{expected_name}")
            && is_lower_hex_sha256(&self.sha256)
            && self.size_bytes > 0
            && match self.kind {
                ReleaseAssetKind::Desktop => {
                    self.platform == ReleasePlatform::Macos
                        || self.architecture == ReleaseArchitecture::X64
                }
                ReleaseAssetKind::Product => {
                    self.platform != ReleasePlatform::Linux
                        && (self.platform == ReleasePlatform::Macos
                            || self.architecture == ReleaseArchitecture::X64)
                }
            }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagedDesktopAsset {
    pub(crate) release_asset: TrustedReleaseAsset,
    pub(crate) path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedProductArchive {
    pub(crate) release_asset: TrustedReleaseAsset,
    pub(crate) path: PathBuf,
}

impl StagedProductArchive {
    pub(crate) fn new(release_asset: TrustedReleaseAsset, path: PathBuf) -> Self {
        Self {
            release_asset,
            path,
        }
    }

    #[must_use]
    pub fn release_asset(&self) -> &TrustedReleaseAsset {
        &self.release_asset
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl StagedDesktopAsset {
    pub(crate) fn new(release_asset: TrustedReleaseAsset, path: PathBuf) -> Self {
        Self {
            release_asset,
            path,
        }
    }

    #[must_use]
    pub fn release_asset(&self) -> &TrustedReleaseAsset {
        &self.release_asset
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Verifies the detached Ed25519 signature over the exact release-manifest
/// bytes before parsing any release-controlled field.
///
/// # Errors
///
/// Returns [`SignedManifestError`] when signature decoding or verification
/// fails, the JSON contract is open or malformed, or an asset is not the exact
/// canonical Debrute GitHub release asset for its signed version and target.
pub(crate) fn verify_signed_release_manifest(
    manifest_bytes: &[u8],
    signature_text: &str,
    public_key_bytes: &[u8; 32],
) -> Result<TrustedReleaseManifest, SignedManifestError> {
    if manifest_bytes.len() > RELEASE_MANIFEST_MAX_BYTES
        || signature_text.len() > RELEASE_SIGNATURE_MAX_BYTES
    {
        return Err(SignedManifestError::InputTooLarge);
    }
    let signature_bytes = STANDARD
        .decode(signature_text.trim())
        .map_err(|_| SignedManifestError::InvalidSignatureEncoding)?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| SignedManifestError::InvalidSignatureEncoding)?;
    let key = VerifyingKey::from_bytes(public_key_bytes)
        .map_err(|_| SignedManifestError::InvalidPublicKey)?;
    key.verify(manifest_bytes, &signature)
        .map_err(|_| SignedManifestError::InvalidSignature)?;

    let wire: ReleaseManifestWire = serde_json::from_slice(manifest_bytes)
        .map_err(|error| SignedManifestError::InvalidJson(error.to_string()))?;
    let mut trusted = validate_release_wire(wire)?;
    trusted.manifest_bytes = manifest_bytes.to_vec();
    signature_text.clone_into(&mut trusted.signature_text);
    Ok(trusted)
}

/// Verifies a release manifest against Debrute's compiled production update
/// signing key.
///
/// # Errors
///
/// Returns [`SignedManifestError`] under the same conditions as
/// [`verify_signed_release_manifest`].
pub fn verify_official_signed_release_manifest(
    manifest_bytes: &[u8],
    signature_text: &str,
) -> Result<TrustedReleaseManifest, SignedManifestError> {
    verify_signed_release_manifest(
        manifest_bytes,
        signature_text,
        &DEBRUTE_UPDATE_PUBLIC_KEY_BYTES,
    )
}

fn validate_release_wire(
    wire: ReleaseManifestWire,
) -> Result<TrustedReleaseManifest, SignedManifestError> {
    if wire.schema_version != 1 {
        return Err(SignedManifestError::InvalidSchemaVersion(
            wire.schema_version,
        ));
    }
    if wire.product != RELEASE_PRODUCT_NAME {
        return Err(SignedManifestError::InvalidProduct(wire.product));
    }
    validate_release_version(&wire.version).map_err(SignedManifestError::ProductManifest)?;
    let expected_tag = format!("v{}", wire.version);
    if wire.release_tag != expected_tag {
        return Err(SignedManifestError::InvalidReleaseTag {
            expected: expected_tag,
            actual: wire.release_tag,
        });
    }
    if !is_utc_millisecond_timestamp(&wire.published_at) {
        return Err(SignedManifestError::InvalidPublishedAt(wire.published_at));
    }
    if wire.assets.is_empty() {
        return Err(SignedManifestError::EmptyAssets);
    }
    let assets = wire
        .assets
        .into_iter()
        .map(|asset| {
            TrustedReleaseAsset::restore(
                asset.kind,
                asset.platform,
                asset.architecture,
                asset.name,
                asset.url,
                asset.sha256,
                asset.size_bytes,
            )
        })
        .collect::<Vec<_>>();
    let mut targets = HashSet::new();
    for asset in &assets {
        let target = (asset.kind, asset.platform, asset.architecture);
        if !targets.insert(target) {
            return Err(SignedManifestError::DuplicateTarget {
                kind: asset.kind,
                platform: asset.platform,
                architecture: asset.architecture,
            });
        }
        validate_release_asset(asset, &wire.version, &wire.release_tag)?;
    }
    for (kind, platform, architecture) in targets.clone() {
        if platform == ReleasePlatform::Linux {
            continue;
        }
        let companion = match kind {
            ReleaseAssetKind::Desktop => ReleaseAssetKind::Product,
            ReleaseAssetKind::Product => ReleaseAssetKind::Desktop,
        };
        if !targets.contains(&(companion, platform, architecture)) {
            return Err(SignedManifestError::MissingCompanionAsset {
                kind,
                platform,
                architecture,
            });
        }
    }
    Ok(TrustedReleaseManifest {
        version: wire.version,
        published_at: wire.published_at,
        assets,
        manifest_bytes: Vec::new(),
        signature_text: String::new(),
    })
}

fn validate_release_asset(
    asset: &TrustedReleaseAsset,
    version: &str,
    release_tag: &str,
) -> Result<(), SignedManifestError> {
    if (asset.platform != ReleasePlatform::Macos && asset.architecture != ReleaseArchitecture::X64)
        || (asset.kind == ReleaseAssetKind::Product && asset.platform == ReleasePlatform::Linux)
    {
        return Err(SignedManifestError::UnsupportedTarget {
            platform: asset.platform,
            architecture: asset.architecture,
        });
    }
    let expected_name = match asset.kind {
        ReleaseAssetKind::Desktop => format!(
            "debrute-desktop-{version}-{}-{}.{}",
            asset.platform.as_str(),
            asset.architecture.as_str(),
            asset.platform.extension()
        ),
        ReleaseAssetKind::Product => format!(
            "debrute-product-{version}-{}-{}.zip",
            asset.platform.as_str(),
            asset.architecture.as_str()
        ),
    };
    if asset.name != expected_name {
        return Err(SignedManifestError::InvalidAssetName {
            expected: expected_name,
            actual: asset.name.clone(),
        });
    }
    let expected_url = format!("{GITHUB_RELEASE_ROOT}/{release_tag}/{}", asset.name);
    if asset.url != expected_url {
        return Err(SignedManifestError::InvalidAssetUrl {
            expected: expected_url,
            actual: asset.url.clone(),
        });
    }
    if !is_lower_hex_sha256(&asset.sha256) {
        return Err(SignedManifestError::InvalidAssetSha256(asset.name.clone()));
    }
    if asset.size_bytes == 0 {
        return Err(SignedManifestError::InvalidAssetSize(asset.name.clone()));
    }
    Ok(())
}

pub(crate) fn validate_release_version(version: &str) -> Result<(), ProductManifestError> {
    let parsed = Version::parse(version)
        .map_err(|_| ProductManifestError::InvalidProductVersion(version.to_owned()))?;
    if !parsed.pre.is_empty()
        || !parsed.build.is_empty()
        || version != format!("{}.{}.{}", parsed.major, parsed.minor, parsed.patch)
    {
        return Err(ProductManifestError::InvalidProductVersion(
            version.to_owned(),
        ));
    }
    Ok(())
}

fn validate_product_path(path: &str) -> Result<(), ProductManifestError> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        || path == PRODUCT_MANIFEST_NAME
    {
        return Err(ProductManifestError::InvalidFilePath(path.to_owned()));
    }
    Ok(())
}

pub(crate) fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_utc_millisecond_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        }))
    {
        return false;
    }
    let parsed = decimal(&bytes[0..4])
        .zip(decimal(&bytes[5..7]))
        .zip(decimal(&bytes[8..10]))
        .zip(decimal(&bytes[11..13]))
        .zip(decimal(&bytes[14..16]))
        .zip(decimal(&bytes[17..19]));
    let Some((((((year, month), day), hour), minute), second)) = parsed else {
        return false;
    };
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day) && hour < 24 && minute < 60 && second < 60
}

fn decimal(bytes: &[u8]) -> Option<u32> {
    bytes.iter().try_fold(0_u32, |value, byte| {
        byte.is_ascii_digit()
            .then_some(value * 10 + u32::from(byte - b'0'))
    })
}

fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProductManifestError {
    InvalidSchemaVersion(u32),
    InvalidProduct(String),
    InvalidProductVersion(String),
    IncompatibleControlProtocol { protocol: String, version: u32 },
    EmptyFiles,
    InvalidFilePath(String),
    DuplicateFile(String),
    InvalidFileSize(String),
    InvalidSha256(String),
    MissingComponent(String),
    InvalidEntrypoints,
    MissingEntrypoint(String),
}

impl fmt::Display for ProductManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid product manifest: {self:?}")
    }
}

impl Error for ProductManifestError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignedManifestError {
    InputTooLarge,
    InvalidSignatureEncoding,
    InvalidPublicKey,
    InvalidSignature,
    InvalidJson(String),
    InvalidSchemaVersion(u32),
    InvalidProduct(String),
    ProductManifest(ProductManifestError),
    InvalidReleaseTag {
        expected: String,
        actual: String,
    },
    InvalidPublishedAt(String),
    EmptyAssets,
    DuplicateTarget {
        kind: ReleaseAssetKind,
        platform: ReleasePlatform,
        architecture: ReleaseArchitecture,
    },
    MissingCompanionAsset {
        kind: ReleaseAssetKind,
        platform: ReleasePlatform,
        architecture: ReleaseArchitecture,
    },
    UnsupportedTarget {
        platform: ReleasePlatform,
        architecture: ReleaseArchitecture,
    },
    InvalidAssetName {
        expected: String,
        actual: String,
    },
    InvalidAssetUrl {
        expected: String,
        actual: String,
    },
    InvalidAssetSha256(String),
    InvalidAssetSize(String),
}

impl fmt::Display for SignedManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "untrusted product update manifest: {self:?}")
    }
}

impl Error for SignedManifestError {}
