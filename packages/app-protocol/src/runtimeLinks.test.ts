import { describe, expect, it } from 'vitest';
import {
  isDebruteMutatingMethod,
  normalizeDebruteRuntimeInfo,
  parseDebruteWorkbenchPath,
  type DebruteDefaultFrontend,
  type DebruteGlobalSettingsView,
  type LiveProjectsView,
  type SaveDebruteGlobalSettingsInput,
  type WorkbenchEvent,
  type WorkbenchApiClient,
  type WorkbenchProjectOpenResult,
  type WorkbenchProjectPickerOpenResult,
  type WorkbenchProjectSessionSnapshot
} from './index.js';

type IsExactType<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends
  (<Value>() => Value extends Expected ? 1 : 2)
    ? true
    : false;
type AssertTrue<Value extends true> = Value;
type OpenProjectReturnIsExact = AssertTrue<IsExactType<
  ReturnType<WorkbenchApiClient['openProject']>,
  Promise<WorkbenchProjectOpenResult>
>>;
type OpenProjectFromPickerReturnIsExact = AssertTrue<IsExactType<
  ReturnType<WorkbenchApiClient['openProjectFromPicker']>,
  Promise<WorkbenchProjectPickerOpenResult>
>>;

describe('app-protocol runtime metadata', { tags: ['runtime'] }, () => {
  it('models runtime-owned global settings and default frontend', () => {
    const frontend: DebruteDefaultFrontend = 'runtime-only';
    const settings: DebruteGlobalSettingsView = {
      workbench: {
        locale: 'en',
        themePreference: 'system',
        defaultFrontend: frontend
      },
      chrome: {
        recentProjectRoots: ['/tmp/project-a']
      },
      models: {
        image: { models: [] },
        video: { models: [] },
        audio: { models: [] }
      },
      integrations: {
        integrations: [],
        backends: []
      },
      adobeBridge: { enabled: true }
    };
    const input: SaveDebruteGlobalSettingsInput = {
      workbench: { defaultFrontend: 'browser' },
      adobeBridge: { enabled: false }
    };
    const event: WorkbenchEvent = { type: 'globalSettings.changed', settings };
    const recentProjectsEvent: WorkbenchEvent = {
      type: 'recentProjects.changed',
      recentProjectRoots: ['/tmp/project-a']
    };

    expect(settings.workbench.defaultFrontend).toBe('runtime-only');
    expect(input).toEqual({
      workbench: { defaultFrontend: 'browser' },
      adobeBridge: { enabled: false }
    });
    expect(event.type).toBe('globalSettings.changed');
    expect(recentProjectsEvent).toEqual({
      type: 'recentProjects.changed',
      recentProjectRoots: ['/tmp/project-a']
    });
  });

  it('normalizes runtime info without active project state', () => {
    const runtime = normalizeDebruteRuntimeInfo({
      daemonUrl: 'http://127.0.0.1:17456/',
      webBaseUrl: 'http://127.0.0.1:17573/',
      platform: 'darwin'
    });

    expect(runtime).toEqual({
      daemonUrl: 'http://127.0.0.1:17456',
      webBaseUrl: 'http://127.0.0.1:17573',
      platform: 'darwin'
    });
    expect(JSON.stringify(runtime)).not.toContain('token');
  });

  it('parses final Web Workbench routes', () => {
    expect(parseDebruteWorkbenchPath('/')).toEqual({ kind: 'workbench' });
    expect(parseDebruteWorkbenchPath('/open', '')).toEqual({ kind: 'project-open' });
    expect(parseDebruteWorkbenchPath('/open', '?path=%2FUsers%2Fme%2FProject%20A')).toEqual({
      kind: 'project-open',
      projectRoot: '/Users/me/Project A'
    });
    expect(parseDebruteWorkbenchPath('/projects/123e4567-e89b-42d3-a456-426614174000')).toEqual({
      kind: 'project',
      projectId: '123e4567-e89b-42d3-a456-426614174000'
    });

    expect(parseDebruteWorkbenchPath('/projects/123e4567-e89b-42d3-a456-426614174000/files/briefs/cover%20art.png')).toEqual({ kind: 'workbench' });
    expect(parseDebruteWorkbenchPath('/settings')).toEqual({ kind: 'workbench' });
  });

  it('models live projects as a collection instead of an active project alias', () => {
    const view: LiveProjectsView = {
      projects: [{
        projectId: '123e4567-e89b-42d3-a456-426614174000',
        snapshot: {
          metadata: {
            project: {
              id: 'project-record-id',
              name: 'Alpha',
              createdAt: '2026-06-03T00:00:00.000Z',
              updatedAt: '2026-06-03T00:00:00.000Z'
            }
          },
          files: [],
          canvases: [],
          projections: [],
          diagnostics: [],
          health: {
            projectName: 'Alpha',
            canvasCount: 0,
            diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
            runtimeDataLocation: 'debrute-home',
            checkedAt: '2026-06-03T00:00:00.000Z'
          }
        },
        clients: { liveCount: 1 }
      }]
    };

    expect(view.projects[0]?.projectId).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(JSON.stringify(view)).not.toContain('activeProjectId');
  });

  it('requires project open clients to return an opened project result', () => {
    const _typeCheck: OpenProjectReturnIsExact = true;
    expect(_typeCheck).toBe(true);
  });

  it('models picker project open results without project roots', () => {
    const _typeCheck: OpenProjectFromPickerReturnIsExact = true;
    const snapshot: WorkbenchProjectSessionSnapshot = {
      metadata: {
        project: {
          id: 'project-record-id',
          name: 'Alpha',
          createdAt: '2026-06-22T00:00:00.000Z',
          updatedAt: '2026-06-22T00:00:00.000Z'
        }
      },
      files: [],
      canvases: [],
      projections: [],
      diagnostics: [],
      canvasRegistry: { status: 'ready', canvasOrder: [] },
      health: {
        projectName: 'Alpha',
        canvasCount: 0,
        diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
        runtimeDataLocation: 'debrute-home',
        checkedAt: '2026-06-22T00:00:00.000Z'
      }
    };
    const canceled: WorkbenchProjectPickerOpenResult = { opened: false };
    const opened: WorkbenchProjectPickerOpenResult = {
      opened: true,
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      projectRevision: 1,
      snapshot
    };

    expect(_typeCheck).toBe(true);
    expect(canceled.opened).toBe(false);
    expect(opened.projectId).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(JSON.stringify(opened)).not.toContain('projectRoot');
  });

  it('classifies mutating HTTP methods', () => {
    expect(isDebruteMutatingMethod('GET')).toBe(false);
    expect(isDebruteMutatingMethod('HEAD')).toBe(false);
    expect(isDebruteMutatingMethod('POST')).toBe(true);
    expect(isDebruteMutatingMethod('PUT')).toBe(true);
    expect(isDebruteMutatingMethod('PATCH')).toBe(true);
    expect(isDebruteMutatingMethod('DELETE')).toBe(true);
  });
});
