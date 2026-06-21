import React, { useEffect, useState } from 'react';
import { Bot, Cable, Cpu, Eye, EyeOff, RefreshCw, Save, Search, Settings, Terminal, Trash2, Wrench } from 'lucide-react';
import type {
  ImageModelSettingRecord,
  LlmProviderSettingRecord,
  SaveLlmProviderSettingInput,
  VideoModelSettingRecord
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { getDebruteShellApi } from '../../api/shellApi';
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
import { DebruteCliSettingsPage } from './debrute-cli/DebruteCliSettingsPage';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';
import { IntegrationsSettingsPage } from './integrations/IntegrationsSettingsPage';
import { AdobeBridgeSettingsPage } from './adobe-bridge/AdobeBridgeSettingsPage';

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
  { id: 'general', label: 'General', icon: Settings },
  { id: 'llm', label: 'LLM', icon: Bot },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'integrations', label: 'Integrations', icon: Wrench },
  { id: 'adobe-bridge', label: 'Adobe Bridge', icon: Cable },
  { id: 'debrute-cli', label: 'Debrute CLI', icon: Terminal }
] as const;

type SettingsPageId = typeof SETTINGS_NAV_ITEMS[number]['id'];

export function SettingsPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }): React.ReactElement {
  const [activePage, setActivePage] = useState<SettingsPageId>('general');
  return (
    <div className="settings-panel">
      <nav className="settings-directory" aria-label="Settings sections">
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
              <strong>{item.label}</strong>
            </button>
          );
        })}
      </nav>
      <div className="settings-page">
        {activePage === 'general' ? (
          <GeneralSettingsPage shell={getDebruteShellApi()} />
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
        ) : activePage === 'debrute-cli' ? (
          <DebruteCliSettingsPage shell={getDebruteShellApi()} />
        ) : null}
      </div>
    </div>
  );
}

