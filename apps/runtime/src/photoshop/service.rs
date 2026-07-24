use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs::File,
    io::Read as _,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;
use uuid::Uuid;

use crate::project::{
    ProjectCommand, ProjectCommandResult, ProjectPathKind, ProjectSession, ProjectSessionRegistry,
    ProjectUploadEntry, ProjectUse, ProjectUseKind, assert_project_tree_visible_mutation_path,
    join_project_path, normalize_project_directory_path, normalize_project_relative_path,
    open_no_symlink_existing_project_file,
};

use super::{
    NewPhotoshopDownload, NewPhotoshopTransfer, PHOTOSHOP_BRIDGE_MAX_UPLOAD_BYTES,
    PHOTOSHOP_BRIDGE_PROTOCOL_VERSION, PhotoshopBridgeError, PhotoshopBridgeErrorCode,
    PhotoshopBridgeSettingsView, PhotoshopBridgeStateView, PhotoshopClientView,
    PhotoshopDiscoveryStatus, PhotoshopDownloadPlan, PhotoshopHandshakeChallenge,
    PhotoshopHelloMessage, PhotoshopImportDispatch, PhotoshopPairingAuthority,
    PhotoshopPairingCreated, PhotoshopPluginSessionGrant, PhotoshopProjectDirectoryView,
    PhotoshopProjectLinkView, PhotoshopProjectView, PhotoshopRuntimeMessage,
    PhotoshopSessionAdmission, PhotoshopTransferDirection, PhotoshopTransferStore,
    PhotoshopTransferView, PhotoshopUploadResult, RuntimePhotoshopMessage, validate_bounded_text,
    validate_opaque,
};

const CHALLENGE_TTL: Duration = Duration::from_secs(5);
const REPLACEMENT_REDIRECT_WINDOW: Duration = Duration::from_secs(5);
const MAX_CHALLENGES: usize = 64;
const MAX_DOWNLOAD_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_PNG_BASENAME_BYTES: usize = 220;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

struct ChallengeRecord {
    challenge: [u8; 32],
    expires_at: Instant,
}

struct PluginSessionRecord {
    bearer: String,
    client: PhotoshopClientView,
}

struct ProjectLinkRecord {
    view: PhotoshopProjectLinkView,
    _project_use: ProjectUse,
}

struct PhotoshopUploadInput<'a> {
    bearer: &'a str,
    transfer_id: &'a str,
    project_id: &'a str,
    target_directory: &'a str,
    suggested_name: &'a str,
    mime_type: &'a str,
    declared_byte_length: u64,
    content: PhotoshopUploadContent,
}

enum PhotoshopUploadContent {
    Bytes(Vec<u8>),
    TemporaryFile(PathBuf),
}

struct PreparedPhotoshopUpload {
    instance: String,
    transfer_id: String,
    project_id: String,
    session: Arc<ProjectSession>,
    command: ProjectCommand,
}

struct PhotoshopBridgeState {
    enabled: bool,
    discovery_status: PhotoshopDiscoveryStatus,
    challenges: HashMap<String, ChallengeRecord>,
    sessions: HashMap<String, PluginSessionRecord>,
    session_by_instance: HashMap<String, String>,
    session_by_bearer: HashMap<String, String>,
    links: HashMap<(String, String), ProjectLinkRecord>,
    transfers: PhotoshopTransferStore,
}

pub struct PhotoshopBridgeService {
    pairings: Arc<PhotoshopPairingAuthority>,
    projects: ProjectSessionRegistry,
    product_version: String,
    runtime_instance_id: String,
    admission: Mutex<()>,
    state: Mutex<PhotoshopBridgeState>,
    on_change: Arc<dyn Fn() + Send + Sync>,
}

impl PhotoshopBridgeService {
    #[must_use]
    pub fn new(
        pairings: Arc<PhotoshopPairingAuthority>,
        projects: ProjectSessionRegistry,
        product_version: impl Into<String>,
        runtime_instance_id: impl Into<String>,
        enabled: bool,
        discovery_status: PhotoshopDiscoveryStatus,
    ) -> Self {
        Self::with_change_callback(
            pairings,
            projects,
            product_version,
            runtime_instance_id,
            enabled,
            discovery_status,
            Arc::new(|| {}),
        )
    }

