import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { ProjectBindingLifecycle } from './projectBindingLifecycle';
import type { WorkbenchProjectProjection } from './WorkbenchProjectProjection';

export interface ProjectCommandGate {
  available(): boolean;
  accept(): ProjectCommandScope | undefined;
}

export interface ProjectCommandScope {
  submit<T>(operation: () => Promise<T>): Promise<T> | undefined;
  isCurrent(resultBindingId?: string): boolean;
  waitForRevision(revision: number): Promise<WorkbenchProjectSessionSnapshot>;
}

export function createProjectCommandGate(input: {
  projectBindingLifecycle: Pick<ProjectBindingLifecycle, 'getState'>;
  projectProjection: Pick<WorkbenchProjectProjection, 'getState' | 'waitForRevision'>;
  isCommandSurfaceAvailable(): boolean;
}): ProjectCommandGate {
  const admittedBinding = (): { bindingId: string; generation: number } | undefined => {
    const current = input.projectProjection.getState();
    if (
      input.projectBindingLifecycle.getState().opening
      || !input.isCommandSurfaceAvailable()
      || current.status !== 'bound'
    ) {
      return undefined;
    }
    return { bindingId: current.bindingId, generation: current.generation };
  };

  return {
    available: () => admittedBinding() !== undefined,
    accept() {
      const accepted = admittedBinding();
      if (!accepted) {
        return undefined;
      }
      const isCurrent = (resultBindingId?: string): boolean => {
        const current = input.projectProjection.getState();
        return current.status === 'bound'
          && current.bindingId === accepted.bindingId
          && current.generation === accepted.generation
          && (resultBindingId === undefined || resultBindingId === accepted.bindingId);
      };
      const canSubmit = (): boolean => isCurrent()
        && !input.projectBindingLifecycle.getState().opening
        && input.isCommandSurfaceAvailable();
      return {
        submit: (operation) => canSubmit() ? operation() : undefined,
        isCurrent,
        waitForRevision: (revision) => input.projectProjection.waitForRevision(
          accepted.generation,
          revision
        )
      };
    }
  };
}
