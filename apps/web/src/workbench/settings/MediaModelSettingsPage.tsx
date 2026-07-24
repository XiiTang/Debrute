import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from '../ui/index.js';
import type {
  AudioModelKind,
  AudioModelSettingRecord,
  ImageModelSettingRecord,
  SaveModelSettingInput,
  VideoModelSettingRecord
} from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../types';
import { Card, CloseButton, EmptyState, Field, IconButton, Input, SecretInput } from '../ui/index.js';
import { useI18n } from '../i18n';

export interface ModelDraft {
  baseUrlOverride: string;
  requestModelIdOverride: string;
  apiKeyInput: string;
}

type SaveStatus = { status: 'idle' } | { status: 'error'; message: string };
type MediaModelSettingRecord = ImageModelSettingRecord | VideoModelSettingRecord | AudioModelSettingRecord;

interface ApiKeyInputProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  label?: string;
  onBlur?: () => void;
  placeholder?: string;
  resetKey?: string;
  configured: boolean;
  onReveal: () => Promise<string>;
  onRevealError: (error: unknown) => void;
}

export function ImageModelSettings({ settings, actions }: { settings: ImageModelSettingRecord[]; actions: WorkbenchActions }): React.ReactElement {
  return <MediaModelSettings models={settings} actions={actions} />;
}

export function VideoModelSettings({ settings, actions }: { settings: VideoModelSettingRecord[]; actions: WorkbenchActions }): React.ReactElement {
  return <MediaModelSettings models={settings} actions={actions} />;
}

export function AudioModelSettings({
  settings,
  actions,
  kind
}: {
  settings: AudioModelSettingRecord[];
  actions: WorkbenchActions;
  kind: AudioModelKind;
}): React.ReactElement {
  return <MediaModelSettings models={settings.filter((model) => model.kind === kind)} actions={actions} />;
}

function MediaModelSettings({
  models,
  actions
}: {
  models: MediaModelSettingRecord[];
  actions: WorkbenchActions;
}): React.ReactElement {
  const i18n = useI18n();

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
              onReveal={() => actions.revealModelApiKey(model.debruteModelId)}
              onSave={(input) => actions.saveGlobalSettings({
                modelSetting: { modelId: model.debruteModelId, setting: input }
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
  onReveal,
  onSave
}: {
  model: MediaModelSettingRecord;
  onReveal: () => Promise<string>;
  onSave: (input: SaveModelSettingInput) => Promise<void>;
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
      if (nextDraft.apiKeyInput) {
        setDraft((current) => current.apiKeyInput === nextDraft.apiKeyInput
          ? { ...current, apiKeyInput: '' }
          : current);
      }
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
                  {i18n.t('settings.models.apiKeyConfigured')}
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
            resetKey={persistedSignature}
            configured={model.apiKeySet}
            onReveal={async () => {
              setStatus({ status: 'idle' });
              return onReveal();
            }}
            onRevealError={(error) => setStatus({ status: 'error', message: errorMessage(error) })}
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
  resetKey,
  configured,
  onReveal,
  onRevealError
}: ApiKeyInputProps): React.ReactElement {
  const i18n = useI18n();
  const [visible, setVisible] = useState(false);
  const [revealedValue, setRevealedValue] = useState('');
  const [revealPending, setRevealPending] = useState(false);
  const revealGeneration = useRef(0);

  useEffect(() => {
    revealGeneration.current += 1;
    setVisible(false);
    setRevealedValue('');
    setRevealPending(false);
  }, [resetKey]);

  useEffect(() => () => {
    revealGeneration.current += 1;
  }, []);

  const hide = () => {
    revealGeneration.current += 1;
    setVisible(false);
    setRevealedValue('');
    setRevealPending(false);
  };

  const toggleVisibility = async () => {
    if (visible) {
      hide();
      return;
    }
    if (value || !configured) {
      setVisible(true);
      return;
    }
    const generation = revealGeneration.current + 1;
    revealGeneration.current = generation;
    setRevealPending(true);
    try {
      const apiKey = await onReveal();
      if (revealGeneration.current === generation) {
        setRevealedValue(apiKey);
        setVisible(true);
      }
    } catch (error) {
      if (revealGeneration.current === generation) {
        onRevealError(error);
      }
    } finally {
      if (revealGeneration.current === generation) {
        setRevealPending(false);
      }
    }
  };

  const visibilityLabel = visible ? i18n.t('settings.models.hideApiKey') : i18n.t('settings.models.showApiKey');
  const effectiveValue = value || revealedValue;
  const effectivePlaceholder = effectiveValue ? undefined : placeholder;
  const input = (
    <span className="settings-secret-field">
      <SecretInput
        className="settings-secret-field__control"
        aria-label={ariaLabel}
        masked={!visible && Boolean(effectiveValue)}
        value={effectiveValue}
        onChange={(event) => {
          revealGeneration.current += 1;
          setRevealedValue('');
          setRevealPending(false);
          onChange(event.currentTarget.value);
        }}
        onBlur={onBlur}
        placeholder={effectivePlaceholder}
        spellCheck={false}
      />
      <IconButton
        className="settings-secret-field__visibility"
        label={visibilityLabel}
        size="xs"
        pressed={visible}
        disabled={revealPending}
        icon={visible ? <EyeOff size={13} /> : <Eye size={13} />}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void toggleVisibility()}
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
  const apiKey = draft.apiKeyInput;
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
    apiKeySet: model.apiKeySet
  });
}

function modelDraftMatchesPersisted(draft: ModelDraft, model: ImageModelSettingRecord | VideoModelSettingRecord | AudioModelSettingRecord): boolean {
  return draft.baseUrlOverride.trim() === (model.baseUrlOverride ?? '')
    && draft.requestModelIdOverride.trim() === (model.requestModelIdOverride ?? '')
    && draft.apiKeyInput === '';
}
