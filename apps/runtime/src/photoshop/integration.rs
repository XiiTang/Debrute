use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{self, Read as _, Seek as _, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::{
    control::{RuntimeControlState, RuntimeWorkPermit},
    project::{
        CanonicalProjectRoot, ProjectCommand, ProjectCommandResult, ProjectDirectoryPath,
        ProjectError, ProjectPathKind, ProjectSessionRegistry, ProjectSessionSummary,
        ProjectUploadEntry, ProjectUse, ProjectUseKind, assert_project_tree_visible_path,
        is_project_visible_path, list_project_directory, open_no_symlink_existing_project_file,
        resolve_no_symlink_existing_project_path, resolve_project_path,
    },
};

use super::{
    PHOTOSHOP_MAX_BATCH_BYTES, PHOTOSHOP_MAX_BATCH_ITEMS, PHOTOSHOP_MAX_FILE_BYTES,
    PhotoshopDocumentView, PhotoshopError, PhotoshopErrorCode, PhotoshopExportItem,
    PhotoshopExportResult, PhotoshopIntegrationStatus, PhotoshopMimeType, PhotoshopProjectView,
    PhotoshopSendResult, PhotoshopSessionView, PhotoshopStateView, PhotoshopUploadResult,
    PluginPhotoshopMessage, RuntimePhotoshopMessage,
};

type PhotoshopStateObserver = Arc<dyn Fn(PhotoshopStateView) + Send + Sync>;

struct Session {
    bearer: String,
    host_version: String,
    placement_mime_types: Vec<PhotoshopMimeType>,
    documents: Vec<PhotoshopDocumentView>,
    sender: mpsc::Sender<RuntimePhotoshopMessage>,
    active_command: Option<String>,
}

enum Command {
    Place(PlaceCommand),
    Export(ExportCommand),
}

struct PlaceCommand {
    session_id: String,
    staged_path: PathBuf,
    byte_length: u64,
    completion: oneshot::Sender<Result<(), PhotoshopError>>,
    _project_use: ProjectUse,
    _product_work: RuntimeWorkPermit,
}

struct ExportCommand {
    session_id: String,
    canonical_root: CanonicalProjectRoot,
    project_revision: u64,
    directory: String,
    items: HashMap<String, String>,
    consumed_items: HashSet<String>,
    successful_items: HashMap<String, String>,
    uploaded_bytes: u64,
    upload_in_progress: bool,
    _project_use: ProjectUse,
    _product_work: RuntimeWorkPermit,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum GatewayAvailability {
    #[default]
    Unchecked,
    Unavailable,
    Available,
}

#[derive(Default)]
struct State {
    enabled: bool,
    gateway_availability: GatewayAvailability,
    sessions: HashMap<String, Session>,
    bearer_sessions: HashMap<String, String>,
    commands: HashMap<String, Command>,
}

#[derive(Debug)]
pub(crate) enum PhotoshopEnableMutationError<E> {
    TransferActive,
    Persist(E),
}

pub struct PhotoshopSessionAdmission {
    pub plugin_session_id: String,
    pub ready: RuntimePhotoshopMessage,
    pub projects: RuntimePhotoshopMessage,
}

pub struct PhotoshopContent {
    pub bytes: Vec<u8>,
    pub byte_length: u64,
}

pub struct PhotoshopIntegration {
    runtime_instance_id: String,
    runtime_state: Arc<RuntimeControlState>,
    projects: ProjectSessionRegistry,
    // Orders the complete persistence-through-gateway settlement transition.
    lifecycle_mutation: Mutex<()>,
    // Linearizes enablement with session and transfer admission, then releases
    // before the gateway worker is joined.
    admission: Mutex<()>,
    state: Mutex<State>,
    observer: PhotoshopStateObserver,
}

impl PhotoshopIntegration {
    #[must_use]
    pub fn new(
        runtime_instance_id: String,
        runtime_state: Arc<RuntimeControlState>,
        projects: ProjectSessionRegistry,
        observer: PhotoshopStateObserver,
    ) -> Self {
        Self {
            runtime_instance_id,
            runtime_state,
            projects,
            lifecycle_mutation: Mutex::new(()),
            admission: Mutex::new(()),
            state: Mutex::new(State::default()),
            observer,
        }
    }

    pub(crate) fn mutate_enabled<T, E>(
        &self,
        enabled: bool,
        persist: impl FnOnce() -> Result<T, E>,
        settle_lifecycle: impl FnOnce(),
    ) -> Result<(T, bool), PhotoshopEnableMutationError<E>> {
        let _lifecycle_mutation = self.lock_lifecycle_mutation();
        let admission = self.lock_admission();
        let current = {
            let state = self.lock();
            if state.enabled && !enabled && transfer_active(&state) {
                return Err(PhotoshopEnableMutationError::TransferActive);
            }
            state.enabled
        };
        let value = persist().map_err(PhotoshopEnableMutationError::Persist)?;
        let changed = current != enabled;
        if changed {
            self.apply_enabled(enabled);
            drop(admission);
            settle_lifecycle();
            if !enabled {
                self.publish();
            }
        } else {
            drop(admission);
        }
        Ok((value, changed))
    }

    pub(crate) fn initialize_enabled(&self, enabled: bool) {
        if !enabled {
            return;
        }
        let _admission = self.lock_admission();
        self.apply_enabled(true);
    }

    pub(crate) fn set_gateway_available(&self, available: bool) {
        let availability = if available {
            GatewayAvailability::Available
        } else {
            GatewayAvailability::Unavailable
        };
        let changed = {
            let mut state = self.lock();
            if !state.enabled || state.gateway_availability == availability {
                false
            } else {
                state.gateway_availability = availability;
                true
            }
        };
        if changed {
            self.publish();
        }
    }

    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub fn set_gateway_available_for_tests(&self, available: bool) {
        self.set_gateway_available(available);
    }

    fn apply_enabled(&self, enabled: bool) {
        {
            let mut state = self.lock();
            state.enabled = enabled;
            state.gateway_availability = GatewayAvailability::Unchecked;
            if !enabled {
                assert!(
                    !transfer_active(&state),
                    "Photoshop Integration cannot disable with an active transfer"
                );
                state.sessions.clear();
                state.bearer_sessions.clear();
                assert!(
                    state.commands.is_empty(),
                    "Photoshop command registry must be empty when disable is admitted"
                );
            }
        }
    }

    /// Admits one freshly handshaken Photoshop process session.
    ///
    /// # Errors
    ///
    /// Returns an error when the initial host snapshot or Project projection is invalid.
    ///
    /// # Panics
    ///
    /// Panics if a Runtime-generated session identity collides with existing state.
    pub fn connect(
        &self,
        host_version: String,
        placement_mime_types: Vec<PhotoshopMimeType>,
        documents: Vec<PhotoshopDocumentView>,
        sender: mpsc::Sender<RuntimePhotoshopMessage>,
    ) -> Result<PhotoshopSessionAdmission, PhotoshopError> {
        let _admission = self.lock_admission();
        validate_host_snapshot(&host_version, &placement_mime_types, &documents)?;
        let plugin_session_id = Uuid::new_v4().to_string();
        let bearer = random_credential();
        let ready = RuntimePhotoshopMessage::SessionReady {
            runtime_instance_id: self.runtime_instance_id.clone(),
            plugin_session_id: plugin_session_id.clone(),
            bearer: bearer.clone(),
        };
        let projects = RuntimePhotoshopMessage::ProjectsSnapshot {
            projects: self.projects_snapshot()?,
        };
        {
            let mut state = self.lock();
            require_available(&state)?;
            assert!(
                state
                    .bearer_sessions
                    .insert(bearer.clone(), plugin_session_id.clone())
                    .is_none(),
                "Runtime-generated Photoshop bearer must be unique"
            );
            assert!(
                state
                    .sessions
                    .insert(
                        plugin_session_id.clone(),
                        Session {
                            bearer,
                            host_version,
                            placement_mime_types,
                            documents,
                            sender,
                            active_command: None,
                        },
                    )
                    .is_none(),
                "Runtime-generated Photoshop session ID must be unique"
            );
        }
        self.publish();
        Ok(PhotoshopSessionAdmission {
            plugin_session_id,
            ready,
            projects,
        })
    }

    /// Retires one Photoshop session and all commands that it owns.
    ///
    /// # Panics
    ///
    /// Panics if the bearer reverse index no longer matches its owning session.
    pub fn disconnect(&self, session_id: &str) {
        let removed = {
            let mut state = self.lock();
            let removed = state.sessions.remove(session_id);
            if let Some(session) = &removed {
                assert_eq!(
                    state.bearer_sessions.remove(&session.bearer).as_deref(),
                    Some(session_id),
                    "Photoshop bearer reverse index must match its session"
                );
            }
            let command_ids = state
                .commands
                .iter()
                .filter(|(_, command)| command_session(command) == session_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for command_id in command_ids {
                if let Some(command) = state.commands.remove(&command_id) {
                    fail_removed_command(command, "Photoshop Runtime session disconnected.");
                }
            }
            removed.is_some()
        };
        if removed {
            self.publish();
        }
    }

    /// Applies one closed-protocol message from an admitted Photoshop session.
    ///
    /// # Errors
    ///
    /// Returns an error when the session, message, Project, or command state is invalid.
    pub fn handle_message(
        &self,
        session_id: &str,
        message: PluginPhotoshopMessage,
    ) -> Result<(), PhotoshopError> {
        match message {
            PluginPhotoshopMessage::DocumentsSnapshot { documents } => {
                validate_documents(&documents)?;
                let mut state = self.lock();
                let session = session_mut(&mut state, session_id)?;
                session.documents = documents;
                drop(state);
                self.publish();
                Ok(())
            }
            PluginPhotoshopMessage::ProjectDirectoriesRequest {
                request_id,
                canonical_root,
                revision,
            } => self.send_directories(session_id, request_id, canonical_root, revision),
            PluginPhotoshopMessage::ExportStart {
                command_id,
                canonical_root,
                project_revision,
                directory,
                items,
            } => self.begin_export(
                session_id,
                &command_id,
                &canonical_root,
                project_revision,
                &directory,
                items,
            ),
            PluginPhotoshopMessage::ExportFinish { command_id, items } => {
                self.finish_export(session_id, &command_id, &items)
            }
            PluginPhotoshopMessage::PlaceResult {
                command_id,
                ok,
                error_code,
                message,
            } => self.finish_place(
                session_id,
                &command_id,
                ok,
                error_code.as_deref(),
                message.as_deref(),
            ),
            PluginPhotoshopMessage::SessionStart { .. } => Err(PhotoshopError::new(
                PhotoshopErrorCode::ProtocolInvalid,
                "Photoshop session.start is valid only as the first WebSocket message.",
            )),
        }
    }

    /// Stages one Project file and waits for native placement in the exact live Document.
    ///
    /// # Errors
    ///
    /// Returns an error when the source, target session, Document, or placement fails.
    pub async fn send_project_file(
        &self,
        canonical_root: &str,
        project_relative_path: &str,
        plugin_session_id: &str,
        document_id: u64,
    ) -> Result<PhotoshopSendResult, PhotoshopError> {
        let (receiver, result) = self.prepare_place(
            canonical_root,
            project_relative_path,
            plugin_session_id,
            document_id,
        )?;
        match receiver.await {
            Ok(Ok(())) => Ok(result),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(PhotoshopError::new(
                PhotoshopErrorCode::SessionInvalid,
                "Photoshop placement ended without a result.",
            )),
        }
    }

    /// Reads immutable command-owned bytes for an authorized live plugin session.
    ///
    /// # Errors
    ///
    /// Returns an error when the bearer, command, or staged content is invalid.
    pub fn content(
        &self,
        bearer: &str,
        command_id: &str,
    ) -> Result<PhotoshopContent, PhotoshopError> {
        let (path, expected_byte_length) = {
            let state = self.lock();
            let session_id = session_for_bearer(&state, bearer)?;
            let Some(Command::Place(command)) = state.commands.get(command_id) else {
                return Err(invalid_command());
            };
            if command.session_id != session_id {
                return Err(invalid_command());
            }
            (command.staged_path.clone(), command.byte_length)
        };
        let bytes = fs::read(path)?;
        let byte_length = u64::try_from(bytes.len()).map_err(|_| invalid_command())?;
        if byte_length != expected_byte_length {
            return Err(invalid_command());
        }
        Ok(PhotoshopContent { bytes, byte_length })
    }

    /// Commits one PNG export item into its exact Project revision.
    ///
    /// # Errors
    ///
    /// Returns an error when authorization, limits, command state, or Project mutation fails.
    ///
    /// # Panics
    ///
    /// Panics if a reserved upload command disappears or changes kind while its Project
    /// mutation is in progress.
    pub fn upload(
        &self,
        bearer: &str,
        command_id: &str,
        item_id: &str,
        bytes: &[u8],
    ) -> Result<PhotoshopUploadResult, PhotoshopError> {
        let byte_length = u64::try_from(bytes.len()).map_err(|_| file_too_large())?;
        if byte_length > PHOTOSHOP_MAX_FILE_BYTES {
            return Err(file_too_large());
        }
        let (canonical_root, revision, directory, source_name) = {
            let mut state = self.lock();
            let session_id = session_for_bearer(&state, bearer)?.to_owned();
            let Some(Command::Export(command)) = state.commands.get_mut(command_id) else {
                return Err(invalid_command());
            };
            if command.session_id != session_id
                || command.upload_in_progress
                || command.consumed_items.contains(item_id)
            {
                return Err(invalid_command());
            }
            let source_name = command
                .items
                .get(item_id)
                .cloned()
                .ok_or_else(invalid_command)?;
            if command.uploaded_bytes.saturating_add(byte_length) > PHOTOSHOP_MAX_BATCH_BYTES {
                command.consumed_items.insert(item_id.to_owned());
                return Err(PhotoshopError::new(
                    PhotoshopErrorCode::FileTooLarge,
                    "Photoshop export batch exceeds 1 GiB.",
                ));
            }
            command.upload_in_progress = true;
            command.consumed_items.insert(item_id.to_owned());
            command.uploaded_bytes += byte_length;
            (
                command.canonical_root.clone(),
                command.project_revision,
                command.directory.clone(),
                source_name,
            )
        };
        let result = self.commit_export_item(
            canonical_root.as_wire(),
            revision,
            &directory,
            &source_name,
            bytes,
        );
        let mut state = self.lock();
        let command = match state.commands.get_mut(command_id) {
            Some(Command::Export(command)) => command,
            Some(Command::Place(_)) => {
                panic!("Photoshop upload command changed kind after Project commit")
            }
            None => panic!("Photoshop upload command disappeared during Project commit"),
        };
        assert!(
            command.upload_in_progress && command.consumed_items.contains(item_id),
            "Photoshop upload command must retain its in-progress item"
        );
        command.upload_in_progress = false;
        if let Ok((file_name, next_revision)) = &result {
            command.project_revision = *next_revision;
            assert!(
                command
                    .successful_items
                    .insert(item_id.to_owned(), file_name.clone())
                    .is_none(),
                "Photoshop upload item must settle successfully once"
            );
        }
        drop(state);
        result.map(|(file_name, _)| PhotoshopUploadResult { file_name })
    }

    #[must_use]
    pub fn state(&self) -> PhotoshopStateView {
        let _lifecycle_mutation = self.lock_lifecycle_mutation();
        state_view(&self.lock())
    }

    /// Publishes the current committed Project projection to every live Photoshop session.
    /// A closed Project registry has no live Projects and is therefore published as an empty
    /// projection while the Photoshop gateway finishes shutting down.
    ///
    /// # Panics
    ///
    /// Panics if a committed Project can no longer be represented by the Photoshop protocol.
    pub fn broadcast_projects(&self) {
        let senders = self
            .lock()
            .sessions
            .iter()
            .map(|(session_id, session)| (session_id.clone(), session.sender.clone()))
            .collect::<Vec<_>>();
        if senders.is_empty() {
            return;
        }
        let projects = match self.projects.list() {
            Ok(projects) => project_views(projects),
            Err(ProjectError::RegistryClosed) => Vec::new(),
            Err(error) => {
                panic!("committed Photoshop Project projection must be publishable: {error}")
            }
        };
        let mut stale_sessions = Vec::new();
        for (session_id, sender) in senders {
            if sender
                .try_send(RuntimePhotoshopMessage::ProjectsSnapshot {
                    projects: projects.clone(),
                })
                .is_err()
            {
                stale_sessions.push(session_id);
            }
        }
        for session_id in stale_sessions {
            self.disconnect(&session_id);
        }
    }

    fn prepare_place(
        &self,
        canonical_root: &str,
        project_relative_path: &str,
        plugin_session_id: &str,
        document_id: u64,
    ) -> Result<
        (
            oneshot::Receiver<Result<(), PhotoshopError>>,
            PhotoshopSendResult,
        ),
        PhotoshopError,
    > {
        let product_work = self.begin_product_transfer()?;
        let command_id = Uuid::new_v4().to_string();
        let relative = assert_project_tree_visible_path(project_relative_path)?;
        let mime_type = photoshop_mime_type(&relative)?;
        let document_title =
            self.reserve_place_session(plugin_session_id, &command_id, document_id, mime_type)?;
        let prepared = (|| {
            let session = self.projects.get(Path::new(canonical_root))?;
            let project_use = self
                .projects
                .acquire_use(Path::new(canonical_root), ProjectUseKind::Transfer)?;
            let file_name = Path::new(&relative)
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| {
                    PhotoshopError::new(
                        PhotoshopErrorCode::InvalidTransferPayload,
                        "Photoshop source file name is invalid.",
                    )
                })?
                .to_owned();
            let mut source = open_no_symlink_existing_project_file(session.root(), &relative)?;
            let (staged_path, byte_length) = stage_project_file(&mut source)?;
            Ok::<_, PhotoshopError>((project_use, file_name, mime_type, staged_path, byte_length))
        })();
        let (project_use, file_name, mime_type, staged_path, byte_length) =
            prepared.inspect_err(|_| self.clear_active(plugin_session_id, &command_id))?;
        let (completion, receiver) = oneshot::channel();
        let registration = (|| -> Result<(), PhotoshopError> {
            let mut state = self.lock();
            let session = session_mut(&mut state, plugin_session_id)?;
            assert_eq!(
                session.active_command.as_deref(),
                Some(command_id.as_str()),
                "reserved Photoshop place command must remain active until registration"
            );
            assert!(
                state
                    .commands
                    .insert(
                        command_id.clone(),
                        Command::Place(PlaceCommand {
                            session_id: plugin_session_id.to_owned(),
                            staged_path: staged_path.clone(),
                            byte_length,
                            completion,
                            _project_use: project_use,
                            _product_work: product_work,
                        }),
                    )
                    .is_none(),
                "Runtime-generated Photoshop command ID must be unique"
            );
            Ok(())
        })();
        registration.inspect_err(|_| {
            let _ = fs::remove_file(&staged_path);
        })?;
        let message = RuntimePhotoshopMessage::PlaceRequest {
            command_id: command_id.clone(),
            document_id,
            file_name: file_name.clone(),
            mime_type,
            byte_length,
        };
        self.send(plugin_session_id, message)?;
        Ok((
            receiver,
            PhotoshopSendResult {
                command_id,
                document_title,
                file_name,
            },
        ))
    }

    fn reserve_place_session(
        &self,
        session_id: &str,
        command_id: &str,
        document_id: u64,
        mime_type: PhotoshopMimeType,
    ) -> Result<String, PhotoshopError> {
        let admission = self.lock_admission();
        let mut state = self.lock();
        require_available(&state)?;
        let session = session_mut(&mut state, session_id)?;
        if session.active_command.is_some() {
            return Err(PhotoshopError::new(
                PhotoshopErrorCode::Busy,
                "Photoshop is already transferring files.",
            ));
        }
        let document_title = session
            .documents
            .iter()
            .find(|document| document.document_id == document_id)
            .map(|document| document.title.clone())
            .ok_or_else(|| {
                PhotoshopError::new(
                    PhotoshopErrorCode::DocumentClosed,
                    "The Target Photoshop Document is no longer open.",
                )
            })?;
        if !session.placement_mime_types.contains(&mime_type) {
            return Err(PhotoshopError::new(
                PhotoshopErrorCode::UnsupportedFileType,
                "The Target Photoshop session cannot place this file format.",
            ));
        }
        session.active_command = Some(command_id.to_owned());
        drop(state);
        drop(admission);
        self.publish();
        Ok(document_title)
    }

    fn send_directories(
        &self,
        session_id: &str,
        request_id: String,
        canonical_root: String,
        revision: u64,
    ) -> Result<(), PhotoshopError> {
        let Ok(session) = self.projects.get(Path::new(&canonical_root)) else {
            return self.send_current_projects(session_id);
        };
        let summary = session.summary()?;
        if summary.project_revision != revision {
            return self.send_current_projects(session_id);
        }
        let directories = list_photoshop_target_directories(session.root())?;
        self.send(
            session_id,
            RuntimePhotoshopMessage::ProjectDirectoriesSnapshot {
                request_id,
                canonical_root,
                revision,
                directories,
            },
        )
    }

    fn begin_export(
        &self,
        session_id: &str,
        command_id: &str,
        canonical_root: &str,
        project_revision: u64,
        directory: &str,
        items: Vec<PhotoshopExportItem>,
    ) -> Result<(), PhotoshopError> {
        let product_work = self.begin_product_transfer()?;
        validate_command_id(command_id)?;
        if items.is_empty() || items.len() > PHOTOSHOP_MAX_BATCH_ITEMS {
            return Err(PhotoshopError::new(
                PhotoshopErrorCode::InvalidTransferPayload,
                "Photoshop export requires between 1 and 50 items.",
            ));
        }
        let mut item_map = HashMap::new();
        for item in items {
            if item.item_id.is_empty()
                || item.source_name.is_empty()
                || item_map.insert(item.item_id, item.source_name).is_some()
            {
                return Err(invalid_command());
            }
        }
        self.reserve_export_session(session_id, command_id)?;
        let prepared = (|| {
            let project = self.projects.get(Path::new(canonical_root))?;
            if project.summary()?.project_revision != project_revision {
                return Err(revision_changed());
            }
            let directory = ProjectDirectoryPath::parse(directory)?;
            if !directory.is_empty() && !is_project_visible_path(&directory) {
                return Err(PhotoshopError::new(
                    PhotoshopErrorCode::TargetDirectoryNotVisible,
                    "Photoshop target directory is not visible.",
                ));
            }
            let directory_path =
                resolve_no_symlink_existing_project_path(project.root(), &directory).map_err(
                    |_| {
                        PhotoshopError::new(
                            PhotoshopErrorCode::TargetDirectoryMissing,
                            "Photoshop target directory no longer exists.",
                        )
                    },
                )?;
            if !directory_path.is_dir() {
                return Err(PhotoshopError::new(
                    PhotoshopErrorCode::TargetDirectoryMissing,
                    "Photoshop target directory no longer exists.",
                ));
            }
            let project_use = self
                .projects
                .acquire_use(Path::new(canonical_root), ProjectUseKind::Transfer)?;
            Ok::<_, PhotoshopError>((directory, project_use))
        })();
        let (directory, project_use) =
            prepared.inspect_err(|_| self.clear_active(session_id, command_id))?;
        {
            let mut state = self.lock();
            let session = session_mut(&mut state, session_id)?;
            assert_eq!(
                session.active_command.as_deref(),
                Some(command_id),
                "reserved Photoshop export command must remain active until registration"
            );
            assert!(
                state
                    .commands
                    .insert(
                        command_id.to_owned(),
                        Command::Export(ExportCommand {
                            session_id: session_id.to_owned(),
                            canonical_root: project_use.canonical_root().clone(),
                            project_revision,
                            directory: directory.into_string(),
                            items: item_map,
                            consumed_items: HashSet::new(),
                            successful_items: HashMap::new(),
                            uploaded_bytes: 0,
                            upload_in_progress: false,
                            _project_use: project_use,
                            _product_work: product_work,
                        }),
                    )
                    .is_none(),
                "client Photoshop command ID was validated unique before registration"
            );
        }
        self.send(
            session_id,
            RuntimePhotoshopMessage::ExportReady {
                command_id: command_id.to_owned(),
            },
        )
    }

    fn begin_product_transfer(&self) -> Result<RuntimeWorkPermit, PhotoshopError> {
        self.runtime_state.begin_product_work().ok_or_else(|| {
            PhotoshopError::new(
                PhotoshopErrorCode::Unavailable,
                "Runtime is preparing a Product update and is not accepting new Photoshop transfers.",
            )
        })
    }

    fn reserve_export_session(
        &self,
        session_id: &str,
        command_id: &str,
    ) -> Result<(), PhotoshopError> {
        let admission = self.lock_admission();
        let mut state = self.lock();
        require_available(&state)?;
        if state.commands.contains_key(command_id) {
            return Err(invalid_command());
        }
        let session = session_mut(&mut state, session_id)?;
        if session.active_command.is_some() {
            return Err(PhotoshopError::new(
                PhotoshopErrorCode::Busy,
                "Photoshop is already transferring files.",
            ));
        }
        session.active_command = Some(command_id.to_owned());
        drop(state);
        drop(admission);
        self.publish();
        Ok(())
    }

    fn finish_export(
        &self,
        session_id: &str,
        command_id: &str,
        results: &[PhotoshopExportResult],
    ) -> Result<(), PhotoshopError> {
        let command = {
            let mut state = self.lock();
            let Some(Command::Export(command)) = state.commands.get(command_id) else {
                return Err(invalid_command());
            };
            if command.session_id != session_id || command.upload_in_progress {
                return Err(invalid_command());
            }
            let result_ids = results
                .iter()
                .map(|result| result.item_id.as_str())
                .collect::<HashSet<_>>();
            if result_ids.len() != results.len()
                || result_ids.len() != command.items.len()
                || !command
                    .items
                    .keys()
                    .all(|item_id| result_ids.contains(item_id.as_str()))
                || results.iter().any(invalid_export_result)
                || results.iter().any(|result| {
                    result.ok
                        && command.successful_items.get(&result.item_id)
                            != result.file_name.as_ref()
                })
            {
                return Err(invalid_command());
            }
            state
                .commands
                .remove(command_id)
                .expect("validated export command exists")
        };
        self.clear_active(session_id, command_id);
        drop(command);
        self.broadcast_projects();
        Ok(())
    }

    fn finish_place(
        &self,
        session_id: &str,
        command_id: &str,
        ok: bool,
        error_code: Option<&str>,
        message: Option<&str>,
    ) -> Result<(), PhotoshopError> {
        if ok && (error_code.is_some() || message.is_some()) {
            return Err(invalid_command());
        }
        let command = {
            let mut state = self.lock();
            let Some(Command::Place(command)) = state.commands.get(command_id) else {
                return Err(invalid_command());
            };
            if command.session_id != session_id {
                return Err(invalid_command());
            }
            state
                .commands
                .remove(command_id)
                .expect("validated place command exists")
        };
        self.clear_active(session_id, command_id);
        let Command::Place(command) = command else {
            unreachable!("validated place command changed kind")
        };
        let _ = fs::remove_file(&command.staged_path);
        let result = if ok {
            Ok(())
        } else {
            if let Some(message) = message {
                eprintln!("Debrute Photoshop placement failed in the plugin: {message:?}");
            }
            let (code, message) = match error_code {
                Some("photoshop_document_closed") => (
                    PhotoshopErrorCode::DocumentClosed,
                    "The Target Photoshop Document is no longer open.",
                ),
                _ => (
                    PhotoshopErrorCode::PlaceFailed,
                    "Photoshop could not place the Embedded Smart Object.",
                ),
            };
            Err(PhotoshopError::new(code, message))
        };
        let _ = command.completion.send(result);
        Ok(())
    }

    fn commit_export_item(
        &self,
        canonical_root: &str,
        revision: u64,
        directory: &str,
        source_name: &str,
        bytes: &[u8],
    ) -> Result<(String, u64), PhotoshopError> {
        let session = self.projects.get(Path::new(canonical_root))?;
        if session.summary()?.project_revision != revision {
            return Err(revision_changed());
        }
        let stem = sanitized_stem(source_name);
        let directory = crate::project::ProjectDirectoryPath::parse(directory)?;
        let temporary = temporary_path("export");
        fs::write(&temporary, bytes)?;
        let result = (|| {
            for index in 1..=10_000_u32 {
                let file_name = if index == 1 {
                    format!("{stem}.png")
                } else {
                    format!("{stem} {index}.png")
                };
                let relative = directory.join_name(&file_name)?;
                if resolve_project_path(session.root(), relative.as_directory_path())?.exists() {
                    continue;
                }
                let result = session
                    .execute_at_revision(
                        revision,
                        ProjectCommand::ImportUploadEntries {
                            entries: vec![ProjectUploadEntry::TemporaryFile {
                                project_relative_path: relative,
                                temporary_path: temporary.clone(),
                            }],
                            target_directory: directory.clone(),
                            overwrite: false,
                        },
                    )
                    .map_err(|error| export_project_error(&error))?;
                if let ProjectCommandResult::PathsChanged { .. } = result.value {
                    return Ok((file_name, result.project_revision));
                }
                return Err(PhotoshopError::new(
                    PhotoshopErrorCode::ExportFailed,
                    "Photoshop export did not commit a Project file.",
                ));
            }
            Err(PhotoshopError::new(
                PhotoshopErrorCode::ExportFailed,
                "Photoshop export could not allocate a collision-free file name.",
            ))
        })();
        let _ = fs::remove_file(temporary);
        result
    }

    fn projects_snapshot(&self) -> Result<Vec<PhotoshopProjectView>, PhotoshopError> {
        Ok(project_views(self.projects.list()?))
    }

    fn send(
        &self,
        session_id: &str,
        message: RuntimePhotoshopMessage,
    ) -> Result<(), PhotoshopError> {
        let sender = self
            .lock()
            .sessions
            .get(session_id)
            .map(|session| session.sender.clone())
            .ok_or_else(session_invalid)?;
        if sender.try_send(message).is_err() {
            self.disconnect(session_id);
            Err(PhotoshopError::new(
                PhotoshopErrorCode::Unavailable,
                "Photoshop session outbound queue is unavailable.",
            ))
        } else {
            Ok(())
        }
    }

    fn send_current_projects(&self, session_id: &str) -> Result<(), PhotoshopError> {
        self.send(
            session_id,
            RuntimePhotoshopMessage::ProjectsSnapshot {
                projects: self.projects_snapshot()?,
            },
        )
    }

    fn clear_active(&self, session_id: &str, command_id: &str) {
        let changed = {
            let mut state = self.lock();
            if let Some(session) = state.sessions.get_mut(session_id) {
                assert_eq!(
                    session.active_command.as_deref(),
                    Some(command_id),
                    "Photoshop session active command must match settlement"
                );
                session.active_command = None;
                true
            } else {
                false
            }
        };
        if changed {
            self.publish();
        }
    }

    fn publish(&self) {
        let state = state_view(&self.lock());
        (self.observer)(state);
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .expect("Photoshop integration lock poisoned")
    }

    fn lock_admission(&self) -> MutexGuard<'_, ()> {
        self.admission
            .lock()
            .expect("Photoshop admission lock poisoned")
    }

    fn lock_lifecycle_mutation(&self) -> MutexGuard<'_, ()> {
        self.lifecycle_mutation
            .lock()
            .expect("Photoshop lifecycle mutation lock poisoned")
    }
}

