use std::{
    collections::BTreeSet,
    fs,
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::project::replace_file;

use super::{
    PairedPhotoshopPluginView, PhotoshopBridgeError, PhotoshopBridgeErrorCode,
    PhotoshopClientRuntime, PhotoshopHelloMessage, PhotoshopPairingCreated,
};

const PAIRING_CODE_TTL: Duration = Duration::from_mins(5);
const PAIRING_CODE_ATTEMPT_LIMIT: u8 = 5;
const MAX_OUTSTANDING_PAIRINGS: usize = 32;
const MAX_PERSISTED_PAIRINGS: usize = 128;
const MAX_PAIRING_REGISTRY_BYTES: u64 = 1024 * 1024;
const PAIRING_CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingRegistry {
    pairings: Vec<PersistedPairing>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedPairing {
    plugin_instance_id: String,
    client_runtime: PhotoshopClientRuntime,
    public_key: String,
    created_at: String,
}

#[derive(Debug, Clone)]
struct OutstandingPairing {
    pairing_id: String,
    browser_session: String,
    code_tag: String,
    code_hash: [u8; 32],
    expires_at: OffsetDateTime,
    failed_attempts: u8,
}

struct PairingState {
    registry: PairingRegistry,
    outstanding: Vec<OutstandingPairing>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedPhotoshopPairing {
    pub plugin_instance_id: String,
    pub client_runtime: PhotoshopClientRuntime,
    pub created_at: String,
    pub first_pairing: bool,
}

/// Persisted public-key registry plus memory-only first-pairing codes.
pub struct PhotoshopPairingAuthority {
    registry_path: PathBuf,
    state: Mutex<PairingState>,
}

impl PhotoshopPairingAuthority {
    /// Opens and fully validates the pairing registry.
    ///
    /// # Errors
    /// Returns a persistence or closed-registry error for unreadable state.
    pub fn open(debrute_home: impl AsRef<Path>) -> Result<Self, PhotoshopBridgeError> {
        let registry_path = debrute_home
            .as_ref()
            .join("config")
            .join("photoshop_bridge_pairings.json");
        let registry = read_registry(&registry_path)?;
        validate_registry(&registry)?;
        Ok(Self {
            registry_path,
            state: Mutex::new(PairingState {
                registry,
                outstanding: Vec::new(),
            }),
        })
    }

    /// Creates one browser-session-bound, one-use pairing code.
    ///
    /// # Errors
    /// Returns an error for invalid session identity, randomness failure, or capacity.
    pub fn create_pairing(
        &self,
        browser_session: &str,
    ) -> Result<PhotoshopPairingCreated, PhotoshopBridgeError> {
        self.create_pairing_at(browser_session, OffsetDateTime::now_utc())
    }

    fn create_pairing_at(
        &self,
        browser_session: &str,
        now: OffsetDateTime,
    ) -> Result<PhotoshopPairingCreated, PhotoshopBridgeError> {
        validate_opaque(browser_session, "browser session")?;
        let mut state = self.lock();
        prune_expired(&mut state.outstanding, now);
        state
            .outstanding
            .retain(|entry| entry.browser_session != browser_session);
        if state.outstanding.len() >= MAX_OUTSTANDING_PAIRINGS {
            return Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::PairingCapacityReached,
                "Photoshop pairing code capacity is exhausted.",
            ));
        }
        let code = unique_pairing_code(&state.outstanding)?;
        let expires_at = now + PAIRING_CODE_TTL;
        let pairing_id = Uuid::new_v4().to_string();
        push_outstanding_pairing(
            &mut state.outstanding,
            OutstandingPairing {
                pairing_id: pairing_id.clone(),
                browser_session: browser_session.to_owned(),
                code_tag: code[..4].to_owned(),
                code_hash: sha256(code.as_bytes()),
                expires_at,
                failed_attempts: 0,
            },
        );
        Ok(PhotoshopPairingCreated {
            pairing_id,
            code: grouped_code(&code),
            expires_at: format_time(expires_at)?,
        })
    }

    /// Cancels one outstanding code only for the browser session that created it.
    ///
    /// # Errors
    /// Returns `pairing_not_found` for expired, consumed, foreign, or stale ids.
    pub fn cancel_pairing(
        &self,
        browser_session: &str,
        pairing_id: &str,
    ) -> Result<(), PhotoshopBridgeError> {
        self.cancel_pairing_at(browser_session, pairing_id, OffsetDateTime::now_utc())
    }

    fn cancel_pairing_at(
        &self,
        browser_session: &str,
        pairing_id: &str,
        now: OffsetDateTime,
    ) -> Result<(), PhotoshopBridgeError> {
        validate_opaque(browser_session, "browser session")?;
        validate_opaque(pairing_id, "pairing id")?;
        let mut state = self.lock();
        prune_expired(&mut state.outstanding, now);
        let before = state.outstanding.len();
        state.outstanding.retain(|entry| {
            entry.pairing_id != pairing_id || entry.browser_session != browser_session
        });
        if state.outstanding.len() == before {
            return Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::PairingNotFound,
                "Photoshop pairing code was not found.",
            ));
        }
        Ok(())
    }

    /// Verifies one fresh challenge and consumes first-pairing authority when used.
    ///
    /// # Errors
    /// Returns a closed pairing, key, signature, expiry, or persistence error.
    pub(crate) fn verify_hello(
        &self,
        challenge: &[u8; 32],
        hello: &PhotoshopHelloMessage,
    ) -> Result<VerifiedPhotoshopPairing, PhotoshopBridgeError> {
        self.verify_hello_at(challenge, hello, OffsetDateTime::now_utc())
    }

    fn verify_hello_at(
        &self,
        challenge: &[u8; 32],
        hello: &PhotoshopHelloMessage,
        now: OffsetDateTime,
    ) -> Result<VerifiedPhotoshopPairing, PhotoshopBridgeError> {
        validate_hello_identity(hello)?;
        let mut state = self.lock();
        if let Some(pairing) = state
            .registry
            .pairings
            .iter()
            .find(|pairing| pairing.plugin_instance_id == hello.plugin_instance_id)
            .cloned()
        {
            return verify_existing_pairing(pairing, challenge, hello);
        }
        verify_first_pairing(&self.registry_path, &mut state, challenge, hello, now)
    }

    /// Removes one persisted public key. The caller owns live-session/link revocation.
    ///
    /// # Errors
    /// Returns an error when the id is absent or persistence fails.
    pub(crate) fn remove_pairing(
        &self,
        plugin_instance_id: &str,
    ) -> Result<(), PhotoshopBridgeError> {
        validate_opaque(plugin_instance_id, "plugin instance id")?;
        let mut state = self.lock();
        let mut next = state.registry.clone();
        let before = next.pairings.len();
        next.pairings
            .retain(|entry| entry.plugin_instance_id != plugin_instance_id);
        if next.pairings.len() == before {
            return Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::PairingNotFound,
                "Photoshop plugin pairing was not found.",
            ));
        }
        write_registry(&self.registry_path, &next)?;
        state.registry = next;
        Ok(())
    }

    pub(crate) fn clear_outstanding(&self) {
        self.lock().outstanding.clear();
    }

    pub(crate) fn pairing_views(
        &self,
        connected: &BTreeSet<String>,
    ) -> Vec<PairedPhotoshopPluginView> {
        let state = self.lock();
        state
            .registry
            .pairings
            .iter()
            .map(|pairing| PairedPhotoshopPluginView {
                plugin_instance_id: pairing.plugin_instance_id.clone(),
                client_runtime: pairing.client_runtime,
                created_at: pairing.created_at.clone(),
                connected: connected.contains(&pairing.plugin_instance_id),
            })
            .collect()
    }

    fn lock(&self) -> MutexGuard<'_, PairingState> {
        self.state
            .lock()
            .expect("Photoshop pairing state lock poisoned")
    }
}