    #[must_use]
    pub fn with_change_callback(
        pairings: Arc<PhotoshopPairingAuthority>,
        projects: ProjectSessionRegistry,
        product_version: impl Into<String>,
        runtime_instance_id: impl Into<String>,
        enabled: bool,
        discovery_status: PhotoshopDiscoveryStatus,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            pairings,
            projects,
            product_version: product_version.into(),
            runtime_instance_id: runtime_instance_id.into(),
            admission: Mutex::new(()),
            state: Mutex::new(PhotoshopBridgeState {
                enabled,
                discovery_status,
                challenges: HashMap::new(),
                sessions: HashMap::new(),
                session_by_instance: HashMap::new(),
                session_by_bearer: HashMap::new(),
                links: HashMap::new(),
                transfers: PhotoshopTransferStore::new(),
            }),
            on_change,
        }
    }

    /// Creates a short-lived, one-use WebSocket challenge.
    ///
    /// # Errors
    /// Returns an error when the Bridge is disabled, saturated, or unavailable.
    pub fn begin_handshake(&self) -> Result<PhotoshopHandshakeChallenge, PhotoshopBridgeError> {
        let mut state = self.lock_state()?;
        require_enabled(&state)?;
        prune_challenges(&mut state);
        if state.challenges.len() >= MAX_CHALLENGES {
            return Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::PairingCapacityReached,
                "Photoshop handshake challenge capacity is exhausted.",
            ));
        }
        let challenge = random_bytes::<32>()?;
        let challenge_id = Uuid::new_v4().to_string();
        state.challenges.insert(
            challenge_id.clone(),
            ChallengeRecord {
                challenge,
                expires_at: Instant::now() + CHALLENGE_TTL,
            },
        );
        Ok(PhotoshopHandshakeChallenge {
            challenge_id,
            message: RuntimePhotoshopMessage::BridgeChallenge {
                bridge_version: PHOTOSHOP_BRIDGE_PROTOCOL_VERSION,
                product_version: self.product_version.clone(),
                runtime_instance_id: self.runtime_instance_id.clone(),
                challenge: URL_SAFE_NO_PAD.encode(challenge),
            },
        })
    }

    /// Consumes a challenge, proves the persisted/first-pairing key and creates one live session.
    ///
    /// # Errors
    /// Returns an error for an expired challenge, failed proof, or unavailable state.
    pub fn complete_handshake(
        &self,
        challenge_id: &str,
        hello: &PhotoshopHelloMessage,
    ) -> Result<PhotoshopSessionAdmission, PhotoshopBridgeError> {
        let admission = self.lock_admission()?;
        let challenge = {
            let mut state = self.lock_state()?;
            require_enabled(&state)?;
            prune_challenges(&mut state);
            state.challenges.remove(challenge_id).ok_or_else(|| {
                PhotoshopBridgeError::new(
                    PhotoshopBridgeErrorCode::PairingExpired,
                    "Photoshop handshake challenge expired or was already consumed.",
                )
            })?
        };
        let verified = self.pairings.verify_hello(&challenge.challenge, hello)?;
        let timestamp = now_string()?;
        let session_id = Uuid::new_v4().to_string();
        let bearer = random_token()?;
        let client = PhotoshopClientView {
            plugin_instance_id: verified.plugin_instance_id.clone(),
            host_app: "photoshop",
            host_version: hello.host_version.clone(),
            client_runtime: verified.client_runtime,
            display_name: display_name(hello),
            document_count: hello.document_count,
            active_document_title: hello.active_document_title.clone(),
            connected_at: timestamp.clone(),
            last_seen_at: timestamp,
        };
        let replaced_session_id = {
            let mut state = self.lock_state()?;
            require_enabled(&state)?;
            let replaced = state
                .session_by_instance
                .get(&verified.plugin_instance_id)
                .cloned();
            if let Some(replaced) = &replaced {
                revoke_session(
                    &mut state,
                    replaced,
                    PhotoshopBridgeErrorCode::PluginSessionReplaced,
                );
            }
            state
                .session_by_instance
                .insert(verified.plugin_instance_id.clone(), session_id.clone());
            state
                .session_by_bearer
                .insert(bearer.clone(), session_id.clone());
            state.sessions.insert(
                session_id.clone(),
                PluginSessionRecord {
                    bearer: bearer.clone(),
                    client,
                },
            );
            replaced
        };
        let state = match self.state_for_session(&session_id) {
            Ok(state) => state,
            Err(error) => {
                if let Ok(mut state) = self.state.lock() {
                    revoke_session(
                        &mut state,
                        &session_id,
                        PhotoshopBridgeErrorCode::PluginSessionInvalid,
                    );
                }
                drop(admission);
                (self.on_change)();
                return Err(error);
            }
        };
        drop(admission);
        (self.on_change)();
        Ok(PhotoshopSessionAdmission {
            grant: PhotoshopPluginSessionGrant {
                plugin_session_id: session_id,
                plugin_instance_id: verified.plugin_instance_id,
                bearer,
                state,
            },
            replaced_session_id,
        })
    }

    /// Revokes a still-current plugin session and all authority derived from it.
    ///
    /// # Errors
    /// Returns an error when Bridge state is unavailable.
    pub fn disconnect_session(&self, session_id: &str) -> Result<(), PhotoshopBridgeError> {
        let admission = self.lock_admission()?;
        let changed = {
            let mut state = self.lock_state()?;
            let current = state.sessions.get(session_id).is_some_and(|session| {
                state
                    .session_by_instance
                    .get(&session.client.plugin_instance_id)
                    .is_some_and(|current| current == session_id)
            });
            if current {
                revoke_session(
                    &mut state,
                    session_id,
                    PhotoshopBridgeErrorCode::AdobeClientOffline,
                );
            }
            current
        };
        drop(admission);
        if changed {
            (self.on_change)();
        }
        Ok(())
    }

    /// Creates a browser-session-bound first-pairing code.
    ///
    /// # Errors
    /// Returns an error when disabled, invalid, or at capacity.
    pub fn create_pairing(
        &self,
        browser_session: &str,
    ) -> Result<PhotoshopPairingCreated, PhotoshopBridgeError> {
        let _admission = self.lock_admission()?;
        let state = self.lock_state()?;
        require_enabled(&state)?;
        drop(state);
        self.pairings.create_pairing(browser_session)
    }

    /// Cancels an outstanding code owned by one browser session.
    ///
    /// # Errors
    /// Returns an error for foreign, expired, consumed, or unavailable state.
    pub fn cancel_pairing(
        &self,
        browser_session: &str,
        pairing_id: &str,
    ) -> Result<(), PhotoshopBridgeError> {
        self.pairings.cancel_pairing(browser_session, pairing_id)
    }

    /// Removes a persisted pairing and revokes its live authority.
    ///
    /// # Errors
    /// Returns an error when the pairing is absent or cannot be persisted.
    pub fn remove_pairing(
        &self,
        plugin_instance_id: &str,
    ) -> Result<PhotoshopBridgeStateView, PhotoshopBridgeError> {
        let admission = self.lock_admission()?;
        self.pairings.remove_pairing(plugin_instance_id)?;
        {
            let mut state = self.lock_state()?;
            if let Some(session_id) = state.session_by_instance.get(plugin_instance_id).cloned() {
                revoke_session(
                    &mut state,
                    &session_id,
                    PhotoshopBridgeErrorCode::PairingNotFound,
                );
            }
        }
        drop(admission);
        (self.on_change)();
        self.state()
    }

    /// Changes Bridge availability, revoking all memory authority when disabled.
    ///
    /// # Errors
    /// Returns an error when state or admission authority is unavailable.
    pub fn set_enabled(&self, enabled: bool) -> Result<(), PhotoshopBridgeError> {
        let admission = self.lock_admission()?;
        if !enabled {
            self.pairings.clear_outstanding()?;
        }
        let changed = {
            let mut state = self.lock_state()?;
            if state.enabled == enabled {
                false
            } else {
                state.enabled = enabled;
                if !enabled {
                    state.challenges.clear();
                    state.links.clear();
                    state.transfers.fail_all(
                        PhotoshopBridgeErrorCode::AdobeBridgeDisabled,
                        "Photoshop Bridge was disabled.",
                    );
                    state.sessions.clear();
                    state.session_by_instance.clear();
                    state.session_by_bearer.clear();
                }
                true
            }
        };
        drop(admission);
        if changed {
            (self.on_change)();
        }
        Ok(())
    }

    /// Records whether the optional fixed discovery listener is available.
    ///
    /// # Errors
    /// Returns an error when Bridge state is unavailable.
    pub fn set_discovery_status(
        &self,
        discovery_status: PhotoshopDiscoveryStatus,
    ) -> Result<(), PhotoshopBridgeError> {
        let changed = {
            let mut state = self.lock_state()?;
            if state.discovery_status == discovery_status {
                false
            } else {
                state.discovery_status = discovery_status;
                true
            }
        };
        if changed {
            (self.on_change)();
        }
        Ok(())
    }

    /// Applies one bounded message from the current plugin socket.
    ///
    /// # Errors
    /// Returns an error for a replaced session or invalid message/transfer.
    pub fn update_plugin_message(
        &self,
        session_id: &str,
        message: PhotoshopRuntimeMessage,
    ) -> Result<Option<PhotoshopTransferView>, PhotoshopBridgeError> {
        let result = {
            let mut state = self.lock_state()?;
            let instance = current_instance_for_session(&state, session_id)?.to_owned();
            match message {
                PhotoshopRuntimeMessage::PhotoshopStatus {
                    document_count,
                    active_document_title,
                } => {
                    if document_count > 10_000
                        || active_document_title.as_ref().is_some_and(|title| {
                            title.is_empty() || title.len() > 1024 || title.contains('\0')
                        })
                    {
                        return Err(PhotoshopBridgeError::new(
                            PhotoshopBridgeErrorCode::InvalidTransferPayload,
                            "Photoshop status is outside its bounds.",
                        ));
                    }
                    let timestamp = now_string()?;
                    let session = state
                        .sessions
                        .get_mut(session_id)
                        .ok_or_else(invalid_session)?;
                    session.client.document_count = document_count;
                    session.client.active_document_title = active_document_title;
                    session.client.last_seen_at = timestamp;
                    None
                }
                PhotoshopRuntimeMessage::TransferImportResult {
                    transfer_id,
                    ok,
                    error_code,
                    message,
                } => {
                    validate_opaque(&transfer_id, "transfer id")?;
                    if let Some(message) = &message {
                        validate_bounded_text(message, 2_048, "Photoshop transfer message")?;
                    }
                    Some(state.transfers.complete(
                        &instance,
                        &transfer_id,
                        ok,
                        error_code,
                        message,
                        None,
                    )?)
                }
            }
        };
        (self.on_change)();
        Ok(result)
    }

    /// Links one live paired plugin to one open Project from Workbench authority.
    ///
    /// # Errors
    /// Returns an error when either side is offline or the Project use cannot be acquired.
    pub fn link_project_for_browser(
        &self,
        project_id: &str,
        plugin_instance_id: &str,
    ) -> Result<PhotoshopBridgeStateView, PhotoshopBridgeError> {
        if self.link_project(project_id, plugin_instance_id)? {
            (self.on_change)();
        }
        self.state()
    }

    /// Links the bearer-owning plugin to one open Project.
    ///
    /// # Errors
    /// Returns an error for invalid bearer, offline Project, or Project-use failure.
    pub fn link_project_for_plugin(
        &self,
        bearer: &str,
        project_id: &str,
    ) -> Result<PhotoshopBridgeStateView, PhotoshopBridgeError> {
        let admission = self.lock_admission()?;
        let instance = self.instance_for_bearer(bearer)?;
        let changed = self.link_project(project_id, &instance)?;
        drop(admission);
        if changed {
            (self.on_change)();
        }
        self.state_for_bearer(bearer)
    }

    fn link_project(
        &self,
        project_id: &str,
        plugin_instance_id: &str,
    ) -> Result<bool, PhotoshopBridgeError> {
        validate_opaque(plugin_instance_id, "plugin instance id")?;
        {
            let state = self.lock_state()?;
            require_enabled(&state)?;
            require_live_instance(&state, plugin_instance_id)?;
            if state
                .links
                .contains_key(&(plugin_instance_id.to_owned(), project_id.to_owned()))
            {
                return Ok(false);
            }
        }
        let project_use = self
            .projects
            .acquire_use(project_id, ProjectUseKind::PhotoshopLink)?;
        let link = ProjectLinkRecord {
            view: PhotoshopProjectLinkView {
                link_id: Uuid::new_v4().to_string(),
                project_id: project_id.to_owned(),
                plugin_instance_id: plugin_instance_id.to_owned(),
                created_at: now_string()?,
                status: "active",
            },
            _project_use: project_use,
        };
        {
            let mut state = self.lock_state()?;
            require_enabled(&state)?;
            require_live_instance(&state, plugin_instance_id)?;
            state
                .links
                .entry((plugin_instance_id.to_owned(), project_id.to_owned()))
                .or_insert(link);
        }
        Ok(true)
    }

    /// Releases a browser-selected Project link when it exists.
    ///
    /// # Errors
    /// Returns an error when Bridge or Project state cannot be captured.
    pub fn unlink_project_for_browser(
        &self,
        project_id: &str,
        plugin_instance_id: &str,
    ) -> Result<PhotoshopBridgeStateView, PhotoshopBridgeError> {
        if self.unlink_project(project_id, plugin_instance_id)? {
            (self.on_change)();
        }
        self.state()
    }

    /// Releases a bearer-owned Project link when it exists.
    ///
    /// # Errors
    /// Returns an error for invalid bearer or unavailable state.
    pub fn unlink_project_for_plugin(
        &self,
        bearer: &str,
        project_id: &str,
    ) -> Result<PhotoshopBridgeStateView, PhotoshopBridgeError> {
        let admission = self.lock_admission()?;
        let instance = self.instance_for_bearer(bearer)?;
        let changed = self.unlink_project(project_id, &instance)?;
        drop(admission);
        if changed {
            (self.on_change)();
        }
        self.state_for_bearer(bearer)
    }

    fn unlink_project(
        &self,
        project_id: &str,
        plugin_instance_id: &str,
    ) -> Result<bool, PhotoshopBridgeError> {
        let removed = self
            .lock_state()?
            .links
            .remove(&(plugin_instance_id.to_owned(), project_id.to_owned()));
        Ok(removed.is_some())
    }

    /// Creates a one-use download and import request for a linked Photoshop session.
    ///
    /// # Errors
    /// Returns an error for invalid file, missing link, capacity, or Project I/O.
    pub fn send_project_file(
        &self,
        project_id: &str,
        plugin_instance_id: &str,
        project_relative_path: &str,
        api_base_url: &str,
    ) -> Result<PhotoshopImportDispatch, PhotoshopBridgeError> {
        let admission = self.lock_admission()?;
        let relative = normalize_project_relative_path(project_relative_path)?;
        assert_project_tree_visible_mutation_path(&relative)?;
        let mime_type = photoshop_mime_type(&relative)?;
        let project_use = {
            let state = self.lock_state()?;
            require_transfer_link(&state, project_id, plugin_instance_id)?;
            drop(state);
            self.projects
                .acquire_use(project_id, ProjectUseKind::Transfer)?
        };
        let session = self.projects.get(project_id)?;
        let file = open_no_symlink_existing_project_file(session.root(), &relative)?;
        let byte_length = file.metadata()?.len();
        if byte_length > MAX_DOWNLOAD_BYTES {
            return Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::UploadTooLarge,
                "Project file exceeds the Photoshop transfer limit.",
            ));
        }
        let file_name = Path::new(&relative)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                PhotoshopBridgeError::new(
                    PhotoshopBridgeErrorCode::InvalidTransferPayload,
                    "Photoshop transfer file name is invalid.",
                )
            })?
            .to_owned();
        let transfer_id = Uuid::new_v4().to_string();
        let token = random_token()?;
        let mut base = photoshop_api_base_url(api_base_url)?;
        base.set_path(&format!(
            "/api/adobe-bridge/transfers/{transfer_id}/content"
        ));
        base.set_query(Some(&format!("token={token}")));
        let (session_id, transfer) = {
            let mut state = self.lock_state()?;
            require_transfer_link(&state, project_id, plugin_instance_id)?;
            let session_id = state
                .session_by_instance
                .get(plugin_instance_id)
                .cloned()
                .ok_or_else(client_offline)?;
            let transfer = state.transfers.begin_download(NewPhotoshopDownload {
                transfer: NewPhotoshopTransfer {
                    transfer_id: &transfer_id,
                    direction: PhotoshopTransferDirection::DebruteToPhotoshop,
                    project_id,
                    plugin_instance_id,
                    project_relative_path: Some(relative.clone()),
                    project_use,
                },
                token,
                file,
                byte_length,
                mime_type,
                file_name: file_name.clone(),
            })?;
            (session_id, transfer)
        };
        drop(admission);
        (self.on_change)();
        Ok(PhotoshopImportDispatch {
            plugin_session_id: session_id,
            message: RuntimePhotoshopMessage::TransferImportRequest {
                transfer_id,
                project_id: project_id.to_owned(),
                project_relative_path: relative,
                file_name,
                mime_type: mime_type.to_owned(),
                byte_length,
                download_url: base.into(),
            },
            transfer,
        })
    }

    /// Atomically consumes one bearer- and token-bound download handle.
    ///
    /// # Errors
    /// Returns an error for invalid bearer, token, transfer, or expiry.
    pub fn take_download(
        &self,
        bearer: &str,
        transfer_id: &str,
        token: &str,
    ) -> Result<PhotoshopDownloadPlan, PhotoshopBridgeError> {
        let _admission = self.lock_admission()?;
        validate_opaque(transfer_id, "transfer id")?;
        validate_download_token(token)?;
        let instance = self.instance_for_bearer(bearer)?;
        let mut state = self.lock_state()?;
        let project_id = state
            .transfers
            .active_download_project(&instance, transfer_id)?;
        require_transfer_link(&state, &project_id, &instance)?;
        state.transfers.take_download(&instance, transfer_id, token)
    }

    /// Imports one exact PNG payload through the revisioned Project session.
    ///
    /// # Errors
    /// Returns an error for invalid authority/payload/target or a failed Project mutation.
    #[allow(clippy::too_many_arguments)]
    pub fn import_png(
        &self,
        bearer: &str,
        transfer_id: &str,
        project_id: &str,
        target_directory: &str,
        suggested_name: &str,
        mime_type: &str,
        declared_byte_length: u64,
        content: Vec<u8>,
    ) -> Result<PhotoshopUploadResult, PhotoshopBridgeError> {
        let admission = self.lock_admission()?;
        let prepared = self.prepare_png_import(PhotoshopUploadInput {
            bearer,
            transfer_id,
            project_id,
            target_directory,
            suggested_name,
            mime_type,
            declared_byte_length,
            content: PhotoshopUploadContent::Bytes(content),
        })?;
        let result = self.commit_png_import(prepared);
        drop(admission);
        (self.on_change)();
        result
    }

    /// Imports one already-streamed Runtime-owned PNG file through the
    /// revisioned Project session without buffering the payload in memory.
    ///
    /// # Errors
    /// Returns an error for invalid authority, length, signature, target, or a
    /// failed Project mutation.
    #[allow(clippy::too_many_arguments)]
    pub fn import_png_file(
        &self,
        bearer: &str,
        transfer_id: &str,
        project_id: &str,
        target_directory: &str,
        suggested_name: &str,
        mime_type: &str,
        declared_byte_length: u64,
        temporary_path: PathBuf,
    ) -> Result<PhotoshopUploadResult, PhotoshopBridgeError> {
        let admission = self.lock_admission()?;
        let prepared = self.prepare_png_import(PhotoshopUploadInput {
            bearer,
            transfer_id,
            project_id,
            target_directory,
            suggested_name,
            mime_type,
            declared_byte_length,
            content: PhotoshopUploadContent::TemporaryFile(temporary_path),
        })?;
        let result = self.commit_png_import(prepared);
        drop(admission);
        (self.on_change)();
        result
    }

    fn prepare_png_import(
        &self,
        input: PhotoshopUploadInput<'_>,
    ) -> Result<PreparedPhotoshopUpload, PhotoshopBridgeError> {
        validate_png_upload(&input)?;
        let instance = self.instance_for_bearer(input.bearer)?;
        {
            let state = self.lock_state()?;
            require_transfer_link(&state, input.project_id, &instance)?;
        }
        let target = normalize_project_directory_path(input.target_directory).map_err(|_| {
            PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::InvalidTransferPayload,
                "Photoshop upload target directory is invalid.",
            )
        })?;
        if !target.is_empty() {
            let probe = join_project_path(&target, "__debrute_probe__.png")?;
            assert_project_tree_visible_mutation_path(&probe).map_err(|_| {
                PhotoshopBridgeError::new(
                    PhotoshopBridgeErrorCode::TargetDirectoryNotVisible,
                    "Photoshop upload target directory is not visible.",
                )
            })?;
        }
        let session = self.projects.get(input.project_id)?;
        let snapshot = session.sync_snapshot()?;
        if !target.is_empty()
            && !snapshot.snapshot.files.iter().any(|entry| {
                entry.project_relative_path == target && entry.kind == ProjectPathKind::Directory
            })
        {
            return Err(PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::TargetDirectoryMissing,
                "Photoshop upload target directory does not exist.",
            ));
        }
        let existing = snapshot
            .snapshot
            .files
            .iter()
            .filter_map(|entry| {
                let parent = entry
                    .project_relative_path
                    .rsplit_once('/')
                    .map_or("", |(parent, _)| parent);
                (parent == target).then(|| {
                    entry
                        .project_relative_path
                        .rsplit('/')
                        .next()
                        .unwrap_or_default()
                        .to_owned()
                })
            })
            .collect::<HashSet<_>>();
        let file_name = unique_png_name(&existing, input.suggested_name);
        let relative = join_project_path(&target, &file_name)?;
        assert_project_tree_visible_mutation_path(&relative).map_err(|_| {
            PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::TargetDirectoryNotVisible,
                "Photoshop upload target directory is not visible.",
            )
        })?;
        let project_use = self
            .projects
            .acquire_use(input.project_id, ProjectUseKind::Transfer)?;
        {
            let mut state = self.lock_state()?;
            require_transfer_link(&state, input.project_id, &instance)?;
            state.transfers.begin_upload(NewPhotoshopTransfer {
                transfer_id: input.transfer_id,
                direction: PhotoshopTransferDirection::PhotoshopToDebrute,
                project_id: input.project_id,
                plugin_instance_id: &instance,
                project_relative_path: None,
                project_use,
            })?;
        }
        let upload = match input.content {
            PhotoshopUploadContent::Bytes(content) => ProjectUploadEntry::File {
                project_relative_path: relative.clone(),
                content,
            },
            PhotoshopUploadContent::TemporaryFile(temporary_path) => {
                ProjectUploadEntry::TemporaryFile {
                    project_relative_path: relative.clone(),
                    temporary_path,
                }
            }
        };
        let command = ProjectCommand::ImportUploadEntries {
            entries: vec![upload],
            target_directory: target,
            overwrite: false,
        };
        Ok(PreparedPhotoshopUpload {
            instance,
            transfer_id: input.transfer_id.to_owned(),
            project_id: input.project_id.to_owned(),
            session,
            command,
        })
    }

    fn commit_png_import(
        &self,
        prepared: PreparedPhotoshopUpload,
    ) -> Result<PhotoshopUploadResult, PhotoshopBridgeError> {
        match prepared.session.execute(prepared.command) {
            Ok(result) => {
                let imported = match &result.value {
                    ProjectCommandResult::PathsChanged { results, .. } => results
                        .first()
                        .map(|entry| entry.project_relative_path.clone()),
                    _ => None,
                }
                .ok_or_else(|| {
                    PhotoshopBridgeError::new(
                        PhotoshopBridgeErrorCode::StatePoisoned,
                        "Photoshop upload returned an unexpected Project result.",
                    )
                })?;
                self.lock_state()?.transfers.complete(
                    &prepared.instance,
                    &prepared.transfer_id,
                    true,
                    None,
                    None,
                    Some(imported.clone()),
                )?;
                Ok(PhotoshopUploadResult {
                    transfer_id: prepared.transfer_id,
                    project_id: prepared.project_id,
                    project_revision: result.project_revision,
                    project_relative_path: imported,
                    kind: "file",
                })
            }
            Err(error) => {
                let message = error.to_string();
                let mut state = self.lock_state()?;
                let _ = state.transfers.complete(
                    &prepared.instance,
                    &prepared.transfer_id,
                    false,
                    Some(PhotoshopBridgeErrorCode::PersistenceFailed),
                    Some(message),
                    None,
                );
                drop(state);
                Err(error.into())
            }
        }
    }

    /// Captures the browser-visible Bridge state.
    ///
    /// # Errors
    /// Returns an error when Bridge, pairing, or Project state is unavailable.
    pub fn state(&self) -> Result<PhotoshopBridgeStateView, PhotoshopBridgeError> {
        self.build_state(None)
    }

    /// Captures state scoped to the current socket session.
    ///
    /// # Errors
    /// Returns an error for a replaced session or unavailable state.
    pub fn state_for_session(
        &self,
        session_id: &str,
    ) -> Result<PhotoshopBridgeStateView, PhotoshopBridgeError> {
        let instance = {
            let state = self.lock_state()?;
            current_instance_for_session(&state, session_id)?.to_owned()
        };
        self.build_state(Some(&instance))
    }

    /// Captures state scoped to the bearer-owning plugin.
    ///
    /// # Errors
    /// Returns an error for an invalid bearer or unavailable state.
    pub fn state_for_bearer(
        &self,
        bearer: &str,
    ) -> Result<PhotoshopBridgeStateView, PhotoshopBridgeError> {
        let _admission = self.lock_admission()?;
        let instance = self.instance_for_bearer(bearer)?;
        self.build_state(Some(&instance))
    }

    fn build_state(
        &self,
        filter_instance: Option<&str>,
    ) -> Result<PhotoshopBridgeStateView, PhotoshopBridgeError> {
        let (settings, clients, links, transfers, connected, linked_projects) = {
            let state = self.lock_state()?;
            let settings = PhotoshopBridgeSettingsView {
                enabled: state.enabled,
                discovery_status: if state.enabled {
                    state.discovery_status
                } else {
                    PhotoshopDiscoveryStatus::Disabled
                },
            };
            let mut clients = state
                .sessions
                .values()
                .filter(|session| {
                    filter_instance
                        .is_none_or(|instance| session.client.plugin_instance_id == instance)
                })
                .map(|session| session.client.clone())
                .collect::<Vec<_>>();
            clients.sort_by(|left, right| left.plugin_instance_id.cmp(&right.plugin_instance_id));
            let mut links = state
                .links
                .values()
                .filter(|link| {
                    filter_instance.is_none_or(|instance| link.view.plugin_instance_id == instance)
                })
                .map(|link| link.view.clone())
                .collect::<Vec<_>>();
            links.sort_by(|left, right| {
                left.project_id
                    .cmp(&right.project_id)
                    .then_with(|| left.plugin_instance_id.cmp(&right.plugin_instance_id))
            });
            let transfers = state
                .transfers
                .views()
                .into_iter()
                .filter(|transfer| {
                    filter_instance.is_none_or(|instance| transfer.plugin_instance_id == instance)
                })
                .collect::<Vec<_>>();
            let connected = state.session_by_instance.keys().cloned().collect();
            let linked_projects = links
                .iter()
                .map(|link| link.project_id.clone())
                .collect::<BTreeSet<_>>();
            (
                settings,
                clients,
                links,
                transfers,
                connected,
                linked_projects,
            )
        };
        let mut paired_plugins = self.pairings.pairing_views(&connected)?;
        if let Some(instance) = filter_instance {
            paired_plugins.retain(|pairing| pairing.plugin_instance_id == instance);
        }
        let mut projects = Vec::new();
        for summary in self.projects.list()? {
            let session = match self.projects.get(&summary.project_id) {
                Ok(session) => session,
                Err(error) if matches!(error.code(), "project_not_open" | "project_not_found") => {
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            let snapshot = session.sync_snapshot()?;
            let directories =
                if filter_instance.is_none() || linked_projects.contains(&summary.project_id) {
                    project_directories(&snapshot.snapshot.files)
                } else {
                    Vec::new()
                };
            projects.push(PhotoshopProjectView {
                project_id: summary.project_id,
                project_name: summary.project_name,
                project_revision: snapshot.project_revision,
                directories,
            });
        }
        Ok(PhotoshopBridgeStateView {
            settings,
            paired_plugins,
            clients,
            projects,
            links,
            transfers,
        })
    }

    fn instance_for_bearer(&self, bearer: &str) -> Result<String, PhotoshopBridgeError> {
        validate_session_token(bearer)?;
        let state = self.lock_state()?;
        require_enabled(&state)?;
        let session_id = state
            .session_by_bearer
            .get(bearer)
            .ok_or_else(invalid_session)?;
        current_instance_for_session(&state, session_id).map(str::to_owned)
    }

    /// Builds the bounded rediscovery notice used only for planned replacement.
    ///
    /// # Errors
    /// Returns an error for invalid replacement identity or time formatting.
    pub fn planned_replacement_message(
        &self,
        replacement_runtime_instance_id: &str,
    ) -> Result<RuntimePhotoshopMessage, PhotoshopBridgeError> {
        validate_opaque(replacement_runtime_instance_id, "runtime instance id")?;
        Ok(RuntimePhotoshopMessage::RuntimeReplacing {
            runtime_instance_id: replacement_runtime_instance_id.to_owned(),
            deadline: (OffsetDateTime::now_utc() + REPLACEMENT_REDIRECT_WINDOW)
                .format(&Rfc3339)
                .map_err(|error| {
                    PhotoshopBridgeError::new(
                        PhotoshopBridgeErrorCode::PersistenceFailed,
                        error.to_string(),
                    )
                })?,
        })
    }

    /// Applies transfer deadlines and releases timed-out Project uses.
    ///
    /// # Errors
    /// Returns an error when Bridge state is unavailable.
    pub fn expire_due_transfers(&self) -> Result<(), PhotoshopBridgeError> {
        let changed = self.lock_state()?.transfers.expire_due();
        if changed {
            (self.on_change)();
        }
        Ok(())
    }

    /// Returns the wait until the next active transfer deadline.
    ///
    /// # Errors
    /// Returns an error when Bridge state is unavailable.
    pub fn next_transfer_expiry(&self) -> Result<Option<Duration>, PhotoshopBridgeError> {
        Ok(self
            .lock_state()?
            .transfers
            .next_deadline()
            .map(|deadline| deadline.saturating_duration_since(Instant::now())))
    }

    #[cfg(test)]
    pub(crate) fn expire_transfers_for_test(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.transfers.expire_all_for_test();
        }
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, PhotoshopBridgeState>, PhotoshopBridgeError> {
        self.state.lock().map_err(|_| {
            PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::StatePoisoned,
                "Photoshop Bridge state is poisoned.",
            )
        })
    }

    fn lock_admission(&self) -> Result<MutexGuard<'_, ()>, PhotoshopBridgeError> {
        self.admission.lock().map_err(|_| {
            PhotoshopBridgeError::new(
                PhotoshopBridgeErrorCode::StatePoisoned,
                "Photoshop Bridge admission state is poisoned.",
            )
        })
    }
}

