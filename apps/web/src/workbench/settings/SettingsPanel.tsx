import React, { useEffect, useState } from 'react';
import { Cable, Cpu, Eye, EyeOff, Settings, Wrench } from 'lucide-react';
import type {
  ImageModelSettingRecord,
  VideoModelSettingRecord
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import {
  Button,
  Card,
  Field,
  IconButton,
  Input,
  SecretInput,
  StatusPill
} from '../ui';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';
import { IntegrationsSettingsPage } from './integrations/IntegrationsSettingsPage';
import { AdobeBridgeSettingsPage } from './adobe-bridge/AdobeBridgeSettingsPage';
import { useI18n } from '../i18n';

export interface ModelDraft {
  baseUrlOverride: string;
  requestModelIdOverride: string;
  apiKeyInput: string;
}

type SaveStatus = { status: 'idle' } | { status: 'error'; message: string };

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
  { id: 'models', labelKey: 'settings.nav.models', icon: Cpu },
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
        ) : activePage === 'models' ? (
          <>
            <ImageModelSettings state={state} actions={actions} />
            <VideoModelSettings state={state} actions={actions} />
          </>
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
  model: ImageModelSettingRecord | VideoModelSettingRecord;
  onSave: (input: ReturnType<typeof modelDraftToSaveInput>) => Promise<void>;
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

  const clearApiKey = async () => {
    setStatus({ status: 'idle' });
    try {
      await onSave(modelDraftToClearApiKeyInput(draft));
    } catch (error) {
      setStatus({ status: 'error', message: errorMessage(error) });
    }
  };

  return (
    <Card className="db-model-card">
      <div className="db-model-card__header">
        <div>
          <strong>{model.debruteModelId}</strong>
          {model.apiKeySet
            ? <StatusPill>{i18n.t('settings.models.apiKeyConfigured', { preview: requireApiKeyPreview(model.apiKeyPreview) })}</StatusPill>
            : <StatusPill tone="neutral">{i18n.t('settings.models.apiKeyMissing')}</StatusPill>}
        </div>
        {model.apiKeySet ? (
          <Button type="button" variant="danger" onClick={() => void clearApiKey()}>
            {i18n.t('settings.models.clearApiKey')}
          </Button>
        ) : null}
      </div>
      <div className="db-model-card__fields">
        <div className="db-form-row">
          <ApiKeyInput
            ariaLabel={i18n.t('settings.models.apiKey')}
            value={draft.apiKeyInput}
            onChange={(apiKeyInput) => setDraft({ ...draft, apiKeyInput })}
            onBlur={() => void saveDraft(draft)}
            placeholder={i18n.t('settings.models.apiKey')}
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

export function modelToDraft(model: ImageModelSettingRecord | VideoModelSettingRecord): ModelDraft {
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

export function modelDraftToClearApiKeyInput(draft: ModelDraft) {
  return {
    baseUrlOverride: draft.baseUrlOverride.trim() || null,
    requestModelIdOverride: draft.requestModelIdOverride.trim() || null,
    apiKey: ''
  };
}

function requireApiKeyPreview(preview: string | undefined): string {
  if (preview === undefined) {
    throw new Error('[debrute:settings] Missing API key preview.');
  }
  return preview;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelDraftMatchesPersisted(draft: ModelDraft, model: ImageModelSettingRecord | VideoModelSettingRecord): boolean {
  return draft.baseUrlOverride.trim() === (model.baseUrlOverride ?? '')
    && draft.requestModelIdOverride.trim() === (model.requestModelIdOverride ?? '')
    && draft.apiKeyInput.trim() === '';
}