fn verify_existing_pairing(
    pairing: PersistedPairing,
    challenge: &[u8; 32],
    hello: &PhotoshopHelloMessage,
) -> Result<VerifiedPhotoshopPairing, PhotoshopBridgeError> {
    if hello.public_key.is_some() || hello.pairing_code.is_some() {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingKeyInvalid,
            "An already-paired Photoshop plugin must prove its persisted key.",
        ));
    }
    if pairing.client_runtime != hello.client_runtime {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingKeyInvalid,
            "Photoshop plugin runtime does not match its pairing.",
        ));
    }
    verify_signature(
        &pairing.public_key,
        &hello.plugin_instance_id,
        challenge,
        &hello.signature,
    )?;
    Ok(VerifiedPhotoshopPairing {
        plugin_instance_id: pairing.plugin_instance_id,
        client_runtime: pairing.client_runtime,
        created_at: pairing.created_at,
        first_pairing: false,
    })
}

fn verify_first_pairing(
    registry_path: &Path,
    state: &mut PairingState,
    challenge: &[u8; 32],
    hello: &PhotoshopHelloMessage,
    now: OffsetDateTime,
) -> Result<VerifiedPhotoshopPairing, PhotoshopBridgeError> {
    let public_key = hello.public_key.as_deref().ok_or_else(|| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingKeyInvalid,
            "First Photoshop pairing requires a P-256 public key.",
        )
    })?;
    verify_signature(
        public_key,
        &hello.plugin_instance_id,
        challenge,
        &hello.signature,
    )?;
    let code = normalize_code(hello.pairing_code.as_deref().unwrap_or_default())?;
    let Some(index) = state
        .outstanding
        .iter()
        .position(|entry| entry.code_tag == code[..4])
    else {
        return Err(invalid_pairing_code());
    };
    verify_pairing_code(&mut state.outstanding, index, &code, now)?;
    if state.registry.pairings.len() >= MAX_PERSISTED_PAIRINGS {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingCapacityReached,
            "Photoshop pairing registry is full.",
        ));
    }
    let created_at = format_time(now)?;
    let persisted = PersistedPairing {
        plugin_instance_id: hello.plugin_instance_id.clone(),
        client_runtime: hello.client_runtime,
        public_key: normalize_public_key(public_key)?,
        created_at: created_at.clone(),
    };
    let mut next = state.registry.clone();
    next.pairings.push(persisted.clone());
    next.pairings
        .sort_by(|left, right| left.plugin_instance_id.cmp(&right.plugin_instance_id));
    write_registry(registry_path, &next)?;
    state.registry = next;
    state.outstanding.remove(index);
    Ok(VerifiedPhotoshopPairing {
        plugin_instance_id: persisted.plugin_instance_id,
        client_runtime: persisted.client_runtime,
        created_at,
        first_pairing: true,
    })
}