fn list_photoshop_target_directories(root: &Path) -> Result<Vec<String>, ProjectError> {
    let mut directories = Vec::new();
    let mut pending = vec![String::new()];
    while let Some(parent) = pending.pop() {
        let parent_path = crate::project::ProjectDirectoryPath::parse(&parent)?;
        for entry in list_project_directory(root, &parent_path)? {
            if entry.kind != ProjectPathKind::Directory
                || !is_project_visible_path(&entry.project_relative_path)
            {
                continue;
            }
            pending.push(entry.project_relative_path.clone());
            directories.push(entry.project_relative_path);
        }
    }
    directories.sort();
    directories.dedup();
    Ok(directories)
}

impl Drop for PhotoshopIntegration {
    fn drop(&mut self) {
        let state = self
            .state
            .get_mut()
            .expect("Photoshop integration lock poisoned");
        for (_, command) in state.commands.drain() {
            fail_removed_command(command, "Photoshop Runtime stopped.");
        }
    }
}

fn stage_project_file(source: &mut fs::File) -> Result<(PathBuf, u64), PhotoshopError> {
    if source.metadata()?.len() > PHOTOSHOP_MAX_FILE_BYTES {
        return Err(file_too_large());
    }
    let staged_path = temporary_path("place");
    let result = (|| -> Result<u64, PhotoshopError> {
        let mut staged = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged_path)?;
        source.seek(SeekFrom::Start(0))?;
        let byte_length = io::copy(&mut source.take(PHOTOSHOP_MAX_FILE_BYTES + 1), &mut staged)?;
        if byte_length > PHOTOSHOP_MAX_FILE_BYTES {
            return Err(file_too_large());
        }
        staged.sync_all()?;
        Ok(byte_length)
    })();
    match result {
        Ok(byte_length) => Ok((staged_path, byte_length)),
        Err(error) => {
            let _ = fs::remove_file(&staged_path);
            Err(error)
        }
    }
}

