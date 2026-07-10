import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type {
  AudioModelKind,
  AudioModelSettingRecord,
  AudioModelSettingsView,
  ImageModelSettingRecord,
  ImageModelSettingsView,
  VideoModelSettingRecord,
  VideoModelSettingsView
} from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../types';
import { Card, CloseButton, EmptyState, Field, IconButton, Input, SecretInput } from '../ui';
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

export function ImageModelSettings({ settings, actions }: { settings: ImageModelSettingsView; actions: WorkbenchActions }): React.ReactElement {
  const i18n = useI18n();
  const models = settings.models;

  return (
    <section className="settings-page-body">
      {models.length === 0 ? (
        <EmptyState title={i18n.t('settings.models.noneAvailable')} />
      ) : (
        <div className="db-form-grid">
          {models.map((model) => (
            <MediaModelCard
              key={model.debruteModelId}
              model={model}
              onSave={(input) => actions.saveGlobalSettings({
                models: { image: { modelId: model.debruteModelId, setting: input } }
              })}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function VideoModelSettings({ settings, actions }: { settings: VideoModelSettingsView; actions: WorkbenchActions }): React.ReactElement {
  const i18n = useI18n();
  const models = settings.models;

  return (
    <section className="settings-page-body">
      {models.length === 0 ? (
        <EmptyState title={i18n.t('settings.models.noneAvailable')} />
      ) : (
        <div className="db-form-grid">
          {models.map((model) => (
            <MediaModelCard
              key={model.debruteModelId}
              model={model}
              onSave={(input) => actions.saveGlobalSettings({
                models: { video: { modelId: model.debruteModelId, setting: input } }
              })}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function AudioModelSettings({
  settings,
  actions,
  kind
}: {
  settings: AudioModelSettingsView;
  actions: WorkbenchActions;
  kind: AudioModelKind;
}): React.ReactElement {
  const i18n = useI18n();
  const models = settings.models.filter((model) => model.kind === kind);

  return (
    <section className="settings-page-body">
      {models.length === 0 ? (
        <EmptyState title={i18n.t('settings.models.noneAvailable')} />
      ) : (
        <div className="db-form-grid">
          {models.map((model) => (
            <MediaModelCard
              key={model.debruteModelId}
              model={model}
              onSave={(input) => actions.saveGlobalSettings({
                models: { audio: { modelId: model.debruteModelId, setting: input } }
              })}
            />
          ))}
        </div>
      )}
    </section>
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
  const persistedSignature = mediaModelPersistedSignature(model);

  useEffect(() => {
    setDraft(modelToDraft(model));
    setStatus({ status: 'idle' });
  }, [persistedSignature]);

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
    <Card className="settings-model-card">
      <div className="settings-model-card__header">
        <div>
          <strong>{model.debruteModelId}</strong>
          {model.apiKeySet ? (
            <div className="settings-model-card__key-summary">
              <span className="settings-api-key-summary">
                <span className="settings-api-key-summary__text">
                  {i18n.t('settings.models.apiKeyConfigured', { preview: model.apiKeyPreview })}
                </span>
                <CloseButton
                  className="settings-api-key-summary__remove"
                  label={i18n.t('settings.models.deleteApiKey')}
                  title={i18n.t('settings.models.deleteApiKey')}
                  onClick={() => void deleteApiKey()}
                />
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="settings-model-card__fields">
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
    <span className="settings-secret-field">
      <SecretInput
        className="settings-secret-field__control"
        aria-label={ariaLabel}
        masked={!visible && Boolean(value)}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={onBlur}
        placeholder={effectivePlaceholder}
        spellCheck={false}
      />
      <IconButton
        className="settings-secret-field__visibility"
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

function mediaModelPersistedSignature(model: ImageModelSettingRecord | VideoModelSettingRecord | AudioModelSettingRecord): string {
  return JSON.stringify({
    debruteModelId: model.debruteModelId,
    baseUrlOverride: model.baseUrlOverride ?? null,
    requestModelIdOverride: model.requestModelIdOverride ?? null,
    apiKeySet: model.apiKeySet,
    apiKeyPreview: model.apiKeyPreview ?? null
  });
}

function modelDraftMatchesPersisted(draft: ModelDraft, model: ImageModelSettingRecord | VideoModelSettingRecord | AudioModelSettingRecord): boolean {
  return draft.baseUrlOverride.trim() === (model.baseUrlOverride ?? '')
    && draft.requestModelIdOverride.trim() === (model.requestModelIdOverride ?? '')
    && draft.apiKeyInput.trim() === '';
}