fn verify_pairing_code(
    outstanding: &mut Vec<OutstandingPairing>,
    index: usize,
    code: &str,
    now: OffsetDateTime,
) -> Result<(), PhotoshopBridgeError> {
    if outstanding[index].expires_at <= now {
        outstanding.remove(index);
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingExpired,
            "Photoshop pairing code expired.",
        ));
    }
    if constant_time_equal(&outstanding[index].code_hash, &sha256(code.as_bytes())) {
        return Ok(());
    }
    outstanding[index].failed_attempts = outstanding[index].failed_attempts.saturating_add(1);
    if outstanding[index].failed_attempts >= PAIRING_CODE_ATTEMPT_LIMIT {
        outstanding.remove(index);
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingAttemptsExceeded,
            "Photoshop pairing code exceeded its attempt limit.",
        ));
    }
    Err(invalid_pairing_code())
}

fn invalid_pairing_code() -> PhotoshopBridgeError {
    PhotoshopBridgeError::new(
        PhotoshopBridgeErrorCode::PairingCodeInvalid,
        "Photoshop pairing code is invalid.",
    )
}

fn validate_hello_identity(hello: &PhotoshopHelloMessage) -> Result<(), PhotoshopBridgeError> {
    validate_opaque(&hello.plugin_instance_id, "plugin instance id")?;
    if hello.host_app != "photoshop" {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingKeyInvalid,
            "Photoshop Bridge accepts only the fixed photoshop host identity.",
        ));
    }
    validate_bounded_text(&hello.host_version, 64, "Photoshop host version")?;
    if hello.document_count > 10_000 {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::InvalidTransferPayload,
            "Photoshop document count is outside its bound.",
        ));
    }
    if let Some(title) = &hello.active_document_title {
        validate_bounded_text(title, 1024, "Photoshop document title")?;
    }
    Ok(())
}

