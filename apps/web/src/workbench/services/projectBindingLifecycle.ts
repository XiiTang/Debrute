import type {
  WorkbenchApiClient,
  WorkbenchProjectTarget
} from '@debrute/app-protocol';
import type {
  WorkbenchProjectProjection,
  WorkbenchProjectProjectionState
} from './WorkbenchProjectProjection.js';

export interface ProjectBindingLifecycleState {
  opening: boolean;
}

export type ProjectBindingLifecycleOutcome =
  | {
      outcome: 'bound';
      bindingId: string;
      canonicalRoot: string;
      generation: number;
    }
  | {
      outcome: 'focused_existing_desktop';
      canonicalRoot: string;
    }
  | {
      outcome: 'failed';
      error: Error;
    }
  | {
      outcome: 'superseded';
    }
  | {
      outcome: 'ignored_while_opening';
    };

export interface ProjectBindingLifecycle {
  getState(): ProjectBindingLifecycleState;
  subscribe(listener: () => void): () => void;
  open(target: WorkbenchProjectTarget): Promise<ProjectBindingLifecycleOutcome>;
  canAcceptProjectPathCommand(generation: number): boolean;
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
        return { outcome: 'ignored_while_opening' };
      }
      const source = input.projectProjection.getState();
      transition(true);
      try {
        const opened = await input.openProject(target);
        if ('outcome' in opened) {
          return bindingIsUnchanged(source, input.projectProjection.getState())
            ? opened
            : { outcome: 'superseded' };
        }
        const accepted = input.projectProjection.getState();
        if (
          accepted.status !== 'bound'
          || accepted.bindingId !== opened.bindingId
        ) {
          return { outcome: 'superseded' };
        }
        input.commitProjectRoute(accepted.canonicalRoot);
        return {
          outcome: 'bound',
          bindingId: accepted.bindingId,
          canonicalRoot: accepted.canonicalRoot,
          generation: accepted.generation
        };
      } catch (error) {
        if (!bindingIsUnchanged(source, input.projectProjection.getState())) {
          return { outcome: 'superseded' };
        }
        return {
          outcome: 'failed',
          error: error instanceof Error ? error : new Error(String(error))
        };
      } finally {
        transition(false);
      }
    },
    canAcceptProjectPathCommand(generation) {
      const current = input.projectProjection.getState();
      return !state.opening
        && current.status === 'bound'
        && current.generation === generation;
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
