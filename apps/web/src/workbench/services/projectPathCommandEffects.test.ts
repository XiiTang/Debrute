import type { WorkbenchApiClient } from '@debrute/app-protocol';
import { describe, expect, it, vi } from 'vitest';
import type { AcceptedProjectPathCommandScope } from './projectPathCommandIntake.js';
import { createProjectPathCommandEffects } from './projectPathCommandEffects.js';

describe('Project Path Command effects', () => {
  it('submits through the accepted scope and refuses a scope that can no longer submit', async () => {
    const trashProjectPaths = vi.fn<WorkbenchApiClient['trashProjectPaths']>(async () => ({
      projectId: 'project-a',
      projectRevision: 2,
      results: []
    }));
    const effects = createProjectPathCommandEffects({
      trashProjectPaths
    } as never);
    let canSubmit = true;
    const scope = {
      projectId: 'project-a',
      generation: 1,
      canSubmit: () => canSubmit,
      isCurrent: () => true
    } as AcceptedProjectPathCommandScope;
    const input = {
      entries: [{ projectRelativePath: 'brief.md', kind: 'file' as const }]
    };

    await expect(effects.trashProjectPaths(scope, input)).resolves.toMatchObject({
      projectId: 'project-a'
    });
    canSubmit = false;
    expect(effects.trashProjectPaths(scope, input)).toBeUndefined();
    expect(trashProjectPaths).toHaveBeenCalledOnce();
  });

  it('lets an already-submitted request finish after admission closes', async () => {
    let resolveRequest!: (result: Awaited<ReturnType<WorkbenchApiClient['trashProjectPaths']>>) => void;
    const trashProjectPaths = vi.fn<WorkbenchApiClient['trashProjectPaths']>(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const effects = createProjectPathCommandEffects({ trashProjectPaths } as never);
    let canSubmit = true;
    const scope = {
      projectId: 'project-a',
      generation: 1,
      canSubmit: () => canSubmit,
      isCurrent: () => true
    } as AcceptedProjectPathCommandScope;

    const request = effects.trashProjectPaths(scope, {
      entries: [{ projectRelativePath: 'brief.md', kind: 'file' }]
    });
    expect(request).toBeDefined();
    canSubmit = false;
    resolveRequest({
      projectId: 'project-a',
      projectRevision: 2,
      results: []
    });

    await expect(request).resolves.toMatchObject({ projectId: 'project-a' });
    expect(trashProjectPaths).toHaveBeenCalledOnce();
  });
});
