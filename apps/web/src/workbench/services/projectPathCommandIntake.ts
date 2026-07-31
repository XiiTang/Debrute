import type { ProjectBindingLifecycle } from './projectBindingLifecycle.js';
import type { WorkbenchProjectProjection } from './WorkbenchProjectProjection.js';

const acceptedProjectPathCommandScope = Symbol('AcceptedProjectPathCommandScope');

export interface AcceptedProjectPathCommandScope {
  readonly projectId: string;
  readonly generation: number;
  canSubmit(): boolean;
  isCurrent(resultProjectId?: string): boolean;
  readonly [acceptedProjectPathCommandScope]: true;
}

export interface ProjectPathCommandIntake {
  canAccept(): boolean;
  tryAccept(): AcceptedProjectPathCommandScope | undefined;
}

export function createProjectPathCommandIntake(input: {
  projectBindingLifecycle: Pick<ProjectBindingLifecycle, 'canAcceptProjectPathCommand'>;
  projectProjection: Pick<WorkbenchProjectProjection, 'getState'>;
  isCommandSurfaceAvailable(): boolean;
}): ProjectPathCommandIntake {
  const currentAcceptedScope = (): { projectId: string; generation: number } | undefined => {
    const current = input.projectProjection.getState();
    if (
      current.status !== 'bound'
      || !input.isCommandSurfaceAvailable()
      || !input.projectBindingLifecycle.canAcceptProjectPathCommand(current.generation)
    ) {
      return undefined;
    }
    return {
      projectId: current.projectId,
      generation: current.generation
    };
  };

  return {
    canAccept: () => currentAcceptedScope() !== undefined,
    tryAccept() {
      const accepted = currentAcceptedScope();
      if (!accepted) {
        return undefined;
      }
      const isCurrent = (resultProjectId?: string): boolean => {
        const current = input.projectProjection.getState();
        return current.status !== 'unbound'
          && current.projectId === accepted.projectId
          && current.generation === accepted.generation
          && (resultProjectId === undefined || resultProjectId === accepted.projectId);
      };
      return {
        ...accepted,
        canSubmit: () => isCurrent()
          && input.isCommandSurfaceAvailable()
          && input.projectBindingLifecycle.canAcceptProjectPathCommand(accepted.generation),
        isCurrent,
        [acceptedProjectPathCommandScope]: true
      };
    }
  };
}
