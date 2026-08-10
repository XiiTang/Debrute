import { useMemo, useSyncExternalStore } from 'react';
import type {
  CanvasTextAppearance,
  DebruteGlobalSettingsView,
  DebruteProductState,
  PhotoshopStateView,
  MutateDebruteGlobalSettingsInput,
  WorkbenchApiClient
} from '@debrute/app-protocol';
import type { EventProjection } from '../../types.js';
import type {
  WorkbenchGlobalProjection,
  WorkbenchGlobalProjectionState
} from '../services/WorkbenchGlobalProjection.js';
import type { WorkbenchGlobalSettingsController } from '../services/useWorkbenchGlobalSettingsController.js';

export interface WorkbenchSettingsActions {
  checkProductUpdate(): Promise<void>;
  applyProductUpdate(): Promise<void>;
  mutateGlobalSettings(input: MutateDebruteGlobalSettingsInput): Promise<void>;
  removeProduct(keepConfig: boolean): Promise<void>;
  revealModelApiKey(modelId: string): Promise<string>;
}

export interface WorkbenchSettingsController {
  globalSettings: EventProjection<DebruteGlobalSettingsView>;
  photoshop: EventProjection<PhotoshopStateView>;
  product: EventProjection<DebruteProductState | null>;
  canvasTextAppearance: CanvasTextAppearance;
  actions: WorkbenchSettingsActions;
}

export interface WorkbenchSettingsControllerInput {
  api: WorkbenchApiClient;
  globalProjection: WorkbenchGlobalProjection;
  globalSettingsController: WorkbenchGlobalSettingsController;
  onProductRemovalAccepted(): void;
}

export function useWorkbenchSettingsController(
  input: WorkbenchSettingsControllerInput
): WorkbenchSettingsController {
  const projectionState = useSyncExternalStore(
    input.globalProjection.subscribe,
    input.globalProjection.getState,
    input.globalProjection.getState
  );
  const projection = initializedGlobalProjection(projectionState);
  const actions = useMemo<WorkbenchSettingsActions>(() => ({
    checkProductUpdate: async () => { await input.api.checkProductUpdate(); },
    applyProductUpdate: async () => { await input.api.applyProductUpdate(); },
    mutateGlobalSettings: input.globalSettingsController.mutate,
    removeProduct: async (keepConfig) => {
      await input.api.removeProduct({ confirmed: true, keepConfig });
      input.onProductRemovalAccepted();
    },
    revealModelApiKey: async (modelId) => (await input.api.revealModelApiKey(modelId)).apiKey
  }), [
    input.api,
    input.globalSettingsController,
    input.onProductRemovalAccepted
  ]);

  const canvasTextAppearance = input.globalSettingsController.settings.canvas.textAppearance;
  const globalSettings = useMemo<EventProjection<DebruteGlobalSettingsView>>(() => ({
    status: 'ready',
    value: input.globalSettingsController.settings
  }), [input.globalSettingsController.settings]);
  return useMemo(() => ({
    globalSettings,
    photoshop: projection.photoshop,
    product: projection.product,
    canvasTextAppearance,
    actions
  }), [actions, canvasTextAppearance, globalSettings, projection.photoshop, projection.product]);
}

type InitializedWorkbenchGlobalProjection = Exclude<WorkbenchGlobalProjectionState, { status: 'uninitialized' }>;

function initializedGlobalProjection(state: WorkbenchGlobalProjectionState): InitializedWorkbenchGlobalProjection {
  if (state.status === 'uninitialized') throw new Error('Settings feature requires the initial Global snapshot.');
  return state;
}
