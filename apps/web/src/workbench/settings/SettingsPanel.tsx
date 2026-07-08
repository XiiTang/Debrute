import React, { useEffect, useState } from 'react';
import { AudioLines, Cable, Eye, EyeOff, Image as ImageIcon, Music, Settings, Video, WandSparkles, Wrench } from 'lucide-react';
import type {
  AudioModelKind,
  AudioModelSettingRecord,
  AudioModelSettingsView,
  ImageModelSettingRecord,
  ImageModelSettingsView,
  VideoModelSettingRecord,
  VideoModelSettingsView
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import {
  Card,
  CloseButton,
  Field,
  IconButton,
  Input,
  SecretInput
} from '../ui';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';
import { IntegrationsSettingsPage } from './integrations/IntegrationsSettingsPage';
import { AdobeBridgeSettingsPage } from './adobe-bridge/AdobeBridgeSettingsPage';
import { SettingsResourcePanel } from './SettingsResourcePanel';
import { useI18n } from '../i18n';

export interface ModelDraft {
  baseUrlOverride: string;
  requestModelIdOverride: string;
  apiKeyInput: string;
}

type SaveStatus = { status: 'idle' } | { status: 'error'; message: string };

type MediaModelSaveInput = {
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKey?: string;
};

interface ApiKeyInputProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  label?: string;
  onBlur?: () => void;
  placeholder?: string;
  resetKey?: string;
}

const SETTINGS_NAV_ITEMS = [
  { id: 'general', labelKey: 'settings.nav.general', icon: Settings },
  { id: 'image-models', labelKey: 'settings.nav.imageModels', icon: ImageIcon },
  { id: 'video-models', labelKey: 'settings.nav.videoModels', icon: Video },
  { id: 'tts-models', labelKey: 'settings.nav.ttsModels', icon: AudioLines },
  { id: 'music-models', labelKey: 'settings.nav.musicModels', icon: Music },
  { id: 'sfx-models', labelKey: 'settings.nav.sfxModels', icon: WandSparkles },
  { id: 'integrations', labelKey: 'settings.nav.integrations', icon: Wrench },
  { id: 'adobe-bridge', labelKey: 'settings.nav.adobeBridge', icon: Cable }
] as const;

type SettingsPageId = typeof SETTINGS_NAV_ITEMS[number]['id'];

export function SettingsPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }): React.ReactElement {
  const i18n = useI18n();
  const [activePage, setActivePage] = useState<SettingsPageId>('general');
  return (
    <div className="settings-panel">
      <nav className="settings-directory" aria-label={i18n.t('settings.nav.sections')}>
        {SETTINGS_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={activePage === item.id ? 'db-nav-row db-nav-row--active' : 'db-nav-row'}
              aria-pressed={activePage === item.id}
              onClick={() => setActivePage(item.id)}
            >
              <span className="db-nav-row__icon"><Icon size={15} /></span>
              <strong>{i18n.t(item.labelKey)}</strong>
            </button>
          );
        })}
      </nav>
      <div className="settings-page">
        {activePage === 'general' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.general.title')}
            resource={state.workbenchPreferences}
            onRetry={actions.reloadWorkbenchPreferences}
          >
            {(preferences) => (
              <GeneralSettingsPage
                actions={actions}
                resolvedTheme={state.resolvedTheme}
                preferences={preferences}
                onPreferencesChange={actions.saveWorkbenchPreferences}
              />
            )}
          </SettingsResourcePanel>
        ) : activePage === 'image-models' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.models.imageTitle')}
            resource={state.imageModelSettings}
            onRetry={actions.reloadImageModelSettings}
          >
            {(settings) => <ImageModelSettings settings={settings} actions={actions} />}
          </SettingsResourcePanel>
        ) : activePage === 'video-models' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.models.videoTitle')}
            resource={state.videoModelSettings}
            onRetry={actions.reloadVideoModelSettings}
          >
            {(settings) => <VideoModelSettings settings={settings} actions={actions} />}
          </SettingsResourcePanel>
        ) : activePage === 'tts-models' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.models.ttsTitle')}
            resource={state.audioModelSettings}
            onRetry={actions.reloadAudioModelSettings}
          >
            {(settings) => <AudioModelSettings settings={settings} actions={actions} kind="tts" title={i18n.t('settings.models.ttsTitle')} />}
          </SettingsResourcePanel>
        ) : activePage === 'music-models' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.models.musicTitle')}
            resource={state.audioModelSettings}
            onRetry={actions.reloadAudioModelSettings}
          >
            {(settings) => <AudioModelSettings settings={settings} actions={actions} kind="music" title={i18n.t('settings.models.musicTitle')} />}
          </SettingsResourcePanel>
        ) : activePage === 'sfx-models' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.models.sfxTitle')}
            resource={state.audioModelSettings}
            onRetry={actions.reloadAudioModelSettings}
          >
            {(settings) => <AudioModelSettings settings={settings} actions={actions} kind="sound-effect" title={i18n.t('settings.models.sfxTitle')} />}
          </SettingsResourcePanel>
        ) : activePage === 'integrations' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.integrations.title')}
            resource={state.integrationsSettings}
            onRetry={actions.reloadIntegrationsSettings}
          >
            {(settings) => <IntegrationsSettingsPage settings={settings} actions={actions} />}
          </SettingsResourcePanel>
        ) : activePage === 'adobe-bridge' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.adobeBridge.title')}
            resource={state.adobeBridge}
            onRetry={actions.reloadAdobeBridge}
          >
            {(bridge) => <AdobeBridgeSettingsPage bridge={bridge} projectId={state.projectId} actions={actions} />}
          </SettingsResourcePanel>
        ) : null}
      </div>
    </div>
  );
}

