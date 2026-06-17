import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsPanel } from '../apps/web/src/workbench/settings/SettingsPanel';
import { IntegrationsSettingsPage } from '../apps/web/src/workbench/settings/integrations/IntegrationsSettingsPage';
import type { WorkbenchActions, WorkbenchState } from '../apps/web/src/types';

describe('web Integrations settings page', () => {
  it('adds Integrations to the Settings directory', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPanel, {
      state: createState(),
      actions: createActions()
    }));

    expect(html).toContain('Integrations');
    expect(html).toContain('db-nav-row');
    expect(html).toContain('db-nav-row__icon');
  });

  it('renders ready, missing, failed, and Python CLI integration states', () => {
    const html = renderToStaticMarkup(React.createElement(IntegrationsSettingsPage, {
      state: createState(),
      actions: createActions()
    }));

    expect(html).toContain('<h2>Integrations</h2>');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Integration actions"');
    expect(html).toContain('Homebrew, uv');
    expect(html).toContain('<span>FFmpeg</span>');
    expect(html).toContain('7.1.1');
    expect(html).toContain('brew upgrade --formula ffmpeg');
    expect(html).toContain('brew uninstall --formula ffmpeg');
    expect(html).toContain('<span>ImageMagick</span>');
    expect(html).toContain('Not found');
    expect(html).toContain('brew install --formula imagemagick');
    expect(html).toContain('MediaInfo');
    expect(html).toContain('Integration operations require a ready detected integration.');
    expect(html).toContain('<span>Remove AI Watermarks</span>');
    expect(html).toContain('0.5.4');
    expect(html).toContain('uv tool upgrade remove-ai-watermarks');
    expect(html).toContain('<span>FFmpeg</span>');
    expect(html).toContain('class="db-status-pill db-status-pill--success">Ready</span>');
  });

  it('renders missing binaries as neutral rows with blank version cells', () => {
    const html = renderToStaticMarkup(React.createElement(IntegrationsSettingsPage, {
      state: createState({
        integrationsSettings: {
          backends: [{ kind: 'system-package-manager', backend: 'brew', available: true }],
          integrations: [{
            integrationId: 'imagemagick',
            displayName: 'ImageMagick',
            description: 'Image conversion toolkit.',
            category: 'media',
            status: 'not_found',
            summary: 'magick is missing.',
            binaries: [{
              binaryId: 'magick',
              displayName: 'magick',
              status: 'not_found'
            }]
          }]
        }
      }),
      actions: createActions()
    }));

    expect(html).toContain('<span>ImageMagick</span>');
    expect(html).toContain('Not found');
    expect(html).toContain('class="db-status-pill db-status-pill--neutral">Not found</span>');
    expect(html).toContain('<small></small>');
  });

  it('renders query failure diagnostics without top-level operation diagnostics', () => {
    const state = createState();
    const ffmpeg = state.integrationsSettings!.integrations[0]!;
    ffmpeg.operationStatus = {
      backendKind: 'system-package-manager',
      backend: 'brew',
      packageName: 'ffmpeg',
      uninstallCommandPreview: 'brew uninstall --formula ffmpeg',
      queryDiagnostic: {
        commandPreview: 'brew outdated --json=v2 --formula ffmpeg',
        exitCode: 1,
        errorKind: 'nonzero_exit',
        stderrTail: 'brew exploded'
      }
    };
    const html = renderToStaticMarkup(React.createElement(IntegrationsSettingsPage, {
      state,
      actions: createActions()
    }));

    expect(html).toContain('Unable to check updates.');
    expect(html).toContain('nonzero_exit');
    expect(html).toContain('brew exploded');
  });
});

function createState(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    snapshot: undefined,
    explorerSelection: { selectedPaths: [], focusedPath: null, anchorPath: null },
    llmSettings: { providers: [], availableModelKeys: [], defaultModelKey: null },
    imageModelSettings: { models: [] },
    videoModelSettings: { models: [] },
    integrationsSettings: {
      backends: [
        { kind: 'system-package-manager', backend: 'brew', available: true },
        { kind: 'python-cli-installer', backend: 'uv', available: true }
      ],
      integrations: [{
        integrationId: 'ffmpeg',
        displayName: 'FFmpeg',
        description: 'Video and audio processing toolkit.',
        category: 'media',
        status: 'ready',
        summary: 'Ready.',
        operationStatus: {
          backendKind: 'system-package-manager',
          backend: 'brew',
          packageName: 'ffmpeg',
          installedVersion: '7.1.1',
          latestVersion: '8.0',
          updateCommandPreview: 'brew upgrade --formula ffmpeg',
          uninstallCommandPreview: 'brew uninstall --formula ffmpeg'
        },
        binaries: [{
          binaryId: 'ffmpeg',
          displayName: 'ffmpeg',
          status: 'ready',
          version: '7.1.1'
        }, {
          binaryId: 'ffprobe',
          displayName: 'ffprobe',
          status: 'ready',
          version: '7.1.1'
        }]
      }, {
        integrationId: 'imagemagick',
        displayName: 'ImageMagick',
        description: 'Image conversion toolkit.',
        category: 'media',
        status: 'not_found',
        summary: 'magick is missing.',
        operationStatus: {
          backendKind: 'system-package-manager',
          backend: 'brew',
          packageName: 'imagemagick',
          latestVersion: '7.1.2-23',
          installCommandPreview: 'brew install --formula imagemagick'
        },
        binaries: [{
          binaryId: 'magick',
          displayName: 'magick',
          status: 'not_found'
        }]
      }, {
        integrationId: 'mediainfo',
        displayName: 'MediaInfo',
        description: 'Media information reader.',
        category: 'media',
        status: 'probe_failed',
        summary: 'mediainfo probe failed.',
        operationStatus: {
          backendKind: 'system-package-manager',
          backend: 'brew',
          packageName: 'media-info',
          unavailableReason: 'Integration operations require a ready detected integration.'
        },
        binaries: [{
          binaryId: 'mediainfo',
          displayName: 'mediainfo',
          status: 'probe_failed',
          probe: { errorKind: 'nonzero_exit', stderrTail: 'failed' }
        }]
      }, {
        integrationId: 'remove-ai-watermarks',
        displayName: 'Remove AI Watermarks',
        description: 'Visible AI watermark removal and AI metadata cleanup CLI.',
        category: 'image-cleanup',
        status: 'ready',
        summary: 'Ready.',
        operationStatus: {
          backendKind: 'python-cli-installer',
          backend: 'uv',
          packageName: 'remove-ai-watermarks',
          updateCommandPreview: 'uv tool upgrade remove-ai-watermarks',
          uninstallCommandPreview: 'uv tool uninstall remove-ai-watermarks'
        },
        binaries: [{
          binaryId: 'remove-ai-watermarks',
          displayName: 'remove-ai-watermarks',
          status: 'ready',
          version: '0.5.4'
        }]
      }]
    },
    textFileBuffers: {},
    textEditorWindows: {},
    notifications: [],
    ...overrides
  };
}

function createActions(): WorkbenchActions {
  return {
    rescanIntegrations: async () => createState().integrationsSettings!
  } as unknown as WorkbenchActions;
}