export function LlmSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }): React.ReactElement {
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
        setDiscovery({ status: 'ok', message: 'Model discovery is not available for this provider.' });
        return;
      }
      setDraft((current) => ({
        ...current,
        modelIdsText: mergeModelIds(current.modelIdsText, result.models).join('\n')
      }));
      setDiscovery({
        status: 'ok',
        message: result.modelsCount === 0
          ? `No models found at ${result.endpoint}.`
          : `Discovered ${result.modelsCount} models from ${result.endpoint}.`
      });
    } catch (error) {
      setDiscovery({ status: 'error', message: errorMessage(error) });
    }
  };

  return (
    <section className="settings-section">
      <SettingsSectionHeader title="LLM Providers" />
      <Card>
        <Field label="Default Model">
          <Select
            value={settings?.defaultModelKey ?? ''}
            onChange={(event) => void actions.setDefaultLlmModelKey(event.currentTarget.value || null)}
          >
            <option value="">None</option>
            {(settings?.availableModelKeys ?? []).map((modelKey: string) => (
              <option key={modelKey} value={modelKey}>{modelKey}</option>
            ))}
          </Select>
        </Field>
      </Card>
      <div className="settings-grid">
        <form className="settings-edit-form" onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}>
          <Card>
          <strong>{editingProviderId ? 'Edit LLM Provider' : 'Add LLM Provider'}</strong>
          <div className="settings-row">
            <Field label="Provider Type">
              <Select value={draft.providerType} onChange={(event) => setDraft({ ...draft, providerType: event.currentTarget.value as LlmProviderDraft['providerType'] })}>
                <option value="openai_compat">OpenAI Compatible</option>
                <option value="anthropic">Anthropic</option>
              </Select>
            </Field>
          </div>
          <div className="settings-row"><Field label="ID"><Input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.currentTarget.value })} /></Field></div>
          <div className="settings-row"><Field label="Name"><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></Field></div>
          <div className="settings-row"><Field label="Base URL"><Input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.currentTarget.value })} /></Field></div>
          <div className="settings-row"><Field label="Model IDs"><Textarea value={draft.modelIdsText} onChange={(event) => setDraft({ ...draft, modelIdsText: event.currentTarget.value })} /></Field></div>
          <div className="settings-row">
            <ApiKeyInput
              label="API Key"
              value={draft.apiKeyInput}
              onChange={(apiKeyInput) => setDraft({ ...draft, apiKeyInput })}
              resetKey={editingProviderId ?? 'new'}
            />
          </div>
          <Switch label="Enabled" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })} />
          {discovery.status !== 'idle' ? (
            <small className={discovery.status === 'error' ? 'settings-error' : ''}>
              {discovery.status === 'loading' ? 'Discovering models' : discovery.message}
            </small>
          ) : null}
          <Toolbar ariaLabel="LLM provider actions" className="settings-actions">
            {editingProviderId ? <Button type="button" onClick={() => setEditingProviderId(undefined)}>Cancel</Button> : null}
            <Button type="button" disabled={!draft.baseUrl.trim() || discovery.status === 'loading'} iconStart={<Search size={14} />} onClick={() => void discoverModels()}>
              Discover Models
            </Button>
            <Button type="submit" variant="primary" disabled={!draft.id.trim() || !draft.name.trim() || !draft.baseUrl.trim() || splitModelIds(draft.modelIdsText).length === 0} iconStart={<Save size={14} />}>
              {editingProviderId ? 'Save LLM Provider' : 'Add LLM Provider'}
            </Button>
          </Toolbar>
          </Card>
        </form>
        <div className="settings-grid">
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
  const models = state.imageModelSettings?.models ?? [];

  return (
    <section className="settings-section">
      <SettingsSectionHeader title="Image Models" />
      <div className="settings-grid">
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
  const models = state.videoModelSettings?.models ?? [];

  return (
    <section className="settings-section">
      <SettingsSectionHeader title="Video Models" />
      <div className="settings-grid">
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
    <header className="settings-section-header">
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
    <Card className="settings-model-card">
      <div className="settings-model-card-header">
        <div>
          <strong>{model.debruteModelId}</strong>
          {model.apiKeySet ? <StatusPill>key {model.apiKeyPreview}</StatusPill> : <StatusPill tone="neutral">no key</StatusPill>}
        </div>
        {model.apiKeySet ? (
          <Button type="button" variant="danger" onClick={() => void clearApiKey()}>
            Clear API key
          </Button>
        ) : null}
      </div>
      <div className="settings-model-card-fields">
        <div className="settings-row">
          <MediaApiKeyInput
            ariaLabel="API Key"
            value={draft.apiKeyInput}
            onChange={(apiKeyInput) => setDraft({ ...draft, apiKeyInput })}
            onBlur={() => void saveDraft(draft)}
            placeholder="API Key"
          />
        </div>
        <div className="settings-model-edit-grid">
          <div className="settings-row">
            <Field label="Base URL override">
            <Input
              aria-label="Base URL override"
              value={draft.baseUrlOverride}
              onChange={(event) => setDraft({ ...draft, baseUrlOverride: event.currentTarget.value })}
              onBlur={() => void saveDraft(draft)}
              placeholder={model.defaultBaseUrl}
            />
            </Field>
          </div>
          <div className="settings-row">
            <Field label="Request model ID override">
            <Input
              aria-label="Request model ID override"
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
        <small className="settings-error">{status.message}</small>
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
  return (
    <Card>
      <strong>{provider.name}</strong>
      <small>{provider.providerType} / {provider.baseUrl}</small>
      <div className="settings-pills">
        {!provider.enabled ? <StatusPill tone="neutral">disabled</StatusPill> : null}
        {provider.apiKeySet ? <StatusPill>key {provider.apiKeyPreview}</StatusPill> : <StatusPill tone="neutral">no key</StatusPill>}
        {provider.modelKeys.map((modelKey) => <StatusPill key={modelKey}>{modelKey}</StatusPill>)}
      </div>
      <Toolbar ariaLabel={`${provider.name} actions`} className="settings-actions">
        <Button type="button" onClick={onEdit}>Edit</Button>
        {provider.apiKeySet ? <Button type="button" variant="danger" onClick={onClearApiKey}>Clear API key</Button> : null}
        <Button type="button" variant="danger" iconStart={<Trash2 size={14} />} onClick={onDelete}>Delete</Button>
      </Toolbar>
    </Card>
  );
}

function MediaApiKeyInput({
  value,
  onChange,
  ariaLabel,
  onBlur,
  placeholder
}: Pick<ApiKeyInputProps, 'value' | 'onChange' | 'ariaLabel' | 'onBlur' | 'placeholder'>): React.ReactElement {
  return (
    <Input
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      spellCheck={false}
    />
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
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(false);
  }, [resetKey]);

  const visibilityLabel = visible ? 'Hide API key' : 'Show API key';
  const effectivePlaceholder = value ? undefined : placeholder;
  const input = (
    <span className="settings-key-input">
      <SecretInput
        className="settings-key-control"
        aria-label={ariaLabel}
        masked={!visible && Boolean(value)}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={onBlur}
        placeholder={effectivePlaceholder}
        spellCheck={false}
      />
      <IconButton
        className="settings-key-visibility"
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