fn export_project_error(error: &ProjectError) -> PhotoshopError {
    if error.code() == "project_revision_changed" {
        return revision_changed();
    }
    eprintln!("Debrute Photoshop export Project commit failed: {error}");
    PhotoshopError::new(
        PhotoshopErrorCode::ExportFailed,
        "Photoshop export could not be saved to the selected Debrute Project.",
    )
}

fn state_view(state: &State) -> PhotoshopStateView {
    let mut sessions = state
        .sessions
        .iter()
        .map(|(plugin_session_id, session)| PhotoshopSessionView {
            plugin_session_id: plugin_session_id.clone(),
            host_version: session.host_version.clone(),
            placement_mime_types: session.placement_mime_types.clone(),
            documents: session.documents.clone(),
        })
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| left.plugin_session_id.cmp(&right.plugin_session_id));
    let transfer_active = transfer_active(state);
    let status = if !state.enabled {
        PhotoshopIntegrationStatus::Off
    } else if state.gateway_availability != GatewayAvailability::Available {
        PhotoshopIntegrationStatus::Unavailable
    } else if sessions.is_empty() {
        PhotoshopIntegrationStatus::Waiting
    } else {
        PhotoshopIntegrationStatus::Connected
    };
    PhotoshopStateView {
        status,
        transfer_active,
        sessions,
    }
}

