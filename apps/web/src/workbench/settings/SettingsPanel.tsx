import React, { useEffect, useState } from 'react';
import { AudioLines, Cable, Image as ImageIcon, Music, Settings, Video, WandSparkles, Wrench } from 'lucide-react';
import type {
  AudioModelKind,
  AudioModelSettingRecord,
  ImageModelSettingRecord,
  SaveModelApiKeyEntryInput,
  VideoModelSettingRecord
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import {
  Card,
  Field,
  Input,
  StatusPill
} from '../ui';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';
import { IntegrationsSettingsPage } from './integrations/IntegrationsSettingsPage';
import { AdobeBridgeSettingsPage } from './adobe-bridge/AdobeBridgeSettingsPage';
import { useI18n } from '../i18n';
import { ModelApiKeyListEditor } from './ModelApiKeyListEditor';

export interface ModelDraft {
  baseUrlOverride: string;
  requestModelIdOverride: string;
}

type SaveStatus = { status: 'idle' } | { status: 'error'; message: string };

type MediaModelSaveInput = {
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
  apiKeys?: SaveModelApiKeyEntryInput[];
};

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
          <GeneralSettingsPage
            actions={actions}
            resolvedTheme={state.resolvedTheme}
            onPreferencesChange={actions.saveWorkbenchPreferences}
            {...(state.workbenchPreferences ? { preferences: state.workbenchPreferences } : {})}
          />
        ) : activePage === 'image-models' ? (
          <ImageModelSettings state={state} actions={actions} />
        ) : activePage === 'video-models' ? (
          <VideoModelSettings state={state} actions={actions} />
        ) : activePage === 'tts-models' ? (
          <AudioModelSettings state={state} actions={actions} kind="tts" title={i18n.t('settings.models.ttsTitle')} />
        ) : activePage === 'music-models' ? (
          <AudioModelSettings state={state} actions={actions} kind="music" title={i18n.t('settings.models.musicTitle')} />
        ) : activePage === 'sfx-models' ? (
          <AudioModelSettings state={state} actions={actions} kind="sound-effect" title={i18n.t('settings.models.sfxTitle')} />
        ) : activePage === 'integrations' ? (
          <IntegrationsSettingsPage state={state} actions={actions} />
        ) : activePage === 'adobe-bridge' ? (
          <AdobeBridgeSettingsPage state={state} actions={actions} />
        ) : null}
      </div>
    </div>
  );
}

export function ImageModelSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }): React.ReactElement {
  const i18n = useI18n();
  const models = state.imageModelSettings?.models ?? [];

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

export function VideoModelSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }): React.ReactElement {
  const i18n = useI18n();
  const models = state.videoModelSettings?.models ?? [];

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
  state,
  actions,
  kind,
  title
}: {
  state: WorkbenchState;
  actions: WorkbenchActions;
  kind: AudioModelKind;
  title: string;
}): React.ReactElement {
  const models = (state.audioModelSettings?.models ?? []).filter((model) => model.kind === kind);

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

  return (
    <Card className="db-model-card">
      <div className="db-model-card__header">
        <div>
          <strong>{model.debruteModelId}</strong>
          <div className="db-model-card__key-summary">
            <StatusPill tone={model.apiKeySet ? 'success' : 'neutral'}>
              {model.apiKeySet
                ? i18n.t('settings.models.apiKeysEnabledSummary', {
                  enabled: model.enabledApiKeyCount,
                  total: model.apiKeyCount
                })
                : i18n.t('settings.models.apiKeyMissing')}
            </StatusPill>
          </div>
        </div>
      </div>
      <div className="db-model-card__fields">
        <ModelApiKeyListEditor
          previews={model.apiKeyPreviews}
          onSave={(apiKeys) => onSave({
            baseUrlOverride: draft.baseUrlOverride.trim() || null,
            requestModelIdOverride: draft.requestModelIdOverride.trim() || null,
            apiKeys
          })}
        />
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

export function modelToDraft(model: ImageModelSettingRecord | VideoModelSettingRecord | AudioModelSettingRecord): ModelDraft {
  return {
    baseUrlOverride: model.baseUrlOverride ?? '',
    requestModelIdOverride: model.requestModelIdOverride ?? ''
  };
}

export function modelDraftToSaveInput(draft: ModelDraft) {
  return {
    baseUrlOverride: draft.baseUrlOverride.trim() || null,
    requestModelIdOverride: draft.requestModelIdOverride.trim() || null
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelDraftMatchesPersisted(draft: ModelDraft, model: ImageModelSettingRecord | VideoModelSettingRecord | AudioModelSettingRecord): boolean {
  return draft.baseUrlOverride.trim() === (model.baseUrlOverride ?? '')
    && draft.requestModelIdOverride.trim() === (model.requestModelIdOverride ?? '');
}