fn require_enabled(state: &PhotoshopBridgeState) -> Result<(), PhotoshopBridgeError> {
    if state.enabled {
        Ok(())
    } else {
        Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::AdobeBridgeDisabled,
            "Photoshop Bridge is disabled.",
        ))
    }
}

fn require_live_instance(
    state: &PhotoshopBridgeState,
    instance: &str,
) -> Result<(), PhotoshopBridgeError> {
    if state.session_by_instance.contains_key(instance) {
        Ok(())
    } else {
        Err(client_offline())
    }
}

fn require_transfer_link(
    state: &PhotoshopBridgeState,
    project_id: &str,
    instance: &str,
) -> Result<(), PhotoshopBridgeError> {
    require_enabled(state)?;
    require_live_instance(state, instance)?;
    if state
        .links
        .contains_key(&(instance.to_owned(), project_id.to_owned()))
    {
        Ok(())
    } else {
        Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::ProjectNotLinked,
            "Photoshop is not linked to this Debrute Project.",
        ))
    }
}

fn current_instance_for_session<'a>(
    state: &'a PhotoshopBridgeState,
    session_id: &str,
) -> Result<&'a str, PhotoshopBridgeError> {
    let session = state.sessions.get(session_id).ok_or_else(invalid_session)?;
    if state
        .session_by_instance
        .get(&session.client.plugin_instance_id)
        .is_some_and(|current| current == session_id)
    {
        Ok(&session.client.plugin_instance_id)
    } else {
        Err(invalid_session())
    }
}

