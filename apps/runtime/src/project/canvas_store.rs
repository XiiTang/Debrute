use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
};

use uuid::Uuid;

use crate::global::root_state_directory;

use super::{
    CanvasState, CanvasWorkspaceCanvas, CanvasWorkspaceDocument, CanvasWorkspaceUnavailable,
    CanvasWorkspaceUnavailableCode, normalize_canvas_name, replace_file, validate_canvas_id,
    validate_canvas_state,
};

const CANVAS_WORKSPACE_FILE: &str = "canvas.json";

pub(crate) struct CanvasWorkspaceStore {
    canonical_root: String,
    path: PathBuf,
}

impl CanvasWorkspaceStore {
    pub(crate) fn new(debrute_home: &Path, canonical_root: &str) -> Self {
        Self {
            canonical_root: canonical_root.to_owned(),
            path: root_state_directory(debrute_home, canonical_root).join(CANVAS_WORKSPACE_FILE),
        }
    }

    pub(crate) fn load_or_create(
        &self,
    ) -> Result<CanvasWorkspaceDocument, CanvasWorkspaceUnavailable> {
        match fs::read(&self.path) {
            Ok(bytes) => {
                let document =
                    serde_json::from_slice::<CanvasWorkspaceDocument>(&bytes).map_err(|error| {
                        canvas_workspace_unavailable(
                            CanvasWorkspaceUnavailableCode::CanvasWorkspaceInvalid,
                            format!("Canvas workspace JSON is invalid: {error}"),
                        )
                    })?;
                validate_canvas_workspace(&document, &self.canonical_root)?;
                Ok(document)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let document = default_canvas_workspace(&self.canonical_root);
                self.save(&document)?;
                Ok(document)
            }
            Err(error) => Err(canvas_workspace_unavailable(
                CanvasWorkspaceUnavailableCode::CanvasWorkspaceUnreadable,
                format!("Canvas workspace cannot be read: {error}"),
            )),
        }
    }

    pub(crate) fn save(
        &self,
        document: &CanvasWorkspaceDocument,
    ) -> Result<(), CanvasWorkspaceUnavailable> {
        validate_canvas_workspace(document, &self.canonical_root)?;
        let parent = self.path.parent().ok_or_else(|| {
            canvas_workspace_unavailable(
                CanvasWorkspaceUnavailableCode::CanvasWorkspacePersistenceFailed,
                "Canvas workspace path has no parent directory.",
            )
        })?;
        fs::create_dir_all(parent).map_err(|error| canvas_workspace_persistence_error(&error))?;
        let temporary = parent.join(format!(".canvas.{}.tmp", Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(document)
            .map_err(|error| canvas_workspace_persistence_error(&error))?;
        fs::write(&temporary, bytes).map_err(|error| canvas_workspace_persistence_error(&error))?;
        if let Err(error) = replace_file(&temporary, &self.path) {
            let _ = fs::remove_file(&temporary);
            return Err(canvas_workspace_unavailable(
                CanvasWorkspaceUnavailableCode::CanvasWorkspacePersistenceFailed,
                error.to_string(),
            ));
        }
        Ok(())
    }
}

fn canvas_workspace_persistence_error(error: &impl ToString) -> CanvasWorkspaceUnavailable {
    canvas_workspace_unavailable(
        CanvasWorkspaceUnavailableCode::CanvasWorkspacePersistenceFailed,
        error.to_string(),
    )
}

fn canvas_workspace_unavailable(
    code: CanvasWorkspaceUnavailableCode,
    message: impl Into<String>,
) -> CanvasWorkspaceUnavailable {
    CanvasWorkspaceUnavailable::new(code, message)
}

#[must_use]
pub(crate) fn default_canvas_workspace(canonical_root: &str) -> CanvasWorkspaceDocument {
    CanvasWorkspaceDocument {
        canonical_root: canonical_root.to_owned(),
        active_canvas_id: "main".to_owned(),
        canvases: vec![CanvasWorkspaceCanvas {
            id: "main".to_owned(),
            name: "Main".to_owned(),
            state: CanvasState::default(),
        }],
    }
}

pub(crate) fn validate_canvas_workspace(
    document: &CanvasWorkspaceDocument,
    canonical_root: &str,
) -> Result<(), CanvasWorkspaceUnavailable> {
    if document.canonical_root != canonical_root {
        return Err(canvas_workspace_unavailable(
            CanvasWorkspaceUnavailableCode::CanvasWorkspaceRootMismatch,
            "Canvas workspace canonicalRoot does not match its root-state bucket.",
        ));
    }
    if document.canvases.is_empty() {
        return Err(canvas_workspace_unavailable(
            CanvasWorkspaceUnavailableCode::CanvasWorkspaceInvalid,
            "Canvas workspace must contain at least one Canvas.",
        ));
    }
    let mut ids = HashSet::new();
    for canvas in &document.canvases {
        validate_canvas_id(&canvas.id).map_err(|error| {
            canvas_workspace_unavailable(
                CanvasWorkspaceUnavailableCode::CanvasWorkspaceInvalid,
                error.to_string(),
            )
        })?;
        normalize_canvas_name(&canvas.name).map_err(|error| {
            canvas_workspace_unavailable(
                CanvasWorkspaceUnavailableCode::CanvasWorkspaceInvalid,
                error.to_string(),
            )
        })?;
        validate_canvas_state(&canvas.state).map_err(|error| {
            canvas_workspace_unavailable(
                CanvasWorkspaceUnavailableCode::CanvasWorkspaceInvalid,
                error.to_string(),
            )
        })?;
        if !ids.insert(canvas.id.as_str()) {
            return Err(canvas_workspace_unavailable(
                CanvasWorkspaceUnavailableCode::CanvasWorkspaceInvalid,
                format!(
                    "Canvas workspace contains duplicate Canvas id: {}",
                    canvas.id
                ),
            ));
        }
    }
    if !ids.contains(document.active_canvas_id.as_str()) {
        return Err(canvas_workspace_unavailable(
            CanvasWorkspaceUnavailableCode::CanvasWorkspaceInvalid,
            "Canvas workspace activeCanvasId does not identify a Canvas.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_workspace_creates_one_root_scoped_document() {
        let home = std::env::temp_dir().join(format!("dbrt-canvas-store-{}", Uuid::new_v4()));
        let root = "/projects/campaign";
        let store = CanvasWorkspaceStore::new(&home, root);
        let document = store.load_or_create().unwrap();
        assert_eq!(document, default_canvas_workspace(root));
        assert!(store.path.is_file());
        assert_eq!(
            serde_json::from_slice::<CanvasWorkspaceDocument>(&fs::read(&store.path).unwrap())
                .unwrap(),
            document
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn mismatched_root_is_rejected_without_replacing_the_document() {
        let home = std::env::temp_dir().join(format!("dbrt-canvas-store-{}", Uuid::new_v4()));
        let store = CanvasWorkspaceStore::new(&home, "/projects/campaign");
        let wrong = default_canvas_workspace("/projects/other");
        fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        fs::write(&store.path, serde_json::to_vec_pretty(&wrong).unwrap()).unwrap();
        assert_eq!(
            store.load_or_create().unwrap_err().code.as_str(),
            "canvas_workspace_root_mismatch"
        );
        assert_eq!(
            serde_json::from_slice::<CanvasWorkspaceDocument>(&fs::read(&store.path).unwrap())
                .unwrap(),
            wrong
        );
        fs::remove_dir_all(home).unwrap();
    }
}
