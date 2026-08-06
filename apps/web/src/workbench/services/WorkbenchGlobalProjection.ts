import type {
  DebruteGlobalSettingsView,
  DebruteProductState,
  IntegrationSettingsView,
  PhotoshopStateView,
  WorkbenchEvent
} from '@debrute/app-protocol';

type LoadingResource = { status: 'loading' };
type ReadyResource<T> = { status: 'ready'; value: T };
type PhotoshopResource = LoadingResource | ReadyResource<PhotoshopStateView>;

interface WorkbenchGlobalProjectionData {
  revision: number;
  settings: DebruteGlobalSettingsView;
  integrations: LoadingResource | ReadyResource<IntegrationSettingsView>;
  photoshop: PhotoshopResource;
  product: LoadingResource | ReadyResource<DebruteProductState | null>;
}

export type WorkbenchGlobalProjectionState =
  | { status: 'uninitialized' }
  | ({ status: 'active' } & WorkbenchGlobalProjectionData)
  | ({ status: 'failed'; error: Error } & WorkbenchGlobalProjectionData);

export type WorkbenchGlobalEvent = Exclude<
  WorkbenchEvent,
  { bindingId: string; projectRevision: number }
>;

export interface WorkbenchGlobalProjection {
  getState(): WorkbenchGlobalProjectionState;
  subscribe(listener: () => void): () => void;
}

export interface WorkbenchGlobalProjectionWriter extends WorkbenchGlobalProjection {
  acceptSnapshot(input: { revision: number; settings: DebruteGlobalSettingsView }): void;
  acceptEvent(event: WorkbenchGlobalEvent): void;
  endConnection(error: Error): void;
}

export function createWorkbenchGlobalProjection(): WorkbenchGlobalProjectionWriter {
  let state: WorkbenchGlobalProjectionState = { status: 'uninitialized' };
  const listeners = new Set<() => void>();

  const transition = (next: WorkbenchGlobalProjectionState): void => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const fail = (message: string): never => {
    const error = new Error(message);
    if (state.status !== 'uninitialized') {
      transition({ ...state, status: 'failed', error });
    }
    throw error;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acceptSnapshot(input) {
      if (state.status !== 'uninitialized') {
        fail('Workbench Global projection already accepted its initial snapshot.');
      }
      transition({
        status: 'active',
        revision: input.revision,
        settings: input.settings,
        integrations: { status: 'loading' },
        photoshop: { status: 'loading' },
        product: { status: 'loading' }
      });
    },
    acceptEvent(event) {
      if (state.status === 'uninitialized') {
        throw new Error(`Cannot accept ${event.type} before the Global snapshot.`);
      }
      if (state.status === 'failed') {
        throw state.error;
      }
      const current = state;
      const initialHydration = event.revision === current.revision
        && canHydrateInitialResource(current, event);
      if (!initialHydration && event.revision !== current.revision + 1) {
        fail(`Expected Global revision ${current.revision + 1}, received ${event.revision}.`);
      }
      const revision = initialHydration ? current.revision : event.revision;
      switch (event.type) {
        case 'globalSettings.changed':
          transition({ ...current, revision, settings: event.settings });
          return;
        case 'recentProjects.changed':
          transition({
            ...current,
            revision,
            settings: {
              ...current.settings,
              chrome: { ...current.settings.chrome, recentProjectRoots: event.recentProjectRoots }
            }
          });
          return;
        case 'integrations.changed':
          transition({
            ...current,
            revision,
            integrations: { status: 'ready', value: event.integrations }
          });
          return;
        case 'photoshop.state.changed':
          transition({
            ...current,
            revision,
            photoshop: { status: 'ready', value: event.state }
          });
          return;
        case 'product.changed':
          transition({
            ...current,
            revision,
            product: { status: 'ready', value: event.product }
          });
          return;
        default:
          return assertNever(event);
      }
    },
    endConnection(error) {
      if (state.status === 'active') {
        transition({ ...state, status: 'failed', error });
      }
    }
  };
}

function canHydrateInitialResource(
  state: WorkbenchGlobalProjectionData,
  event: WorkbenchGlobalEvent
): boolean {
  if (event.type === 'integrations.changed') {
    return state.integrations.status === 'loading';
  }
  if (event.type === 'product.changed') {
    return state.product.status === 'loading';
  }
  if (event.type === 'photoshop.state.changed') {
    return state.photoshop.status === 'loading';
  }
  return false;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Global event: ${JSON.stringify(value)}`);
}