pub(crate) fn validate_opaque(value: &str, label: &str) -> Result<(), PhotoshopBridgeError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
    {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::InvalidTransferPayload,
            format!("{label} is invalid."),
        ));
    }
    Ok(())
}

pub(crate) fn validate_bounded_text(
    value: &str,
    maximum_bytes: usize,
    label: &str,
) -> Result<(), PhotoshopBridgeError> {
    if value.trim().is_empty() || value.len() > maximum_bytes || value.contains('\0') {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::InvalidTransferPayload,
            format!("{label} is invalid."),
        ));
    }
    Ok(())
}

fn verify_signature(
    public_key: &str,
    plugin_instance_id: &str,
    challenge: &[u8; 32],
    signature: &str,
) -> Result<(), PhotoshopBridgeError> {
    let public_key = decode_public_key(public_key)?;
    let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingSignatureInvalid,
            "Photoshop pairing signature is not base64url.",
        )
    })?;
    let signature = Signature::from_slice(&signature).map_err(|_| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingSignatureInvalid,
            "Photoshop pairing signature must be a 64-byte P1363 value.",
        )
    })?;
    let mut transcript = Vec::with_capacity(20 + plugin_instance_id.len() + challenge.len());
    transcript.extend_from_slice(b"debrute-bridge-v1\0");
    transcript.extend_from_slice(plugin_instance_id.as_bytes());
    transcript.push(0);
    transcript.extend_from_slice(challenge);
    public_key.verify(&transcript, &signature).map_err(|_| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingSignatureInvalid,
            "Photoshop pairing challenge signature is invalid.",
        )
    })
}

fn normalize_public_key(value: &str) -> Result<String, PhotoshopBridgeError> {
    let key = URL_SAFE_NO_PAD.decode(value).map_err(|_| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingKeyInvalid,
            "Photoshop pairing public key is not base64url.",
        )
    })?;
    if key.len() != 65 || key.first() != Some(&4) {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingKeyInvalid,
            "Photoshop pairing public key must be an uncompressed P-256 point.",
        ));
    }
    VerifyingKey::from_sec1_bytes(&key).map_err(|_| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingKeyInvalid,
            "Photoshop pairing public key is not a valid P-256 point.",
        )
    })?;
    Ok(URL_SAFE_NO_PAD.encode(key))
}

fn decode_public_key(value: &str) -> Result<VerifyingKey, PhotoshopBridgeError> {
    let normalized = normalize_public_key(value)?;
    let bytes = URL_SAFE_NO_PAD.decode(normalized).map_err(|_| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingKeyInvalid,
            "Photoshop pairing public key is invalid.",
        )
    })?;
    VerifyingKey::from_sec1_bytes(&bytes).map_err(|_| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingKeyInvalid,
            "Photoshop pairing public key is invalid.",
        )
    })
}

