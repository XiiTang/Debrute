import React, { useEffect, useState } from 'react';
import { Bot, Cable, Cpu, Eye, EyeOff, RefreshCw, Save, Search, Settings, Trash2, Wrench } from 'lucide-react';
import type {
  ImageModelSettingRecord,
  LlmProviderSettingRecord,
  SaveLlmProviderSettingInput,
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
  Select,
  StatusPill,
  Switch,
  Textarea,
  Toolbar
} from '../ui';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';
import { IntegrationsSettingsPage } from './integrations/IntegrationsSettingsPage';
import { AdobeBridgeSettingsPage } from './adobe-bridge/AdobeBridgeSettingsPage';
import { useI18n } from '../i18n';

export interface LlmProviderDraft {
  id: string;
  name: string;
  providerType: 'openai_compat' | 'anthropic';
  baseUrl: string;
  modelIdsText: string;
  enabled: boolean;
  apiKeyInput: string;
}

export interface ModelDraft {
  baseUrlOverride: string;
  requestModelIdOverride: string;
  apiKeyInput: string;
}

interface ApiKeyInputProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  label?: string;
  onBlur?: () => void;
  placeholder?: string;
  resetKey?: string;
}

type DiscoveryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; message: string }
  | { status: 'error'; message: string };

const SETTINGS_NAV_ITEMS = [
  { id: 'general', labelKey: 'settings.nav.general', icon: Settings },
  { id: 'llm', labelKey: 'settings.nav.llm', icon: Bot },
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
        ) : activePage === 'llm' ? (
          <LlmSettings state={state} actions={actions} />
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

export function LlmSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }): React.ReactElement {
  const i18n = useI18n();
  const settings = state.llmSettings;
  const [editingProviderId, setEditingProviderId] = useState<string>();
  const [draft, setDraft] = useState<LlmProviderDraft>(createEmptyLlmProviderDraft());
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: 'idle' });

  useEffect(() => {
    const provider = settings?.providers.find((entry) => entry.id === editingProviderId);
    setDraft(provider ? llmProviderToDraft(provider) : createEmptyLlmProviderDraft());
    setDiscovery({ status: 'idle' });
  }, [editingProviderId, settings]);

  const save = async () => {
    await actions.saveLlmProviderSetting(llmProviderDraftToSaveInput(draft), editingProviderId);
    setEditingProviderId(undefined);
  };

  const clearProviderApiKey = async (provider: LlmProviderSettingRecord) => {
    await actions.saveLlmProviderSetting(llmProviderDraftToClearApiKeyInput(llmProviderToDraft(provider)), provider.id);
  };

  const discoverModels = async () => {
    setDiscovery({ status: 'loading' });
    try {
      const result = await actions.discoverLlmProviderModels({
        id: draft.id.trim(),
        providerType: draft.providerType,
        baseUrl: draft.baseUrl.trim(),
        ...(draft.apiKeyInput.trim() ? { apiKey: draft.apiKeyInput.trim() } : {})
      }, editingProviderId);
      if (!result.supportsDiscovery) {
        setDiscovery({ status: 'ok', message: i18n.t('settings.llm.discoveryUnavailable') });
        return;
      }
      setDraft((current) => ({
        ...current,
        modelIdsText: mergeModelIds(current.modelIdsText, result.models).join('\n')
      }));
      setDiscovery({
        status: 'ok',
        message: result.modelsCount === 0
          ? i18n.t('settings.llm.noModelsFound', { endpoint: result.endpoint })
          : i18n.t('settings.llm.discoveredModels', { count: result.modelsCount, endpoint: result.endpoint })
      });
    } catch (error) {
      setDiscovery({ status: 'error', message: errorMessage(error) });
    }
  };

  return (
    <section className="db-settings-section">
      <SettingsSectionHeader title={i18n.t('settings.llm.title')} />
      <Card>
        <Field label={i18n.t('settings.llm.defaultModel')}>
          <Select
            value={settings?.defaultModelKey ?? ''}
            onChange={(event) => void actions.setDefaultLlmModelKey(event.currentTarget.value || null)}
          >
            <option value="">{i18n.t('common.none')}</option>
            {(settings?.availableModelKeys ?? []).map((modelKey: string) => (
              <option key={modelKey} value={modelKey}>{modelKey}</option>
            ))}
          </Select>
        </Field>
      </Card>
      <div className="db-form-grid">
        <form className="db-form-grid db-form-grid--contents" onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}>
          <Card>
            <strong>{editingProviderId ? i18n.t('settings.llm.editProvider') : i18n.t('settings.llm.addProvider')}</strong>
            <div className="db-form-row">
              <Field label={i18n.t('settings.llm.providerType')}>
                <Select value={draft.providerType} onChange={(event) => setDraft({ ...draft, providerType: event.currentTarget.value as LlmProviderDraft['providerType'] })}>
                  <option value="openai_compat">{i18n.t('settings.llm.openaiCompatible')}</option>
                  <option value="anthropic">{i18n.t('settings.llm.anthropic')}</option>
                </Select>
              </Field>
            </div>
            <div className="db-form-row"><Field label={i18n.t('settings.llm.id')}><Input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.currentTarget.value })} /></Field></div>
            <div className="db-form-row"><Field label={i18n.t('settings.llm.name')}><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></Field></div>
            <div className="db-form-row"><Field label={i18n.t('settings.llm.baseUrl')}><Input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.currentTarget.value })} /></Field></div>
            <div className="db-form-row"><Field label={i18n.t('settings.llm.modelIds')}><Textarea value={draft.modelIdsText} onChange={(event) => setDraft({ ...draft, modelIdsText: event.currentTarget.value })} /></Field></div>
            <div className="db-form-row">
              <ApiKeyInput
                label={i18n.t('settings.llm.apiKey')}
                value={draft.apiKeyInput}
                onChange={(apiKeyInput) => setDraft({ ...draft, apiKeyInput })}
                resetKey={editingProviderId ?? 'new'}
              />
            </div>
            <Switch label={i18n.t('common.enabled')} checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })} />
            {discovery.status !== 'idle' ? (
              <small className={discovery.status === 'error' ? 'db-form-error' : ''}>
                {discovery.status === 'loading' ? i18n.t('settings.llm.discoveringModels') : discovery.message}
              </small>
            ) : null}
            <Toolbar ariaLabel={i18n.t('settings.llm.providerActions', { name: draft.name || draft.id || i18n.t('settings.llm.addProvider') })} className="db-action-row">
              {editingProviderId ? <Button type="button" onClick={() => setEditingProviderId(undefined)}>{i18n.t('common.cancel')}</Button> : null}
              <Button type="button" disabled={!draft.baseUrl.trim() || discovery.status === 'loading'} iconStart={<Search size={14} />} onClick={() => void discoverModels()}>
                {i18n.t('settings.llm.discoverModels')}
              </Button>
              <Button type="submit" variant="primary" disabled={!draft.id.trim() || !draft.name.trim() || !draft.baseUrl.trim() || splitModelIds(draft.modelIdsText).length === 0} iconStart={<Save size={14} />}>
                {editingProviderId ? i18n.t('settings.llm.saveProvider') : i18n.t('settings.llm.addProviderAction')}
              </Button>
            </Toolbar>
          </Card>
        </form>
        <div className="db-form-grid">
          {(settings?.providers ?? []).map((provider) => (
            <LlmProviderCard
              key={provider.id}
              provider={provider}
              onEdit={() => setEditingProviderId(provider.id)}
              onClearApiKey={() => void clearProviderApiKey(provider)}
              onDelete={() => void actions.deleteLlmProviderSetting(provider.id)}
            />
          ))}
        </div>
      </div>
    </section>
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
  const [status, setStatus] = useState<DiscoveryState>({ status: 'idle' });

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
            ariaLabel={i18n.t('settings.llm.apiKey')}
            value={draft.apiKeyInput}
            onChange={(apiKeyInput) => setDraft({ ...draft, apiKeyInput })}
            onBlur={() => void saveDraft(draft)}
            placeholder={i18n.t('settings.llm.apiKey')}
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