fn revoke_session(
    state: &mut PhotoshopBridgeState,
    session_id: &str,
    failure_code: PhotoshopBridgeErrorCode,
) {
    let Some(session) = state.sessions.remove(session_id) else {
        return;
    };
    state.session_by_bearer.remove(&session.bearer);
    if state
        .session_by_instance
        .get(&session.client.plugin_instance_id)
        .is_some_and(|current| current == session_id)
    {
        state
            .session_by_instance
            .remove(&session.client.plugin_instance_id);
    }
    state
        .links
        .retain(|(instance, _), _| instance != &session.client.plugin_instance_id);
    state.transfers.fail_for_plugin(
        &session.client.plugin_instance_id,
        failure_code,
        "Photoshop plugin session ended.",
    );
}

fn prune_challenges(state: &mut PhotoshopBridgeState) {
    let now = Instant::now();
    state
        .challenges
        .retain(|_, challenge| challenge.expires_at > now);
}

fn project_directories(
    files: &[crate::project::ProjectFileEntry],
) -> Vec<PhotoshopProjectDirectoryView> {
    let mut directories = files
        .iter()
        .filter(|entry| {
            entry.kind == ProjectPathKind::Directory
                && assert_project_tree_visible_mutation_path(&format!(
                    "{}/__debrute_probe__.png",
                    entry.project_relative_path
                ))
                .is_ok()
        })
        .filter_map(|entry| {
            let name = entry.project_relative_path.rsplit('/').next()?.to_owned();
            Some(PhotoshopProjectDirectoryView {
                depth: entry.project_relative_path.matches('/').count() + 1,
                project_relative_path: entry.project_relative_path.clone(),
                name,
            })
        })
        .collect::<Vec<_>>();
    directories.sort_by(|left, right| left.project_relative_path.cmp(&right.project_relative_path));
    directories
}

