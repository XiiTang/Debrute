import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchApiClient, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { openInitialProject } from './projectSessionState';

describe('project session startup', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('opens the project addressed by the project Workbench route', async () => {
    const calls: unknown[] = [];
    const snapshot = { canvases: [{ id: 'canvas-1' }] } as WorkbenchProjectSessionSnapshot;
    const api = {
      openProject: async (input: unknown) => {
        calls.push(input);
        return { projectId: '123e4567-e89b-42d3-a456-426614174000', snapshot };
      }
    } as unknown as WorkbenchApiClient;

    await expect(openInitialProject(api, {
      kind: 'project',
      projectId: '123e4567-e89b-42d3-a456-426614174000'
    })).resolves.toEqual({
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      snapshot,
      route: {
        kind: 'project',
        projectId: '123e4567-e89b-42d3-a456-426614174000'
      }
    });

    expect(calls).toEqual([{ projectId: '123e4567-e89b-42d3-a456-426614174000' }]);
  });

  it('keeps the Workbench root empty until a project is explicitly opened', async () => {
    const calls: unknown[] = [];
    const api = {
      openProject: async (input: unknown) => {
        calls.push(input);
        throw new Error('openProject should not be called for the Workbench root');
      }
    } as unknown as WorkbenchApiClient;

    await expect(openInitialProject(api, { kind: 'workbench' })).resolves.toEqual({
      snapshot: undefined,
      route: { kind: 'workbench' }
    });

    expect(calls).toEqual([]);
  });

  it('does not rewrite the Workbench root route without an explicit project id', async () => {
    const replaceState = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { pathname: '/', search: '', hash: '' },
      history: { replaceState }
    };
    const api = {
      openProject: async () => {
        throw new Error('openProject should not be called for the Workbench root');
      }
    } as unknown as WorkbenchApiClient;

    await openInitialProject(api, { kind: 'workbench' });

    expect(replaceState).not.toHaveBeenCalled();
  });
});
