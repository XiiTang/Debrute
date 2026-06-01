import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AxisSetupPage } from '../apps/desktop/src/workbench/setup/AxisSetupPage';
import { CliSettingsPage } from '../apps/desktop/src/workbench/settings/cli/CliSettingsPage';
import { SettingsPanel } from '../apps/desktop/src/workbench/settings/SettingsPanel';
import type { WorkbenchActions, WorkbenchState } from '../apps/desktop/src/types';

describe('Axis CLI desktop UI', () => {
  it('renders first-run setup with CLI status and project entry actions', () => {
    const html = renderToStaticMarkup(React.createElement(AxisSetupPage, {
      state: createState(),
      actions: createActions()
    }));

    expect(html).toContain('AXIS Setup');
    expect(html).toContain('CLI missing');
    expect(html).toContain('/Users/test/.axis/bin/axis');
    expect(html).toContain('Install CLI');
    expect(html).toContain('Open Project');
  });

  it('adds CLI management to Settings', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPanel, {
      state: createState(),
      actions: createActions()
    }));

    expect(html).toContain('CLI');
    expect(html).toContain('Command install and PATH');
  });

  it('does not render a Desktop Skills settings page', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPanel, {
      state: createState(),
      actions: createActions()
    }));

    expect(html).toContain('CLI');
    expect(html).not.toContain('Skills');
    expect(html).not.toContain('AXIS capability packages');
  });

  it('renders fixed CLI operations without accepting paths or URLs', () => {
    const html = renderToStaticMarkup(React.createElement(CliSettingsPage, {
      state: createState({
        axisCliStatus: {
          mode: 'release',
          managed: true,
          installedVersion: '0.1.0',
          latestVersion: '0.2.0',
          updateAvailable: true,
          commandPath: '/Users/test/.axis/bin/axis',
          resolvedPath: '/opt/homebrew/bin/axis',
          binDir: '/Users/test/.axis/bin',
          installRoot: '/Users/test/.axis/cli',
          pathState: 'configured-pending-terminal',
          conflict: {
            managedPath: '/Users/test/.axis/bin/axis',
            resolvedPath: '/opt/homebrew/bin/axis',
            message: 'Another axis command resolves before AXIS.'
          }
        }
      }),
      actions: createActions()
    }));

    expect(html).toContain('Update CLI');
    expect(html).toContain('Repair');
    expect(html).toContain('Uninstall');
    expect(html).toContain('/opt/homebrew/bin/axis');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('https://');
  });
});

function createState(overrides: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    snapshot: undefined,
    selection: undefined,
    explorerSelection: undefined,
    llmSettings: { providers: [], availableModelKeys: [], defaultModelKey: null },
    imageModelSettings: { models: [] },
    videoModelSettings: { models: [] },
    integrationsSettings: undefined,
    canvasSettings: { imagePreviewsEnabled: true },
    canvasFeedback: undefined,
    textFileBuffers: {},
    textEditorWindows: {},
    notifications: [],
    updateState: undefined,
    setupCompleted: false,
    axisCliStatus: {
      mode: 'missing',
      managed: false,
      updateAvailable: false,
      commandPath: '/Users/test/.axis/bin/axis',
      binDir: '/Users/test/.axis/bin',
      installRoot: '/Users/test/.axis/cli',
      pathState: 'not-configured'
    },
    ...overrides
  };
}

function createActions(): WorkbenchActions {
  return {
    selectExplorerPath: () => undefined,
    selectCanvasEntity: () => undefined,
    saveLlmProviderSetting: async () => undefined,
    deleteLlmProviderSetting: async () => undefined,
    setDefaultLlmModelKey: async () => undefined,
    discoverLlmProviderModels: async () => ({ endpoint: '', models: [], modelsCount: 0, supportsDiscovery: true }),
    saveImageModelSetting: async () => undefined,
    saveVideoModelSetting: async () => undefined,
    refreshIntegrationsStatus: async () => ({ integrations: [], backends: [], operationRunning: false }),
    rescanIntegrations: async () => ({ integrations: [], backends: [], operationRunning: false }),
    saveCanvasSettings: async () => undefined,
    lookupGeneratedAssetMetadata: async () => ({ status: 'unavailable', reason: 'missing', message: '', fingerprint: { algorithm: 'sha256', hash: '' } }) as never,
    readProjectTextFile: async () => ({ projectRelativePath: '', content: '', language: 'text' }) as never,
    writeProjectTextFile: async () => ({ projectRelativePath: '', content: '', language: 'text' }) as never,
    resolveProjectAbsolutePath: async () => '',
    createProjectFile: async () => ({ projectRelativePath: '', snapshot: {} }) as never,
    createProjectDirectory: async () => ({ projectRelativePath: '', snapshot: {} }) as never,
    renameProjectPath: async () => ({ projectRelativePath: '', snapshot: {} }) as never,
    copyProjectPath: async () => ({ projectRelativePath: '', snapshot: {} }) as never,
    moveProjectPath: async () => ({ projectRelativePath: '', snapshot: {} }) as never,
    trashProjectPath: async () => ({ projectRelativePath: '', snapshot: {} }) as never,
    deleteProjectPathPermanently: async () => undefined,
    revealProjectPathInSystemFileManager: async () => ({ ok: true }),
    ensureTextFileBuffer: async () => undefined,
    updateTextFileBuffer: () => undefined,
    saveTextFileBuffer: async () => undefined,
    reloadTextFileBuffer: async () => undefined,
    openTextEditorWindow: () => undefined,
    toggleTextFileWordWrap: () => undefined,
    updateCanvasNodeLayouts: async () => undefined,
    updateCanvasNodeLayers: async () => undefined,
    updateCanvasViewport: async () => undefined,
    updateCanvasFeedbackEntry: async () => undefined,
    openProject: async () => undefined,
    updateNow: async () => undefined,
    refreshAxisCliStatus: async () => createState().axisCliStatus!,
    installAxisCli: async () => createState().axisCliStatus!,
    updateAxisCli: async () => createState().axisCliStatus!,
    repairAxisCli: async () => createState().axisCliStatus!,
    uninstallAxisCli: async () => createState().axisCliStatus!,
    refreshAxisCliDevelopmentLink: async () => createState().axisCliStatus!,
    completeSetup: async () => undefined
  };
}
