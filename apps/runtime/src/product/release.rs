use std::{
    error::Error,
    fmt, fs,
    io::{self, Read as _, Write as _},
    path::{Path, PathBuf},
    time::Duration,
};

use reqwest::{StatusCode, blocking::Client};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use url::Url;
use uuid::Uuid;

use super::{TrustedReleaseAsset, TrustedReleaseManifest, verify_official_signed_release_manifest};

const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/xiitang/debrute/releases/latest";
const MANIFEST_NAME: &str = "debrute-update-manifest.json";
const SIGNATURE_NAME: &str = "debrute-update-manifest.json.sig";
const MANIFEST_MAX_BYTES: usize = 256 * 1024;
const SIGNATURE_MAX_BYTES: usize = 8 * 1024;
const LATEST_METADATA_MAX_BYTES: usize = 1024 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

pub trait ProductReleaseSource: Send + Sync {
    /// Locates and authenticates the newest official release, if one exists.
    ///
    /// # Errors
    ///
    /// Returns [`ProductReleaseError`] for transport, size, signature, or
    /// closed-manifest contract failures.
    fn latest(&self) -> Result<Option<TrustedReleaseManifest>, ProductReleaseError>;

    /// Downloads exactly one signed release asset into a private directory.
    ///
    /// # Errors
    ///
    /// Returns [`ProductReleaseError`] when the response does not match the
    /// signed size and SHA-256 or cannot be persisted safely.
    fn download(
        &self,
        asset: &TrustedReleaseAsset,
        directory: &Path,
    ) -> Result<PathBuf, ProductReleaseError>;
}

pub struct GitHubProductReleaseSource {
    client: Client,
}

impl GitHubProductReleaseSource {
    /// Builds the fixed official GitHub release client.
    ///
    /// # Errors
    ///
    /// Returns [`ProductReleaseError`] if the bounded HTTPS client cannot be
    /// constructed.
    pub fn new() -> Result<Self, ProductReleaseError> {
        let client = Client::builder()
            .timeout(HTTP_TIMEOUT)
            .user_agent("Debrute-Runtime-Updater")
            .build()
            .map_err(ProductReleaseError::Http)?;
        Ok(Self { client })
    }

    fn download_small(
        &self,
        url: &str,
        limit: usize,
        label: &'static str,
    ) -> Result<Vec<u8>, ProductReleaseError> {
        validate_github_download_url(url, label)?;
        let response = self
            .client
            .get(url)
            .send()
            .map_err(ProductReleaseError::Http)?;
        if !response.status().is_success() {
            return Err(ProductReleaseError::HttpStatus {
                label,
                status: response.status(),
            });
        }
        if response
            .content_length()
            .is_some_and(|content_length| content_length > limit as u64)
        {
            return Err(ProductReleaseError::InputTooLarge(label));
        }
        let mut bytes = Vec::new();
        response.take((limit + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(ProductReleaseError::InputTooLarge(label));
        }
        Ok(bytes)
    }
}

impl ProductReleaseSource for GitHubProductReleaseSource {
    fn latest(&self) -> Result<Option<TrustedReleaseManifest>, ProductReleaseError> {
        let response = self
            .client
            .get(LATEST_RELEASE_URL)
            .send()
            .map_err(ProductReleaseError::Http)?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(ProductReleaseError::HttpStatus {
                label: "latest release",
                status: response.status(),
            });
        }
        if response
            .content_length()
            .is_some_and(|length| length > LATEST_METADATA_MAX_BYTES as u64)
        {
            return Err(ProductReleaseError::InputTooLarge("latest release"));
        }
        let mut bytes = Vec::new();
        response
            .take((LATEST_METADATA_MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > LATEST_METADATA_MAX_BYTES {
            return Err(ProductReleaseError::InputTooLarge("latest release"));
        }
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|_| ProductReleaseError::InvalidGitHubResponse)?;
        let assets = body
            .as_object()
            .and_then(|object| object.get("assets"))
            .and_then(Value::as_array)
            .ok_or(ProductReleaseError::InvalidGitHubResponse)?;
        let manifest_url = named_asset_url(assets, MANIFEST_NAME)?;
        let signature_url = named_asset_url(assets, SIGNATURE_NAME)?;
        let manifest = self.download_small(&manifest_url, MANIFEST_MAX_BYTES, MANIFEST_NAME)?;
        let signature = self.download_small(&signature_url, SIGNATURE_MAX_BYTES, SIGNATURE_NAME)?;
        let signature = std::str::from_utf8(&signature)
            .map_err(|_| ProductReleaseError::InvalidSignatureText)?;
        verify_official_signed_release_manifest(&manifest, signature)
            .map(Some)
            .map_err(|error| ProductReleaseError::InvalidManifest(error.to_string()))
    }