fn unique_pairing_code(outstanding: &[OutstandingPairing]) -> Result<String, PhotoshopBridgeError> {
    for _ in 0..32 {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).map_err(|error| {
            PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::PersistenceFailed,
                format!("Unable to create Photoshop pairing code: {error}"),
            )
        })?;
        let code = random
            .iter()
            .map(|byte| char::from(PAIRING_CODE_ALPHABET[usize::from(*byte & 31)]))
            .collect::<String>();
        if outstanding.iter().all(|entry| entry.code_tag != code[..4]) {
            return Ok(code);
        }
    }
    Err(PhotoshopBridgeError::new(
        PhotoshopBridgeErrorCode::PairingCapacityReached,
        "Unable to allocate a unique Photoshop pairing code.",
    ))
}

fn normalize_code(value: &str) -> Result<String, PhotoshopBridgeError> {
    let normalized = value
        .bytes()
        .filter(|byte| !matches!(byte, b'-' | b' '))
        .map(|byte| byte.to_ascii_uppercase())
        .collect::<Vec<_>>();
    if normalized.len() != 12
        || !normalized
            .iter()
            .all(|byte| PAIRING_CODE_ALPHABET.contains(byte))
    {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingCodeInvalid,
            "Photoshop pairing code must contain twelve base32 characters.",
        ));
    }
    String::from_utf8(normalized).map_err(|_| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PairingCodeInvalid,
            "Photoshop pairing code is invalid.",
        )
    })
}

fn grouped_code(code: &str) -> String {
    format!("{}-{}-{}", &code[..4], &code[4..8], &code[8..12])
}

fn prune_expired(outstanding: &mut Vec<OutstandingPairing>, now: OffsetDateTime) {
    outstanding.retain(|entry| entry.expires_at > now);
}

fn push_outstanding_pairing(
    outstanding: &mut Vec<OutstandingPairing>,
    pairing: OutstandingPairing,
) {
    assert!(
        !outstanding
            .iter()
            .any(|existing| existing.pairing_id == pairing.pairing_id),
        "Runtime-generated Photoshop pairing id must be unique"
    );
    outstanding.push(pairing);
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn constant_time_equal(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn format_time(value: OffsetDateTime) -> Result<String, PhotoshopBridgeError> {
    value.format(&Rfc3339).map_err(|error| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PersistenceFailed,
            error.to_string(),
        )
    })
}

fn read_registry(path: &Path) -> Result<PairingRegistry, PhotoshopBridgeError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::PairingRegistryInvalid,
                "Photoshop pairing registry must be a regular file.",
            ))
        }
        Ok(metadata) if metadata.len() > MAX_PAIRING_REGISTRY_BYTES => {
            Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::PairingRegistryInvalid,
                "Photoshop pairing registry exceeds its size limit.",
            ))
        }
        Ok(_) => Ok(serde_json::from_slice(&fs::read(path)?)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(PairingRegistry::default()),
        Err(error) => Err(error.into()),
    }
}

fn validate_registry(registry: &PairingRegistry) -> Result<(), PhotoshopBridgeError> {
    if registry.pairings.len() > MAX_PERSISTED_PAIRINGS {
        return invalid_registry("Photoshop pairing registry is too large.");
    }
    let mut ids = BTreeSet::new();
    for pairing in &registry.pairings {
        validate_opaque(&pairing.plugin_instance_id, "plugin instance id").map_err(|_| {
            PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::PairingRegistryInvalid,
                "Photoshop pairing registry contains an invalid plugin instance id.",
            )
        })?;
        if !ids.insert(&pairing.plugin_instance_id) {
            return invalid_registry("Photoshop pairing registry contains duplicate instances.");
        }
        normalize_public_key(&pairing.public_key).map_err(|_| {
            PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::PairingRegistryInvalid,
                "Photoshop pairing registry contains an invalid public key.",
            )
        })?;
        OffsetDateTime::parse(&pairing.created_at, &Rfc3339).map_err(|_| {
            PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::PairingRegistryInvalid,
                "Photoshop pairing registry contains an invalid timestamp.",
            )
        })?;
    }
    Ok(())
}

fn invalid_registry<T>(message: &str) -> Result<T, PhotoshopBridgeError> {
    Err(PhotoshopBridgeError::new(
        PhotoshopBridgeErrorCode::PairingRegistryInvalid,
        message,
    ))
}