function LlmProviderCard({
  provider,
  onEdit,
  onClearApiKey,
  onDelete
}: {
  provider: LlmProviderSettingRecord;
  onEdit: () => void;
  onClearApiKey: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const i18n = useI18n();
  return (
    <Card>
      <strong>{provider.name}</strong>
      <small>{provider.providerType} / {provider.baseUrl}</small>
      <div className="db-status-list">
        {!provider.enabled ? <StatusPill tone="neutral">{i18n.t('common.disabled')}</StatusPill> : null}
        {provider.apiKeySet
          ? <StatusPill>{i18n.t('settings.llm.apiKeyConfigured', { preview: requireApiKeyPreview(provider.apiKeyPreview) })}</StatusPill>
          : <StatusPill tone="neutral">{i18n.t('settings.llm.apiKeyMissing')}</StatusPill>}
        {provider.modelKeys.map((modelKey) => <StatusPill key={modelKey}>{modelKey}</StatusPill>)}
      </div>
      <Toolbar ariaLabel={i18n.t('settings.llm.providerActions', { name: provider.name })} className="db-action-row">
        <Button type="button" onClick={onEdit}>{i18n.t('settings.llm.edit')}</Button>
        {provider.apiKeySet ? <Button type="button" variant="danger" onClick={onClearApiKey}>{i18n.t('settings.llm.clearApiKey')}</Button> : null}
        <Button type="button" variant="danger" iconStart={<Trash2 size={14} />} onClick={onDelete}>{i18n.t('common.delete')}</Button>
      </Toolbar>
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

  const visibilityLabel = visible ? i18n.t('settings.llm.hideApiKey') : i18n.t('settings.llm.showApiKey');
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

function modelDraftMatchesPersisted(draft: ModelDraft, model: ImageModelSettingRecord | VideoModelSettingRecord): boolean {
  return draft.baseUrlOverride.trim() === (model.baseUrlOverride ?? '')
    && draft.requestModelIdOverride.trim() === (model.requestModelIdOverride ?? '')
    && draft.apiKeyInput.trim() === '';
}

function createEmptyLlmProviderDraft(): LlmProviderDraft {
  return {
    id: '',
    name: '',
    providerType: 'openai_compat',
    baseUrl: '',
    modelIdsText: '',
    enabled: true,
    apiKeyInput: ''
  };
}

export function llmProviderToDraft(provider: LlmProviderSettingRecord): LlmProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    providerType: provider.providerType,
    baseUrl: provider.baseUrl,
    modelIdsText: provider.modelIds.join('\n'),
    enabled: provider.enabled,
    apiKeyInput: ''
  };
}

export function llmProviderDraftToSaveInput(draft: LlmProviderDraft): SaveLlmProviderSettingInput {
  const apiKey = draft.apiKeyInput.trim();
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    providerType: draft.providerType,
    baseUrl: draft.baseUrl.trim(),
    enabled: draft.enabled,
    modelIds: splitModelIds(draft.modelIdsText),
    ...(apiKey ? { apiKey } : {})
  };
}

export function llmProviderDraftToClearApiKeyInput(draft: LlmProviderDraft): SaveLlmProviderSettingInput {
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    providerType: draft.providerType,
    baseUrl: draft.baseUrl.trim(),
    enabled: draft.enabled,
    modelIds: splitModelIds(draft.modelIdsText),
    apiKey: ''
  };
}

function splitModelIds(value: string): string[] {
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function mergeModelIds(currentText: string, discoveredModels: string[]): string[] {
  return [...new Set([...splitModelIds(currentText), ...discoveredModels.map((model) => model.trim()).filter(Boolean)])];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
