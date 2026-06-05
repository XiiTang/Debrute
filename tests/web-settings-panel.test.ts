import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CanvasSettingsPage, SettingsPanel } from '../apps/web/src/workbench/settings/SettingsPanel';
import {
  DebruteCliSettingsPage,
  debruteCliSkillsStatusFromActionResult,
  debruteCliStatusFromActionResult
} from '../apps/web/src/workbench/settings/debrute-cli/DebruteCliSettingsPage';
import type { DebruteCliStatus } from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../apps/web/src/types';

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
            apiKeySet: true
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
        videoModelSettings: { models: [] },
        canvasSettings: { imagePreviewsEnabled: true }
      } as unknown as WorkbenchState,
      actions: {} as unknown as WorkbenchActions
    }));

    expect(html).toContain('settings-directory');
    expect(html).toContain('settings-nav-icon');
    expect(html).toContain('Model routing and provider credentials');
    expect(html).toContain('Generation endpoints and API keys');
    expect(html).toContain('LLM');
    expect(html).toContain('Models');
    expect(html).toContain('Canvas');
    expect(html).toContain('Canvas rendering resources');
    expect(html).toContain('Integrations');
    expect(html).toContain('Optional local capabilities');
    expect(html).toContain('Debrute CLI');
    expect(html).toContain('Command install and Skills sync');
    expect(html).not.toContain('Updates');
    expect(html).toContain('Image Models');
    expect(html).toContain('placeholder="https://api.openai.com/v1"');
    expect(html).toContain('placeholder="gpt-image-2"');
    expect(html).toContain('aria-label="Base URL override"');
    expect(html).toContain('aria-label="Request model ID override"');
    expect(html).toContain('aria-label="API Key"');
    expect(html).toContain('Leave blank to keep existing key');
    expect(html).toContain('configured');
    expect(html).toContain('no key');
  });

  it('renders the Canvas image previews toggle', () => {
    const html = renderToStaticMarkup(React.createElement(CanvasSettingsPage, {
      settings: { imagePreviewsEnabled: false },
      onSave: async () => undefined
    }));

    expect(html).toContain('Canvas image previews');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
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