fn display_name(hello: &PhotoshopHelloMessage) -> String {
    hello.active_document_title.as_ref().map_or_else(
        || format!("Photoshop {}", hello.host_version),
        |title| format!("Photoshop {} · {title}", hello.host_version),
    )
}

fn photoshop_mime_type(path: &str) -> Result<&'static str, PhotoshopBridgeError> {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => Ok("image/png"),
        Some("jpg" | "jpeg") => Ok("image/jpeg"),
        Some("webp") => Ok("image/webp"),
        Some("psd") => Ok("image/vnd.adobe.photoshop"),
        _ => Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::UnsupportedFileType,
            "Project file type is not supported by Photoshop Bridge.",
        )),
    }
}

fn photoshop_api_base_url(value: &str) -> Result<Url, PhotoshopBridgeError> {
    let url = Url::parse(value).map_err(|_| invalid_api_base_url())?;
    let host = url
        .host_str()
        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
        .filter(std::net::IpAddr::is_loopback);
    if url.scheme() != "http"
        || host.is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_api_base_url());
    }
    Ok(url)
}

fn invalid_api_base_url() -> PhotoshopBridgeError {
    PhotoshopBridgeError::new(
        PhotoshopBridgeErrorCode::InvalidTransferPayload,
        "Photoshop transfer API base URL must be a credential-free numeric loopback HTTP origin.",
    )
}

