use std::{
    collections::BTreeMap,
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Deserializer, Serialize};
use unicode_segmentation::UnicodeSegmentation;
use uuid::Uuid;

use crate::models::ModelCatalog;

use super::models::{ModelSettingsView, settings_view};

const RECENT_PROJECT_LIMIT: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkbenchSettings {
    pub locale: String,
    pub theme_preference: String,
}

impl Default for WorkbenchSettings {
    fn default() -> Self {
        Self {
            locale: "en".to_owned(),
            theme_preference: "system".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CanvasFontId {
    #[default]
    NotoSansMonoCjkSc,
    Lilex,
    JetbrainsMono,
    IbmPlexMono,
    NotoSansSc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasTextAppearance {
    pub font_id: CanvasFontId,
    pub font_size_px: f64,
    pub line_height_ratio: f64,
    pub font_weight: u16,
    pub letter_spacing_px: f64,
    pub ligatures: bool,
}

impl Default for CanvasTextAppearance {
    fn default() -> Self {
        Self {
            font_id: CanvasFontId::default(),
            font_size_px: 12.0,
            line_height_ratio: 1.4,
            font_weight: 400,
            letter_spacing_px: 0.0,
            ligatures: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasSettings {
    pub text_appearance: CanvasTextAppearance,
    pub hierarchy_edges_visible: bool,
}

impl Default for CanvasSettings {
    fn default() -> Self {
        Self {
            text_appearance: CanvasTextAppearance::default(),
            hierarchy_edges_visible: true,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChromeSettings {
    pub recent_project_roots: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoshopPluginSettings {
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSettings {
    pub photoshop: PhotoshopPluginSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackCatalogEntry {
    pub name: String,
    pub icon: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackSettings {
    pub catalog: Vec<FeedbackCatalogEntry>,
    pub action_bar: Vec<String>,
}

impl Default for FeedbackSettings {
    fn default() -> Self {
        let catalog = [
            ("like", "heart"),
            ("dislike", "thumbs-down"),
            ("check", "check-circle"),
            ("cross", "x-circle"),
            ("pending", "clock"),
            ("important", "star"),
            ("needs_revision", "warning-circle"),
        ]
        .into_iter()
        .map(|(name, icon)| FeedbackCatalogEntry {
            name: name.to_owned(),
            icon: icon.to_owned(),
        })
        .collect::<Vec<_>>();
        Self {
            action_bar: catalog.iter().map(|entry| entry.name.clone()).collect(),
            catalog,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConfig {
    pub debrute_model_id: String,
    #[serde(deserialize_with = "deserialize_nullable_string")]
    pub base_url_override: Option<String>,
    #[serde(deserialize_with = "deserialize_nullable_string")]
    pub request_model_id_override: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlobalSettingsConfig {
    pub workbench: WorkbenchSettings,
    pub canvas: CanvasSettings,
    pub chrome: ChromeSettings,
    pub plugins: PluginSettings,
    pub feedback: FeedbackSettings,
    pub models: Vec<ModelConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretsConfig {
    pub model_api_keys: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct GlobalConfigSnapshot {
    pub settings: GlobalSettingsConfig,
    pub secrets: SecretsConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettingsView {
    pub workbench: WorkbenchSettings,
    pub canvas: CanvasSettings,
    pub chrome: ChromeSettings,
    pub plugins: PluginSettings,
    pub feedback: FeedbackSettings,
    pub models: ModelSettingsView,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GlobalSettingsMutation {
    SetLocale {
        locale: String,
    },
    SetThemePreference {
        theme_preference: String,
    },
    SetCanvasTextAppearance {
        text_appearance: CanvasTextAppearance,
    },
    SetHierarchyEdgesVisible {
        hierarchy_edges_visible: bool,
    },
    CreateFeedbackMark {
        name: String,
        icon: String,
    },
    SetFeedbackMarkIcon {
        name: String,
        icon: String,
    },
    DeleteFeedbackMark {
        name: String,
    },
    SetFeedbackActionBar {
        names: Vec<String>,
    },
    SetPhotoshopPluginEnabled {
        enabled: bool,
    },
    SaveModelSetting {
        model_id: String,
        setting: SaveModelSettingMutation,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveModelSettingMutation {
    #[serde(deserialize_with = "deserialize_nullable_string")]
    pub base_url_override: Option<String>,
    #[serde(deserialize_with = "deserialize_nullable_string")]
    pub request_model_id_override: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GlobalMutationResult {
    pub view: GlobalSettingsView,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentProjectsMutationResult {
    pub recent_project_roots: Vec<String>,
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
        let _guard = self.lock();
        let snapshot = self.read_snapshot_unlocked()?;
        validate_snapshot(&snapshot, catalog)?;
        Ok(project_view(&snapshot, catalog))
    }

    /// Reads only the persisted fields needed by native Runtime presentation
    /// during startup.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] for malformed or unreadable state.
    pub fn read_desktop_presentation(
        &self,
        catalog: &ModelCatalog,
    ) -> Result<(Vec<String>, String), GlobalSettingsError> {
        let _guard = self.lock();
        let snapshot = self.read_snapshot_unlocked()?;
        validate_snapshot(&snapshot, catalog)?;
        Ok((
            snapshot.settings.chrome.recent_project_roots,
            snapshot.settings.workbench.theme_preference,
        ))
    }

    /// Reads the validated Runtime-owned settings and secret snapshot.
    ///
    /// This crate-visible form is intentionally unavailable to HTTP clients;
    /// model executors need the unredacted key while every public projection
    /// continues to use [`Self::read_view`].
    pub(crate) fn read_snapshot(
        &self,
        catalog: &ModelCatalog,
    ) -> Result<GlobalConfigSnapshot, GlobalSettingsError> {
        let _guard = self.lock();
        let snapshot = self.read_snapshot_unlocked()?;
        validate_snapshot(&snapshot, catalog)?;
        Ok(snapshot)
    }

    pub(crate) fn read_model_api_key(
        &self,
        model_id: &str,
        catalog: &ModelCatalog,
    ) -> Result<String, GlobalSettingsError> {
        if model_id.is_empty() || model_id.trim() != model_id {
            return validation("Model id must be a canonical non-empty string.");
        }
        if catalog.find(model_id).is_none() {
            return validation(format!("Unknown model: {model_id}"));
        }
        let _guard = self.lock();
        let snapshot = self.read_snapshot_unlocked()?;
        validate_snapshot(&snapshot, catalog)?;
        snapshot
            .secrets
            .model_api_keys
            .get(model_id)
            .cloned()
            .ok_or_else(|| {
                GlobalSettingsError::Validation(format!(
                    "Model API key is not configured: {model_id}"
                ))
            })
    }

    /// Applies one validated settings intent atomically per file.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] without writing when input validation
    /// fails, or when current state cannot be read/persisted.
    pub fn mutate(
        &self,
        input: &GlobalSettingsMutation,
        catalog: &ModelCatalog,
    ) -> Result<GlobalMutationResult, GlobalSettingsError> {
        let _guard = self.lock();
        let current = self.read_snapshot_unlocked()?;
        validate_snapshot(&current, catalog)?;
        let next = apply_mutation(current.clone(), input, catalog)?;
        validate_snapshot(&next, catalog)?;
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

    /// Remembers one canonical root in most-recent-first order.
    ///
    /// # Errors
    ///
    /// Returns [`GlobalSettingsError`] when current state is invalid or cannot
    /// be persisted.
    pub fn remember_recent_project(
        &self,
        canonical_root: &str,
        catalog: &ModelCatalog,
    ) -> Result<RecentProjectsMutationResult, GlobalSettingsError> {
        if canonical_root.is_empty()
            || canonical_root.trim() != canonical_root
            || !Path::new(canonical_root).is_absolute()
        {
            return validation("Recent Project requires an absolute canonical root.");
        }
        let _guard = self.lock();
        let mut snapshot = self.read_snapshot_unlocked()?;
        validate_snapshot(&snapshot, catalog)?;
        let previous = snapshot.settings.chrome.recent_project_roots.clone();
        snapshot
            .settings
            .chrome
            .recent_project_roots
            .retain(|root| root != canonical_root);
        snapshot
            .settings
            .chrome
            .recent_project_roots
            .insert(0, canonical_root.to_owned());
        snapshot
            .settings
            .chrome
            .recent_project_roots
            .truncate(RECENT_PROJECT_LIMIT);
        let changed = previous != snapshot.settings.chrome.recent_project_roots;
        if changed {
            write_json_atomic(&self.settings_path, &snapshot.settings, false)?;
        }
        Ok(RecentProjectsMutationResult {
            recent_project_roots: snapshot.settings.chrome.recent_project_roots,
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
        catalog: &ModelCatalog,
    ) -> Result<RecentProjectsMutationResult, GlobalSettingsError> {
        let _guard = self.lock();
        let mut snapshot = self.read_snapshot_unlocked()?;
        validate_snapshot(&snapshot, catalog)?;
        if snapshot.settings.chrome.recent_project_roots.is_empty() {
            return Ok(RecentProjectsMutationResult {
                recent_project_roots: Vec::new(),
                changed: false,
            });
        }
        snapshot.settings.chrome.recent_project_roots.clear();
        write_json_atomic(&self.settings_path, &snapshot.settings, false)?;
        Ok(RecentProjectsMutationResult {
            recent_project_roots: Vec::new(),
            changed: true,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.operation
            .lock()
            .expect("Global settings operation lock poisoned")
    }

    fn read_snapshot_unlocked(&self) -> Result<GlobalConfigSnapshot, GlobalSettingsError> {
        Ok(GlobalConfigSnapshot {
            settings: read_json_or_default(&self.settings_path)?,
            secrets: read_json_or_default(&self.secrets_path)?,
        })
    }
}

fn project_view(snapshot: &GlobalConfigSnapshot, catalog: &ModelCatalog) -> GlobalSettingsView {
    GlobalSettingsView {
        workbench: snapshot.settings.workbench.clone(),
        canvas: snapshot.settings.canvas.clone(),
        chrome: snapshot.settings.chrome.clone(),
        plugins: snapshot.settings.plugins.clone(),
        feedback: snapshot.settings.feedback.clone(),
        models: settings_view(snapshot, catalog),
    }
}

fn apply_mutation(
    mut snapshot: GlobalConfigSnapshot,
    input: &GlobalSettingsMutation,
    catalog: &ModelCatalog,
) -> Result<GlobalConfigSnapshot, GlobalSettingsError> {
    match input {
        GlobalSettingsMutation::SetLocale { locale } => {
            snapshot.settings.workbench.locale.clone_from(locale);
            validate_workbench(&snapshot.settings.workbench)?;
        }
        GlobalSettingsMutation::SetThemePreference { theme_preference } => {
            snapshot
                .settings
                .workbench
                .theme_preference
                .clone_from(theme_preference);
            validate_workbench(&snapshot.settings.workbench)?;
        }
        GlobalSettingsMutation::SetCanvasTextAppearance { text_appearance } => {
            validate_canvas_text_appearance(text_appearance)?;
            snapshot.settings.canvas.text_appearance = text_appearance.clone();
        }
        GlobalSettingsMutation::SetHierarchyEdgesVisible {
            hierarchy_edges_visible,
        } => snapshot.settings.canvas.hierarchy_edges_visible = *hierarchy_edges_visible,
        GlobalSettingsMutation::CreateFeedbackMark { name, icon } => {
            create_feedback_mark(&mut snapshot.settings.feedback, name, icon)?;
        }
        GlobalSettingsMutation::SetFeedbackMarkIcon { name, icon } => {
            set_feedback_mark_icon(&mut snapshot.settings.feedback, name, icon)?;
        }
        GlobalSettingsMutation::DeleteFeedbackMark { name } => {
            delete_feedback_mark(&mut snapshot.settings.feedback, name)?;
        }
        GlobalSettingsMutation::SetFeedbackActionBar { names } => {
            set_feedback_action_bar(&mut snapshot.settings.feedback, names)?;
        }
        GlobalSettingsMutation::SetPhotoshopPluginEnabled { enabled } => {
            snapshot.settings.plugins.photoshop.enabled = *enabled;
        }
        GlobalSettingsMutation::SaveModelSetting { model_id, setting } => {
            apply_model_mutation(
                model_id,
                setting,
                catalog,
                &mut snapshot.settings.models,
                &mut snapshot.secrets.model_api_keys,
            )?;
        }
    }
    Ok(snapshot)
}

fn apply_model_mutation(
    model_id: &str,
    setting: &SaveModelSettingMutation,
    catalog: &ModelCatalog,
    configs: &mut Vec<ModelConfig>,
    secrets: &mut BTreeMap<String, String>,
) -> Result<(), GlobalSettingsError> {
    if model_id.is_empty() || model_id.trim() != model_id {
        return validation("Model id must be a canonical non-empty string.");
    }
    if catalog.find(model_id).is_none() {
        return validation(format!("Unknown model: {model_id}"));
    }
    validate_optional_override(setting.base_url_override.as_deref(), "baseUrlOverride")?;
    validate_optional_override(
        setting.request_model_id_override.as_deref(),
        "requestModelIdOverride",
    )?;
    let base_url_override = setting.base_url_override.clone();
    let request_model_id_override = setting.request_model_id_override.clone();
    configs.retain(|config| config.debrute_model_id != model_id);
    if base_url_override.is_some() || request_model_id_override.is_some() {
        configs.push(ModelConfig {
            debrute_model_id: model_id.to_owned(),
            base_url_override,
            request_model_id_override,
        });
        configs.sort_by(|left, right| left.debrute_model_id.cmp(&right.debrute_model_id));
    }
    if let Some(api_key) = &setting.api_key {
        if api_key.is_empty() {
            secrets.remove(model_id);
        } else {
            secrets.insert(model_id.to_owned(), api_key.clone());
        }
    }
    Ok(())
}

fn create_feedback_mark(
    settings: &mut FeedbackSettings,
    name: &str,
    icon: &str,
) -> Result<(), GlobalSettingsError> {
    validate_configured_feedback_name(name)?;
    validate_feedback_icon_for_write(icon)?;
    if settings.catalog.iter().any(|entry| entry.name == name) {
        return validation("Feedback catalog already contains this exact name.");
    }
    settings.catalog.push(FeedbackCatalogEntry {
        name: name.to_owned(),
        icon: icon.to_owned(),
    });
    Ok(())
}

fn set_feedback_mark_icon(
    settings: &mut FeedbackSettings,
    name: &str,
    icon: &str,
) -> Result<(), GlobalSettingsError> {
    validate_feedback_icon_for_write(icon)?;
    let entry = settings
        .catalog
        .iter_mut()
        .find(|entry| entry.name == name)
        .ok_or_else(|| {
            GlobalSettingsError::Validation(
                "Feedback catalog does not contain this exact name.".to_owned(),
            )
        })?;
    icon.clone_into(&mut entry.icon);
    Ok(())
}

fn delete_feedback_mark(
    settings: &mut FeedbackSettings,
    name: &str,
) -> Result<(), GlobalSettingsError> {
    let previous_len = settings.catalog.len();
    settings.catalog.retain(|entry| entry.name != name);
    if settings.catalog.len() == previous_len {
        return validation("Feedback catalog does not contain this exact name.");
    }
    settings.action_bar.retain(|current| current != name);
    Ok(())
}

fn set_feedback_action_bar(
    settings: &mut FeedbackSettings,
    names: &[String],
) -> Result<(), GlobalSettingsError> {
    validate_feedback_action_bar(settings, names)?;
    settings.action_bar = names.to_vec();
    Ok(())
}

fn validate_feedback_action_bar(
    settings: &FeedbackSettings,
    names: &[String],
) -> Result<(), GlobalSettingsError> {
    if names.len() > 8 {
        return validation("Feedback Action Bar supports at most 8 names.");
    }
    for (index, name) in names.iter().enumerate() {
        if names[..index].contains(name) {
            return validation("Feedback Action Bar contains a duplicate exact name.");
        }
        if !settings.catalog.iter().any(|entry| entry.name == *name) {
            return validation("Feedback Action Bar names must exist in the catalog.");
        }
    }
    Ok(())
}

fn validate_feedback_settings(settings: &FeedbackSettings) -> Result<(), GlobalSettingsError> {
    for (index, entry) in settings.catalog.iter().enumerate() {
        validate_configured_feedback_name(&entry.name)?;
        if settings.catalog[..index]
            .iter()
            .any(|current| current.name == entry.name)
        {
            return validation("Feedback catalog contains a duplicate exact name.");
        }
    }
    validate_feedback_action_bar(settings, &settings.action_bar)
}

fn validate_configured_feedback_name(name: &str) -> Result<(), GlobalSettingsError> {
    let grapheme_count = name.graphemes(true).count();
    if !(1..=32).contains(&grapheme_count) {
        return validation("Feedback name must contain 1–32 Unicode grapheme clusters.");
    }
    if name.chars().any(is_forbidden_feedback_name_character) {
        return validation("Feedback name contains a forbidden control character.");
    }
    Ok(())
}

fn is_forbidden_feedback_name_character(character: char) -> bool {
    matches!(character as u32, 0x0000..=0x001f | 0x007f..=0x009f | 0x061c | 0x200e..=0x200f | 0x202a..=0x202e | 0x2066..=0x2069)
}

fn validate_feedback_icon_for_write(icon: &str) -> Result<(), GlobalSettingsError> {
    if include_str!("feedback_icon_names.txt")
        .lines()
        .any(|candidate| candidate == icon)
    {
        Ok(())
    } else {
        validation("Feedback icon is not part of the pinned Phosphor Fill catalog.")
    }
}

fn validate_optional_override(value: Option<&str>, field: &str) -> Result<(), GlobalSettingsError> {
    validate_persisted_override(value, field)
}

fn validate_snapshot(
    snapshot: &GlobalConfigSnapshot,
    catalog: &ModelCatalog,
) -> Result<(), GlobalSettingsError> {
    validate_workbench(&snapshot.settings.workbench)?;
    validate_canvas_text_appearance(&snapshot.settings.canvas.text_appearance)?;
    validate_recent_projects(&snapshot.settings.chrome.recent_project_roots)?;
    validate_feedback_settings(&snapshot.settings.feedback)?;
    validate_model_configs(&snapshot.settings.models, catalog)?;
    validate_secret_map(&snapshot.secrets.model_api_keys, catalog)?;
    Ok(())
}

fn validate_canvas_text_appearance(
    appearance: &CanvasTextAppearance,
) -> Result<(), GlobalSettingsError> {
    if !is_finite_inclusive(appearance.font_size_px, 6.0, 100.0)
        || !has_decimal_precision(appearance.font_size_px, 2.0)
    {
        return validation(
            "Canvas text fontSizePx must be a finite 6–100 value in 0.5px increments.",
        );
    }
    if !is_finite_inclusive(appearance.line_height_ratio, 1.0, 2.0)
        || !has_decimal_precision(appearance.line_height_ratio, 100.0)
    {
        return validation(
            "Canvas text lineHeightRatio must be a finite 1.0–2.0 value with at most two decimal places.",
        );
    }
    if !(100..=900).contains(&appearance.font_weight) {
        return validation("Canvas text fontWeight must be an integer from 100 to 900.");
    }
    if !is_finite_inclusive(appearance.letter_spacing_px, -5.0, 20.0)
        || !has_decimal_precision(appearance.letter_spacing_px, 10.0)
    {
        return validation(
            "Canvas text letterSpacingPx must be a finite -5–20 value in 0.1px increments.",
        );
    }
    Ok(())
}

fn is_finite_inclusive(value: f64, minimum: f64, maximum: f64) -> bool {
    value.is_finite() && value >= minimum && value <= maximum
}

fn has_decimal_precision(value: f64, scale: f64) -> bool {
    let scaled = value * scale;
    (scaled - scaled.round()).abs() <= f64::EPSILON * scale * 8.0
}

fn validate_recent_projects(recent_project_roots: &[String]) -> Result<(), GlobalSettingsError> {
    if recent_project_roots.len() > RECENT_PROJECT_LIMIT {
        return validation("Workbench chrome recentProjectRoots contains more than 12 entries.");
    }
    for (index, root) in recent_project_roots.iter().enumerate() {
        if root.is_empty() || root.trim() != root || !Path::new(root).is_absolute() {
            return validation(
                "Workbench chrome recentProjectRoots entries must be absolute canonical roots.",
            );
        }
        if recent_project_roots[..index].contains(root) {
            return validation("Workbench chrome recentProjectRoots contains a duplicate root.");
        }
    }
    Ok(())
}

fn validate_model_configs(
    configs: &[ModelConfig],
    catalog: &ModelCatalog,
) -> Result<(), GlobalSettingsError> {
    for (index, config) in configs.iter().enumerate() {
        if config.debrute_model_id.is_empty()
            || config.debrute_model_id.trim() != config.debrute_model_id
        {
            return validation("Model debruteModelId must be a canonical non-empty string.");
        }
        if catalog.find(&config.debrute_model_id).is_none() {
            return validation(format!("Unknown model: {}", config.debrute_model_id));
        }
        if configs[..index]
            .iter()
            .any(|current| current.debrute_model_id == config.debrute_model_id)
        {
            return validation(format!(
                "Model config contains duplicate debruteModelId: {}",
                config.debrute_model_id
            ));
        }
        validate_persisted_override(config.base_url_override.as_deref(), "baseUrlOverride")?;
        validate_persisted_override(
            config.request_model_id_override.as_deref(),
            "requestModelIdOverride",
        )?;
    }
    Ok(())
}

fn validate_persisted_override(
    value: Option<&str>,
    field: &str,
) -> Result<(), GlobalSettingsError> {
    let Some(current) = value else {
        return Ok(());
    };
    if current.is_empty() || current.trim() != current {
        return validation(format!(
            "Model {field} must be null or a canonical non-empty string."
        ));
    }
    Ok(())
}

fn validate_secret_map(
    secrets: &BTreeMap<String, String>,
    catalog: &ModelCatalog,
) -> Result<(), GlobalSettingsError> {
    for (key, secret) in secrets {
        if key.is_empty() || key.trim() != key {
            return validation(
                "Secrets config modelApiKeys keys must be canonical non-empty strings.",
            );
        }
        if catalog.find(key).is_none() {
            return validation(format!(
                "Secrets config modelApiKeys contains unknown model: {key}"
            ));
        }
        if secret.is_empty() {
            return validation("Secrets config modelApiKeys values must be non-empty.");
        }
    }
    Ok(())
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
    Ok(())
}

fn deserialize_nullable_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
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

fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    debrute_native_fs::replace_file_atomic(source, destination)
}

#[cfg(unix)]
fn set_directory_permissions(path: &Path) -> Result<(), GlobalSettingsError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(GlobalSettingsError::Io)
}

#[cfg(not(unix))]
#[expect(
    clippy::unnecessary_wraps,
    reason = "the shared persistence path has one fallible permission contract"
)]
fn set_directory_permissions(_path: &Path) -> Result<(), GlobalSettingsError> {
    Ok(())
}

#[cfg(unix)]
fn set_secret_permissions(path: &Path) -> Result<(), GlobalSettingsError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(GlobalSettingsError::Io)
}

#[cfg(not(unix))]
#[expect(
    clippy::unnecessary_wraps,
    reason = "the shared persistence path has one fallible permission contract"
)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn remembering_a_recent_root_is_idempotent() {
        let home =
            std::env::temp_dir().join(format!("debrute-global-initialize-{}", Uuid::new_v4()));
        let project = home.join("project");
        fs::create_dir_all(&project).unwrap();
        let project_root = project.to_string_lossy().into_owned();
        let catalog = ModelCatalog::bundled();
        let store = GlobalConfigStore::new(&home);
        store
            .remember_recent_project(&project_root, &catalog)
            .unwrap();
        store
            .remember_recent_project(&project_root, &catalog)
            .unwrap();

        let (recent, _) = store.read_desktop_presentation(&catalog).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0], project_root);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn feedback_catalog_uses_exact_unicode_names_and_strict_writes() {
        let mut settings = FeedbackSettings::default();
        let initial_action_bar = settings.action_bar.clone();
        for entry in &settings.catalog {
            validate_feedback_icon_for_write(&entry.icon).unwrap();
        }
        create_feedback_mark(&mut settings, "é", "heart").unwrap();
        create_feedback_mark(&mut settings, "e\u{301}", "star").unwrap();
        create_feedback_mark(&mut settings, " like ", "thumbs-up").unwrap();
        assert!(settings.catalog.iter().any(|entry| entry.name == "é"));
        assert!(
            settings
                .catalog
                .iter()
                .any(|entry| entry.name == "e\u{301}")
        );
        assert_eq!(settings.action_bar, initial_action_bar);
        assert!(create_feedback_mark(&mut settings, "é", "heart").is_err());
        assert!(create_feedback_mark(&mut settings, "bad\nname", "heart").is_err());
        assert!(create_feedback_mark(&mut settings, "bad\u{202e}name", "heart").is_err());
        assert!(create_feedback_mark(&mut settings, "new", "unknown-icon").is_err());
        assert!(create_feedback_mark(&mut settings, "unresolved", "question").is_err());
    }

    #[test]
    fn feedback_action_bar_accepts_eight_and_rejects_invalid_membership() {
        let mut settings = FeedbackSettings::default();
        create_feedback_mark(&mut settings, "eighth", "circle").unwrap();
        let eight = settings
            .catalog
            .iter()
            .map(|entry| entry.name.clone())
            .collect::<Vec<_>>();
        assert_eq!(eight.len(), 8);
        set_feedback_action_bar(&mut settings, &eight).unwrap();
        assert_eq!(settings.action_bar, eight);

        create_feedback_mark(&mut settings, "ninth", "circle").unwrap();
        let nine = settings
            .catalog
            .iter()
            .map(|entry| entry.name.clone())
            .collect::<Vec<_>>();
        assert_eq!(nine.len(), 9);
        assert!(set_feedback_action_bar(&mut settings, &nine).is_err());
        assert!(
            set_feedback_action_bar(&mut settings, &[eight[0].clone(), eight[0].clone()]).is_err()
        );
        assert!(set_feedback_action_bar(&mut settings, &["unknown".to_owned()]).is_err());
        assert_eq!(settings.action_bar, eight);
    }

    #[test]
    fn persisted_unknown_feedback_icons_remain_readable() {
        let settings = FeedbackSettings {
            catalog: vec![FeedbackCatalogEntry {
                name: "future".to_owned(),
                icon: "future-phosphor-name".to_owned(),
            }],
            action_bar: vec!["future".to_owned()],
        };
        validate_feedback_settings(&settings).unwrap();
    }
}
