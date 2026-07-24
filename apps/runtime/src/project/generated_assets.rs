//! Project-owned Generated Asset provenance and content-fingerprint lookup.

use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read as _, Seek as _, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use super::{
    ProjectCapabilityFileStage, ProjectCapabilityFileWrite, ProjectCapabilityFs, ProjectError,
    assert_project_tree_visible_mutation_path, normalize_project_relative_path,
    open_no_symlink_existing_project_file,
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

pub(crate) struct CommitGeneratedAssetFile {
    pub(crate) input: RecordGeneratedAssetInput,
    pub(crate) content: Vec<u8>,
    pub(crate) replace: bool,
}

pub(crate) struct StagedGeneratedAssetFiles {
    files: ProjectCapabilityFileStage,
    metadata: Vec<StagedGeneratedAssetMetadata>,
}

struct StagedGeneratedAssetMetadata {
    input: RecordGeneratedAssetInput,
    fingerprint: GeneratedAssetFingerprint,
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
        diagnostics: Vec<GeneratedAssetMetadataDiagnostic>,
    },
    Unmatched {
        fingerprint: GeneratedAssetFingerprint,
        diagnostics: Vec<GeneratedAssetMetadataDiagnostic>,
    },
    Unavailable {
        reason: GeneratedAssetUnavailableReason,
        message: String,
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

#[derive(Default)]
pub struct GeneratedAssetMetadataService {
    project_locks: Mutex<BTreeMap<PathBuf, Weak<Mutex<()>>>>,
}

pub(crate) struct GeneratedAssetProjectCommit<'a> {
    project_root: &'a Path,
}

impl GeneratedAssetProjectCommit<'_> {
    pub(crate) fn commit_staged_generated_files(
        self,
        staged: StagedGeneratedAssetFiles,
    ) -> Result<(), ProjectError> {
        GeneratedAssetMetadataService::commit_staged_generated_files_locked(
            self.project_root,
            staged,
        )
    }
}

impl GeneratedAssetMetadataService {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn stage_generated_files(
        capability: &ProjectCapabilityFs,
        files: Vec<CommitGeneratedAssetFile>,
    ) -> Result<StagedGeneratedAssetFiles, ProjectError> {
        let mut writes = Vec::with_capacity(files.len());
        let mut metadata = Vec::with_capacity(files.len());
        for file in files {
            validate_model_run_id(&file.input.model_run_id)?;
            let relative = normalize_generated_asset_path(&file.input.project_relative_path)?;
            let fingerprint = GeneratedAssetFingerprint {
                algorithm: GeneratedAssetFingerprintAlgorithm::Sha256,
                hash: format!("{:x}", Sha256::digest(&file.content)),
            };
            let mut input = file.input;
            input.project_relative_path.clone_from(&relative);
            writes.push(ProjectCapabilityFileWrite {
                project_relative_path: relative,
                content: file.content,
                replace: file.replace,
            });
            metadata.push(StagedGeneratedAssetMetadata { input, fingerprint });
        }
        Ok(StagedGeneratedAssetFiles {
            files: capability.stage_files(writes)?,
            metadata,
        })
    }

