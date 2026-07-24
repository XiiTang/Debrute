use std::{
    collections::BTreeMap,
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use super::models::{ModelCatalog, ModelSettingsView, empty_secret_map, settings_view};

const RECENT_PROJECT_LIMIT: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchSettings {
    pub locale: String,
    pub theme_preference: String,
    pub default_frontend: String,
}

impl Default for WorkbenchSettings {
    fn default() -> Self {
        Self {
            locale: "en".to_owned(),
            theme_preference: "system".to_owned(),
            default_frontend: "electron".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChromeSettings {
    pub recent_projects: Vec<RecentProjectEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentProjectEntry {
    pub project_id: String,
    pub project_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub debrute_model_id: String,
    pub base_url_override: Option<String>,
    pub request_model_id_override: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageModelsConfig {
    pub image_models: Vec<ModelConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoModelsConfig {
    pub video_models: Vec<ModelConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioModelsConfig {
    pub audio_models: Vec<ModelConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelsConfig {
    pub image: ImageModelsConfig,
    pub video: VideoModelsConfig,
    pub audio: AudioModelsConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdobeBridgeSettings {
    pub enabled: bool,
}

impl Default for AdobeBridgeSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettingsConfig {
    pub workbench: WorkbenchSettings,
    pub chrome: ChromeSettings,
    pub models: ModelsConfig,
    pub adobe_bridge: AdobeBridgeSettings,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsConfig {
    pub image_model_api_keys: BTreeMap<String, String>,
    pub video_model_api_keys: BTreeMap<String, String>,
    pub audio_model_api_keys: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalConfigSnapshot {
    pub settings: GlobalSettingsConfig,
    pub secrets: SecretsConfig,
}

impl Default for GlobalConfigSnapshot {
    fn default() -> Self {
        Self {
            settings: GlobalSettingsConfig::default(),
            secrets: SecretsConfig {
                image_model_api_keys: empty_secret_map(),
                video_model_api_keys: empty_secret_map(),
                audio_model_api_keys: empty_secret_map(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettingsView {
    pub workbench: WorkbenchSettings,
    pub chrome: ChromeSettings,
    pub models: ModelSettingsView,
    pub adobe_bridge: AdobeBridgeSettings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalMutationResult {
    pub view: GlobalSettingsView,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentProjectsMutationResult {
    pub recent_projects: Vec<RecentProjectEntry>,
    pub changed: bool,
}

pub struct GlobalConfigStore {
    settings_path: PathBuf,
    secrets_path: PathBuf,
    operation: Mutex<()>,
}

impl GlobalConfigStore {
    #[must_use]
    pub fn new(debrute_home: impl AsRef<Path>) -> Self {
        let config = debrute_home.as_ref().join("config");
        Self {
            settings_path: config.join("global_settings.json"),
            secrets_path: config.join("secrets.json"),
            operation: Mutex::new(()),
        }
    }

    /// Reads the persisted settings and projects the bundled model catalog.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] for malformed or unreadable state.
    pub fn read_view(
        &self,
        catalog: &ModelCatalog,
    ) -> Result<GlobalSettingsView, GlobalSettingsError> {
        let _guard = self.lock()?;
        let snapshot = self.read_snapshot_unlocked()?;
        validate_snapshot(&snapshot)?;
        Ok(project_view(&snapshot, catalog))
    }

    /// Reads only the persisted recent-Project projection needed by native
    /// Runtime presentation during startup.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] for malformed or unreadable state.
    pub fn read_recent_projects(&self) -> Result<Vec<RecentProjectEntry>, GlobalSettingsError> {
        let _guard = self.lock()?;
        let snapshot = self.read_snapshot_unlocked()?;
        validate_snapshot(&snapshot)?;
        Ok(snapshot.settings.chrome.recent_projects)
    }

    /// Reads the validated Runtime-owned settings and secret snapshot.
    ///
    /// This crate-visible form is intentionally unavailable to HTTP clients;
    /// model executors need the unredacted key while every public projection
    /// continues to use [`Self::read_view`].
    pub(crate) fn read_snapshot(&self) -> Result<GlobalConfigSnapshot, GlobalSettingsError> {
        let _guard = self.lock()?;
        let snapshot = self.read_snapshot_unlocked()?;
        validate_snapshot(&snapshot)?;
        Ok(snapshot)
    }

    /// Applies one validated partial settings patch atomically per file.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] without writing when input validation
    /// fails, or when current state cannot be read/persisted.
    pub fn patch(
        &self,
        input: &Value,
        catalog: &ModelCatalog,
    ) -> Result<GlobalMutationResult, GlobalSettingsError> {
        let _guard = self.lock()?;
        let current = self.read_snapshot_unlocked()?;
        validate_snapshot(&current)?;
        let next = apply_patch(current.clone(), input, catalog)?;
        let settings_changed = next.settings != current.settings;
        let secrets_changed = next.secrets != current.secrets;
        if secrets_changed {
            write_json_atomic(&self.secrets_path, &next.secrets, true)?;
        }
        if settings_changed {
            write_json_atomic(&self.settings_path, &next.settings, false)?;
        }
        Ok(GlobalMutationResult {
            view: project_view(&next, catalog),
            changed: settings_changed || secrets_changed,
        })
    }

    /// Remembers one stable Project id and canonical root in most-recent-first order.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] when current state is invalid or cannot
    /// be persisted.
    pub fn remember_recent_project(
        &self,
        project_id: &str,
        project_root: &str,
    ) -> Result<RecentProjectsMutationResult, GlobalSettingsError> {
        let project_id = project_id.trim();
        let root = project_root.trim();
        if project_id.is_empty() || root.is_empty() || !Path::new(root).is_absolute() {
            return validation("Recent Project requires a stable id and absolute canonical root.");
        }
        let _guard = self.lock()?;
        let mut snapshot = self.read_snapshot_unlocked()?;
        validate_snapshot(&snapshot)?;
        if snapshot
            .settings
            .chrome
            .recent_projects
            .iter()
            .any(|entry| entry.project_root == root && entry.project_id != project_id)
        {
            return validation("Recent Project root is already associated with another id.");
        }
        if snapshot
            .settings
            .chrome
            .recent_projects
            .iter()
            .any(|entry| entry.project_id == project_id && entry.project_root != root)
        {
            return validation("Recent Project id is already associated with another root.");
        }
        let previous = snapshot.settings.chrome.recent_projects.clone();
        snapshot
            .settings
            .chrome
            .recent_projects
            .retain(|entry| entry.project_id != project_id);
        snapshot.settings.chrome.recent_projects.insert(
            0,
            RecentProjectEntry {
                project_id: project_id.to_owned(),
                project_root: root.to_owned(),
            },
        );
        snapshot
            .settings
            .chrome
            .recent_projects
            .truncate(RECENT_PROJECT_LIMIT);
        let changed = previous != snapshot.settings.chrome.recent_projects;
        if changed {
            write_json_atomic(&self.settings_path, &snapshot.settings, false)?;
        }
        Ok(RecentProjectsMutationResult {
            recent_projects: snapshot.settings.chrome.recent_projects,
            changed,
        })
    }

    /// Clears the recent Project projection.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] when current state is invalid or cannot
    /// be persisted.
    pub fn clear_recent_projects(
        &self,
    ) -> Result<RecentProjectsMutationResult, GlobalSettingsError> {
        let _guard = self.lock()?;
        let mut snapshot = self.read_snapshot_unlocked()?;
        validate_snapshot(&snapshot)?;
        if snapshot.settings.chrome.recent_projects.is_empty() {
            return Ok(RecentProjectsMutationResult {
                recent_projects: Vec::new(),
                changed: false,
            });
        }
        snapshot.settings.chrome.recent_projects.clear();
        write_json_atomic(&self.settings_path, &snapshot.settings, false)?;
        Ok(RecentProjectsMutationResult {
            recent_projects: Vec::new(),
            changed: true,
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, GlobalSettingsError> {
        self.operation.lock().map_err(|_| {
            GlobalSettingsError::Persistence("Global settings lock is poisoned.".to_owned())
        })
    }

    fn read_snapshot_unlocked(&self) -> Result<GlobalConfigSnapshot, GlobalSettingsError> {
        normalize_snapshot(GlobalConfigSnapshot {
            settings: read_json_or_default(&self.settings_path)?,
            secrets: read_json_or_default(&self.secrets_path)?,
        })
    }
}

fn project_view(snapshot: &GlobalConfigSnapshot, catalog: &ModelCatalog) -> GlobalSettingsView {
    GlobalSettingsView {
        workbench: snapshot.settings.workbench.clone(),
        chrome: snapshot.settings.chrome.clone(),
        models: settings_view(snapshot, catalog),
        adobe_bridge: snapshot.settings.adobe_bridge.clone(),
    }
}

fn apply_patch(
    mut snapshot: GlobalConfigSnapshot,
    input: &Value,
    catalog: &ModelCatalog,
) -> Result<GlobalConfigSnapshot, GlobalSettingsError> {
    let patch = record(input, "Global settings patch")?;
    if let Some(value) = patch.get("workbench") {
        let workbench = record(value, "Global settings workbench")?;
        if let Some(locale) = workbench.get("locale") {
            string(locale, "Workbench locale")?.clone_into(&mut snapshot.settings.workbench.locale);
        }
        if let Some(theme) = workbench.get("themePreference") {
            string(theme, "Workbench theme preference")?
                .clone_into(&mut snapshot.settings.workbench.theme_preference);
        }
        if let Some(frontend) = workbench.get("defaultFrontend") {
            string(frontend, "Global settings defaultFrontend")?
                .clone_into(&mut snapshot.settings.workbench.default_frontend);
        }
        validate_workbench(&snapshot.settings.workbench)?;
    }
    if let Some(value) = patch.get("models") {
        let models = record(value, "Global settings models")?;
        if let Some(value) = models.get("image") {
            apply_model_patch(
                value,
                "Image",
                |id| catalog.contains_image(id),
                &mut snapshot.settings.models.image.image_models,
                &mut snapshot.secrets.image_model_api_keys,
            )?;
        }
        if let Some(value) = models.get("video") {
            apply_model_patch(
                value,
                "Video",
                |id| catalog.contains_video(id),
                &mut snapshot.settings.models.video.video_models,
                &mut snapshot.secrets.video_model_api_keys,
            )?;
        }
        if let Some(value) = models.get("audio") {
            apply_model_patch(
                value,
                "Audio",
                |id| catalog.contains_audio(id),
                &mut snapshot.settings.models.audio.audio_models,
                &mut snapshot.secrets.audio_model_api_keys,
            )?;
        }
    }
    if let Some(value) = patch.get("adobeBridge") {
        let bridge = record(value, "Global settings adobeBridge")?;
        let Some(enabled) = bridge.get("enabled").and_then(Value::as_bool) else {
            return validation("Adobe Bridge config must contain enabled.");
        };
        snapshot.settings.adobe_bridge.enabled = enabled;
    }
    Ok(snapshot)
}

fn apply_model_patch(
    value: &Value,
    label: &str,
    known: impl Fn(&str) -> bool,
    configs: &mut Vec<ModelConfig>,
    secrets: &mut BTreeMap<String, String>,
) -> Result<(), GlobalSettingsError> {
    let patch = record(
        value,
        &format!("Global settings models.{}", label.to_lowercase()),
    )?;
    let raw_model_id = string(
        patch.get("modelId").ok_or_else(|| {
            GlobalSettingsError::Validation(format!("{label} model id must be a string."))
        })?,
        &format!("{label} model id"),
    )?;
    if raw_model_id.trim().is_empty() {
        return validation(format!("{label} model id must be a non-empty string."));
    }
    if !known(raw_model_id) {
        return validation(format!(
            "Unknown {} model: {raw_model_id}",
            label.to_lowercase()
        ));
    }
    let model_id = raw_model_id.trim();
    let setting = record(
        patch.get("setting").ok_or_else(|| {
            GlobalSettingsError::Validation(format!("{label} model setting must be an object."))
        })?,
        &format!("{label} model setting"),
    )?;
    let base_url_override = nullable_non_empty_string(
        setting.get("baseUrlOverride"),
        &format!("{label} model baseUrlOverride"),
    )?;
    let request_model_id_override = nullable_non_empty_string(
        setting.get("requestModelIdOverride"),
        &format!("{label} model requestModelIdOverride"),
    )?;
    configs.retain(|config| config.debrute_model_id != model_id);
    if base_url_override.is_some() || request_model_id_override.is_some() {
        configs.push(ModelConfig {
            debrute_model_id: model_id.to_owned(),
            base_url_override,
            request_model_id_override,
        });
        configs.sort_by(|left, right| left.debrute_model_id.cmp(&right.debrute_model_id));
    }
    if let Some(api_key) = setting.get("apiKey") {
        let api_key = string(api_key, &format!("{label} model apiKey"))?.trim();
        if api_key.is_empty() {
            secrets.remove(model_id);
        } else {
            secrets.insert(model_id.to_owned(), api_key.to_owned());
        }
    }
    Ok(())
}

fn validate_snapshot(snapshot: &GlobalConfigSnapshot) -> Result<(), GlobalSettingsError> {
    validate_workbench(&snapshot.settings.workbench)?;
    if snapshot.settings.chrome.recent_projects.len() > RECENT_PROJECT_LIMIT {
        return validation("Workbench chrome recentProjects contains more than 12 entries.");
    }
    Ok(())
}

fn normalize_snapshot(
    mut snapshot: GlobalConfigSnapshot,
) -> Result<GlobalConfigSnapshot, GlobalSettingsError> {
    validate_workbench(&snapshot.settings.workbench)?;
    let mut recent = Vec::new();
    for entry in &snapshot.settings.chrome.recent_projects {
        let project_id = entry.project_id.trim();
        let project_root = entry.project_root.trim();
        if !project_id.is_empty()
            && Path::new(project_root).is_absolute()
            && !recent.iter().any(|current: &RecentProjectEntry| {
                current.project_id == project_id || current.project_root == project_root
            })
        {
            recent.push(RecentProjectEntry {
                project_id: project_id.to_owned(),
                project_root: project_root.to_owned(),
            });
        }
        if recent.len() == RECENT_PROJECT_LIMIT {
            break;
        }
    }
    snapshot.settings.chrome.recent_projects = recent;
    normalize_model_configs(&mut snapshot.settings.models.image.image_models, "Image")?;
    normalize_model_configs(&mut snapshot.settings.models.video.video_models, "Video")?;
    normalize_model_configs(&mut snapshot.settings.models.audio.audio_models, "Audio")?;
    snapshot.secrets.image_model_api_keys =
        normalize_secret_map(snapshot.secrets.image_model_api_keys, "imageModelApiKeys")?;
    snapshot.secrets.video_model_api_keys =
        normalize_secret_map(snapshot.secrets.video_model_api_keys, "videoModelApiKeys")?;
    snapshot.secrets.audio_model_api_keys =
        normalize_secret_map(snapshot.secrets.audio_model_api_keys, "audioModelApiKeys")?;
    Ok(snapshot)
}

fn normalize_model_configs(
    configs: &mut [ModelConfig],
    label: &str,
) -> Result<(), GlobalSettingsError> {
    for config in configs {
        config.debrute_model_id = config.debrute_model_id.trim().to_owned();
        if config.debrute_model_id.is_empty() {
            return validation(format!(
                "{label} model debruteModelId must be a non-empty string."
            ));
        }
        normalize_persisted_override(&mut config.base_url_override, label, "baseUrlOverride")?;
        normalize_persisted_override(
            &mut config.request_model_id_override,
            label,
            "requestModelIdOverride",
        )?;
    }
    Ok(())
}

fn normalize_persisted_override(
    value: &mut Option<String>,
    label: &str,
    field: &str,
) -> Result<(), GlobalSettingsError> {
    let Some(current) = value else {
        return Ok(());
    };
    let trimmed = current.trim();
    if trimmed.is_empty() {
        return validation(format!(
            "{label} model {field} must be null or a non-empty string."
        ));
    }
    *current = trimmed.to_owned();
    Ok(())
}

fn normalize_secret_map(
    secrets: BTreeMap<String, String>,
    field: &str,
) -> Result<BTreeMap<String, String>, GlobalSettingsError> {
    let mut normalized = BTreeMap::new();
    for (key, secret) in secrets {
        let key = key.trim();
        if key.is_empty() {
            return validation(format!(
                "Secrets config {field} keys must be non-empty strings."
            ));
        }
        normalized.insert(key.to_owned(), secret);
    }
    Ok(normalized)
}

fn validate_workbench(settings: &WorkbenchSettings) -> Result<(), GlobalSettingsError> {
    if !matches!(settings.locale.as_str(), "en" | "zh-CN") {
        return validation("Workbench locale must be \"en\" or \"zh-CN\".");
    }
    if !matches!(
        settings.theme_preference.as_str(),
        "system" | "dark" | "light"
    ) {
        return validation(
            "Workbench theme preference must be \"system\", \"dark\", or \"light\".",
        );
    }
    if !matches!(
        settings.default_frontend.as_str(),
        "electron" | "browser" | "runtime-only"
    ) {
        return validation(
            "Global settings defaultFrontend must be \"electron\", \"browser\", or \"runtime-only\".",
        );
    }
    Ok(())
}

fn record<'a>(
    value: &'a Value,
    label: &str,
) -> Result<&'a Map<String, Value>, GlobalSettingsError> {
    value
        .as_object()
        .ok_or_else(|| GlobalSettingsError::Validation(format!("{label} must be an object.")))
}

fn string<'a>(value: &'a Value, label: &str) -> Result<&'a str, GlobalSettingsError> {
    value
        .as_str()
        .ok_or_else(|| GlobalSettingsError::Validation(format!("{label} must be a string.")))
}

fn nullable_non_empty_string(
    value: Option<&Value>,
    label: &str,
) -> Result<Option<String>, GlobalSettingsError> {
    let Some(value) = value else {
        return validation(format!("{label} must be a string or null."));
    };
    if value.is_null() {
        return Ok(None);
    }
    let value = string(value, label)?.trim();
    if value.is_empty() {
        return validation(format!("{label} must be null or a non-empty string."));
    }
    Ok(Some(value.to_owned()))
}

fn validation<T>(message: impl Into<String>) -> Result<T, GlobalSettingsError> {
    Err(GlobalSettingsError::Validation(message.into()))
}

fn read_json_or_default<T>(path: &Path) -> Result<T, GlobalSettingsError>
where
    T: Default + for<'de> Deserialize<'de>,
{
    match fs::read_to_string(path) {
        Ok(source) => serde_json::from_str(&source).map_err(GlobalSettingsError::Json),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            ensure_missing_path_is_usable(path)?;
            Ok(T::default())
        }
        Err(error) => Err(GlobalSettingsError::Io(error)),
    }
}

fn ensure_missing_path_is_usable(path: &Path) -> Result<(), GlobalSettingsError> {
    let mut current = path;
    while let Some(parent) = current.parent() {
        match fs::symlink_metadata(current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let target = fs::metadata(current).map_err(GlobalSettingsError::Io)?;
                if !target.is_dir() {
                    return Err(GlobalSettingsError::Persistence(format!(
                        "Global settings path is not a directory: {}",
                        current.display()
                    )));
                }
                return Ok(());
            }
            Ok(metadata) if metadata.is_dir() => return Ok(()),
            Ok(_) => {
                return Err(GlobalSettingsError::Persistence(format!(
                    "Global settings path is not a directory: {}",
                    current.display()
                )));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => current = parent,
            Err(error) => return Err(GlobalSettingsError::Io(error)),
        }
    }
    Ok(())
}

fn write_json_atomic<T: Serialize>(
    path: &Path,
    value: &T,
    secret: bool,
) -> Result<(), GlobalSettingsError> {
    let directory = path.parent().ok_or_else(|| {
        GlobalSettingsError::Persistence("Global settings path has no parent.".to_owned())
    })?;
    fs::create_dir_all(directory).map_err(GlobalSettingsError::Io)?;
    set_directory_permissions(directory)?;
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let source = format!(
        "{}\n",
        serde_json::to_string_pretty(value).map_err(GlobalSettingsError::Json)?
    );
    let write_result = (|| {
        fs::write(&temporary, source).map_err(GlobalSettingsError::Io)?;
        if secret {
            set_secret_permissions(&temporary)?;
        }
        replace_file(&temporary, path).map_err(GlobalSettingsError::Io)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    debrute_windows_product_fs::replace_file_atomic(source, destination)
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(unix)]
fn set_directory_permissions(path: &Path) -> Result<(), GlobalSettingsError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(GlobalSettingsError::Io)
}

#[cfg(not(unix))]
fn set_directory_permissions(_path: &Path) -> Result<(), GlobalSettingsError> {
    Ok(())
}

#[cfg(unix)]
fn set_secret_permissions(path: &Path) -> Result<(), GlobalSettingsError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(GlobalSettingsError::Io)
}

#[cfg(not(unix))]
fn set_secret_permissions(_path: &Path) -> Result<(), GlobalSettingsError> {
    Ok(())
}

#[derive(Debug)]
pub enum GlobalSettingsError {
    Validation(String),
    Persistence(String),
    Io(io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for GlobalSettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(message) | Self::Persistence(message) => formatter.write_str(message),
            Self::Io(error) => error.fmt(formatter),
            Self::Json(error) => error.fmt(formatter),
        }
    }
}

impl Error for GlobalSettingsError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::Validation(_) | Self::Persistence(_) => None,
        }
    }
}