fn transfer_active(state: &State) -> bool {
    state
        .sessions
        .values()
        .any(|session| session.active_command.is_some())
}

fn require_available(state: &State) -> Result<(), PhotoshopError> {
    if state.enabled && state.gateway_availability == GatewayAvailability::Available {
        return Ok(());
    }
    Err(PhotoshopError::new(
        PhotoshopErrorCode::Unavailable,
        "Photoshop Integration is not available.",
    ))
}

fn project_views(projects: Vec<ProjectSessionSummary>) -> Vec<PhotoshopProjectView> {
    let mut projects = projects
        .into_iter()
        .map(|project| PhotoshopProjectView {
            canonical_root: project.canonical_root,
            name: project.project_name,
            revision: project.project_revision,
        })
        .collect::<Vec<_>>();
    projects.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.canonical_root.cmp(&right.canonical_root))
    });
    projects
}

fn validate_host_snapshot(
    host_version: &str,
    placement_mime_types: &[PhotoshopMimeType],
    documents: &[PhotoshopDocumentView],
) -> Result<(), PhotoshopError> {
    if host_version.is_empty() {
        return Err(PhotoshopError::new(
            PhotoshopErrorCode::ProtocolInvalid,
            "Photoshop host version is required.",
        ));
    }
    let unique_mime_types = placement_mime_types.iter().collect::<HashSet<_>>();
    if placement_mime_types.is_empty() || unique_mime_types.len() != placement_mime_types.len() {
        return Err(PhotoshopError::new(
            PhotoshopErrorCode::ProtocolInvalid,
            "Photoshop placement MIME capabilities are invalid.",
        ));
    }
    validate_documents(documents)
}

