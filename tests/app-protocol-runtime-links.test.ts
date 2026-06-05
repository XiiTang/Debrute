import { describe, expect, it } from 'vitest';
import {
  isDebruteMutatingMethod,
  normalizeDebruteRuntimeInfo,
  parseDebruteWorkbenchPath,
  type LiveProjectsView,
  type WorkbenchApiClient,
  type WorkbenchProjectOpenResult
} from '@debrute/app-protocol';

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

describe('app-protocol runtime metadata', () => {
  it('normalizes runtime info without active project state', () => {
    const runtime = normalizeDebruteRuntimeInfo({
      daemonUrl: 'http://127.0.0.1:17456/',
      webBaseUrl: 'http://127.0.0.1:17573/'
    });

    expect(runtime).toEqual({
      daemonUrl: 'http://127.0.0.1:17456',
      webBaseUrl: 'http://127.0.0.1:17573'
    });
  });

  it('parses only project-level Workbench routes', () => {
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
            schemaVersion: 1,
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

  it('classifies mutating HTTP methods', () => {
    expect(isDebruteMutatingMethod('GET')).toBe(false);
    expect(isDebruteMutatingMethod('HEAD')).toBe(false);
    expect(isDebruteMutatingMethod('POST')).toBe(true);
    expect(isDebruteMutatingMethod('PUT')).toBe(true);
    expect(isDebruteMutatingMethod('PATCH')).toBe(true);
    expect(isDebruteMutatingMethod('DELETE')).toBe(true);
  });
});
