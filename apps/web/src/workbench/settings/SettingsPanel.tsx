import React, { useEffect, useState } from 'react';
import { Bot, Cpu, Image as ImageIcon, KeyRound, RefreshCw, Save, Search, Terminal, Trash2, Wrench } from 'lucide-react';
import type {
  CanvasSettingsView,
  ImageModelSettingRecord,
  LlmProviderSettingRecord,
  SaveLlmProviderSettingInput,
  VideoModelSettingRecord
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { getDebruteShellApi } from '../../api/shellApi';
import { DebruteCliSettingsPage } from './debrute-cli/DebruteCliSettingsPage';
import { IntegrationsSettingsPage } from './integrations/IntegrationsSettingsPage';

interface LlmProviderDraft {
  id: string;
  name: string;
  providerType: 'openai_compat' | 'anthropic';
  baseUrl: string;
  modelIdsText: string;
  enabled: boolean;
  apiKey: string;
}

interface ModelDraft {
  baseUrlOverride: string;
  requestModelIdOverride: string;
  apiKey: string;
}

type DiscoveryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; message: string }
  | { status: 'error'; message: string };

const SETTINGS_NAV_ITEMS = [
  { id: 'llm', label: 'LLM', description: 'Model routing and provider credentials', icon: Bot },
  { id: 'models', label: 'Models', description: 'Generation endpoints and API keys', icon: Cpu },
  { id: 'canvas', label: 'Canvas', description: 'Canvas rendering resources', icon: ImageIcon },
  { id: 'integrations', label: 'Integrations', description: 'Optional local capabilities', icon: Wrench },
  { id: 'debrute-cli', label: 'Debrute CLI', description: 'Command install and Skills sync', icon: Terminal }
] as const;

type SettingsPageId = typeof SETTINGS_NAV_ITEMS[number]['id'];