fn validate_documents(documents: &[PhotoshopDocumentView]) -> Result<(), PhotoshopError> {
    let mut ids = HashSet::new();
    if documents.iter().any(|document| {
        document.document_id == 0 || document.title.is_empty() || !ids.insert(document.document_id)
    }) {
        return Err(PhotoshopError::new(
            PhotoshopErrorCode::ProtocolInvalid,
            "Photoshop Document snapshot is invalid.",
        ));
    }
    Ok(())
}

fn validate_command_id(command_id: &str) -> Result<(), PhotoshopError> {
    if command_id.is_empty() {
        Err(invalid_command())
    } else {
        Ok(())
    }
}

fn invalid_export_result(result: &PhotoshopExportResult) -> bool {
    result.item_id.is_empty()
        || result.ok
            && (result.error_code.is_some()
                || result.message.is_some()
                || result.file_name.is_none())
        || !result.ok && result.file_name.is_some()
}

fn session_mut<'a>(
    state: &'a mut State,
    session_id: &str,
) -> Result<&'a mut Session, PhotoshopError> {
    state
        .sessions
        .get_mut(session_id)
        .ok_or_else(session_invalid)
}

fn session_for_bearer<'a>(state: &'a State, bearer: &str) -> Result<&'a str, PhotoshopError> {
    state
        .bearer_sessions
        .get(bearer)
        .map(String::as_str)
        .ok_or_else(session_invalid)
}

fn command_session(command: &Command) -> &str {
    match command {
        Command::Place(command) => &command.session_id,
        Command::Export(command) => &command.session_id,
    }
}

fn fail_removed_command(command: Command, message: &'static str) {
    if let Command::Place(command) = command {
        let _ = fs::remove_file(command.staged_path);
        let _ = command.completion.send(Err(PhotoshopError::new(
            PhotoshopErrorCode::SessionInvalid,
            message,
        )));
    }
}

fn photoshop_mime_type(path: &str) -> Result<PhotoshopMimeType, PhotoshopError> {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => Ok(PhotoshopMimeType::Png),
        Some("jpg" | "jpeg") => Ok(PhotoshopMimeType::Jpeg),
        Some("webp") => Ok(PhotoshopMimeType::Webp),
        Some("psd") => Ok(PhotoshopMimeType::Psd),
        Some("avif") => Ok(PhotoshopMimeType::Avif),
        _ => Err(PhotoshopError::new(
            PhotoshopErrorCode::UnsupportedFileType,
            "Photoshop accepts only PNG, JPEG, WebP, PSD, and AVIF files.",
        )),
    }
}

fn sanitized_stem(source_name: &str) -> String {
    let without_extension = Path::new(source_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Photoshop File");
    let cleaned = without_extension
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "Photoshop File".to_owned()
    } else {
        trimmed.chars().take(120).collect()
    }
}

fn temporary_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("debrute-photoshop-{label}-{}", Uuid::new_v4()))
}

fn random_credential() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn session_invalid() -> PhotoshopError {
    PhotoshopError::new(
        PhotoshopErrorCode::SessionInvalid,
        "Photoshop session is not live.",
    )
}

fn invalid_command() -> PhotoshopError {
    PhotoshopError::new(
        PhotoshopErrorCode::InvalidTransferPayload,
        "Photoshop command payload is invalid.",
    )
}

fn revision_changed() -> PhotoshopError {
    PhotoshopError::new(
        PhotoshopErrorCode::ProjectRevisionChanged,
        "Debrute Project revision changed.",
    )
}

