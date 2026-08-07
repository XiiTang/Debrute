import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CanvasTextAppearance,
  DebruteGlobalSettingsView,
  DebruteProductState,
  IntegrationSettingsView,
  PhotoshopStateView,
  RunIntegrationOperationInput,
  RunIntegrationOperationResult,
  SaveDebruteGlobalSettingsInput,
  WorkbenchApiClient
} from '@debrute/app-protocol';
import type { EventProjection, SettingsResource } from '../../types.js';
import type {
  WorkbenchGlobalProjection,
  WorkbenchGlobalProjectionState
} from '../services/WorkbenchGlobalProjection.js';
import type { CanvasGlobalSettingsController } from '../services/useCanvasGlobalSettingsController.js';

export interface WorkbenchSettingsActions {
  checkProductUpdate(): Promise<void>;
  applyProductUpdate(): Promise<void>;
  saveGlobalSettings(input: SaveDebruteGlobalSettingsInput): Promise<void>;
  revealModelApiKey(modelId: string): Promise<string>;
  rescanIntegrations(): Promise<void>;
  runIntegrationOperation(input: RunIntegrationOperationInput): Promise<RunIntegrationOperationResult>;
}

export interface WorkbenchSettingsController {
  globalSettings: EventProjection<DebruteGlobalSettingsView>;
  integrations: SettingsResource<IntegrationSettingsView>;
  photoshop: EventProjection<PhotoshopStateView>;
  product: EventProjection<DebruteProductState | null>;
  canvasTextAppearance: CanvasTextAppearance;
  actions: WorkbenchSettingsActions;
}

export interface WorkbenchSettingsControllerInput {
  api: WorkbenchApiClient;
  globalProjection: WorkbenchGlobalProjection;
  canvasGlobalSettings: CanvasGlobalSettingsController;
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
  const [integrationsLoadError, setIntegrationsLoadError] = useState<string>();
  const optionalResourcesRequestedRef = useRef(false);

  useEffect(() => {
    if (projection.integrations.status === 'ready') setIntegrationsLoadError(undefined);
  }, [projection.integrations]);

  const rescanIntegrations = useCallback(async () => {
    setIntegrationsLoadError(undefined);
    try {
      await input.api.integrationsRescan();
    } catch (error) {
      setIntegrationsLoadError(errorMessage(error));
    }
  }, [input.api.integrationsRescan]);

  useEffect(() => {
    if (optionalResourcesRequestedRef.current) return;
    optionalResourcesRequestedRef.current = true;
    if (projection.integrations.status === 'loading') void rescanIntegrations();
  }, [projection.integrations.status, rescanIntegrations]);

  const actions = useMemo<WorkbenchSettingsActions>(() => ({
    checkProductUpdate: async () => { await input.api.checkProductUpdate(); },
    applyProductUpdate: async () => { await input.api.applyProductUpdate(); },
    saveGlobalSettings: async (saveInput) => {
      if (saveInput.canvas && Object.keys(saveInput).length === 1) {
        await input.canvasGlobalSettings.save(saveInput.canvas);
      } else {
        await input.api.globalSettingsSave(saveInput);
      }
    },
    revealModelApiKey: async (modelId) => (await input.api.revealModelApiKey(modelId)).apiKey,
    rescanIntegrations,
    runIntegrationOperation: async (operationInput) => (
      input.api.integrationsRunOperation(operationInput)
    )
  }), [
    input.api,
    input.canvasGlobalSettings,
    rescanIntegrations
  ]);

  const canvasTextAppearance = input.canvasGlobalSettings.settings.textAppearance;
  const globalSettings = useMemo<EventProjection<DebruteGlobalSettingsView>>(() => ({
    status: 'ready',
    value: {
      ...projection.settings,
      canvas: input.canvasGlobalSettings.settings
    }
  }), [input.canvasGlobalSettings.settings, projection.settings]);
  const integrations = integrationsLoadError
    ? { status: 'error' as const, message: integrationsLoadError }
    : projection.integrations;
  return useMemo(() => ({
    globalSettings,
    integrations,
    photoshop: projection.photoshop,
    product: projection.product,
    canvasTextAppearance,
    actions
  }), [actions, canvasTextAppearance, globalSettings, integrations, projection.photoshop, projection.product]);
}

type InitializedWorkbenchGlobalProjection = Exclude<WorkbenchGlobalProjectionState, { status: 'uninitialized' }>;

function initializedGlobalProjection(state: WorkbenchGlobalProjectionState): InitializedWorkbenchGlobalProjection {
  if (state.status === 'uninitialized') throw new Error('Settings feature requires the initial Global snapshot.');
  return state;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