    pub(crate) fn with_project_commit<T, E, F>(
        &self,
        project_root: &Path,
        action: F,
    ) -> Result<T, E>
    where
        E: From<ProjectError>,
        F: FnOnce(GeneratedAssetProjectCommit<'_>) -> Result<T, E>,
    {
        let project_lock = self.project_lock(project_root);
        let _project_guard = lock(&project_lock, "generated asset Project");
        action(GeneratedAssetProjectCommit { project_root })
    }

    fn commit_staged_generated_files_locked(
        project_root: &Path,
        staged: StagedGeneratedAssetFiles,
    ) -> Result<(), ProjectError> {
        if !project_root.is_absolute() {
            return Err(ProjectError::Validation(
                "Generated Asset commit requires an absolute Project root.".to_owned(),
            ));
        }
        if staged.metadata.is_empty() {
            return Ok(());
        }
        let mut index = read_index_from_capability(staged.files.capability())?;
        if index.records.len().saturating_add(staged.metadata.len()) > MAX_GENERATED_ASSET_RECORDS {
            return Err(ProjectError::service(
                "generated_asset_metadata_limit_reached",
                format!(
                    "Generated Asset metadata would exceed its {MAX_GENERATED_ASSET_RECORDS}-record limit."
                ),
            ));
        }

        let StagedGeneratedAssetFiles { files, metadata } = staged;
        let mut writes = Vec::with_capacity(metadata.len().saturating_add(1));
        for staged in metadata {
            let relative = staged.input.project_relative_path.clone();
            let record_id = Uuid::new_v4().to_string();
            let created_at = crate::now_rfc3339();
            let record = GeneratedAssetRecord {
                record_id: record_id.clone(),
                model_run_id: staged.input.model_run_id,
                project_relative_path: relative.clone(),
                created_at: created_at.clone(),
                artifact_role: staged.input.artifact_role,
                artifact_index: staged.input.artifact_index,
                fingerprint: staged.fingerprint.clone(),
                model_run: staged.input.model_run,
            };
            validate_record(&record)?;
            let metadata_path = generated_asset_record_project_path(&record_id)?;
            index.records.push(GeneratedAssetMetadataIndexEntry {
                record_id,
                model_run_id: record.model_run_id.clone(),
                artifact_role: record.artifact_role,
                artifact_index: record.artifact_index,
                created_at,
                fingerprint: staged.fingerprint,
                metadata_path: metadata_path.clone(),
            });
            writes.push(ProjectCapabilityFileWrite {
                project_relative_path: metadata_path,
                content: json_document(&record, MAX_GENERATED_ASSET_RECORD_BYTES)?.into_bytes(),
                replace: false,
            });
        }
        writes.push(ProjectCapabilityFileWrite {
            project_relative_path: GENERATED_ASSET_INDEX_PROJECT_PATH.to_owned(),
            content: json_document(&index, MAX_GENERATED_ASSET_INDEX_BYTES)?.into_bytes(),
            replace: true,
        });
        files.commit_more(writes)?;
        Ok(())
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
        let project_lock = self.project_lock(project_root);
        let _project_guard = lock(&project_lock, "generated asset Project");
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
        let fingerprint = match fingerprint_file(project_root, &relative) {
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
            Ok(index) => index,
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

    fn project_lock(&self, project_root: &Path) -> Arc<Mutex<()>> {
        let mut project_locks = lock(&self.project_locks, "generated asset Project registry");
        project_locks.retain(|_, project_lock| project_lock.strong_count() > 0);
        if let Some(project_lock) = project_locks.get(project_root).and_then(Weak::upgrade) {
            return project_lock;
        }
        let project_lock = Arc::new(Mutex::new(()));
        project_locks.insert(project_root.to_path_buf(), Arc::downgrade(&project_lock));
        project_lock
    }
}

fn lock<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    mutex
        .lock()
        .unwrap_or_else(|_| panic!("{name} lock poisoned"))
}

fn fingerprint_file(
    project_root: &Path,
    relative: &str,
) -> Result<GeneratedAssetFingerprint, ProjectError> {
    let deadline = Instant::now() + FINGERPRINT_OPERATION_TIMEOUT;
    let mut file = open_no_symlink_existing_project_file(project_root, relative)?;
    let identity = debrute_native_fs::file_identity(&file).map_err(ProjectError::from)?;
    let before = file.metadata()?;
    if before.len() > MAX_LOOKUP_HASH_BYTES {
        return Err(ProjectError::service(
            "generated_asset_lookup_budget_exceeded",
            "Generated Asset lookup exceeded its bounded fingerprint budget.",
        ));
    }
    let hash = sha256_file_checked(&mut file, || {
        if Instant::now() >= deadline {
            Err(ProjectError::service(
                "generated_asset_lookup_budget_exceeded",
                "Generated Asset lookup exceeded its fingerprint deadline.",
            ))
        } else {
            Ok(())
        }
    })?;
    let after = file.metadata()?;
    let current = open_no_symlink_existing_project_file(project_root, relative)?;
    if identity != debrute_native_fs::file_identity(&current).map_err(ProjectError::from)?
        || before.len() != after.len()
        || before.modified()? != after.modified()?
    {
        return Err(ProjectError::service(
            "project_path_changed",
            format!("Generated Asset changed while it was fingerprinted: {relative}"),
        ));
    }
    Ok(GeneratedAssetFingerprint {
        algorithm: GeneratedAssetFingerprintAlgorithm::Sha256,
        hash,
    })
}

fn read_index_state(project_root: &Path) -> Result<GeneratedAssetMetadataIndex, ProjectError> {
    let capability = ProjectCapabilityFs::open(project_root)?;
    match capability.read_limited(
        GENERATED_ASSET_INDEX_PROJECT_PATH,
        MAX_GENERATED_ASSET_INDEX_BYTES,
    ) {
        Ok(bytes) => {
            let document: GeneratedAssetMetadataIndex = serde_json::from_slice(&bytes)?;
            validate_index(&document)?;
            Ok(document)
        }
        Err(error) if is_not_found(&error) => Ok(GeneratedAssetMetadataIndex {
            records: Vec::new(),
        }),
        Err(error) => Err(error),
    }
}

fn read_index_from_capability(
    capability: &ProjectCapabilityFs,
) -> Result<GeneratedAssetMetadataIndex, ProjectError> {
    match capability.read_limited(
        GENERATED_ASSET_INDEX_PROJECT_PATH,
        MAX_GENERATED_ASSET_INDEX_BYTES,
    ) {
        Ok(bytes) => {
            let document: GeneratedAssetMetadataIndex = serde_json::from_slice(&bytes)?;
            validate_index(&document)?;
            Ok(document)
        }
        Err(error) if is_not_found(&error) => Ok(GeneratedAssetMetadataIndex {
            records: Vec::new(),
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

fn sha256_file_checked(
    file: &mut File,
    mut check: impl FnMut() -> Result<(), ProjectError>,
) -> Result<String, ProjectError> {
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        check()?;
        let read = file.read(&mut buffer)?;
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
    fn lookup_serialization_includes_an_empty_diagnostics_array() {
        let lookup = GeneratedAssetMetadataLookup::Unmatched {
            fingerprint: GeneratedAssetFingerprint {
                algorithm: GeneratedAssetFingerprintAlgorithm::Sha256,
                hash: "fixture".to_owned(),
            },
            diagnostics: Vec::new(),
        };

        let serialized = serde_json::to_value(lookup).expect("lookup serialization");
        assert_eq!(serialized["diagnostics"], serde_json::json!([]));
    }

    fn commit_files(
        service: &GeneratedAssetMetadataService,
        root: &Path,
        files: &[(&str, &[u8])],
    ) -> Result<(), ProjectError> {
        let capability = ProjectCapabilityFs::open(root)?;
        let staged = GeneratedAssetMetadataService::stage_generated_files(
            &capability,
            files
                .iter()
                .enumerate()
                .map(|(index, (path, content))| {
                    let mut input = input(path);
                    input.artifact_index = u64::try_from(index).unwrap();
                    CommitGeneratedAssetFile {
                        input,
                        content: (*content).to_vec(),
                        replace: false,
                    }
                })
                .collect(),
        )?;
        service.with_project_commit(root, |commit| commit.commit_staged_generated_files(staged))
    }

    #[test]
    fn committed_asset_lookup_follows_content_after_a_move() {
        let root = fixture();
        let service = GeneratedAssetMetadataService::new();
        commit_files(&service, &root, &[("generated/one.png", b"same bytes")]).unwrap();
        let GeneratedAssetMetadataLookup::Matched { mut records, .. } =
            service.lookup(&root, "generated/one.png").unwrap()
        else {
            panic!("committed content should match before it moves");
        };
        let recorded = records.remove(0);
        fs::rename(
            root.join("generated/one.png"),
            root.join("generated/moved.png"),
        )
        .unwrap();

        let lookup = service.lookup(&root, "generated/moved.png").unwrap();
        let GeneratedAssetMetadataLookup::Matched { records, .. } = lookup else {
            panic!("moved byte-identical content should match");
        };
        assert_eq!(records, vec![recorded]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staged_commit_publishes_every_asset_and_one_index() {
        let root = fixture();
        let service = GeneratedAssetMetadataService::new();
        commit_files(&service, &root, &[("one.png", b"one"), ("two.png", b"two")]).unwrap();
        for path in ["one.png", "two.png"] {
            let GeneratedAssetMetadataLookup::Matched { records, .. } =
                service.lookup(&root, path).unwrap()
            else {
                panic!("committed content should match: {path}");
            };
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].project_relative_path, path);
        }
        let index: GeneratedAssetMetadataIndex = serde_json::from_slice(
            &fs::read(root.join(GENERATED_ASSET_INDEX_PROJECT_PATH)).unwrap(),
        )
        .unwrap();
        assert_eq!(index.records.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edited_bytes_do_not_match_the_recorded_asset() {
        let root = fixture();
        let service = GeneratedAssetMetadataService::new();
        commit_files(&service, &root, &[("one.png", b"original")]).unwrap();
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
        let service = GeneratedAssetMetadataService::new();
        commit_files(&service, &root, &[("one.png", b"fixture")]).unwrap();
        let GeneratedAssetMetadataLookup::Matched { mut records, .. } =
            service.lookup(&root, "one.png").unwrap()
        else {
            panic!("committed content should match before its record is corrupted");
        };
        let recorded = records.remove(0);
        let record_path =
            root.join(generated_asset_record_project_path(&recorded.record_id).unwrap());
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
            let error = commit_files(&service, &root, &[(path, b"fixture")]).unwrap_err();
            assert_eq!(error.code(), "generated_asset_path_invalid", "{path}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lookup_rehashes_when_size_and_mtime_are_unchanged() {
        let root = fixture();
        let path = root.join("one.png");
        let service = GeneratedAssetMetadataService::new();
        commit_files(&service, &root, &[("one.png", b"original")]).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, b"changed!").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
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
