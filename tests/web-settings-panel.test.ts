import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  LlmSettings,
  SettingsPanel
} from '../apps/web/src/workbench/settings/SettingsPanel';
import {
  DebruteCliSettingsPage,
  debruteCliSkillsStatusFromActionResult,
  debruteCliStatusFromActionResult
} from '../apps/web/src/workbench/settings/debrute-cli/DebruteCliSettingsPage';
import type { DebruteCliStatus } from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../apps/web/src/types';

const joinText = (...parts: string[]) => parts.join('');

describe('web Settings pages', () => {
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
            apiKey: 'sk-image-ui'
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
    expect(html).not.toContain(joinText('Model routing', ' and provider credentials'));
    expect(html).not.toContain(joinText('Generation endpoints', ' and API keys'));
    expect(html).not.toContain(joinText('Optional local', ' capabilities'));
    expect(html).not.toContain(joinText('Command install', ' and Skills sync'));
    expect(html).toContain('LLM');
    expect(html).toContain('Models');
    expect(html).not.toContain('<strong>Canvas</strong>');
    expect(html).not.toContain('Canvas rendering resources');
    expect(html).toContain('Integrations');
    expect(html).toContain('Debrute CLI');
    expect(html).not.toContain('Updates');
    expect(html).toContain('Image Models');
    expect(html).not.toContain(joinText('Manage image generation model', ' endpoints and credentials.'));
    expect(html).not.toContain(joinText('Manage video generation model', ' endpoints and credentials.'));
    expect(html).toContain('placeholder="https://api.openai.com/v1"');
    expect(html).toContain('placeholder="gpt-image-2"');
    expect(html).toContain('aria-label="Base URL override"');
    expect(html).toContain('aria-label="Request model ID override"');
    expect(html).toContain('aria-label="API Key"');
    expect(html).toContain('value="sk-image-ui"');
    expect(html).not.toContain('Leave blank to keep existing key');
    expect(html).not.toContain('configured');
    expect(html).toContain('no key');
    expect(html).toContain('db-card');
    expect(html).toContain('db-field');
    expect(html).toContain('db-input');
    expect(html).toContain('db-status-pill');
  });

  it('renders visibility controls for every API key input', () => {
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
          apiKey: 'sk-llm-ui'
        }],
        availableModelKeys: ['openai:gpt-4.1'],
        defaultModelKey: null
      },
      imageModelSettings: {
        models: [{
          debruteModelId: 'gpt-image-2',
          summary: 'Image generation',
          defaultBaseUrl: 'https://api.openai.com/v1',
          defaultRequestModelId: 'gpt-image-2',
          baseUrlOverride: null,
          requestModelIdOverride: null,
          apiKeySet: true,
          apiKey: 'sk-image-ui'
        }]
      },
      videoModelSettings: {
        models: [{
          debruteModelId: 'sora-2',
          summary: 'Video generation',
          defaultBaseUrl: 'https://api.openai.com/v1',
          defaultRequestModelId: 'sora-2',
          baseUrlOverride: null,
          requestModelIdOverride: null,
          apiKeySet: true,
          apiKey: 'sk-video-ui'
        }]
      }
    } as unknown as WorkbenchState;
    const actions = {} as unknown as WorkbenchActions;

    const modelHtml = renderToStaticMarkup(React.createElement(SettingsPanel, { state, actions }));
    const llmHtml = renderToStaticMarkup(React.createElement(LlmSettings, { state, actions }));
    const html = `${modelHtml}${llmHtml}`;

    expect(html).not.toContain('type="password"');
    expect(html.match(/db-input--secret/g)).toHaveLength(2);
    expect(html.match(/aria-label="Show API key"/g)).toHaveLength(3);
    expect(html).toContain('value="sk-image-ui"');
    expect(html).toContain('value="sk-video-ui"');
    expect(html).toContain('settings-key-input');
    expect(html).toContain('settings-key-control');
    expect(html).toContain('settings-key-visibility');
    expect(html).not.toContain('Leave blank to keep existing key');
    expect(html).not.toContain('aria-label="Hide API key"');
  });

  it('does not render Canvas settings or image preview controls', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPanel, {
      state: {
        llmSettings: { providers: [], availableModelKeys: [], defaultModelKey: null },
        imageModelSettings: { models: [] },
        videoModelSettings: { models: [] },
        integrationsSettings: undefined
      } as unknown as WorkbenchState,
      actions: {} as unknown as WorkbenchActions
    }));

    expect(html).not.toContain('Canvas image previews');
    expect(html).not.toContain('Canvas rendering resources');
    expect(html).not.toContain('<strong>Canvas</strong>');
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
