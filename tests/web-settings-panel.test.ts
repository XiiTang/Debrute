import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CanvasSettingsPage, SettingsPanel } from '../apps/web/src/workbench/settings/SettingsPanel';
import {
  AxisCliSettingsPage,
  axisCliSkillsStatusFromActionResult,
  axisCliStatusFromActionResult
} from '../apps/web/src/workbench/settings/axis-cli/AxisCliSettingsPage';
import type { AxisCliStatus } from '@axis/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../apps/web/src/types';

describe('web Settings pages', () => {
  it('uses a directory layout with Axis CLI settings', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPanel, {
      state: {
        llmSettings: { providers: [], availableModelKeys: [], defaultModelKey: null },
        imageModelSettings: {
          models: [{
            axisModelId: 'gpt-image-2',
            summary: 'Image generation',
            defaultBaseUrl: 'https://api.openai.com/v1',
            defaultRequestModelId: 'gpt-image-2',
            baseUrlOverride: null,
            requestModelIdOverride: null,
            apiKeySet: true
          }, {
            axisModelId: 'missing-image',
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
    expect(html).toContain('Axis CLI');
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

  it('renders browser-only manual Axis CLI instructions when Desktop shell is unavailable', () => {
    const html = renderToStaticMarkup(React.createElement(AxisCliSettingsPage, {
      shell: undefined
    }));

    expect(html).toContain('Axis CLI');
    expect(html).toContain('Manual install');
    expect(html).toContain('https://github.com/XiiTang/AXIS/releases');
    expect(html).toContain('axis_SHA256SUMS');
    expect(html).toContain('README');
    expect(html).toContain('axis skills sync');
    expect(html).not.toContain('Install Axis CLI</button>');
  });

  it('renders one-click Axis CLI actions from Desktop shell status', () => {
    const html = renderToStaticMarkup(React.createElement(AxisCliSettingsPage, {
      initialStatus: {
        kind: 'update_available',
        desktopVersion: '0.2.0',
        cliVersion: '0.1.0',
        managedPath: '/Users/me/.axis/bin/axis',
        skills: { kind: 'partially_removed', skippedDeletedSkills: ['axis-example'] }
      },
      shell: {
        chooseProjectRoot: async () => undefined,
        getAxisCliStatus: async () => ({ kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' }),
        installAxisCli: async () => ({ ok: true, status: { kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' } }),
        updateAxisCli: async () => ({ ok: true, status: { kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' } }),
        syncAxisCliSkills: async () => ({ ok: true, status: { kind: 'in_sync', axisVersion: '0.2.0' } }),
        restoreAxisCliSkills: async () => ({ ok: true, status: { kind: 'in_sync', axisVersion: '0.2.0' } }),
        repairAxisCliPath: async () => ({ ok: true, status: { kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' } }),
        getAxisCliManualInstallCommand: async () => ({ platform: 'macos', command: 'curl ...' })
      }
    }));

    expect(html).toContain('Update Axis CLI');
    expect(html).toContain('Copy Manual Install Command');
    expect(html).toContain('Restore All Axis Skills');
    expect(html).toContain('axis-example');
  });

  it('uses failed one-click action status instead of hiding it behind a refresh', () => {
    const failedStatus: AxisCliStatus = {
      kind: 'error',
      desktopVersion: '0.2.0',
      code: 'axis_cli_install_failed',
      message: 'Checksum mismatch for axis-cli-0.2.0-macos-arm64.tar.gz.',
      manualCommand: 'curl ...'
    };

    expect(axisCliStatusFromActionResult({ ok: false, status: failedStatus })).toEqual(failedStatus);
    expect(axisCliStatusFromActionResult({ ok: true, status: { kind: 'in_sync', axisVersion: '0.2.0' } })).toBeUndefined();
    expect(axisCliSkillsStatusFromActionResult({
      ok: false,
      status: { kind: 'error', code: 'skills_sync_failed', message: 'Axis Skills sync failed.' }
    })).toEqual({ kind: 'error', code: 'skills_sync_failed', message: 'Axis Skills sync failed.' });
    expect(axisCliSkillsStatusFromActionResult({ ok: true, status: { kind: 'not_checked' } })).toBeUndefined();
  });

  it('renders Axis CLI Skills status details and errors', () => {
    const html = renderToStaticMarkup(React.createElement(AxisCliSettingsPage, {
      initialStatus: {
        kind: 'installed',
        desktopVersion: '0.2.0',
        cliVersion: '0.2.0',
        managedPath: '/Users/me/.axis/bin/axis',
        resolvedPath: '/Users/me/.axis/bin/axis',
        onPath: true,
        skills: { kind: 'error', code: 'skills_sync_failed', message: 'Axis Skills sync failed.' }
      },
      shell: {
        chooseProjectRoot: async () => undefined,
        getAxisCliStatus: async () => ({ kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' })
      }
    }));

    expect(html).toContain('Error skills_sync_failed');
    expect(html).toContain('Axis Skills sync failed.');
  });

});