export function ImageModelSettings({ settings, actions }: { settings: ImageModelSettingsView; actions: WorkbenchActions }): React.ReactElement {
  const i18n = useI18n();
  const models = settings.models;

  return (
    <section className="db-settings-section">
      <SettingsSectionHeader title={i18n.t('settings.models.imageTitle')} />
      <div className="db-form-grid">
        {models.map((model) => (
          <MediaModelCard
            key={model.debruteModelId}
            model={model}
            onSave={(input) => actions.saveImageModelSetting(model.debruteModelId, input)}
          />
        ))}
      </div>
    </section>
  );
}

export function VideoModelSettings({ settings, actions }: { settings: VideoModelSettingsView; actions: WorkbenchActions }): React.ReactElement {
  const i18n = useI18n();
  const models = settings.models;

  return (
    <section className="db-settings-section">
      <SettingsSectionHeader title={i18n.t('settings.models.videoTitle')} />
      <div className="db-form-grid">
        {models.map((model) => (
          <MediaModelCard
            key={model.debruteModelId}
            model={model}
            onSave={(input) => actions.saveVideoModelSetting(model.debruteModelId, input)}
          />
        ))}
      </div>
    </section>
  );
}

export function AudioModelSettings({
  settings,
  actions,
  kind,
  title
}: {
  settings: AudioModelSettingsView;
  actions: WorkbenchActions;
  kind: AudioModelKind;
  title: string;
}): React.ReactElement {
  const models = settings.models.filter((model) => model.kind === kind);

  return (
    <section className="db-settings-section">
      <SettingsSectionHeader title={title} />
      <div className="db-form-grid">
        {models.map((model) => (
          <MediaModelCard
            key={model.debruteModelId}
            model={model}
            onSave={(input) => actions.saveAudioModelSetting(model.debruteModelId, input)}
          />
        ))}
      </div>
    </section>
  );
}

function SettingsSectionHeader({
  title
}: {
  title: string;
}): React.ReactElement {
  return (
    <header className="db-settings-section__header">
      <h2>{title}</h2>
    </header>
  );
}

