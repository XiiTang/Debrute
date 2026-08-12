import type {
  WorkbenchApiClient,
  WorkbenchProjectTarget
} from '@debrute/app-protocol';
import type {
  WorkbenchProjectProjection,
  WorkbenchProjectProjectionState
} from './WorkbenchProjectProjection';

export interface ProjectBindingLifecycleState {
  opening: boolean;
}

export interface ProjectBindingLifecycle {
  getState(): ProjectBindingLifecycleState;
  subscribe(listener: () => void): () => void;
  open(target: WorkbenchProjectTarget): Promise<void>;
}

export function createProjectBindingLifecycle(input: {
  openProject: WorkbenchApiClient['openProject'];
  projectProjection: WorkbenchProjectProjection;
  commitProjectRoute(canonicalRoot: string): void;
}): ProjectBindingLifecycle {
  let state: ProjectBindingLifecycleState = { opening: false };
  const listeners = new Set<() => void>();

  const transition = (opening: boolean): void => {
    if (state.opening === opening) {
      return;
    }
    state = { opening };
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async open(target) {
      if (state.opening) {
        return;
      }
      const source = input.projectProjection.getState();
      transition(true);
      try {
        const opened = await input.openProject(target);
        if ('outcome' in opened) {
          return;
        }
        const accepted = input.projectProjection.getState();
        if (accepted.status !== 'bound' || accepted.bindingId !== opened.bindingId) {
          return;
        }
        input.commitProjectRoute(accepted.canonicalRoot);
      } catch (error) {
        if (bindingIsUnchanged(source, input.projectProjection.getState())) {
          throw error;
        }
      } finally {
        transition(false);
      }
    }
  };
}

function bindingIsUnchanged(
  source: WorkbenchProjectProjectionState,
  current: WorkbenchProjectProjectionState
): boolean {
  if (source.status === 'unbound' || current.status === 'unbound') {
    return source.status === current.status;
  }
  return source.status === current.status
    && source.bindingId === current.bindingId
    && source.generation === current.generation;
}