fn validate_png_upload(input: &PhotoshopUploadInput<'_>) -> Result<(), PhotoshopBridgeError> {
    validate_opaque(input.transfer_id, "transfer id")?;
    validate_bounded_text(input.suggested_name, 512, "Photoshop suggested name")?;
    if input.mime_type != "image/png" || input.declared_byte_length == 0 {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::InvalidTransferPayload,
            "Photoshop upload must be a non-empty image/png payload.",
        ));
    }
    let (actual_byte_length, valid_signature) = match &input.content {
        PhotoshopUploadContent::Bytes(content) => (
            u64::try_from(content.len()).unwrap_or(u64::MAX),
            content.starts_with(PNG_SIGNATURE),
        ),
        PhotoshopUploadContent::TemporaryFile(path) => {
            let mut file = File::open(path)?;
            let metadata = file.metadata()?;
            let mut signature = [0_u8; PNG_SIGNATURE.len()];
            let signature_valid =
                file.read_exact(&mut signature).is_ok() && &signature == PNG_SIGNATURE;
            (metadata.len(), signature_valid)
        }
    };
    if input.declared_byte_length > PHOTOSHOP_BRIDGE_MAX_UPLOAD_BYTES as u64
        || actual_byte_length > PHOTOSHOP_BRIDGE_MAX_UPLOAD_BYTES as u64
    {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::UploadTooLarge,
            "Photoshop upload exceeds 100 MiB.",
        ));
    }
    if input.declared_byte_length != actual_byte_length || !valid_signature {
        return Err(PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::InvalidTransferPayload,
            "Photoshop upload length or PNG signature is invalid.",
        ));
    }
    Ok(())
}

fn unique_png_name(existing: &HashSet<String>, suggested: &str) -> String {
    let without_extension = suggested
        .rsplit_once('.')
        .map_or(suggested, |(stem, _)| stem);
    let mut sanitized = without_extension
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches('.')
        .trim()
        .to_owned();
    if sanitized.is_empty() {
        "Photoshop Layer".clone_into(&mut sanitized);
    }
    truncate_utf8_bytes(&mut sanitized, MAX_PNG_BASENAME_BYTES);
    let first = format!("{sanitized}.png");
    if !existing.contains(&first) {
        return first;
    }
    for index in 2_u64.. {
        let candidate = format!("{sanitized} {index}.png");
        if !existing.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn truncate_utf8_bytes(value: &mut String, maximum_bytes: usize) {
    if value.len() <= maximum_bytes {
        return;
    }
    let mut boundary = maximum_bytes;
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    value.truncate(boundary);
    while value.ends_with(' ') || value.ends_with('.') {
        value.pop();
    }
    if value.is_empty() {
        "Photoshop Layer".clone_into(value);
    }
}

fn random_token() -> Result<String, PhotoshopBridgeError> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes::<32>()?))
}

fn validate_session_token(value: &str) -> Result<(), PhotoshopBridgeError> {
    if value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Ok(())
    } else {
        Err(invalid_session())
    }
}

