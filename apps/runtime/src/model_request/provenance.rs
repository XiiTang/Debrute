//! User-global, content-addressed provenance for Model Artifacts.

use std::{
    fs::{self, File},
    io::Read as _,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::project::{ProjectError, replace_file};

const MAX_PROVENANCE_RECORD_BYTES: u64 = 35 * 1024 * 1024;
const MAX_TRACE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelArtifactProvenanceResponse {
    pub trace: Vec<serde_json::Value>,
    pub output: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelArtifactProvenanceRecord {
    pub operation_id: String,
    pub item_index: u64,
    pub artifact_index: u64,
    pub output_path: String,
    pub created_at: String,
    pub mime_type: String,
    pub request: serde_json::Value,
    pub response: ModelArtifactProvenanceResponse,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordModelArtifactProvenanceInput {
    pub operation_id: String,
    pub item_index: u64,
    pub artifact_index: u64,
    pub output_path: PathBuf,
    pub mime_type: String,
    pub request: serde_json::Value,
    pub response: ModelArtifactProvenanceResponse,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArtifactProvenanceLookup {
    pub sha256: String,
    pub record: Option<ModelArtifactProvenanceRecord>,
}

pub struct ModelArtifactProvenanceStore {
    directory: PathBuf,
    io: Mutex<()>,
}

pub(crate) struct ModelArtifactProvenanceCommit<'a> {
    store: &'a ModelArtifactProvenanceStore,
    _io: MutexGuard<'a, ()>,
}

impl ModelArtifactProvenanceStore {
    #[must_use]
    pub fn new(debrute_home: &Path) -> Self {
        Self {
            directory: debrute_home.join("model-artifacts"),
            io: Mutex::new(()),
        }
    }

    pub(crate) fn begin_commit(&self) -> ModelArtifactProvenanceCommit<'_> {
        ModelArtifactProvenanceCommit {
            store: self,
            _io: self.lock(),
        }
    }

    fn record_unlocked(
        &self,
        input: RecordModelArtifactProvenanceInput,
    ) -> Result<ModelArtifactProvenanceRecord, ProjectError> {
        if input.operation_id.is_empty()
            || input.mime_type.is_empty()
            || input.mime_type.trim() != input.mime_type
        {
            return invalid_provenance("Model Artifact provenance is invalid.");
        }
        if serde_json::to_vec(&input.response.trace)?.len() > MAX_TRACE_BYTES {
            return invalid_provenance("Model Artifact provenance trace exceeds 2 MiB.");
        }
        let output_path = input.output_path.canonicalize()?;
        if !output_path.is_file() {
            return invalid_provenance("Model Artifact outputPath must identify a file.");
        }
        let output_path = output_path.to_str().ok_or_else(|| {
            ProjectError::service(
                "model_artifact_provenance_invalid",
                "Model Artifact outputPath must be UTF-8.",
            )
        })?;
        let sha256 = hash_file(Path::new(output_path))?;
        let record = ModelArtifactProvenanceRecord {
            operation_id: input.operation_id,
            item_index: input.item_index,
            artifact_index: input.artifact_index,
            output_path: output_path.to_owned(),
            created_at: crate::now_rfc3339(),
            mime_type: input.mime_type,
            request: input.request,
            response: input.response,
        };
        let bytes = serde_json::to_vec(&record)?;
        if u64::try_from(bytes.len()).expect("usize fits u64") > MAX_PROVENANCE_RECORD_BYTES {
            return invalid_provenance("Model Artifact provenance exceeds 35 MiB.");
        }
        fs::create_dir_all(&self.directory)?;
        let target = self.directory.join(format!("{sha256}.json"));
        let temporary = self.directory.join(format!(".{sha256}.tmp"));
        fs::write(&temporary, bytes)?;
        if let Err(error) = replace_file(&temporary, &target) {
            let _ = fs::remove_file(&temporary);
            return Err(ProjectError::service(
                "model_artifact_provenance_persistence_failed",
                error.to_string(),
            ));
        }
        Ok(record)
    }

    /// Looks up provenance for the current contents of one file.
    ///
    /// # Errors
    /// Returns an error when the file cannot be hashed or existing metadata is damaged.
    pub fn lookup(&self, path: &Path) -> Result<ModelArtifactProvenanceLookup, ProjectError> {
        let _io = self.lock();
        let sha256 = hash_file(path)?;
        let metadata_path = self.directory.join(format!("{sha256}.json"));
        let record = match File::open(&metadata_path) {
            Ok(file) => Some(read_record(file)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(ModelArtifactProvenanceLookup { sha256, record })
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.io
            .lock()
            .expect("Model Artifact provenance store lock poisoned")
    }
}

impl ModelArtifactProvenanceCommit<'_> {
    pub(crate) fn record(
        &self,
        input: RecordModelArtifactProvenanceInput,
    ) -> Result<ModelArtifactProvenanceRecord, ProjectError> {
        self.store.record_unlocked(input)
    }
}

fn read_record(mut file: File) -> Result<ModelArtifactProvenanceRecord, ProjectError> {
    let size = file.metadata()?.len();
    if size > MAX_PROVENANCE_RECORD_BYTES {
        return invalid_provenance("Model Artifact provenance exceeds 35 MiB.");
    }
    let mut bytes = Vec::with_capacity(usize::try_from(size).expect("35 MiB fits usize"));
    file.read_to_end(&mut bytes)?;
    let record = serde_json::from_slice(&bytes)?;
    Ok(record)
}

fn hash_file(path: &Path) -> Result<String, ProjectError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn invalid_provenance<T>(message: impl Into<String>) -> Result<T, ProjectError> {
    Err(ProjectError::service(
        "model_artifact_provenance_invalid",
        message,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_compact_record_is_stored_directly_by_content_hash() {
        let home = std::env::temp_dir().join(format!("dbrt-provenance-{}", uuid::Uuid::new_v4()));
        let output = home.join("output.png");
        fs::create_dir_all(&home).unwrap();
        fs::write(&output, b"model artifact bytes").unwrap();
        let store = ModelArtifactProvenanceStore::new(&home.join(".debrute"));
        let record = store
            .begin_commit()
            .record(RecordModelArtifactProvenanceInput {
                operation_id: "operation-1".to_owned(),
                item_index: 2,
                artifact_index: 0,
                output_path: output.clone(),
                mime_type: "image/png".to_owned(),
                request: serde_json::json!({"prompt": "fixture"}),
                response: ModelArtifactProvenanceResponse {
                    trace: vec![serde_json::json!({"status": 200})],
                    output: serde_json::json!({"artifactIndex": 0}),
                },
            })
            .unwrap();
        let lookup = store.lookup(&output).unwrap();
        assert_eq!(lookup.record, Some(record));
        assert!(
            home.join(".debrute/model-artifacts")
                .join(format!("{}.json", lookup.sha256))
                .is_file()
        );
        fs::remove_dir_all(home).unwrap();
    }
}