export function SettingsPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }): React.ReactElement {
  const [activePage, setActivePage] = useState<SettingsPageId>('models');
  return (
    <div className="settings-panel">
      <nav className="settings-directory" aria-label="Settings sections">
        {SETTINGS_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={activePage === item.id ? 'active' : ''}
              onClick={() => setActivePage(item.id)}
            >
              <span className="settings-nav-icon"><Icon size={15} /></span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="settings-page">
        {activePage === 'llm' ? (
          <LlmSettings state={state} actions={actions} />
        ) : activePage === 'models' ? (
          <>
            <ImageModelSettings state={state} actions={actions} />
            <VideoModelSettings state={state} actions={actions} />
          </>
        ) : activePage === 'canvas' ? (
          <CanvasSettingsPage settings={state.canvasSettings} onSave={actions.saveCanvasSettings} />
        ) : activePage === 'integrations' ? (
          <IntegrationsSettingsPage state={state} actions={actions} />
        ) : activePage === 'debrute-cli' ? (
          <DebruteCliSettingsPage shell={getDebruteShellApi()} />
        ) : null}
      </div>
    </div>
  );
}

export function CanvasSettingsPage({
  settings,
  onSave
}: {
  settings: CanvasSettingsView | undefined;
  onSave: (settings: CanvasSettingsView) => Promise<void>;
}): React.ReactElement {
  const [status, setStatus] = useState<DiscoveryState>({ status: 'idle' });
  const imagePreviewsEnabled = settings?.imagePreviewsEnabled ?? true;

  const save = async (next: CanvasSettingsView) => {
    setStatus({ status: 'loading' });
    try {
      await onSave(next);
      setStatus({ status: 'idle' });
    } catch (error) {
      setStatus({ status: 'error', message: errorMessage(error) });
    }
  };

  return (
    <section className="settings-section">
      <SettingsSectionHeader title="Canvas" eyebrow="Rendering" description="Canvas rendering resources." />
      <div className="settings-card">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={imagePreviewsEnabled}
            disabled={status.status === 'loading'}
            onChange={(event) => void save({ imagePreviewsEnabled: event.currentTarget.checked })}
          />
          Canvas image previews
        </label>
        {status.status === 'error' ? <small className="settings-error">{status.message}</small> : null}
      </div>
    </section>
  );
}

function LlmSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }): React.ReactElement {
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
    const input: SaveLlmProviderSettingInput = {
      id: draft.id.trim(),
      name: draft.name.trim(),
      providerType: draft.providerType,
      baseUrl: draft.baseUrl.trim(),
      enabled: draft.enabled,
      modelIds: splitModelIds(draft.modelIdsText),
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
    };
    await actions.saveLlmProviderSetting(input, editingProviderId);
    setEditingProviderId(undefined);
  };

  const discoverModels = async () => {
    setDiscovery({ status: 'loading' });
    try {
      const result = await actions.discoverLlmProviderModels({
        id: draft.id.trim(),
        providerType: draft.providerType,
        baseUrl: draft.baseUrl.trim(),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
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
      <SettingsSectionHeader title="LLM Providers" eyebrow="Runtime" description="Configure chat providers, discovery, and the default model route." />
      <div className="settings-card">
        <label>Default Model
          <select
            value={settings?.defaultModelKey ?? ''}
            onChange={(event) => void actions.setDefaultLlmModelKey(event.currentTarget.value || null)}
          >
            <option value="">None</option>
            {(settings?.availableModelKeys ?? []).map((modelKey: string) => (
              <option key={modelKey} value={modelKey}>{modelKey}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="settings-grid">
        <form className="settings-card" onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}>
          <strong>{editingProviderId ? 'Edit LLM Provider' : 'Add LLM Provider'}</strong>
          <div className="settings-row">
            <label>Provider Type
              <select value={draft.providerType} onChange={(event) => setDraft({ ...draft, providerType: event.currentTarget.value as LlmProviderDraft['providerType'] })}>
                <option value="openai_compat">OpenAI Compatible</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
          </div>
          <div className="settings-row"><label>ID<input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.currentTarget.value })} /></label></div>
          <div className="settings-row"><label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></label></div>
          <div className="settings-row"><label>Base URL<input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.currentTarget.value })} /></label></div>
          <div className="settings-row"><label>Model IDs<textarea value={draft.modelIdsText} onChange={(event) => setDraft({ ...draft, modelIdsText: event.currentTarget.value })} /></label></div>
          <div className="settings-row"><label><span><KeyRound size={13} />API Key</span><input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.currentTarget.value })} placeholder={editingProviderId ? 'Leave blank to keep existing key' : ''} /></label></div>
          <label className="settings-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })} />Enabled</label>
          {discovery.status !== 'idle' ? (
            <small className={discovery.status === 'error' ? 'settings-error' : ''}>
              {discovery.status === 'loading' ? 'Discovering models' : discovery.message}
            </small>
          ) : null}
          <div className="settings-actions">
            {editingProviderId ? <button type="button" onClick={() => setEditingProviderId(undefined)}>Cancel</button> : null}
            <button type="button" disabled={!draft.baseUrl.trim() || discovery.status === 'loading'} onClick={() => void discoverModels()}>
              <Search size={14} />
              Discover Models
            </button>
            <button type="submit" disabled={!draft.id.trim() || !draft.name.trim() || !draft.baseUrl.trim() || splitModelIds(draft.modelIdsText).length === 0}>
              <Save size={14} />
              {editingProviderId ? 'Save LLM Provider' : 'Add LLM Provider'}
            </button>
          </div>
        </form>
        <div className="settings-grid">
          {(settings?.providers ?? []).map((provider) => (
            <LlmProviderCard
              key={provider.id}
              provider={provider}
              onEdit={() => setEditingProviderId(provider.id)}
              onDelete={() => void actions.deleteLlmProviderSetting(provider.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ImageModelSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }): React.ReactElement {
  const models = state.imageModelSettings?.models ?? [];

  return (
    <section className="settings-section">
      <SettingsSectionHeader title="Image Models" eyebrow="Generation" description="Manage image generation model endpoints and credentials." />
      <div className="settings-grid">
        {models.map((model) => (
          <MediaModelCard
            key={model.debruteModelId}
            model={model}
            onSave={(draft) => actions.saveImageModelSetting(model.debruteModelId, modelDraftToSaveInput(draft))}
          />
        ))}
      </div>
    </section>
  );
}

function VideoModelSettings({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }): React.ReactElement {
  const models = state.videoModelSettings?.models ?? [];

  return (
    <section className="settings-section">
      <SettingsSectionHeader title="Video Models" eyebrow="Generation" description="Manage video generation model endpoints and credentials." />
      <div className="settings-grid">
        {models.map((model) => (
          <MediaModelCard
            key={model.debruteModelId}
            model={model}
            onSave={(draft) => actions.saveVideoModelSetting(model.debruteModelId, modelDraftToSaveInput(draft))}
          />
        ))}
      </div>
    </section>
  );
}

function SettingsSectionHeader({
  title,
  eyebrow,
  description
}: {
  title: string;
  eyebrow: string;
  description: string;
}): React.ReactElement {
  return (
    <header className="settings-section-header">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

function MediaModelCard({
  model,
  onSave
}: {
  model: ImageModelSettingRecord | VideoModelSettingRecord;
  onSave: (draft: ModelDraft) => Promise<void>;
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
      await onSave(nextDraft);
    } catch (error) {
      setStatus({ status: 'error', message: errorMessage(error) });
    }
  };

  return (
    <article className="settings-card settings-model-card">
      <div className="settings-model-card-header">
        <div>
          <strong>{model.debruteModelId}</strong>
          <small>{model.apiKeySet ? 'configured' : 'no key'}</small>
        </div>
      </div>
      <div className="settings-model-card-fields">
        <div className="settings-row settings-key-input">
          <KeyRound size={13} aria-hidden="true" />
          <input
            aria-label="API Key"
            type="password"
            value={draft.apiKey}
            onChange={(event) => setDraft({ ...draft, apiKey: event.currentTarget.value })}
            onBlur={() => void saveDraft(draft)}
            placeholder={model.apiKeySet ? 'Leave blank to keep existing key' : 'API Key'}
          />
        </div>
        <div className="settings-model-edit-grid">
          <div className="settings-row">
            <input
              aria-label="Base URL override"
              value={draft.baseUrlOverride}
              onChange={(event) => setDraft({ ...draft, baseUrlOverride: event.currentTarget.value })}
              onBlur={() => void saveDraft(draft)}
              placeholder={model.defaultBaseUrl}
            />
          </div>
          <div className="settings-row">
            <input
              aria-label="Request model ID override"
              value={draft.requestModelIdOverride}
              onChange={(event) => setDraft({ ...draft, requestModelIdOverride: event.currentTarget.value })}
              onBlur={() => void saveDraft(draft)}
              placeholder={model.defaultRequestModelId}
            />
          </div>
        </div>
      </div>
      {status.status === 'error' ? (
        <small className="settings-error">{status.message}</small>
      ) : null}
    </article>
  );
}

function LlmProviderCard({
  provider,
  onEdit,
  onDelete
}: {
  provider: LlmProviderSettingRecord;
  onEdit: () => void;
  onDelete: () => void;
}): React.ReactElement {
  return (
    <article className="settings-card">
      <strong>{provider.name}</strong>
      <small>{provider.providerType} / {provider.baseUrl}</small>
      <div className="settings-pills">
        <span>{provider.enabled ? 'enabled' : 'disabled'}</span>
        <span>{provider.apiKeySet ? 'key set' : 'no key'}</span>
      </div>
      <div className="settings-pills">
        {provider.modelKeys.map((modelKey) => <span key={modelKey}>{modelKey}</span>)}
      </div>
      <div className="settings-actions">
        <button type="button" onClick={onEdit}>Edit</button>
        <button type="button" onClick={onDelete}><Trash2 size={14} />Delete</button>
      </div>
    </article>
  );
}

function modelToDraft(model: ImageModelSettingRecord | VideoModelSettingRecord): ModelDraft {
  return {
    baseUrlOverride: model.baseUrlOverride ?? '',
    requestModelIdOverride: model.requestModelIdOverride ?? '',
    apiKey: ''
  };
}

function modelDraftToSaveInput(draft: ModelDraft) {
  return {
    baseUrlOverride: draft.baseUrlOverride.trim() || null,
    requestModelIdOverride: draft.requestModelIdOverride.trim() || null,
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
  };
}

function modelDraftMatchesPersisted(draft: ModelDraft, model: ImageModelSettingRecord | VideoModelSettingRecord): boolean {
  return draft.baseUrlOverride.trim() === (model.baseUrlOverride ?? '')
    && draft.requestModelIdOverride.trim() === (model.requestModelIdOverride ?? '')
    && draft.apiKey.trim() === '';
}

function createEmptyLlmProviderDraft(): LlmProviderDraft {
  return {
    id: '',
    name: '',
    providerType: 'openai_compat',
    baseUrl: '',
    modelIdsText: '',
    enabled: true,
    apiKey: ''
  };
}

function llmProviderToDraft(provider: LlmProviderSettingRecord): LlmProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    providerType: provider.providerType,
    baseUrl: provider.baseUrl,
    modelIdsText: provider.modelIds.join('\n'),
    enabled: provider.enabled,
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