    fn download(
        &self,
        asset: &TrustedReleaseAsset,
        directory: &Path,
    ) -> Result<PathBuf, ProductReleaseError> {
        validate_github_download_url(asset.url(), "release asset")?;
        fs::create_dir_all(directory)?;
        let temporary = directory.join(format!(".download-{}", Uuid::new_v4()));
        let destination = directory.join(asset.name());
        let result = (|| {
            let mut response = self
                .client
                .get(asset.url())
                .send()
                .map_err(ProductReleaseError::Http)?;
            if !response.status().is_success() {
                return Err(ProductReleaseError::HttpStatus {
                    label: "release asset",
                    status: response.status(),
                });
            }
            if response
                .content_length()
                .is_some_and(|length| length != asset.size_bytes())
            {
                return Err(ProductReleaseError::AssetSizeMismatch(
                    asset.name().to_owned(),
                ));
            }
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            let mut digest = Sha256::new();
            let mut size = 0_u64;
            let mut buffer = vec![0_u8; 64 * 1024];
            loop {
                let count = response.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                size = size.checked_add(count as u64).ok_or_else(|| {
                    ProductReleaseError::AssetSizeMismatch(asset.name().to_owned())
                })?;
                if size > asset.size_bytes() {
                    return Err(ProductReleaseError::AssetSizeMismatch(
                        asset.name().to_owned(),
                    ));
                }
                digest.update(&buffer[..count]);
                output.write_all(&buffer[..count])?;
            }
            output.sync_all()?;
            if size != asset.size_bytes() {
                return Err(ProductReleaseError::AssetSizeMismatch(
                    asset.name().to_owned(),
                ));
            }
            if format!("{:x}", digest.finalize()) != asset.sha256() {
                return Err(ProductReleaseError::AssetDigestMismatch(
                    asset.name().to_owned(),
                ));
            }
            fs::rename(&temporary, &destination)?;
            Ok(destination.clone())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

fn named_asset_url(assets: &[Value], name: &'static str) -> Result<String, ProductReleaseError> {
    let matches = assets
        .iter()
        .filter_map(Value::as_object)
        .filter(|asset| asset.get("name").and_then(Value::as_str) == Some(name))
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(ProductReleaseError::MissingOrDuplicateAsset(name));
    }
    matches[0]
        .get("browser_download_url")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
        .ok_or(ProductReleaseError::InvalidGitHubResponse)
}

fn validate_github_download_url(url: &str, label: &'static str) -> Result<(), ProductReleaseError> {
    let parsed = Url::parse(url).map_err(|_| ProductReleaseError::InvalidDownloadUrl(label))?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed
            .path()
            .starts_with("/xiitang/debrute/releases/download/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ProductReleaseError::InvalidDownloadUrl(label));
    }
    Ok(())
}

#[derive(Debug)]
pub enum ProductReleaseError {
    Http(reqwest::Error),
    Io(io::Error),
    HttpStatus {
        label: &'static str,
        status: StatusCode,
    },
    InvalidGitHubResponse,
    MissingOrDuplicateAsset(&'static str),
    InvalidDownloadUrl(&'static str),
    InputTooLarge(&'static str),
    InvalidSignatureText,
    InvalidManifest(String),
    AssetSizeMismatch(String),
    AssetDigestMismatch(String),
}

impl fmt::Display for ProductReleaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Product release transport failed: {self:?}")
    }
}

impl Error for ProductReleaseError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Http(error) => Some(error),
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for ProductReleaseError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn release_metadata_accepts_only_the_fixed_github_download_namespace() {
        assert!(validate_github_download_url(
            "https://github.com/xiitang/debrute/releases/download/v0.0.4/debrute-update-manifest.json",
            "manifest"
        )
        .is_ok());
        for url in [
            "http://github.com/xiitang/debrute/releases/download/v0.0.4/debrute-update-manifest.json",
            "https://example.com/xiitang/debrute/releases/download/v0.0.4/debrute-update-manifest.json",
            "https://github.com/another/debrute/releases/download/v0.0.4/debrute-update-manifest.json",
            "https://github.com/xiitang/debrute/releases/download/v0.0.4/debrute-update-manifest.json?raw=1",
        ] {
            assert!(validate_github_download_url(url, "manifest").is_err());
        }
    }

    #[test]
    fn github_asset_lookup_rejects_missing_and_duplicate_manifest_names() {
        let asset = json!({
            "name": MANIFEST_NAME,
            "browser_download_url": "https://github.com/xiitang/debrute/releases/download/v0.0.4/debrute-update-manifest.json"
        });
        assert!(named_asset_url(&[], MANIFEST_NAME).is_err());
        assert!(named_asset_url(&[asset.clone(), asset], MANIFEST_NAME).is_err());
    }
}
