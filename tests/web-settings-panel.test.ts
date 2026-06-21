import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ImageModelSettings,
  LlmSettings,
  SettingsPanel,
  llmProviderDraftToClearApiKeyInput,
  llmProviderDraftToSaveInput,
  modelDraftToClearApiKeyInput,
  modelDraftToSaveInput
} from '../apps/web/src/workbench/settings/SettingsPanel';
import {
  DebruteCliSettingsPage,
  debruteCliSkillsStatusFromActionResult,
  debruteCliStatusFromActionResult
} from '../apps/web/src/workbench/settings/debrute-cli/DebruteCliSettingsPage';
import { GeneralSettingsPage } from '../apps/web/src/workbench/settings/general/GeneralSettingsPage';
import type {
  DebruteCliStatus,
  DesktopAppUpdateState
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../apps/web/src/types';

describe('web Settings pages', () => {
  it('uses General as the first and default settings page', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPanel, {
      state: {
        llmSettings: { providers: [], availableModelKeys: [], defaultModelKey: null },
        imageModelSettings: { models: [] },
        videoModelSettings: { models: [] }
      } as unknown as WorkbenchState,
      actions: {} as unknown as WorkbenchActions
    }));

    expect(html.match(/class="db-nav-row(?: db-nav-row--active)?"/g)).toHaveLength(6);
    expect(html.indexOf('General')).toBeLessThan(html.indexOf('LLM'));
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Application');
    expect(html).toContain('Updates');
    expect(html.indexOf('Updates')).toBeGreaterThan(html.indexOf('Application'));
  });

  it('uses a directory layout with Debrute CLI settings', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPanel, {
      state: {
        llmSettings: { providers: [], availableModelKeys: [], defaultModelKey: null },
        imageModelSettings: {
          models: [{
            debruteModelId: 'gpt-image-2',
            summary: 'Image generation',
            defaultBaseUrl: 'https://api.openai.com/v1',
            defaultRequestModelId: 'gpt-image-2',
            baseUrlOverride: null,
            requestModelIdOverride: null,
            apiKeySet: true,
            apiKeyPreview: 'sk****************************ui'
          }, {
            debruteModelId: 'missing-image',
            summary: 'Missing configuration',
            defaultBaseUrl: 'https://api.openai.com/v1',
            defaultRequestModelId: 'missing-image',
            baseUrlOverride: null,
            requestModelIdOverride: null,
            apiKeySet: false
          }]
        },
        videoModelSettings: { models: [] }
      } as unknown as WorkbenchState,
      actions: {} as unknown as WorkbenchActions
    }));

    expect(html).toContain('settings-directory');
    expect(html).toContain('db-nav-row');
    expect(html).toContain('db-nav-row__icon');
    expect(html).toContain('aria-label="Settings sections"');
    expect(html.match(/class="db-nav-row(?: db-nav-row--active)?"/g)).toHaveLength(6);
    expect(html).toContain('General');
    expect(html).toContain('LLM');
    expect(html).toContain('Models');
    expect(html).toContain('Integrations');
    expect(html).toContain('Adobe Bridge');
    expect(html).toContain('Debrute CLI');
    expect(html).toContain('Application');
    expect(html).toContain('<header class="settings-section-header"><h2>General</h2></header>');
    expect(html).not.toContain('Base URL override');
    expect(html).not.toContain('aria-label="Base URL override"');
    expect(html).toContain('db-card');
    expect(html).toContain('db-status-pill');
  });

  it('renders disabled browser update state with a stable check action', () => {
    const state: DesktopAppUpdateState = { type: 'disabled', currentVersion: '0.2.0', reason: 'browser' };
    const html = renderToStaticMarkup(React.createElement(GeneralSettingsPage, {
      shell: undefined,
      initialUpdateState: state
    }));

    expect(html).toContain('General');
    expect(html).toContain('Updates');
    expect(html).toContain('Current version');
    expect(html).toContain('0.2.0');
    expect(html).toContain('Updates are unavailable in browser mode.');
    expect(html).toContain('Check for Updates');
    expect(html).toContain('disabled=""');
  });

  it('renders automatic update states and actions', () => {
    const states: DesktopAppUpdateState[] = [
      { type: 'idle', currentVersion: '0.2.0', platform: 'darwin' },
      { type: 'checking', currentVersion: '0.2.0', platform: 'darwin', explicit: true },
      { type: 'available', currentVersion: '0.2.0', platform: 'darwin', updateVersion: '0.3.0', installMode: 'automatic' },
      { type: 'downloading', currentVersion: '0.2.0', platform: 'darwin', updateVersion: '0.3.0', percent: 55 },
      { type: 'downloaded', currentVersion: '0.2.0', platform: 'darwin', updateVersion: '0.3.0' },
      {
        type: 'error',
        currentVersion: '0.2.0',
        platform: 'darwin',
        operation: 'download',
        message: 'network failed',
        retryable: true,
        updateVersion: '0.3.0',
        installMode: 'automatic'
      }
    ];
    const html = states.map((state) => renderToStaticMarkup(React.createElement(GeneralSettingsPage, {
      shell: {
        chooseProjectRoot: async () => undefined,
        getAppUpdateState: async () => state,
        checkForAppUpdate: async () => state,
        downloadAppUpdate: async () => state,
        installAppUpdate: async () => state
      },
      initialUpdateState: state
    }))).join('\n');

    expect(html).toContain('Check for Updates');
    expect(html).toContain('Checking for updates');
    expect(html).toContain('Download Update');
    expect(html).toContain('55%');
    expect(html).toContain('Install and Restart');
    expect(html).toContain('network failed');
    expect(html).not.toContain('unknown');
  });

  it('renders Linux manual download update action', () => {
    const state: DesktopAppUpdateState = {
      type: 'available',
      currentVersion: '0.2.0',
      platform: 'linux',
      updateVersion: '0.3.0',
      releaseUrl: 'https://github.com/XiiTang/Debrute/releases/tag/v0.3.0',
      installMode: 'manual-download'
    };
    const html = renderToStaticMarkup(React.createElement(GeneralSettingsPage, {
      shell: {
        chooseProjectRoot: async () => undefined,
        getAppUpdateState: async () => state,
        openAppUpdateDownloadPage: async () => ({ ok: true })
      },
      initialUpdateState: state
    }));

    expect(html).toContain('Update available');
    expect(html).toContain('0.3.0');
    expect(html).toContain('Open GitHub Releases');
    expect(html).not.toContain('Install and Restart');
  });

  it('renders configured key previews without raw API keys', () => {
    const state = {
      llmSettings: {
        providers: [{
          id: 'openai',
          name: 'OpenAI',
          providerType: 'openai_compat',
          baseUrl: 'https://api.openai.com/v1',
          modelIds: ['gpt-4.1'],
          modelKeys: ['openai:gpt-4.1'],
          enabled: true,
          apiKeySet: true,
          apiKeyPreview: 'sk****************************ui'
        }],
        availableModelKeys: ['openai:gpt-4.1'],
        defaultModelKey: null
      },
      imageModelSettings: { models: [] },
      videoModelSettings: { models: [] }
    } as unknown as WorkbenchState;
    const actions = {} as unknown as WorkbenchActions;

    const html = renderToStaticMarkup(React.createElement(LlmSettings, { state, actions }));

    expect(html).toContain('sk****************************ui');
    expect(html).toContain('Clear API key');
    expect(html).not.toContain('sk-llm-ui');
    expect(html).not.toContain('value="sk');
    expect(html).not.toContain('type="password"');
    expect(html.match(/aria-label="Show API key"/g)).toHaveLength(1);
    expect(html).toContain('settings-key-input');
    expect(html).toContain('settings-key-control');
    expect(html).toContain('settings-key-visibility');
    expect(html).not.toContain('aria-label="Hide API key"');
  });

  it('renders media model URL overrides and plain API key inputs', () => {
    const state = {
      llmSettings: { providers: [], availableModelKeys: [], defaultModelKey: null },
      imageModelSettings: {
        models: [{
          debruteModelId: 'gpt-image-2',
          summary: 'Image generation',
          supportsEditing: true,
          supportsTextRendering: true,
          defaultBaseUrl: 'https://api.openai.com/v1',
          defaultRequestModelId: 'gpt-image-2',
          baseUrlOverride: 'https://images.example.test/v1',
          requestModelIdOverride: null,
          apiKeySet: true,
          apiKeyPreview: 'sk****************************ui'
        }]
      },
      videoModelSettings: { models: [] }
    } as unknown as WorkbenchState;

    const html = renderToStaticMarkup(React.createElement(ImageModelSettings, {
      state,
      actions: {} as unknown as WorkbenchActions
    }));

    expect(html).toContain('Base URL override');
    expect(html).toContain('aria-label="Base URL override"');
    expect(html).toContain('value="https://images.example.test/v1"');
    expect(html).toContain('placeholder="https://api.openai.com/v1"');
    expect(html).toContain('sk****************************ui');
    expect(html).toContain('Clear API key');
    expect(html).toContain('aria-label="API Key"');
    expect(html).not.toContain('settings-key-visibility');
    expect(html).not.toContain('aria-label="Show API key"');
    expect(html).not.toContain('db-input--secret');
    expect(html).not.toContain('value="sk');
  });

  it('omits API keys from ordinary settings saves when the key input is empty', () => {
    expect(llmProviderDraftToSaveInput({
      id: 'openai',
      name: 'OpenAI',
      providerType: 'openai_compat',
      baseUrl: 'https://api.openai.com/v1',
      modelIdsText: 'gpt-4.1',
      enabled: true,
      apiKeyInput: ''
    })).toEqual({
      id: 'openai',
      name: 'OpenAI',
      providerType: 'openai_compat',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      modelIds: ['gpt-4.1']
    });

    expect(modelDraftToSaveInput({
      baseUrlOverride: '',
      requestModelIdOverride: '',
      apiKeyInput: ''
    })).toEqual({
      baseUrlOverride: null,
      requestModelIdOverride: null
    });
  });

  it('sends empty API keys only through explicit clear actions', () => {
    expect(llmProviderDraftToClearApiKeyInput({
      id: 'openai',
      name: 'OpenAI',
      providerType: 'openai_compat',
      baseUrl: 'https://api.openai.com/v1',
      modelIdsText: 'gpt-4.1',
      enabled: true,
      apiKeyInput: ''
    })).toEqual({
      id: 'openai',
      name: 'OpenAI',
      providerType: 'openai_compat',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      modelIds: ['gpt-4.1'],
      apiKey: ''
    });

    expect(modelDraftToClearApiKeyInput({
      baseUrlOverride: '',
      requestModelIdOverride: '',
      apiKeyInput: ''
    })).toEqual({
      baseUrlOverride: null,
      requestModelIdOverride: null,
      apiKey: ''
    });
  });

  it('renders browser-only manual Debrute CLI instructions when Desktop shell is unavailable', () => {
    const html = renderToStaticMarkup(React.createElement(DebruteCliSettingsPage, {
      shell: undefined
    }));

    expect(html).toContain('Debrute CLI');
    expect(html).toContain('Manual install');
    expect(html).toContain('https://github.com/XiiTang/Debrute/releases');
    expect(html).toContain('debrute_SHA256SUMS');
    expect(html).toContain('README');
    expect(html).toContain('debrute skills sync');
    expect(html).not.toContain('Install Debrute CLI</button>');
  });

  it('renders one-click Debrute CLI actions from Desktop shell status', () => {
    const html = renderToStaticMarkup(React.createElement(DebruteCliSettingsPage, {
      initialStatus: {
        kind: 'update_available',
        desktopVersion: '0.2.0',
        cliVersion: '0.1.0',
        managedPath: '/Users/me/.debrute/bin/debrute',
        skills: { kind: 'partially_removed', skippedDeletedSkills: ['debrute-example'] }
      },
      shell: {
        chooseProjectRoot: async () => undefined,
        getDebruteCliStatus: async () => ({ kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' }),
        installDebruteCli: async () => ({ ok: true, status: { kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' } }),
        updateDebruteCli: async () => ({ ok: true, status: { kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' } }),
        syncDebruteCliSkills: async () => ({ ok: true, status: { kind: 'in_sync', debruteVersion: '0.2.0' } }),
        restoreDebruteCliSkills: async () => ({ ok: true, status: { kind: 'in_sync', debruteVersion: '0.2.0' } }),
        repairDebruteCliPath: async () => ({ ok: true, status: { kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' } }),
        getDebruteCliManualInstallCommand: async () => ({ platform: 'macos', command: 'curl ...' })
      }
    }));

    expect(html).toContain('Update Debrute CLI');
    expect(html).toContain('Copy Manual Install Command');
    expect(html).toContain('Restore All Debrute Skills');
    expect(html).toContain('debrute-example');
  });

  it('uses failed one-click action status instead of hiding it behind a refresh', () => {
    const failedStatus: DebruteCliStatus = {
      kind: 'error',
      desktopVersion: '0.2.0',
      code: 'debrute_cli_install_failed',
      message: 'Checksum mismatch for debrute-cli-0.2.0-macos-arm64.tar.gz.',
      manualCommand: 'curl ...'
    };

    expect(debruteCliStatusFromActionResult({ ok: false, status: failedStatus })).toEqual(failedStatus);
    expect(debruteCliStatusFromActionResult({ ok: true, status: { kind: 'in_sync', debruteVersion: '0.2.0' } })).toBeUndefined();
    expect(debruteCliSkillsStatusFromActionResult({
      ok: false,
      status: { kind: 'error', code: 'skills_sync_failed', message: 'Debrute Skills sync failed.' }
    })).toEqual({ kind: 'error', code: 'skills_sync_failed', message: 'Debrute Skills sync failed.' });
    expect(debruteCliSkillsStatusFromActionResult({ ok: true, status: { kind: 'not_checked' } })).toBeUndefined();
  });

  it('renders Debrute CLI Skills status details and errors', () => {
    const html = renderToStaticMarkup(React.createElement(DebruteCliSettingsPage, {
      initialStatus: {
        kind: 'installed',
        desktopVersion: '0.2.0',
        cliVersion: '0.2.0',
        managedPath: '/Users/me/.debrute/bin/debrute',
        resolvedPath: '/Users/me/.debrute/bin/debrute',
        onPath: true,
        skills: { kind: 'error', code: 'skills_sync_failed', message: 'Debrute Skills sync failed.' }
      },
      shell: {
        chooseProjectRoot: async () => undefined,
        getDebruteCliStatus: async () => ({ kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' })
      }
    }));

    expect(html).toContain('Error skills_sync_failed');
    expect(html).toContain('Debrute Skills sync failed.');
  });

});
