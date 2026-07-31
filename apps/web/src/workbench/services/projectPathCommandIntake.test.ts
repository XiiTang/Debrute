import type { WorkbenchApiClient } from '@debrute/app-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createProjectBindingLifecycle } from './projectBindingLifecycle.js';
import { createProjectPathCommandIntake } from './projectPathCommandIntake.js';
import { createWorkbenchProjectProjection } from './WorkbenchProjectProjection.js';

describe('Project Path Command intake', () => {
  it('rejects commands without one currently admitted bound Project', () => {
    const projection = createWorkbenchProjectProjection();
    const lifecycle = createProjectBindingLifecycle({
      openProject: vi.fn<WorkbenchApiClient['openProject']>(),
      projectProjection: projection,
      commitProjectRoute: vi.fn()
    });
    const intake = createProjectPathCommandIntake({
      projectBindingLifecycle: lifecycle,
      projectProjection: projection,
      isCommandSurfaceAvailable: () => true
    });

    expect(intake.canAccept()).toBe(false);
    expect(intake.tryAccept()).toBeUndefined();
  });

  it('captures one admitted Project identity and rejects a different result identity', () => {
    const { intake, projection } = boundIntake('project-a');

    const accepted = intake.tryAccept();

    expect(accepted).toMatchObject({ projectId: 'project-a', generation: 1 });
    expect(accepted?.canSubmit()).toBe(true);
    expect(accepted?.isCurrent()).toBe(true);
    expect(accepted?.isCurrent('project-a')).toBe(true);
    expect(accepted?.isCurrent('project-b')).toBe(false);

    projection.acceptBoundProject(projectResult('project-b'));

    expect(accepted?.canSubmit()).toBe(false);
    expect(accepted?.isCurrent()).toBe(false);
  });

  it('lets a submitted command finish under its captured scope after new admission closes', async () => {
    const { intake, lifecycle } = boundIntake('project-a');
    const accepted = intake.tryAccept();
    const opening = lifecycle.open({ projectRoot: '/projects/b' });

    expect(intake.canAccept()).toBe(false);
    expect(intake.tryAccept()).toBeUndefined();
    expect(accepted?.canSubmit()).toBe(false);
    expect(accepted?.isCurrent('project-a')).toBe(true);

    await expect(opening).resolves.toEqual({
      outcome: 'focused_existing_desktop',
      projectId: 'project-b'
    });
  });

  it('rejects commands while the command surface is unavailable', () => {
    let available = true;
    const { intake } = boundIntake('project-a', () => available);

    expect(intake.canAccept()).toBe(true);
    available = false;
    expect(intake.canAccept()).toBe(false);
    expect(intake.tryAccept()).toBeUndefined();
  });
});

function boundIntake(
  projectId: string,
  isCommandSurfaceAvailable: () => boolean = () => true
) {
  const projection = createWorkbenchProjectProjection();
  projection.acceptBoundProject(projectResult(projectId));
  const lifecycle = createProjectBindingLifecycle({
    openProject: vi.fn<WorkbenchApiClient['openProject']>(async () => ({
      outcome: 'focused_existing_desktop',
      projectId: 'project-b'
    })),
    projectProjection: projection,
    commitProjectRoute: vi.fn()
  });
  return {
    intake: createProjectPathCommandIntake({
      projectBindingLifecycle: lifecycle,
      projectProjection: projection,
      isCommandSurfaceAvailable
    }),
    lifecycle,
    projection
  };
}

function projectResult(projectId: string) {
  return {
    projectId,
    projectRevision: 1,
    snapshot: { projectId } as never,
    workingCopies: { text: {}, feedback: {} }
  };
}
