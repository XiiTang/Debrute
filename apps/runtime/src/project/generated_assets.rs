//! Project-owned Generated Asset provenance and content-fingerprint lookup.

use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read as _, Seek as _, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use super::{
    ProjectCapabilityFs, ProjectDocumentRead, ProjectDocumentTransaction, ProjectDocumentWrite,
    ProjectError, ProjectPathKind, assert_project_tree_visible_mutation_path,
    commit_project_document_transaction_checked, normalize_project_relative_path,
    open_no_symlink_existing_project_file, resolve_no_symlink_project_path_for_write,
    visit_project_files,
};

pub const GENERATED_ASSET_INDEX_PROJECT_PATH: &str = ".debrute/assets/generated-assets-index.json";
pub const GENERATED_ASSET_RECORDS_PROJECT_DIRECTORY: &str = ".debrute/assets/generated";

const MAX_GENERATED_ASSET_INDEX_BYTES: usize = 16 * 1024 * 1024;
const MAX_GENERATED_ASSET_RECORD_BYTES: usize = 2 * 1024 * 1024;
const MAX_GENERATED_ASSET_RECORDS: usize = 100_000;
const MAX_MODEL_RUN_ID_BYTES: usize = 256;
const MAX_PROJECT_PATH_BYTES: usize = 4_096;
const MAX_DIAGNOSTICS: usize = 256;
const MAX_LOOKUP_HASH_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RESOLVE_HASH_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_RESOLVE_HASH_FILES: usize = 10_000;
const FINGERPRINT_OPERATION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GeneratedArtifactRole {
    PrimaryImage,
    PrimaryVideo,
    LastFrame,
    TtsAudio,
    MusicAudio,
    SoundEffectAudio,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeneratedAssetFingerprint {
    pub algorithm: GeneratedAssetFingerprintAlgorithm,
    pub hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GeneratedAssetFingerprintAlgorithm {
    Sha256,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedModelRun {
    pub request: serde_json::Value,
    pub output: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedAssetRecord {
    pub record_id: String,
    pub model_run_id: String,
    pub project_relative_path: String,
    pub created_at: String,
    pub artifact_role: GeneratedArtifactRole,
    pub artifact_index: u64,
    pub fingerprint: GeneratedAssetFingerprint,
    pub model_run: GeneratedModelRun,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordGeneratedAssetInput {
    pub model_run_id: String,
    pub project_relative_path: String,
    pub artifact_role: GeneratedArtifactRole,
    pub artifact_index: u64,
    pub model_run: GeneratedModelRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedAssetMetadataDiagnostic {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum GeneratedAssetMetadataLookup {
    Matched {
        fingerprint: GeneratedAssetFingerprint,
        records: Vec<GeneratedAssetRecord>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        diagnostics: Vec<GeneratedAssetMetadataDiagnostic>,
    },
    Unmatched {
        fingerprint: GeneratedAssetFingerprint,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        diagnostics: Vec<GeneratedAssetMetadataDiagnostic>,
    },
    Unavailable {
        reason: GeneratedAssetUnavailableReason,
        message: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        diagnostics: Vec<GeneratedAssetMetadataDiagnostic>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GeneratedAssetUnavailableReason {
    Missing,
    Unreadable,
    MetadataUnreadable,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordGeneratedAssetResult {
    pub record: GeneratedAssetRecord,
    pub diagnostic: Option<GeneratedAssetMetadataDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeneratedAssetMetadataIndex {
    records: Vec<GeneratedAssetMetadataIndexEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeneratedAssetMetadataIndexEntry {
    record_id: String,
    model_run_id: String,
    artifact_role: GeneratedArtifactRole,
    artifact_index: u64,
    created_at: String,
    fingerprint: GeneratedAssetFingerprint,
    metadata_path: String,
}

struct DocumentState<T> {
    absolute_path: PathBuf,
    expected_hash: Option<String>,
    document: T,
}

#[derive(Default)]
pub struct GeneratedAssetMetadataService {
    project_locks: Mutex<BTreeMap<PathBuf, Weak<Mutex<()>>>>,
}

impl GeneratedAssetMetadataService {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Records one already-written generated Project file and its safe Model Run.
    ///
    /// # Errors
    /// Returns an error when the file/path/input is invalid or the authoritative
    /// record/index transaction cannot commit.
    pub fn record(
        &self,
        project_root: &Path,
        input: RecordGeneratedAssetInput,
    ) -> Result<RecordGeneratedAssetResult, ProjectError> {
        self.record_checked(project_root, input, || Ok::<(), ProjectError>(()))
    }

    pub(crate) fn record_checked<E, F>(
        &self,
        project_root: &Path,
        input: RecordGeneratedAssetInput,
        mut check: F,
    ) -> Result<RecordGeneratedAssetResult, E>
    where
        E: From<ProjectError>,
        F: FnMut() -> Result<(), E>,
    {
        let project_lock = self.project_lock(project_root).map_err(E::from)?;
        let _project_guard = project_lock
            .lock()
            .map_err(|_| E::from(ProjectError::StatePoisoned))?;
        check()?;
        validate_model_run_id(&input.model_run_id).map_err(E::from)?;
        let relative =
            normalize_generated_asset_path(&input.project_relative_path).map_err(E::from)?;
        let mut budget = FingerprintBudget::lookup();
        let fingerprint_state =
            fingerprint_project_file(project_root, &relative, &mut budget, &mut check)?;
        let record_id = Uuid::new_v4().to_string();
        let created_at = now_iso();
        let record = GeneratedAssetRecord {
            record_id: record_id.clone(),
            model_run_id: input.model_run_id,
            project_relative_path: relative.clone(),
            created_at: created_at.clone(),
            artifact_role: input.artifact_role,
            artifact_index: input.artifact_index,
            fingerprint: fingerprint_state.fingerprint.clone(),
            model_run: input.model_run,
        };
        validate_record(&record).map_err(E::from)?;
        let mut index = read_index_state(project_root).map_err(E::from)?;
        if index.document.records.len() >= MAX_GENERATED_ASSET_RECORDS {
            return Err(E::from(ProjectError::service(
                "generated_asset_metadata_limit_reached",
                format!(
                    "Generated Asset metadata has reached its {MAX_GENERATED_ASSET_RECORDS}-record limit."
                ),
            )));
        }
        let metadata_path = generated_asset_record_project_path(&record_id).map_err(E::from)?;
        let record_absolute =
            resolve_no_symlink_project_path_for_write(project_root, &metadata_path)
                .map_err(E::from)?;
        index
            .document
            .records
            .push(GeneratedAssetMetadataIndexEntry {
                record_id,
                model_run_id: record.model_run_id.clone(),
                artifact_role: record.artifact_role,
                artifact_index: record.artifact_index,
                created_at,
                fingerprint: record.fingerprint.clone(),
                metadata_path,
            });
        let record_content =
            json_document(&record, MAX_GENERATED_ASSET_RECORD_BYTES).map_err(E::from)?;
        let index_content =
            json_document(&index.document, MAX_GENERATED_ASSET_INDEX_BYTES).map_err(E::from)?;
        check()?;
        commit_project_document_transaction_checked(
            &ProjectDocumentTransaction {
                project_root: project_root.to_path_buf(),
                owner: "generated-assets".to_owned(),
                reads: vec![
                    ProjectDocumentRead {
                        absolute_path: index.absolute_path.clone(),
                        expected_hash: index.expected_hash,
                    },
                    ProjectDocumentRead {
                        absolute_path: record_absolute.clone(),
                        expected_hash: None,
                    },
                ],
                writes: vec![
                    ProjectDocumentWrite {
                        absolute_path: record_absolute,
                        content: record_content,
                    },
                    ProjectDocumentWrite {
                        absolute_path: index.absolute_path,
                        content: index_content,
                    },
                ],
                deletes: Vec::new(),
            },
            &mut check,
        )?;
        Ok(RecordGeneratedAssetResult {
            record,
            diagnostic: None,
        })
    }

    /// Finds every Generated Asset record matching the current bytes at one path.
    ///
    /// # Errors
    /// Returns an error only when serialization state itself is unavailable. Expected
    /// file and metadata failures are represented by the closed lookup result.
    pub fn lookup(
        &self,
        project_root: &Path,
        project_relative_path: &str,
    ) -> Result<GeneratedAssetMetadataLookup, ProjectError> {
        let project_lock = self.project_lock(project_root)?;
        let _project_guard = project_lock
            .lock()
            .map_err(|_| ProjectError::StatePoisoned)?;
        let relative = match normalize_generated_asset_path(project_relative_path) {
            Ok(relative) => relative,
            Err(error) => {
                return Ok(GeneratedAssetMetadataLookup::Unavailable {
                    reason: GeneratedAssetUnavailableReason::Unreadable,
                    message: error.to_string(),
                    diagnostics: Vec::new(),
                });
            }
        };
        let mut budget = FingerprintBudget::lookup();
        let fingerprint = match fingerprint_file(project_root, &relative, &mut budget) {
            Ok(result) => result,
            Err(error) => {
                return Ok(GeneratedAssetMetadataLookup::Unavailable {
                    reason: if is_not_found(&error) {
                        GeneratedAssetUnavailableReason::Missing
                    } else {
                        GeneratedAssetUnavailableReason::Unreadable
                    },
                    message: error.to_string(),
                    diagnostics: Vec::new(),
                });
            }
        };
        let mut diagnostics = Vec::new();
        let index = match read_index_state(project_root) {
            Ok(index) => index.document,
            Err(error) => {
                return Ok(GeneratedAssetMetadataLookup::Unavailable {
                    reason: GeneratedAssetUnavailableReason::MetadataUnreadable,
                    message: format!("Unable to read generated asset metadata index: {error}"),
                    diagnostics,
                });
            }
        };
        let mut matches = index
            .records
            .into_iter()
            .filter(|entry| entry.fingerprint == fingerprint)
            .collect::<Vec<_>>();
        sort_index_entries(&mut matches);
        let mut records = Vec::new();
        for entry in matches {
            match read_record(project_root, &entry) {
                Ok(record) => records.push(record),
                Err(error) => push_diagnostic(
                    &mut diagnostics,
                    GeneratedAssetMetadataDiagnostic {
                        code: "generated_asset_metadata_record_unreadable".to_owned(),
                        message: error.to_string(),
                        record_id: Some(entry.record_id),
                        metadata_path: Some(entry.metadata_path),
                    },
                ),
            }
        }
        Ok(if records.is_empty() {
            GeneratedAssetMetadataLookup::Unmatched {
                fingerprint,
                diagnostics,
            }
        } else {
            GeneratedAssetMetadataLookup::Matched {
                fingerprint,
                records,
                diagnostics,
            }
        })
    }

    /// Lists all authoritative records newest first.
    ///
    /// # Errors
    /// Returns an error when the index or any referenced record is invalid.
    pub fn list(&self, project_root: &Path) -> Result<Vec<GeneratedAssetRecord>, ProjectError> {
        let project_lock = self.project_lock(project_root)?;
        let _project_guard = project_lock
            .lock()
            .map_err(|_| ProjectError::StatePoisoned)?;
        let mut entries = read_index_state(project_root)?.document.records;
        sort_index_entries(&mut entries);
        entries
            .iter()
            .map(|entry| read_record(project_root, entry))
            .collect()
    }

    /// Reads one authoritative record by id.
    ///
    /// # Errors
    /// Returns an error for invalid/missing ids, index, or record content.
    pub fn read(
        &self,
        project_root: &Path,
        record_id: &str,
    ) -> Result<GeneratedAssetRecord, ProjectError> {
        let project_lock = self.project_lock(project_root)?;
        let _project_guard = project_lock
            .lock()
            .map_err(|_| ProjectError::StatePoisoned)?;
        validate_record_id(record_id)?;
        let index = read_index_state(project_root)?.document;
        let entry = index
            .records
            .iter()
            .find(|entry| entry.record_id == record_id)
            .ok_or_else(|| {
                ProjectError::service(
                    "generated_asset_not_found",
                    format!("Generated Asset was not found: {record_id}"),
                )
            })?;
        read_record(project_root, entry)
    }

    /// Resolves a record to its current byte-identical visible Project path.
    ///
    /// # Errors
    /// Returns an error for invalid metadata, unreadable files, or serialization state.
    pub fn resolve_current_path(
        &self,
        project_root: &Path,
        record_id: &str,
    ) -> Result<Option<String>, ProjectError> {
        let project_lock = self.project_lock(project_root)?;
        let _project_guard = project_lock
            .lock()
            .map_err(|_| ProjectError::StatePoisoned)?;
        validate_record_id(record_id)?;
        let index = read_index_state(project_root)?.document;
        let entry = index
            .records
            .iter()
            .find(|entry| entry.record_id == record_id)
            .ok_or_else(|| {
                ProjectError::service(
                    "generated_asset_not_found",
                    format!("Generated Asset was not found: {record_id}"),
                )
            })?;
        let record = read_record(project_root, entry)?;
        find_current_path(project_root, &record)
    }

    fn project_lock(&self, project_root: &Path) -> Result<Arc<Mutex<()>>, ProjectError> {
        let mut project_locks = self
            .project_locks
            .lock()
            .map_err(|_| ProjectError::StatePoisoned)?;
        project_locks.retain(|_, project_lock| project_lock.strong_count() > 0);
        if let Some(project_lock) = project_locks.get(project_root).and_then(Weak::upgrade) {
            return Ok(project_lock);
        }
        let project_lock = Arc::new(Mutex::new(()));
        project_locks.insert(project_root.to_path_buf(), Arc::downgrade(&project_lock));
        Ok(project_lock)
    }
}

struct FingerprintState {
    fingerprint: GeneratedAssetFingerprint,
}

struct FingerprintBudget {
    deadline: Option<Instant>,
    maximum_files: usize,
    maximum_entries: usize,
    maximum_bytes: u64,
    files: usize,
    entries: usize,
    bytes: u64,
}

impl FingerprintBudget {
    fn lookup() -> Self {
        Self::bounded(1, MAX_LOOKUP_HASH_BYTES)
    }

    fn resolve() -> Self {
        Self::bounded(MAX_RESOLVE_HASH_FILES, MAX_RESOLVE_HASH_BYTES)
    }

    fn bounded(maximum_files: usize, maximum_bytes: u64) -> Self {
        Self {
            deadline: Some(Instant::now() + FINGERPRINT_OPERATION_TIMEOUT),
            maximum_files,
            maximum_entries: maximum_files,
            maximum_bytes,
            files: 0,
            entries: 0,
            bytes: 0,
        }
    }

    fn charge_file(&mut self, bytes: u64) -> Result<(), ProjectError> {
        self.check()?;
        self.files = self.files.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes);
        if self.files > self.maximum_files || self.bytes > self.maximum_bytes {
            return Err(ProjectError::service(
                "generated_asset_lookup_budget_exceeded",
                "Generated Asset lookup exceeded its bounded fingerprint budget.",
            ));
        }
        Ok(())
    }

    fn charge_entry(&mut self) -> Result<(), ProjectError> {
        self.check()?;
        self.entries = self.entries.saturating_add(1);
        if self.entries > self.maximum_entries {
            return Err(ProjectError::service(
                "generated_asset_lookup_budget_exceeded",
                "Generated Asset lookup exceeded its Project traversal budget.",
            ));
        }
        Ok(())
    }

    fn check(&self) -> Result<(), ProjectError> {
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            Err(ProjectError::service(
                "generated_asset_lookup_budget_exceeded",
                "Generated Asset lookup exceeded its fingerprint deadline.",
            ))
        } else {
            Ok(())
        }
    }
}

fn fingerprint_project_file<E, F>(
    project_root: &Path,
    relative: &str,
    budget: &mut FingerprintBudget,
    check: &mut F,
) -> Result<FingerprintState, E>
where
    E: From<ProjectError>,
    F: FnMut() -> Result<(), E>,
{
    check()?;
    let mut file =
        open_no_symlink_existing_project_file(project_root, relative).map_err(E::from)?;
    let identity = debrute_native_fs::file_identity(&file)
        .map_err(ProjectError::from)
        .map_err(E::from)?;
    let before = file
        .metadata()
        .map_err(ProjectError::from)
        .map_err(E::from)?;
    budget.charge_file(before.len()).map_err(E::from)?;
    let hash = sha256_file_checked(&mut file, || {
        budget.check().map_err(E::from)?;
        check()
    })?;
    let after = file
        .metadata()
        .map_err(ProjectError::from)
        .map_err(E::from)?;
    let current = open_no_symlink_existing_project_file(project_root, relative).map_err(E::from)?;
    if identity
        != debrute_native_fs::file_identity(&current)
            .map_err(ProjectError::from)
            .map_err(E::from)?
        || before.len() != after.len()
        || before
            .modified()
            .map_err(ProjectError::from)
            .map_err(E::from)?
            != after
                .modified()
                .map_err(ProjectError::from)
                .map_err(E::from)?
    {
        return Err(E::from(ProjectError::service(
            "project_path_changed",
            format!("Generated Asset changed while it was fingerprinted: {relative}"),
        )));
    }
    let fingerprint = GeneratedAssetFingerprint {
        algorithm: GeneratedAssetFingerprintAlgorithm::Sha256,
        hash,
    };
    Ok(FingerprintState { fingerprint })
}

fn fingerprint_file(
    project_root: &Path,
    relative: &str,
    budget: &mut FingerprintBudget,
) -> Result<GeneratedAssetFingerprint, ProjectError> {
    let mut no_cancel = || Ok::<(), ProjectError>(());
    let state = fingerprint_project_file(project_root, relative, budget, &mut no_cancel)?;
    Ok(state.fingerprint)
}

fn find_current_path(
    project_root: &Path,
    record: &GeneratedAssetRecord,
) -> Result<Option<String>, ProjectError> {
    let mut budget = FingerprintBudget::resolve();
    if project_path_matches(
        project_root,
        &record.project_relative_path,
        &record.fingerprint,
        &mut budget,
    )? {
        return Ok(Some(record.project_relative_path.clone()));
    }
    let mut found = None;
    visit_project_files(project_root, &mut |entry| {
        budget.charge_entry()?;
        if entry.kind == ProjectPathKind::File
            && entry.project_relative_path != record.project_relative_path
            && project_path_matches(
                project_root,
                &entry.project_relative_path,
                &record.fingerprint,
                &mut budget,
            )?
        {
            found = Some(entry.project_relative_path);
            Ok(false)
        } else {
            Ok(true)
        }
    })?;
    Ok(found)
}

fn project_path_matches(
    project_root: &Path,
    relative: &str,
    fingerprint: &GeneratedAssetFingerprint,
    budget: &mut FingerprintBudget,
) -> Result<bool, ProjectError> {
    let result = fingerprint_file(project_root, relative, budget);
    match result {
        Ok(current) => Ok(current == *fingerprint),
        Err(error) if is_not_found(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

fn read_index_state(
    project_root: &Path,
) -> Result<DocumentState<GeneratedAssetMetadataIndex>, ProjectError> {
    let capability = ProjectCapabilityFs::open(project_root)?;
    let absolute_path = resolve_no_symlink_project_path_for_write(
        project_root,
        GENERATED_ASSET_INDEX_PROJECT_PATH,
    )?;
    match capability.read_limited(
        GENERATED_ASSET_INDEX_PROJECT_PATH,
        MAX_GENERATED_ASSET_INDEX_BYTES,
    ) {
        Ok(bytes) => {
            let document: GeneratedAssetMetadataIndex = serde_json::from_slice(&bytes)?;
            validate_index(&document)?;
            Ok(DocumentState {
                expected_hash: Some(super::project_content_hash(&bytes)),
                absolute_path,
                document,
            })
        }
        Err(error) if is_not_found(&error) => Ok(DocumentState {
            absolute_path,
            expected_hash: None,
            document: GeneratedAssetMetadataIndex {
                records: Vec::new(),
            },
        }),
        Err(error) => Err(error),
    }
}

fn read_record(
    project_root: &Path,
    entry: &GeneratedAssetMetadataIndexEntry,
) -> Result<GeneratedAssetRecord, ProjectError> {
    let capability = ProjectCapabilityFs::open(project_root)?;
    let bytes = capability.read_limited(&entry.metadata_path, MAX_GENERATED_ASSET_RECORD_BYTES)?;
    let record: GeneratedAssetRecord = serde_json::from_slice(&bytes)?;
    validate_record(&record)?;
    if record.record_id != entry.record_id
        || record.model_run_id != entry.model_run_id
        || record.artifact_role != entry.artifact_role
        || record.artifact_index != entry.artifact_index
        || record.created_at != entry.created_at
        || record.fingerprint != entry.fingerprint
    {
        return Err(ProjectError::service(
            "generated_asset_metadata_record_invalid",
            format!(
                "Generated Asset record does not match its index entry: {}",
                entry.metadata_path
            ),
        ));
    }
    Ok(record)
}

fn validate_index(index: &GeneratedAssetMetadataIndex) -> Result<(), ProjectError> {
    if index.records.len() > MAX_GENERATED_ASSET_RECORDS {
        return invalid_metadata("Generated Asset index contains too many records.");
    }
    let mut ids = std::collections::BTreeSet::new();
    for entry in &index.records {
        validate_record_id(&entry.record_id)?;
        validate_model_run_id(&entry.model_run_id)?;
        validate_timestamp(&entry.created_at)?;
        validate_fingerprint(&entry.fingerprint)?;
        if !ids.insert(&entry.record_id)
            || generated_asset_record_project_path(&entry.record_id)? != entry.metadata_path
        {
            return invalid_metadata(
                "Generated Asset index contains a duplicate or invalid entry.",
            );
        }
    }
    Ok(())
}

fn validate_record(record: &GeneratedAssetRecord) -> Result<(), ProjectError> {
    validate_record_id(&record.record_id)?;
    validate_model_run_id(&record.model_run_id)?;
    normalize_generated_asset_path(&record.project_relative_path)?;
    validate_timestamp(&record.created_at)?;
    validate_fingerprint(&record.fingerprint)
}

fn validate_fingerprint(fingerprint: &GeneratedAssetFingerprint) -> Result<(), ProjectError> {
    if fingerprint.algorithm != GeneratedAssetFingerprintAlgorithm::Sha256
        || !is_sha256(&fingerprint.hash)
    {
        invalid_metadata("Generated Asset fingerprint is invalid.")
    } else {
        Ok(())
    }
}

fn validate_record_id(value: &str) -> Result<(), ProjectError> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-' | b'.'))
        })
        || matches!(value, "." | "..")
    {
        invalid_metadata("Generated Asset record id is invalid.")
    } else {
        Ok(())
    }
}

fn validate_model_run_id(value: &str) -> Result<(), ProjectError> {
    if value.is_empty()
        || value.len() > MAX_MODEL_RUN_ID_BYTES
        || value.chars().any(char::is_control)
    {
        invalid_metadata("Generated Asset Model Run id is invalid.")
    } else {
        Ok(())
    }
}

fn validate_timestamp(value: &str) -> Result<(), ProjectError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map(|_| ())
        .map_err(|_| {
            ProjectError::service(
                "generated_asset_metadata_invalid",
                "Generated Asset timestamp is invalid.",
            )
        })
}

fn normalize_generated_asset_path(value: &str) -> Result<String, ProjectError> {
    if value.len() > MAX_PROJECT_PATH_BYTES {
        return invalid_metadata("Generated Asset Project path is too long.");
    }
    let relative = normalize_project_relative_path(value).map_err(|_| {
        ProjectError::service(
            "generated_asset_path_invalid",
            "Generated Asset output must be ordinary visible Project content.",
        )
    })?;
    assert_project_tree_visible_mutation_path(&relative).map_err(|_| {
        ProjectError::service(
            "generated_asset_path_invalid",
            "Generated Asset output must be ordinary visible Project content.",
        )
    })?;
    if relative == GENERATED_ASSET_INDEX_PROJECT_PATH
        || relative == GENERATED_ASSET_RECORDS_PROJECT_DIRECTORY
        || relative.starts_with(&format!("{GENERATED_ASSET_RECORDS_PROJECT_DIRECTORY}/"))
    {
        return Err(ProjectError::service(
            "generated_asset_path_invalid",
            "Generated Asset output cannot be Generated Asset metadata.",
        ));
    }
    Ok(relative)
}

fn generated_asset_record_project_path(record_id: &str) -> Result<String, ProjectError> {
    validate_record_id(record_id)?;
    Ok(format!(
        "{GENERATED_ASSET_RECORDS_PROJECT_DIRECTORY}/{record_id}.json"
    ))
}

fn sha256_file_checked<E, F>(file: &mut File, mut check: F) -> Result<String, E>
where
    E: From<ProjectError>,
    F: FnMut() -> Result<(), E>,
{
    file.seek(SeekFrom::Start(0))
        .map_err(ProjectError::from)
        .map_err(E::from)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        check()?;
        let read = file
            .read(&mut buffer)
            .map_err(ProjectError::from)
            .map_err(E::from)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn json_document(value: &impl Serialize, max_bytes: usize) -> Result<String, ProjectError> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    if bytes.len() > max_bytes {
        return Err(ProjectError::service(
            "generated_asset_metadata_too_large",
            format!("Generated Asset metadata exceeds {max_bytes} bytes."),
        ));
    }
    String::from_utf8(bytes).map_err(|error| ProjectError::Validation(error.to_string()))
}

fn sort_index_entries(entries: &mut [GeneratedAssetMetadataIndexEntry]) {
    entries.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.record_id.cmp(&left.record_id))
    });
}

fn push_diagnostic(
    diagnostics: &mut Vec<GeneratedAssetMetadataDiagnostic>,
    diagnostic: GeneratedAssetMetadataDiagnostic,
) {
    if diagnostics.len() < MAX_DIAGNOSTICS {
        diagnostics.push(diagnostic);
    }
}

fn now_iso() -> String {
    crate::now_rfc3339()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn is_not_found(error: &ProjectError) -> bool {
    matches!(error, ProjectError::Io(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory))
}

fn invalid_metadata<T>(message: impl Into<String>) -> Result<T, ProjectError> {
    Err(ProjectError::service(
        "generated_asset_metadata_invalid",
        message,
    ))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("debrute-assets-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn input(path: &str) -> RecordGeneratedAssetInput {
        RecordGeneratedAssetInput {
            model_run_id: "run-1".to_owned(),
            project_relative_path: path.to_owned(),
            artifact_role: GeneratedArtifactRole::PrimaryImage,
            artifact_index: 0,
            model_run: GeneratedModelRun {
                request: serde_json::json!({"prompt":"fixture"}),
                output: serde_json::json!({"status":"ok"}),
            },
        }
    }

    #[test]
    fn record_and_lookup_follow_content_after_a_move() {
        let root = fixture();
        fs::create_dir_all(root.join("generated")).unwrap();
        fs::write(root.join("generated/one.png"), b"same bytes").unwrap();
        let service = GeneratedAssetMetadataService::new();
        let recorded = service.record(&root, input("generated/one.png")).unwrap();
        assert!(recorded.diagnostic.is_none());
        fs::rename(
            root.join("generated/one.png"),
            root.join("generated/moved.png"),
        )
        .unwrap();

        let lookup = service.lookup(&root, "generated/moved.png").unwrap();
        let GeneratedAssetMetadataLookup::Matched { records, .. } = lookup else {
            panic!("moved byte-identical content should match");
        };
        assert_eq!(records, vec![recorded.record.clone()]);
        assert_eq!(
            service
                .resolve_current_path(&root, &recorded.record.record_id)
                .unwrap()
                .as_deref(),
            Some("generated/moved.png")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edited_bytes_do_not_match_the_recorded_asset() {
        let root = fixture();
        fs::write(root.join("one.png"), b"original").unwrap();
        let service = GeneratedAssetMetadataService::new();
        service.record(&root, input("one.png")).unwrap();
        fs::write(root.join("one.png"), b"edited bytes").unwrap();

        assert!(matches!(
            service.lookup(&root, "one.png").unwrap(),
            GeneratedAssetMetadataLookup::Unmatched { .. }
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_matching_record_is_item_local_diagnostic() {
        let root = fixture();
        fs::write(root.join("one.png"), b"fixture").unwrap();
        let service = GeneratedAssetMetadataService::new();
        let recorded = service.record(&root, input("one.png")).unwrap();
        let record_path =
            root.join(generated_asset_record_project_path(&recorded.record.record_id).unwrap());
        fs::write(record_path, "{}\n").unwrap();

        let GeneratedAssetMetadataLookup::Unmatched { diagnostics, .. } =
            service.lookup(&root, "one.png").unwrap()
        else {
            panic!("a corrupt sole record leaves the content unmatched");
        };
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(
            diagnostics[0].code,
            "generated_asset_metadata_record_unreadable"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_outputs_cannot_be_recorded_as_generated_assets() {
        let root = fixture();
        let service = GeneratedAssetMetadataService::new();
        for path in [
            ".debrute/project.json",
            ".debrute/canvases/index.json",
            GENERATED_ASSET_INDEX_PROJECT_PATH,
            ".debrute/assets/generated/record.json",
        ] {
            let error = service.record(&root, input(path)).unwrap_err();
            assert_eq!(error.code(), "generated_asset_path_invalid", "{path}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lookup_rehashes_when_size_and_mtime_are_unchanged() {
        let root = fixture();
        let path = root.join("one.png");
        fs::write(&path, b"original").unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let service = GeneratedAssetMetadataService::new();
        service.record(&root, input("one.png")).unwrap();
        fs::write(&path, b"changed!").unwrap();
        fs::File::open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();

        assert!(matches!(
            service.lookup(&root, "one.png").unwrap(),
            GeneratedAssetMetadataLookup::Unmatched { .. }
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checked_record_cleans_staged_metadata_before_the_commit_point() {
        let root = fixture();
        fs::write(root.join("one.png"), b"fixture").unwrap();
        let service = GeneratedAssetMetadataService::new();
        let mut checks = 0;
        let error = service
            .record_checked::<ProjectError, _>(&root, input("one.png"), || {
                checks += 1;
                if checks == 14 {
                    Err(ProjectError::service(
                        "generation_cancelled",
                        "injected cancellation",
                    ))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();

        assert_eq!(error.code(), "generation_cancelled");
        assert!(!root.join(GENERATED_ASSET_INDEX_PROJECT_PATH).exists());
        let record_directory = root.join(".debrute/assets/generated");
        assert!(
            !record_directory.exists() || fs::read_dir(record_directory).unwrap().next().is_none(),
            "staged record must not become authoritative"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lookup_rejects_files_above_its_hash_budget_without_reading_them() {
        let root = fixture();
        let file = fs::File::create(root.join("huge.bin")).unwrap();
        file.set_len(MAX_LOOKUP_HASH_BYTES + 1).unwrap();
        let lookup = GeneratedAssetMetadataService::new()
            .lookup(&root, "huge.bin")
            .unwrap();
        let GeneratedAssetMetadataLookup::Unavailable { message, .. } = lookup else {
            panic!("over-budget lookup must be unavailable");
        };
        assert!(message.contains("budget"));
        fs::remove_dir_all(root).unwrap();
    }
}