function MediaModelCard({
  model,
  onSave
}: {
  model: ImageModelSettingRecord | VideoModelSettingRecord | AudioModelSettingRecord;
  onSave: (input: MediaModelSaveInput) => Promise<void>;
}): React.ReactElement {
  const i18n = useI18n();
  const [draft, setDraft] = useState(() => modelToDraft(model));
  const [status, setStatus] = useState<SaveStatus>({ status: 'idle' });

  useEffect(() => {
    setDraft(modelToDraft(model));
    setStatus({ status: 'idle' });
  }, [model]);

  const saveDraft = async (nextDraft: ModelDraft) => {
    if (modelDraftMatchesPersisted(nextDraft, model)) {
      return;
    }
    setStatus({ status: 'idle' });
    try {
      await onSave(modelDraftToSaveInput(nextDraft));
    } catch (error) {
      setStatus({ status: 'error', message: errorMessage(error) });
    }
  };

  const deleteApiKey = async () => {
    setStatus({ status: 'idle' });
    try {
      await onSave(modelDraftToDeleteApiKeyInput(draft));
    } catch (error) {
      setStatus({ status: 'error', message: errorMessage(error) });
    }
  };

  return (
    <Card className="db-model-card">
      <div className="db-model-card__header">
        <div>
          <strong>{model.debruteModelId}</strong>
          {model.apiKeySet ? (
            <div className="db-model-card__key-summary">
              <span className="canvas-feedback-comment-pill">
                <span className="canvas-feedback-comment-pill-text">
                  {i18n.t('settings.models.apiKeyConfigured', { preview: model.apiKeyPreview })}
                </span>
                <CloseButton
                  className="canvas-feedback-comment-pill-close"
                  label={i18n.t('settings.models.deleteApiKey')}
                  title={i18n.t('settings.models.deleteApiKey')}
                  onClick={() => void deleteApiKey()}
                />
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="db-model-card__fields">
        <div className="db-form-row">
          <ApiKeyInput
            ariaLabel={i18n.t('settings.models.apiKey')}
            value={draft.apiKeyInput}
            onChange={(apiKeyInput) => setDraft({ ...draft, apiKeyInput })}
            onBlur={() => void saveDraft(draft)}
            placeholder={i18n.t('settings.models.apiKey')}
            resetKey={model.debruteModelId}
          />
        </div>
        <div className="db-form-grid db-form-grid--two">
          <div className="db-form-row">
            <Field label={i18n.t('settings.models.baseUrlOverride')}>
              <Input
                aria-label={i18n.t('settings.models.baseUrlOverride')}
                value={draft.baseUrlOverride}
                onChange={(event) => setDraft({ ...draft, baseUrlOverride: event.currentTarget.value })}
                onBlur={() => void saveDraft(draft)}
                placeholder={model.defaultBaseUrl}
              />
            </Field>
          </div>
          <div className="db-form-row">
            <Field label={i18n.t('settings.models.requestModelIdOverride')}>
              <Input
                aria-label={i18n.t('settings.models.requestModelIdOverride')}
                value={draft.requestModelIdOverride}
                onChange={(event) => setDraft({ ...draft, requestModelIdOverride: event.currentTarget.value })}
                onBlur={() => void saveDraft(draft)}
                placeholder={model.defaultRequestModelId}
              />
            </Field>
          </div>
        </div>
      </div>
      {status.status === 'error' ? (
        <small className="db-form-error">{status.message}</small>
      ) : null}
    </Card>
  );
}

function ApiKeyInput({
  value,
  onChange,
  ariaLabel,
  label,
  onBlur,
  placeholder,
  resetKey
}: ApiKeyInputProps): React.ReactElement {
  const i18n = useI18n();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(false);
  }, [resetKey]);

  const visibilityLabel = visible ? i18n.t('settings.models.hideApiKey') : i18n.t('settings.models.showApiKey');
  const effectivePlaceholder = value ? undefined : placeholder;
  const input = (
    <span className="db-secret-field">
      <SecretInput
        className="db-secret-field__control"
        aria-label={ariaLabel}
        masked={!visible && Boolean(value)}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={onBlur}
        placeholder={effectivePlaceholder}
        spellCheck={false}
      />
      <IconButton
        className="db-secret-field__visibility"
        label={visibilityLabel}
        size="xs"
        pressed={visible}
        icon={visible ? <EyeOff size={13} /> : <Eye size={13} />}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((current) => !current)}
      />
    </span>
  );

  if (!label) {
    return input;
  }

  return <Field label={label}>{input}</Field>;
}

export function modelToDraft(model: ImageModelSettingRecord | VideoModelSettingRecord | AudioModelSettingRecord): ModelDraft {
  return {
    baseUrlOverride: model.baseUrlOverride ?? '',
    requestModelIdOverride: model.requestModelIdOverride ?? '',
    apiKeyInput: ''
  };
}

export function modelDraftToSaveInput(draft: ModelDraft) {
  const apiKey = draft.apiKeyInput.trim();
  return {
    baseUrlOverride: draft.baseUrlOverride.trim() || null,
    requestModelIdOverride: draft.requestModelIdOverride.trim() || null,
    ...(apiKey ? { apiKey } : {})
  };
}

export function modelDraftToDeleteApiKeyInput(draft: ModelDraft) {
  return {
    baseUrlOverride: draft.baseUrlOverride.trim() || null,
    requestModelIdOverride: draft.requestModelIdOverride.trim() || null,
    apiKey: ''
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelDraftMatchesPersisted(draft: ModelDraft, model: ImageModelSettingRecord | VideoModelSettingRecord | AudioModelSettingRecord): boolean {
  return draft.baseUrlOverride.trim() === (model.baseUrlOverride ?? '')
    && draft.requestModelIdOverride.trim() === (model.requestModelIdOverride ?? '')
    && draft.apiKeyInput.trim() === '';
}
