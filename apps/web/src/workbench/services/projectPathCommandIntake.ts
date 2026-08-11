import type { ProjectBindingLifecycle } from './projectBindingLifecycle';
import type { WorkbenchProjectProjection } from './WorkbenchProjectProjection';

const acceptedProjectPathCommandScope = Symbol('AcceptedProjectPathCommandScope');

export interface AcceptedProjectPathCommandScope {
  readonly bindingId: string;
  readonly generation: number;
  canSubmit(): boolean;
  isCurrent(resultBindingId?: string): boolean;
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
  const currentAcceptedScope = (): { bindingId: string; generation: number } | undefined => {
    const current = input.projectProjection.getState();
    if (
      current.status !== 'bound'
      || !input.isCommandSurfaceAvailable()
      || !input.projectBindingLifecycle.canAcceptProjectPathCommand(current.generation)
    ) {
      return undefined;
    }
    return {
      bindingId: current.bindingId,
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
      const isCurrent = (resultBindingId?: string): boolean => {
        const current = input.projectProjection.getState();
        return current.status !== 'unbound'
          && current.bindingId === accepted.bindingId
          && current.generation === accepted.generation
          && (resultBindingId === undefined || resultBindingId === accepted.bindingId);
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