fn file_too_large() -> PhotoshopError {
    PhotoshopError::new(
        PhotoshopErrorCode::FileTooLarge,
        "Photoshop file exceeds the 256 MiB limit.",
    )
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicBool, Ordering},
        sync::{Arc, mpsc as std_mpsc},
        thread,
        time::Duration,
    };

    use tokio::sync::mpsc;

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

    fn registry(home: &Path) -> ProjectSessionRegistry {
        let workers = RuntimeWorkerServices::new();
        let previews = Arc::new(ProjectPreviewService::new(
            &workers,
            MediaToolPaths::unavailable(),
        ));
        let feedback = Arc::new(CanvasFeedbackArtifacts::new(previews).unwrap());
        ProjectSessionRegistry::new(home, Arc::new(DefaultProjectNodeAdapter), feedback)
    }

    fn ready_runtime_state() -> Arc<RuntimeControlState> {
        let state = Arc::new(RuntimeControlState::new("runtime-1"));
        assert!(state.finish_startup());
        state
    }

    fn enabled_integration(
        runtime_state: Arc<RuntimeControlState>,
        projects: ProjectSessionRegistry,
    ) -> PhotoshopIntegration {
        let integration = PhotoshopIntegration::new(
            "runtime-1".to_owned(),
            runtime_state,
            projects,
            Arc::new(|_| {}),
        );
        integration.initialize_enabled(true);
        integration.set_gateway_available(true);
        integration
    }

    fn connect(
        integration: &PhotoshopIntegration,
        documents: Vec<PhotoshopDocumentView>,
    ) -> (
        PhotoshopSessionAdmission,
        mpsc::Receiver<RuntimePhotoshopMessage>,
    ) {
        connect_with_mime_types(
            integration,
            vec![
                PhotoshopMimeType::Png,
                PhotoshopMimeType::Jpeg,
                PhotoshopMimeType::Webp,
                PhotoshopMimeType::Psd,
                PhotoshopMimeType::Avif,
            ],
            documents,
        )
    }

    fn connect_with_mime_types(
        integration: &PhotoshopIntegration,
        placement_mime_types: Vec<PhotoshopMimeType>,
        documents: Vec<PhotoshopDocumentView>,
    ) -> (
        PhotoshopSessionAdmission,
        mpsc::Receiver<RuntimePhotoshopMessage>,
    ) {
        let (sender, receiver) = mpsc::channel(8);
        let admission = integration
            .connect("27.0".to_owned(), placement_mime_types, documents, sender)
            .unwrap();
        (admission, receiver)
    }

    fn bearer(admission: &PhotoshopSessionAdmission) -> &str {
        let RuntimePhotoshopMessage::SessionReady { bearer, .. } = &admission.ready else {
            panic!("admission must contain session.ready");
        };
        bearer
    }

    fn successful_export_result(item_id: &str, file_name: &str) -> PhotoshopExportResult {
        PhotoshopExportResult {
            item_id: item_id.to_owned(),
            ok: true,
            file_name: Some(file_name.to_owned()),
            error_code: None,
            message: None,
        }
    }

    #[test]
    fn enablement_and_gateway_availability_define_the_live_state() {
        let home = TemporaryDirectory::new("enablement-state-home");
        let integration = PhotoshopIntegration::new(
            "runtime-1".to_owned(),
            ready_runtime_state(),
            registry(home.as_ref()),
            Arc::new(|_| {}),
        );

        assert_eq!(integration.state(), PhotoshopStateView::default());
        integration.initialize_enabled(true);
        assert_eq!(
            integration.state().status,
            PhotoshopIntegrationStatus::Unavailable
        );
        integration.set_gateway_available(true);
        assert_eq!(
            integration.state().status,
            PhotoshopIntegrationStatus::Waiting
        );

        let (admission, _outbound) = connect(&integration, Vec::new());
        let session_bearer = bearer(&admission).to_owned();
        assert_eq!(
            integration.state().status,
            PhotoshopIntegrationStatus::Connected
        );

        let result = integration.mutate_enabled(false, || Ok::<_, ()>(()), || {});
        assert!(matches!(result, Ok(((), true))));
        assert_eq!(integration.state(), PhotoshopStateView::default());
        let Err(error) = integration.content(&session_bearer, "retired-command") else {
            panic!("disabled Photoshop bearer must be invalid");
        };
        assert_eq!(error.code(), PhotoshopErrorCode::SessionInvalid);

        integration.initialize_enabled(true);
        assert_eq!(
            integration.state().status,
            PhotoshopIntegrationStatus::Unavailable
        );
        integration.set_gateway_available(true);
        assert_eq!(
            integration.state().status,
            PhotoshopIntegrationStatus::Waiting
        );
        integration.set_gateway_available(false);
        assert_eq!(
            integration.state().status,
            PhotoshopIntegrationStatus::Unavailable
        );

        let disabled_again = integration.mutate_enabled(false, || Ok::<_, ()>(()), || {});
        assert!(matches!(disabled_again, Ok(((), true))));
        assert_eq!(integration.state(), PhotoshopStateView::default());
    }

    #[test]
    fn enablement_publishes_settled_gateway_state_and_off_after_lifecycle_stop() {
        let home = TemporaryDirectory::new("enablement-publication-home");
        let lifecycle_stopped = Arc::new(AtomicBool::new(false));
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observer_stopped = Arc::clone(&lifecycle_stopped);
        let observer_states = Arc::clone(&observed);
        let integration = PhotoshopIntegration::new(
            "runtime-1".to_owned(),
            ready_runtime_state(),
            registry(home.as_ref()),
            Arc::new(move |state| {
                observer_states
                    .lock()
                    .unwrap()
                    .push((state.status, observer_stopped.load(Ordering::SeqCst)));
            }),
        );

        integration
            .mutate_enabled(
                true,
                || Ok::<_, ()>(()),
                || integration.set_gateway_available(true),
            )
            .unwrap();
        integration
            .mutate_enabled(
                false,
                || Ok::<_, ()>(()),
                || lifecycle_stopped.store(true, Ordering::SeqCst),
            )
            .unwrap();

        assert_eq!(
            *observed.lock().unwrap(),
            [
                (PhotoshopIntegrationStatus::Waiting, false),
                (PhotoshopIntegrationStatus::Off, true),
            ]
        );
    }

    #[test]
    fn enablement_mutations_cannot_overtake_lifecycle_settlement() {
        let home = TemporaryDirectory::new("enablement-order-home");
        let integration = Arc::new(PhotoshopIntegration::new(
            "runtime-1".to_owned(),
            ready_runtime_state(),
            registry(home.as_ref()),
            Arc::new(|_| {}),
        ));
        let (settling, settlement_started) = std_mpsc::sync_channel(0);
        let (release_settlement, release) = std_mpsc::sync_channel(0);
        let first_integration = Arc::clone(&integration);
        let first = thread::spawn(move || {
            first_integration
                .mutate_enabled(
                    true,
                    || Ok::<_, ()>(()),
                    || {
                        settling.send(()).unwrap();
                        release.recv().unwrap();
                        first_integration.set_gateway_available(true);
                    },
                )
                .unwrap();
        });
        settlement_started.recv().unwrap();

        let (second_started, second_entered) = std_mpsc::sync_channel(0);
        let (persisted, persistence_observed) = std_mpsc::sync_channel(0);
        let second_integration = Arc::clone(&integration);
        let second = thread::spawn(move || {
            second_started.send(()).unwrap();
            second_integration
                .mutate_enabled(
                    false,
                    || {
                        persisted.send(()).unwrap();
                        Ok::<_, ()>(())
                    },
                    || {},
                )
                .unwrap();
        });
        second_entered.recv().unwrap();
        assert!(matches!(
            persistence_observed.recv_timeout(Duration::from_millis(50)),
            Err(std_mpsc::RecvTimeoutError::Timeout)
        ));

        release_settlement.send(()).unwrap();
        first.join().unwrap();
        persistence_observed
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        second.join().unwrap();
        assert_eq!(integration.state(), PhotoshopStateView::default());
    }

    #[test]
    fn active_transfer_rejects_disable_before_persistence() {
        let project = TemporaryDirectory::new("disable-busy-project");
        let home = TemporaryDirectory::new("disable-busy-home");
        fs::write(project.as_ref().join("source.png"), b"accepted bytes").unwrap();
        let projects = registry(home.as_ref());
        let opened = projects
            .open_project(project.as_ref(), ProjectUseKind::Workbench)
            .unwrap();
        let canonical_root = opened.session.summary().unwrap().canonical_root;
        let integration = enabled_integration(ready_runtime_state(), projects);
        let (admission, _outbound) = connect(
            &integration,
            vec![PhotoshopDocumentView {
                document_id: 10,
                title: "A.psd".to_owned(),
            }],
        );
        let (completion, command) = integration
            .prepare_place(
                &canonical_root,
                "source.png",
                &admission.plugin_session_id,
                10,
            )
            .unwrap();
        assert!(integration.state().transfer_active);

        let persisted = AtomicBool::new(false);
        let rejected = integration.mutate_enabled(
            false,
            || {
                persisted.store(true, Ordering::SeqCst);
                Ok::<_, ()>(())
            },
            || {},
        );
        assert!(matches!(
            rejected,
            Err(PhotoshopEnableMutationError::TransferActive)
        ));
        assert!(!persisted.load(Ordering::SeqCst));
        assert_eq!(
            integration.state().status,
            PhotoshopIntegrationStatus::Connected
        );

        integration
            .handle_message(
                &admission.plugin_session_id,
                PluginPhotoshopMessage::PlaceResult {
                    command_id: command.command_id,
                    ok: true,
                    error_code: None,
                    message: None,
                },
            )
            .unwrap();
        completion.blocking_recv().unwrap().unwrap();
        let lifecycle_settled = AtomicBool::new(false);
        let admitted = integration.mutate_enabled(
            false,
            || {
                persisted.store(true, Ordering::SeqCst);
                Ok::<_, ()>(())
            },
            || lifecycle_settled.store(true, Ordering::SeqCst),
        );
        assert!(matches!(admitted, Ok(((), true))));
        assert!(persisted.load(Ordering::SeqCst));
        assert!(lifecycle_settled.load(Ordering::SeqCst));
        assert_eq!(integration.state(), PhotoshopStateView::default());
    }

    #[test]
    fn incoming_transfer_freezes_bytes_and_binds_the_exact_document() {
        let project = TemporaryDirectory::new("incoming-project");
        let home = TemporaryDirectory::new("incoming-home");
        let source_path = project.as_ref().join("source.png");
        fs::write(&source_path, b"accepted bytes").unwrap();
        let projects = registry(home.as_ref());
        let opened = projects
            .open_project(project.as_ref(), ProjectUseKind::Workbench)
            .unwrap();
        let canonical_root = opened.session.summary().unwrap().canonical_root;
        let integration = enabled_integration(ready_runtime_state(), projects.clone());
        let (admission, mut outbound) = connect(
            &integration,
            vec![
                PhotoshopDocumentView {
                    document_id: 10,
                    title: "A.psd".to_owned(),
                },
                PhotoshopDocumentView {
                    document_id: 20,
                    title: "B.psd".to_owned(),
                },
            ],
        );

        let (completion, result) = integration
            .prepare_place(
                &canonical_root,
                "source.png",
                &admission.plugin_session_id,
                10,
            )
            .unwrap();
        assert_eq!(result.document_title, "A.psd");
        assert!(matches!(
            outbound.try_recv().unwrap(),
            RuntimePhotoshopMessage::PlaceRequest {
                document_id: 10,
                ..
            }
        ));
        fs::write(source_path, b"later bytes").unwrap();
        assert_eq!(
            integration
                .content(bearer(&admission), &result.command_id)
                .unwrap()
                .bytes,
            b"accepted bytes"
        );

        integration
            .handle_message(
                &admission.plugin_session_id,
                PluginPhotoshopMessage::PlaceResult {
                    command_id: result.command_id.clone(),
                    ok: true,
                    error_code: None,
                    message: None,
                },
            )
            .unwrap();
        completion.blocking_recv().unwrap().unwrap();
        assert!(
            integration
                .content(bearer(&admission), &result.command_id)
                .is_err()
        );
        assert_eq!(
            integration
                .prepare_place(
                    &canonical_root,
                    "source.png",
                    &admission.plugin_session_id,
                    999,
                )
                .unwrap_err()
                .code(),
            PhotoshopErrorCode::DocumentClosed
        );

        let (failure_completion, failure) = integration
            .prepare_place(
                &canonical_root,
                "source.png",
                &admission.plugin_session_id,
                10,
            )
            .unwrap();
        assert!(matches!(
            outbound.try_recv().unwrap(),
            RuntimePhotoshopMessage::PlaceRequest { .. }
        ));
        let private_path = r"C:\Users\developer\AppData\Local\Temp\place.png";
        integration
            .handle_message(
                &admission.plugin_session_id,
                PluginPhotoshopMessage::PlaceResult {
                    command_id: failure.command_id,
                    ok: false,
                    error_code: Some("photoshop_place_failed".to_owned()),
                    message: Some(format!("Photoshop could not open {private_path}")),
                },
            )
            .unwrap();
        let error = failure_completion.blocking_recv().unwrap().unwrap_err();
        assert_eq!(error.code(), PhotoshopErrorCode::PlaceFailed);
        assert_eq!(
            error.to_string(),
            "Photoshop could not place the Embedded Smart Object."
        );
        assert!(!error.to_string().contains(private_path));
    }

    #[test]
    fn incoming_transfer_requires_the_exact_session_placement_capability() {
        let project = TemporaryDirectory::new("incoming-avif-project");
        let home = TemporaryDirectory::new("incoming-avif-home");
        fs::write(project.as_ref().join("cover.avif"), b"avif bytes").unwrap();
        let projects = registry(home.as_ref());
        let opened = projects
            .open_project(project.as_ref(), ProjectUseKind::Workbench)
            .unwrap();
        let canonical_root = opened.session.summary().unwrap().canonical_root;
        let integration = enabled_integration(ready_runtime_state(), projects);
        let documents = vec![PhotoshopDocumentView {
            document_id: 10,
            title: "A.psd".to_owned(),
        }];
        let baseline = vec![
            PhotoshopMimeType::Png,
            PhotoshopMimeType::Jpeg,
            PhotoshopMimeType::Webp,
            PhotoshopMimeType::Psd,
        ];
        let (incompatible, mut incompatible_outbound) =
            connect_with_mime_types(&integration, baseline.clone(), documents.clone());

        assert_eq!(
            integration
                .prepare_place(
                    &canonical_root,
                    "cover.avif",
                    &incompatible.plugin_session_id,
                    10,
                )
                .unwrap_err()
                .code(),
            PhotoshopErrorCode::UnsupportedFileType
        );
        assert!(incompatible_outbound.try_recv().is_err());
        let incompatible_view = integration
            .state()
            .sessions
            .into_iter()
            .find(|session| session.plugin_session_id == incompatible.plugin_session_id)
            .unwrap();
        assert_eq!(incompatible_view.placement_mime_types, baseline);

        let (compatible, mut compatible_outbound) = connect_with_mime_types(
            &integration,
            vec![
                PhotoshopMimeType::Png,
                PhotoshopMimeType::Jpeg,
                PhotoshopMimeType::Webp,
                PhotoshopMimeType::Psd,
                PhotoshopMimeType::Avif,
            ],
            documents,
        );
        let (completion, result) = integration
            .prepare_place(
                &canonical_root,
                "cover.avif",
                &compatible.plugin_session_id,
                10,
            )
            .unwrap();
        assert!(matches!(
            compatible_outbound.try_recv().unwrap(),
            RuntimePhotoshopMessage::PlaceRequest {
                mime_type: PhotoshopMimeType::Avif,
                ..
            }
        ));
        integration
            .handle_message(
                &compatible.plugin_session_id,
                PluginPhotoshopMessage::PlaceResult {
                    command_id: result.command_id,
                    ok: true,
                    error_code: None,
                    message: None,
                },
            )
            .unwrap();
        completion.blocking_recv().unwrap().unwrap();
    }

    #[test]
    fn session_start_rejects_empty_or_duplicate_placement_capabilities() {
        let home = TemporaryDirectory::new("invalid-capability-home");
        let projects = registry(home.as_ref());
        let integration = enabled_integration(ready_runtime_state(), projects);

        for placement_mime_types in [
            Vec::new(),
            vec![PhotoshopMimeType::Png, PhotoshopMimeType::Png],
        ] {
            let (sender, _receiver) = mpsc::channel(1);
            let Err(error) =
                integration.connect("27.0".to_owned(), placement_mime_types, Vec::new(), sender)
            else {
                panic!("invalid placement capability list must be rejected");
            };
            assert_eq!(error.code(), PhotoshopErrorCode::ProtocolInvalid);
        }
    }

    #[test]
    fn incoming_transfer_rejects_busy_before_io_and_requires_a_visible_project_file() {
        let project = TemporaryDirectory::new("incoming-admission-project");
        let home = TemporaryDirectory::new("incoming-admission-home");
        fs::write(project.as_ref().join("source.png"), b"accepted bytes").unwrap();
        fs::create_dir(project.as_ref().join(".git")).unwrap();
        fs::write(project.as_ref().join(".git/hidden.png"), b"hidden bytes").unwrap();
        let projects = registry(home.as_ref());
        let opened = projects
            .open_project(project.as_ref(), ProjectUseKind::Workbench)
            .unwrap();
        let canonical_root = opened.session.summary().unwrap().canonical_root;
        let integration = enabled_integration(ready_runtime_state(), projects);
        let (admission, mut outbound) = connect(
            &integration,
            vec![PhotoshopDocumentView {
                document_id: 10,
                title: "A.psd".to_owned(),
            }],
        );

        let (completion, active) = integration
            .prepare_place(
                &canonical_root,
                "source.png",
                &admission.plugin_session_id,
                10,
            )
            .unwrap();
        assert!(matches!(
            outbound.try_recv().unwrap(),
            RuntimePhotoshopMessage::PlaceRequest { .. }
        ));
        assert_eq!(
            integration
                .prepare_place(
                    &canonical_root,
                    "missing.png",
                    &admission.plugin_session_id,
                    10,
                )
                .unwrap_err()
                .code(),
            PhotoshopErrorCode::Busy
        );
        integration
            .handle_message(
                &admission.plugin_session_id,
                PluginPhotoshopMessage::PlaceResult {
                    command_id: active.command_id,
                    ok: true,
                    error_code: None,
                    message: None,
                },
            )
            .unwrap();
        completion.blocking_recv().unwrap().unwrap();

        assert_eq!(
            integration
                .prepare_place(
                    &canonical_root,
                    ".git/hidden.png",
                    &admission.plugin_session_id,
                    10,
                )
                .unwrap_err()
                .code(),
            PhotoshopErrorCode::InvalidTransferPayload
        );
        assert!(outbound.try_recv().is_err());
    }

    #[test]
    fn failed_project_broadcast_retires_the_stale_photoshop_session() {
        let home = TemporaryDirectory::new("stale-broadcast-home");
        let projects = registry(home.as_ref());
        let integration = enabled_integration(ready_runtime_state(), projects);
        let (admission, outbound) = connect(&integration, Vec::new());
        drop(outbound);

        integration.broadcast_projects();

        assert!(integration.state().sessions.is_empty());
        assert_eq!(
            integration
                .send_current_projects(&admission.plugin_session_id)
                .unwrap_err()
                .code(),
            PhotoshopErrorCode::SessionInvalid
        );
    }

    #[test]
    fn closed_project_registry_broadcasts_an_empty_projection() {
        let home = TemporaryDirectory::new("closed-broadcast-home");
        let projects = registry(home.as_ref());
        let integration = enabled_integration(ready_runtime_state(), projects.clone());
        let (_admission, mut outbound) = connect(&integration, Vec::new());

        projects.close().unwrap();
        integration.broadcast_projects();

        assert_eq!(
            outbound.blocking_recv(),
            Some(RuntimePhotoshopMessage::ProjectsSnapshot {
                projects: Vec::new(),
            })
        );
        assert_eq!(integration.state().sessions.len(), 1);
    }

    #[test]
    fn outgoing_directory_snapshot_and_admission_ignore_gitignore_but_keep_protected_filters() {
        let project = TemporaryDirectory::new("filtered-directory-project");
        let home = TemporaryDirectory::new("filtered-directory-home");
        for directory in [
            "exports",
            "ignored/kept",
            "nested/kept",
            "node_modules/package",
        ] {
            fs::create_dir_all(project.as_ref().join(directory)).unwrap();
        }
        fs::write(project.as_ref().join(".gitignore"), "ignored/\n").unwrap();
        let projects = registry(home.as_ref());
        let opened = projects
            .open_project(project.as_ref(), ProjectUseKind::Workbench)
            .unwrap();
        let summary = opened.session.summary().unwrap();
        let integration = enabled_integration(ready_runtime_state(), projects);
        let (admission, mut outbound) = connect(&integration, Vec::new());

        integration
            .handle_message(
                &admission.plugin_session_id,
                PluginPhotoshopMessage::ProjectDirectoriesRequest {
                    request_id: "directories-1".to_owned(),
                    canonical_root: summary.canonical_root.clone(),
                    revision: summary.project_revision,
                },
            )
            .unwrap();

        assert_eq!(
            outbound.blocking_recv(),
            Some(RuntimePhotoshopMessage::ProjectDirectoriesSnapshot {
                request_id: "directories-1".to_owned(),
                canonical_root: summary.canonical_root.clone(),
                revision: summary.project_revision,
                directories: vec![
                    "exports".to_owned(),
                    "ignored".to_owned(),
                    "ignored/kept".to_owned(),
                    "nested".to_owned(),
                    "nested/kept".to_owned(),
                    "node_modules".to_owned(),
                    "node_modules/package".to_owned(),
                ],
            })
        );

        for (index, directory) in [".git/objects"].into_iter().enumerate() {
            let error = integration
                .handle_message(
                    &admission.plugin_session_id,
                    PluginPhotoshopMessage::ExportStart {
                        command_id: format!("filtered-export-{index}"),
                        canonical_root: summary.canonical_root.clone(),
                        project_revision: summary.project_revision,
                        directory: directory.to_owned(),
                        items: vec![PhotoshopExportItem {
                            item_id: "item-1".to_owned(),
                            source_name: "Layer".to_owned(),
                        }],
                    },
                )
                .unwrap_err();
            assert_eq!(error.code(), PhotoshopErrorCode::TargetDirectoryNotVisible);
        }

        integration
            .handle_message(
                &admission.plugin_session_id,
                PluginPhotoshopMessage::ExportStart {
                    command_id: "gitignored-export".to_owned(),
                    canonical_root: summary.canonical_root,
                    project_revision: summary.project_revision,
                    directory: "ignored/kept".to_owned(),
                    items: vec![PhotoshopExportItem {
                        item_id: "item-1".to_owned(),
                        source_name: "Layer".to_owned(),
                    }],
                },
            )
            .unwrap();
        assert!(matches!(
            outbound.blocking_recv(),
            Some(RuntimePhotoshopMessage::ExportReady { command_id })
                if command_id == "gitignored-export"
        ));
    }

    #[test]
    fn outgoing_items_commit_independently_with_collision_free_names() {
        let project = TemporaryDirectory::new("outgoing-project");
        let home = TemporaryDirectory::new("outgoing-home");
        let projects = registry(home.as_ref());
        let opened = projects
            .open_project(project.as_ref(), ProjectUseKind::Workbench)
            .unwrap();
        let summary = opened.session.summary().unwrap();
        let integration = enabled_integration(ready_runtime_state(), projects.clone());
        let (admission, mut outbound) = connect(
            &integration,
            vec![PhotoshopDocumentView {
                document_id: 10,
                title: "A.psd".to_owned(),
            }],
        );
        let command_id = "export-1".to_owned();
        integration
            .handle_message(
                &admission.plugin_session_id,
                PluginPhotoshopMessage::ExportStart {
                    command_id: command_id.clone(),
                    canonical_root: summary.canonical_root,
                    project_revision: summary.project_revision,
                    directory: String::new(),
                    items: vec![
                        PhotoshopExportItem {
                            item_id: "one".to_owned(),
                            source_name: "Layer".to_owned(),
                        },
                        PhotoshopExportItem {
                            item_id: "two".to_owned(),
                            source_name: "Layer".to_owned(),
                        },
                    ],
                },
            )
            .unwrap();
        assert!(matches!(
            outbound.try_recv().unwrap(),
            RuntimePhotoshopMessage::ExportReady { command_id: ready } if ready == command_id
        ));

        let first = integration
            .upload(bearer(&admission), &command_id, "one", b"png-one")
            .unwrap();
        let second = integration
            .upload(bearer(&admission), &command_id, "two", b"png-two")
            .unwrap();
        assert_eq!(first.file_name, "Layer.png");
        assert_eq!(second.file_name, "Layer 2.png");
        assert_eq!(
            fs::read(project.as_ref().join(&first.file_name)).unwrap(),
            b"png-one"
        );
        assert_eq!(
            fs::read(project.as_ref().join(&second.file_name)).unwrap(),
            b"png-two"
        );

        assert_eq!(
            integration
                .handle_message(
                    &admission.plugin_session_id,
                    PluginPhotoshopMessage::ExportFinish {
                        command_id: command_id.clone(),
                        items: vec![
                            successful_export_result("one", "forged.png"),
                            successful_export_result("two", &second.file_name),
                        ],
                    },
                )
                .unwrap_err()
                .code(),
            PhotoshopErrorCode::InvalidTransferPayload
        );

        integration
            .handle_message(
                &admission.plugin_session_id,
                PluginPhotoshopMessage::ExportFinish {
                    command_id: command_id.clone(),
                    items: vec![
                        successful_export_result("one", &first.file_name),
                        successful_export_result("two", &second.file_name),
                    ],
                },
            )
            .unwrap();
        assert!(
            integration
                .upload(bearer(&admission), &command_id, "one", b"again")
                .is_err()
        );
    }

    #[test]
    fn product_update_rejects_new_photoshop_transfers_and_drains_the_admitted_transfer() {
        let project = TemporaryDirectory::new("product-update-project");
        let home = TemporaryDirectory::new("product-update-home");
        let projects = registry(home.as_ref());
        let opened = projects
            .open_project(project.as_ref(), ProjectUseKind::Workbench)
            .unwrap();
        let summary = opened.session.summary().unwrap();
        let runtime_state = ready_runtime_state();
        let integration = enabled_integration(Arc::clone(&runtime_state), projects);
        let (admitted, mut admitted_outbound) = connect(&integration, Vec::new());
        let (rejected, _rejected_outbound) = connect(&integration, Vec::new());
        integration
            .handle_message(
                &admitted.plugin_session_id,
                PluginPhotoshopMessage::ExportStart {
                    command_id: "admitted-export".to_owned(),
                    canonical_root: summary.canonical_root.clone(),
                    project_revision: summary.project_revision,
                    directory: String::new(),
                    items: vec![PhotoshopExportItem {
                        item_id: "one".to_owned(),
                        source_name: "Layer".to_owned(),
                    }],
                },
            )
            .unwrap();
        assert!(matches!(
            admitted_outbound.try_recv().unwrap(),
            RuntimePhotoshopMessage::ExportReady { command_id }
                if command_id == "admitted-export"
        ));

        let (committed_sender, committed_receiver) = std_mpsc::channel();
        assert!(runtime_state.request_product_update(
            &Uuid::new_v4().to_string(),
            Box::new(|| {}),
            Box::new(move || {
                committed_sender.send(()).unwrap();
                Ok(())
            }),
            Box::new(|_| {}),
        ));
        assert!(
            committed_receiver
                .recv_timeout(Duration::from_millis(50))
                .is_err()
        );

        let error = integration
            .handle_message(
                &rejected.plugin_session_id,
                PluginPhotoshopMessage::ExportStart {
                    command_id: "rejected-export".to_owned(),
                    canonical_root: summary.canonical_root,
                    project_revision: summary.project_revision,
                    directory: String::new(),
                    items: vec![PhotoshopExportItem {
                        item_id: "one".to_owned(),
                        source_name: "Layer".to_owned(),
                    }],
                },
            )
            .unwrap_err();
        assert_eq!(error.code(), PhotoshopErrorCode::Unavailable);

        integration.disconnect(&admitted.plugin_session_id);
        committed_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
    }

    #[test]
    fn document_snapshots_replace_atomically_and_reconnects_are_fresh() {
        let home = TemporaryDirectory::new("sessions-home");
        let integration = enabled_integration(ready_runtime_state(), registry(home.as_ref()));
        let (first, _first_outbound) = connect(
            &integration,
            vec![PhotoshopDocumentView {
                document_id: 10,
                title: "A.psd".to_owned(),
            }],
        );
        integration
            .handle_message(
                &first.plugin_session_id,
                PluginPhotoshopMessage::DocumentsSnapshot {
                    documents: vec![PhotoshopDocumentView {
                        document_id: 20,
                        title: "B.psd".to_owned(),
                    }],
                },
            )
            .unwrap();
        let first_view = integration
            .state()
            .sessions
            .into_iter()
            .find(|session| session.plugin_session_id == first.plugin_session_id)
            .unwrap();
        assert_eq!(
            first_view.documents,
            vec![PhotoshopDocumentView {
                document_id: 20,
                title: "B.psd".to_owned(),
            }]
        );

        let (second, _second_outbound) = connect(&integration, Vec::new());
        assert_ne!(first.plugin_session_id, second.plugin_session_id);
        assert_ne!(bearer(&first), bearer(&second));
        integration.disconnect(&first.plugin_session_id);
        assert_eq!(integration.state().sessions.len(), 1);
    }

    #[test]
    fn export_project_errors_keep_staging_paths_out_of_the_photoshop_message() {
        let private_path = r"C:\Users\developer\AppData\Local\Temp\debrute-export.png";
        let source = ProjectError::Io(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("copy {private_path} into Project staging failed"),
        ));
        let error = export_project_error(&source);

        assert_eq!(error.code(), PhotoshopErrorCode::ExportFailed);
        assert_eq!(
            error.to_string(),
            "Photoshop export could not be saved to the selected Debrute Project."
        );
        assert!(!error.to_string().contains(private_path));
    }
}