fn write_registry(path: &Path, registry: &PairingRegistry) -> Result<(), PhotoshopBridgeError> {
    validate_registry(registry)?;
    let directory = path.parent().ok_or_else(|| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PersistenceFailed,
            "Photoshop pairing registry has no parent directory.",
        )
    })?;
    fs::create_dir_all(directory)?;
    set_directory_permissions(directory)?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut bytes = serde_json::to_vec_pretty(registry)?;
    bytes.push(b'\n');
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        set_secret_permissions(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        replace_file(&temporary, path)?;
        Ok::<(), PhotoshopBridgeError>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn set_directory_permissions(path: &Path) -> Result<(), PhotoshopBridgeError> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_directory_permissions(_path: &Path) -> Result<(), PhotoshopBridgeError> {
    Ok(())
}

#[cfg(unix)]
fn set_secret_permissions(path: &Path) -> Result<(), PhotoshopBridgeError> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_secret_permissions(_path: &Path) -> Result<(), PhotoshopBridgeError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use p256::ecdsa::{SigningKey, signature::Signer as _};

    use super::*;

    fn fixture() -> (PathBuf, PhotoshopPairingAuthority) {
        let root = std::env::temp_dir().join(format!("debrute-pairing-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let authority = PhotoshopPairingAuthority::open(&root).unwrap();
        (root, authority)
    }

    fn signing_key() -> SigningKey {
        loop {
            let mut bytes = [0_u8; 32];
            getrandom::fill(&mut bytes).unwrap();
            if let Ok(key) = SigningKey::from_bytes((&bytes).into()) {
                return key;
            }
        }
    }

    fn signed_hello(
        key: &SigningKey,
        instance: &str,
        challenge: &[u8; 32],
        code: Option<String>,
    ) -> PhotoshopHelloMessage {
        let mut transcript = b"debrute-bridge-v1\0".to_vec();
        transcript.extend_from_slice(instance.as_bytes());
        transcript.push(0);
        transcript.extend_from_slice(challenge);
        let signature: Signature = key.sign(&transcript);
        PhotoshopHelloMessage {
            message_type: super::super::PhotoshopHelloMessageType::Hello,
            plugin_instance_id: instance.to_owned(),
            host_app: "photoshop".to_owned(),
            host_version: "27.0".to_owned(),
            client_runtime: PhotoshopClientRuntime::Uxp,
            document_count: 1,
            active_document_title: Some("Poster.psd".to_owned()),
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            public_key: code.as_ref().map(|_| {
                URL_SAFE_NO_PAD.encode(key.verifying_key().to_encoded_point(false).as_bytes())
            }),
            pairing_code: code,
        }
    }

    #[test]
    fn first_pairing_is_browser_bound_one_use_and_persists_only_the_public_key() {
        let (root, authority) = fixture();
        let created = authority.create_pairing("browser-1").unwrap();
        let challenge = [7_u8; 32];
        let key = signing_key();
        let hello = signed_hello(&key, "plugin-1", &challenge, Some(created.code.clone()));
        let verified = authority.verify_hello(&challenge, &hello).unwrap();
        assert!(verified.first_pairing);
        assert_eq!(verified.plugin_instance_id, "plugin-1");
        assert_eq!(
            authority
                .verify_hello(&challenge, &hello)
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::PairingKeyInvalid
        );

        let persisted =
            fs::read_to_string(root.join("config/photoshop_bridge_pairings.json")).unwrap();
        assert!(persisted.contains("plugin-1"));
        assert!(!persisted.contains(&created.code));
        drop(authority);
        let reopened = PhotoshopPairingAuthority::open(&root).unwrap();
        let reconnect = signed_hello(&key, "plugin-1", &challenge, None);
        assert!(
            !reopened
                .verify_hello(&challenge, &reconnect)
                .unwrap()
                .first_pairing
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacing_and_cancelling_codes_are_scoped_to_the_browser_session() {
        let (root, authority) = fixture();
        let first = authority.create_pairing("browser-1").unwrap();
        let replacement = authority.create_pairing("browser-1").unwrap();
        let other = authority.create_pairing("browser-2").unwrap();
        assert_eq!(
            authority
                .cancel_pairing("browser-1", &first.pairing_id)
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::PairingNotFound
        );
        assert_eq!(
            authority
                .cancel_pairing("browser-2", &replacement.pairing_id)
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::PairingNotFound
        );
        authority
            .cancel_pairing("browser-1", &replacement.pairing_id)
            .unwrap();
        authority
            .cancel_pairing("browser-2", &other.pairing_id)
            .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn addressed_wrong_codes_are_destroyed_after_five_attempts() {
        let (root, authority) = fixture();
        let created = authority.create_pairing("browser-1").unwrap();
        let canonical = normalize_code(&created.code).unwrap();
        let replacement = if canonical.ends_with('A') { 'B' } else { 'A' };
        let wrong = format!("{}{}{}", &canonical[..4], &canonical[4..11], replacement);
        let challenge = [9_u8; 32];
        let key = signing_key();
        for attempt in 1..=5 {
            let hello = signed_hello(&key, "plugin-1", &challenge, Some(wrong.clone()));
            let error = authority.verify_hello(&challenge, &hello).unwrap_err();
            assert_eq!(
                error.code(),
                if attempt == 5 {
                    PhotoshopBridgeErrorCode::PairingAttemptsExceeded
                } else {
                    PhotoshopBridgeErrorCode::PairingCodeInvalid
                }
            );
        }
        let hello = signed_hello(&key, "plugin-1", &challenge, Some(created.code));
        assert_eq!(
            authority
                .verify_hello(&challenge, &hello)
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::PairingCodeInvalid
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expired_codes_and_invalid_challenge_signatures_are_terminal() {
        let (root, authority) = fixture();
        let now = OffsetDateTime::from_unix_timestamp(20_000 * 86_400).unwrap();
        let created = authority.create_pairing_at("browser-1", now).unwrap();
        let challenge = [3_u8; 32];
        let key = signing_key();
        let expired = signed_hello(&key, "plugin-1", &challenge, Some(created.code.clone()));
        assert_eq!(
            authority
                .verify_hello_at(&challenge, &expired, now + PAIRING_CODE_TTL)
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::PairingExpired
        );

        let replacement = authority.create_pairing_at("browser-1", now).unwrap();
        let signed_for_another_challenge =
            signed_hello(&key, "plugin-1", &[4_u8; 32], Some(replacement.code));
        assert_eq!(
            authority
                .verify_hello_at(&challenge, &signed_for_another_challenge, now)
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::PairingSignatureInvalid
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn poisoned_pairing_state_panics_instead_of_becoming_an_operational_error() {
        let (root, authority) = fixture();
        std::thread::scope(|scope| {
            assert!(
                scope
                    .spawn(|| {
                        let _state = authority.state.lock().unwrap();
                        panic!("poison pairing state");
                    })
                    .join()
                    .is_err()
            );
        });

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            authority.pairing_views(&BTreeSet::new())
        }));
        assert!(
            result.is_err(),
            "authoritative lock poisoning must remain an unexpected panic"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_runtime_pairing_id_panics() {
        let pairing = OutstandingPairing {
            pairing_id: "pairing-1".to_owned(),
            browser_session: "browser-1".to_owned(),
            code_tag: "ABCD".to_owned(),
            code_hash: [1; 32],
            expires_at: OffsetDateTime::now_utc() + PAIRING_CODE_TTL,
            failed_attempts: 0,
        };
        let mut outstanding = Vec::new();
        push_outstanding_pairing(&mut outstanding, pairing.clone());

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            push_outstanding_pairing(&mut outstanding, pairing);
        }));
        assert!(
            result.is_err(),
            "a duplicate Runtime-generated pairing id must panic"
        );
    }
}