fn validate_download_token(value: &str) -> Result<(), PhotoshopBridgeError> {
    validate_session_token(value).map_err(|_| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::TransferUrlExpired,
            "Photoshop transfer URL expired.",
        )
    })
}

fn random_bytes<const N: usize>() -> Result<[u8; N], PhotoshopBridgeError> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|error| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PersistenceFailed,
            format!("Unable to create Photoshop Bridge authority: {error}"),
        )
    })?;
    Ok(bytes)
}

fn now_string() -> Result<String, PhotoshopBridgeError> {
    OffsetDateTime::now_utc().format(&Rfc3339).map_err(|error| {
        PhotoshopBridgeError::new(
            PhotoshopBridgeErrorCode::PersistenceFailed,
            error.to_string(),
        )
    })
}

fn invalid_session() -> PhotoshopBridgeError {
    PhotoshopBridgeError::new(
        PhotoshopBridgeErrorCode::PluginSessionInvalid,
        "Photoshop plugin session is invalid or was replaced.",
    )
}

fn client_offline() -> PhotoshopBridgeError {
    PhotoshopBridgeError::new(
        PhotoshopBridgeErrorCode::AdobeClientOffline,
        "Photoshop is offline.",
    )
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Read as _, path::PathBuf};

    use p256::ecdsa::{Signature, SigningKey, signature::Signer as _};

    use crate::{
        project::{
            CanvasFeedbackArtifacts, DefaultProjectNodeAdapter, MediaToolPaths,
            ProjectPreviewService, ProjectUseKind,
        },
        workers::RuntimeWorkerServices,
    };

    use super::*;

    struct TemporaryDirectory(PathBuf);

    impl TemporaryDirectory {
        fn new(label: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("debrute-photoshop-{label}-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl AsRef<Path> for TemporaryDirectory {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn feedback_artifacts() -> Arc<CanvasFeedbackArtifacts> {
        let workers = RuntimeWorkerServices::new();
        let previews = Arc::new(ProjectPreviewService::new(
            &workers,
            MediaToolPaths::unavailable(),
        ));
        Arc::new(CanvasFeedbackArtifacts::new(previews).unwrap())
    }

    fn signing_key() -> SigningKey {
        loop {
            let bytes = random_bytes::<32>().unwrap();
            if let Ok(key) = SigningKey::from_bytes((&bytes).into()) {
                return key;
            }
        }
    }

    struct Fixture {
        _home: TemporaryDirectory,
        project: TemporaryDirectory,
        registry: ProjectSessionRegistry,
        service: PhotoshopBridgeService,
    }

    fn fixture() -> Fixture {
        let home = TemporaryDirectory::new("home");
        let project = TemporaryDirectory::new("project");
        fs::write(project.as_ref().join("source.png"), b"source-png").unwrap();
        let registry = ProjectSessionRegistry::new(
            home.as_ref(),
            Arc::new(DefaultProjectNodeAdapter),
            feedback_artifacts(),
        );
        let pairings = Arc::new(PhotoshopPairingAuthority::open(home.as_ref()).unwrap());
        let service = PhotoshopBridgeService::new(
            pairings,
            registry.clone(),
            "1.2.3",
            "runtime-1",
            true,
            PhotoshopDiscoveryStatus::Available,
        );
        Fixture {
            _home: home,
            project,
            registry,
            service,
        }
    }

    fn hello(
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
            client_runtime: super::super::PhotoshopClientRuntime::Uxp,
            document_count: 1,
            active_document_title: Some("Poster.psd".to_owned()),
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            public_key: code.as_ref().map(|_| {
                URL_SAFE_NO_PAD.encode(key.verifying_key().to_encoded_point(false).as_bytes())
            }),
            pairing_code: code,
        }
    }

    fn connect(
        service: &PhotoshopBridgeService,
        key: &SigningKey,
        instance: &str,
        code: Option<String>,
    ) -> PhotoshopSessionAdmission {
        let challenge = service.begin_handshake().unwrap();
        let RuntimePhotoshopMessage::BridgeChallenge {
            challenge: value, ..
        } = challenge.message
        else {
            panic!("expected challenge");
        };
        let bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(value).unwrap().try_into().unwrap();
        service
            .complete_handshake(&challenge.challenge_id, &hello(key, instance, &bytes, code))
            .unwrap()
    }

    fn png_fixture() -> Vec<u8> {
        [PNG_SIGNATURE.as_slice(), b"fixture"].concat()
    }

    #[test]
    fn replacing_a_live_session_revokes_old_bearer_links_and_project_uses() {
        let fixture = fixture();
        let key = signing_key();
        let code = fixture.service.create_pairing("browser-1").unwrap().code;
        let first = connect(&fixture.service, &key, "plugin-1", Some(code));
        let opened = fixture
            .registry
            .open_project(fixture.project.as_ref(), ProjectUseKind::Operation)
            .unwrap();
        let project_id = opened.session.project_id().to_owned();
        fixture
            .service
            .link_project_for_browser(&project_id, "plugin-1")
            .unwrap();
        drop(opened);
        assert!(fixture.registry.get(&project_id).is_ok());

        let replacement = connect(&fixture.service, &key, "plugin-1", None);
        assert_eq!(
            replacement.replaced_session_id.as_deref(),
            Some(first.grant.plugin_session_id.as_str())
        );
        assert_eq!(
            fixture
                .service
                .state_for_bearer(&first.grant.bearer)
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::PluginSessionInvalid
        );
        assert!(fixture.service.state().unwrap().links.is_empty());
        assert!(fixture.registry.get(&project_id).is_err());
        fixture
            .service
            .disconnect_session(&first.grant.plugin_session_id)
            .unwrap();
        assert!(
            fixture
                .service
                .state_for_bearer(&replacement.grant.bearer)
                .is_ok()
        );
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn linked_transfer_download_is_one_use_upload_is_revisioned_and_timeout_is_terminal() {
        let fixture = fixture();
        let key = signing_key();
        let code = fixture.service.create_pairing("browser-1").unwrap().code;
        let connected = connect(&fixture.service, &key, "plugin-1", Some(code));
        let opened = fixture
            .registry
            .open_project(fixture.project.as_ref(), ProjectUseKind::Operation)
            .unwrap();
        let project_id = opened.session.project_id().to_owned();
        fixture
            .service
            .link_project_for_browser(&project_id, "plugin-1")
            .unwrap();
        let dispatch = fixture
            .service
            .send_project_file(
                &project_id,
                "plugin-1",
                "source.png",
                "http://127.0.0.1:4567/api",
            )
            .unwrap();
        let RuntimePhotoshopMessage::TransferImportRequest {
            transfer_id,
            download_url,
            ..
        } = dispatch.message
        else {
            panic!("expected transfer request");
        };
        let url = Url::parse(&download_url).unwrap();
        let token = url
            .query_pairs()
            .find(|(name, _)| name == "token")
            .unwrap()
            .1
            .into_owned();
        let mut plan = fixture
            .service
            .take_download(&connected.grant.bearer, &transfer_id, &token)
            .unwrap();
        let mut bytes = Vec::new();
        plan.file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"source-png");
        assert_eq!(
            fixture
                .service
                .take_download(&connected.grant.bearer, &transfer_id, &token)
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::TransferUrlExpired
        );
        fixture
            .service
            .update_plugin_message(
                &connected.grant.plugin_session_id,
                PhotoshopRuntimeMessage::TransferImportResult {
                    transfer_id,
                    ok: true,
                    error_code: None,
                    message: None,
                },
            )
            .unwrap();

        let png = png_fixture();
        let imported = fixture
            .service
            .import_png(
                &connected.grant.bearer,
                "upload-1",
                &project_id,
                "",
                "Layer.png",
                "image/png",
                u64::try_from(png.len()).unwrap(),
                png.clone(),
            )
            .unwrap();
        assert_eq!(imported.project_relative_path, "Layer.png");
        assert_eq!(
            fs::read(fixture.project.as_ref().join("Layer.png")).unwrap(),
            png
        );

        let timed = fixture
            .service
            .send_project_file(
                &project_id,
                "plugin-1",
                "source.png",
                "http://127.0.0.1:4567/api",
            )
            .unwrap();
        let timed_id = timed.transfer.transfer_id;
        fixture.service.expire_transfers_for_test();
        let transfer = fixture
            .service
            .state()
            .unwrap()
            .transfers
            .into_iter()
            .find(|transfer| transfer.transfer_id == timed_id)
            .unwrap();
        assert_eq!(
            transfer.status,
            super::super::PhotoshopTransferStatus::Failed
        );
        assert_eq!(
            transfer.error_code,
            Some(PhotoshopBridgeErrorCode::TransferTimeout)
        );
    }

    #[test]
    fn disabling_revokes_sessions_and_replacement_is_only_a_bounded_notice() {
        let fixture = fixture();
        let key = signing_key();
        let code = fixture.service.create_pairing("browser-1").unwrap().code;
        let connected = connect(&fixture.service, &key, "plugin-1", Some(code));
        let notice = fixture
            .service
            .planned_replacement_message("runtime-2")
            .unwrap();
        assert!(matches!(
            notice,
            RuntimePhotoshopMessage::RuntimeReplacing {
                runtime_instance_id,
                ..
            } if runtime_instance_id == "runtime-2"
        ));
        fixture.service.set_enabled(false).unwrap();
        assert_eq!(
            fixture
                .service
                .state_for_bearer(&connected.grant.bearer)
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::AdobeBridgeDisabled
        );
        assert_eq!(
            fixture.service.state().unwrap().settings.discovery_status,
            PhotoshopDiscoveryStatus::Disabled
        );
    }

    #[test]
    fn disabling_consumes_outstanding_pairing_codes() {
        let fixture = fixture();
        let key = signing_key();
        let code = fixture.service.create_pairing("browser-1").unwrap().code;
        fixture.service.set_enabled(false).unwrap();
        fixture.service.set_enabled(true).unwrap();
        let challenge = fixture.service.begin_handshake().unwrap();
        let RuntimePhotoshopMessage::BridgeChallenge {
            challenge: value, ..
        } = challenge.message
        else {
            panic!("expected challenge");
        };
        let bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(value).unwrap().try_into().unwrap();
        assert_eq!(
            fixture
                .service
                .complete_handshake(
                    &challenge.challenge_id,
                    &hello(&key, "plugin-1", &bytes, Some(code)),
                )
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::PairingCodeInvalid
        );
    }

    #[test]
    fn plugin_state_lists_open_projects_but_exposes_only_linked_directories() {
        let fixture = fixture();
        let other_project = TemporaryDirectory::new("other-project");
        fs::create_dir(fixture.project.as_ref().join("linked-assets")).unwrap();
        fs::create_dir(other_project.as_ref().join("private-assets")).unwrap();
        let first = fixture
            .registry
            .open_project(fixture.project.as_ref(), ProjectUseKind::Operation)
            .unwrap();
        let second = fixture
            .registry
            .open_project(other_project.as_ref(), ProjectUseKind::Operation)
            .unwrap();
        let first_id = first.session.project_id().to_owned();
        let second_id = second.session.project_id().to_owned();
        let key = signing_key();
        let code = fixture.service.create_pairing("browser-1").unwrap().code;
        let connected = connect(&fixture.service, &key, "plugin-1", Some(code));
        fixture
            .service
            .link_project_for_plugin(&connected.grant.bearer, &first_id)
            .unwrap();

        let state = fixture
            .service
            .state_for_bearer(&connected.grant.bearer)
            .unwrap();
        assert_eq!(state.projects.len(), 2);
        assert!(
            state
                .projects
                .iter()
                .find(|project| project.project_id == first_id)
                .is_some_and(|project| project
                    .directories
                    .iter()
                    .any(|directory| { directory.project_relative_path == "linked-assets" }))
        );
        assert!(
            state
                .projects
                .iter()
                .find(|project| project.project_id == second_id)
                .is_some_and(|project| project.directories.is_empty())
        );
    }

    #[test]
    fn transfer_boundaries_reject_external_origins_spoofed_png_and_unbounded_messages() {
        let fixture = fixture();
        let key = signing_key();
        let code = fixture.service.create_pairing("browser-1").unwrap().code;
        let connected = connect(&fixture.service, &key, "plugin-1", Some(code));
        let opened = fixture
            .registry
            .open_project(fixture.project.as_ref(), ProjectUseKind::Operation)
            .unwrap();
        let project_id = opened.session.project_id().to_owned();
        fixture
            .service
            .link_project_for_browser(&project_id, "plugin-1")
            .unwrap();

        assert_eq!(
            fixture
                .service
                .send_project_file(
                    &project_id,
                    "plugin-1",
                    "source.png",
                    "https://example.com/api",
                )
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::InvalidTransferPayload
        );
        assert_eq!(
            fixture
                .service
                .import_png(
                    &connected.grant.bearer,
                    "upload-bad",
                    &project_id,
                    "",
                    "Layer.png",
                    "image/png",
                    8,
                    b"not-png!".to_vec(),
                )
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::InvalidTransferPayload
        );
        assert_eq!(
            fixture
                .service
                .state_for_bearer("not-a-session-token")
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::PluginSessionInvalid
        );

        let dispatch = fixture
            .service
            .send_project_file(
                &project_id,
                "plugin-1",
                "source.png",
                "http://127.0.0.1:4567/api",
            )
            .unwrap();
        let transfer_id = dispatch.transfer.transfer_id.clone();
        let RuntimePhotoshopMessage::TransferImportRequest { download_url, .. } = dispatch.message
        else {
            panic!("expected transfer request");
        };
        let token = Url::parse(&download_url)
            .unwrap()
            .query_pairs()
            .find(|(name, _)| name == "token")
            .unwrap()
            .1
            .into_owned();
        assert_eq!(
            fixture
                .service
                .update_plugin_message(
                    &connected.grant.plugin_session_id,
                    PhotoshopRuntimeMessage::TransferImportResult {
                        transfer_id: transfer_id.clone(),
                        ok: false,
                        error_code: None,
                        message: Some("x".repeat(2_049)),
                    },
                )
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::InvalidTransferPayload
        );
        fixture
            .service
            .unlink_project_for_plugin(&connected.grant.bearer, &project_id)
            .unwrap();
        assert_eq!(
            fixture
                .service
                .take_download(&connected.grant.bearer, &transfer_id, &token)
                .unwrap_err()
                .code(),
            PhotoshopBridgeErrorCode::ProjectNotLinked
        );
    }
}
