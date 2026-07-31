import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CanvasTextAppearance,
  DebruteGlobalSettingsView,
  DebruteProductState,
  IntegrationSettingsView,
  RunIntegrationOperationInput,
  RunIntegrationOperationResult,
  SaveDebruteGlobalSettingsInput,
  WorkbenchApiClient
} from '@debrute/app-protocol';
import type { EventProjection, SettingsResource } from '../../types.js';
import type { WorkbenchI18n } from '../i18n/index.js';
import type {
  WorkbenchGlobalProjection,
  WorkbenchGlobalProjectionState
} from '../services/WorkbenchGlobalProjection.js';

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
  product: EventProjection<DebruteProductState | null>;
  canvasTextAppearance: CanvasTextAppearance;
  actions: WorkbenchSettingsActions;
}

interface CanvasTextAppearanceSaveWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface CanvasTextAppearanceSaveTask {
  appearance: CanvasTextAppearance;
  waiters: CanvasTextAppearanceSaveWaiter[];
}

interface CanvasTextAppearanceSaveQueue {
  running: boolean;
  inFlight?: CanvasTextAppearanceSaveTask & { confirmed: boolean };
  queued?: CanvasTextAppearanceSaveTask;
  awaitingEvent?: CanvasTextAppearance;
}

export interface WorkbenchSettingsControllerInput {
  api: WorkbenchApiClient;
  globalProjection: WorkbenchGlobalProjection;
  notify(message: string): void;
  getCurrentI18n(): WorkbenchI18n;
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
  const [canvasTextAppearanceOverlay, setCanvasTextAppearanceOverlay] = useState<CanvasTextAppearance>();
  const [integrationsLoadError, setIntegrationsLoadError] = useState<string>();
  const queueRef = useRef<CanvasTextAppearanceSaveQueue>({ running: false });
  const acceptedCanvasTextAppearanceRef = useRef(projection.settings.canvas.textAppearance);
  acceptedCanvasTextAppearanceRef.current = projection.settings.canvas.textAppearance;
  const optionalResourcesRequestedRef = useRef(false);

  useEffect(() => {
    const queue = queueRef.current;
    if (
      queue.awaitingEvent
      && sameCanvasTextAppearance(queue.awaitingEvent, projection.settings.canvas.textAppearance)
    ) {
      delete queue.awaitingEvent;
    }
    if (queue.inFlight && sameCanvasTextAppearance(queue.inFlight.appearance, projection.settings.canvas.textAppearance)) {
      queue.inFlight.confirmed = true;
    }
    setCanvasTextAppearanceOverlay(localCanvasTextAppearance(queue, projection.settings.canvas.textAppearance));
  }, [projection.settings]);

  useEffect(() => {
    if (projection.integrations.status === 'ready') setIntegrationsLoadError(undefined);
  }, [projection.integrations]);

  const saveCanvasTextAppearance = useCallback((appearance: CanvasTextAppearance): Promise<void> => {
    const queue = queueRef.current;
    if (
      !queue.running
      && !queue.inFlight
      && !queue.queued
      && !queue.awaitingEvent
      && sameCanvasTextAppearance(appearance, acceptedCanvasTextAppearanceRef.current)
    ) {
      return Promise.resolve();
    }
    delete queue.awaitingEvent;
    setCanvasTextAppearanceOverlay(appearance);
    const pending = new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      if (queue.queued) {
        queue.queued.appearance = appearance;
        queue.queued.waiters.push(waiter);
      } else {
        queue.queued = { appearance, waiters: [waiter] };
      }
    });
    if (queue.running) return pending;
    queue.running = true;
    void (async () => {
      while (queue.queued) {
        const task = queue.queued;
        delete queue.queued;
        const inFlight = { ...task, confirmed: false };
        queue.inFlight = inFlight;
        try {
          await input.api.globalSettingsSave({ canvas: { textAppearance: task.appearance } });
        } catch (error) {
          delete queue.inFlight;
          const queued = takeQueuedCanvasAppearanceTask(queue);
          delete queue.awaitingEvent;
          queue.running = false;
          task.waiters.forEach((waiter) => waiter.reject(error));
          queued?.waiters.forEach((waiter) => waiter.reject(error));
          setCanvasTextAppearanceOverlay(undefined);
          return;
        }
        task.waiters.forEach((waiter) => waiter.resolve());
        delete queue.inFlight;
        if (!queue.queued && !inFlight.confirmed) queue.awaitingEvent = task.appearance;
      }
      queue.running = false;
      if (!queue.awaitingEvent) setCanvasTextAppearanceOverlay(undefined);
    })();
    return pending;
  }, [input.api.globalSettingsSave]);

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
        await saveCanvasTextAppearance(saveInput.canvas.textAppearance);
      } else {
        await input.api.globalSettingsSave(saveInput);
      }
    },
    revealModelApiKey: async (modelId) => (await input.api.revealModelApiKey(modelId)).apiKey,
    rescanIntegrations,
    runIntegrationOperation: async (operationInput) => {
      const result = await input.api.integrationsRunOperation(operationInput);
      if (!result.ok) {
        const i18n = input.getCurrentI18n();
        const diagnostic = result.diagnostic?.stderrTail
          ?? result.diagnostic?.stdoutTail
          ?? result.diagnostic?.errorKind
          ?? i18n.t('settings.integrations.unknownOperationFailure');
        input.notify(i18n.t('settings.integrations.operationFailedNotification', {
          operation: i18n.t(integrationOperationLabelKey(result.operation)),
          integration: result.integrationId,
          message: diagnostic
        }));
      }
      return result;
    }
  }), [
    input.api,
    input.getCurrentI18n,
    input.notify,
    rescanIntegrations,
    saveCanvasTextAppearance
  ]);

  const canvasTextAppearance = canvasTextAppearanceOverlay
    ?? projection.settings.canvas.textAppearance;
  const globalSettings = useMemo<EventProjection<DebruteGlobalSettingsView>>(() => ({
    status: 'ready',
    value: canvasTextAppearanceOverlay
      ? globalSettingsWithCanvasTextAppearance(projection.settings, canvasTextAppearance)
      : projection.settings
  }), [canvasTextAppearance, canvasTextAppearanceOverlay, projection.settings]);
  const integrations = integrationsLoadError
    ? { status: 'error' as const, message: integrationsLoadError }
    : projection.integrations;
  return useMemo(() => ({
    globalSettings,
    integrations,
    product: projection.product,
    canvasTextAppearance,
    actions
  }), [actions, canvasTextAppearance, globalSettings, integrations, projection.product]);
}

function takeQueuedCanvasAppearanceTask(
  queue: CanvasTextAppearanceSaveQueue
): CanvasTextAppearanceSaveTask | undefined {
  const task = queue.queued;
  delete queue.queued;
  return task;
}

type InitializedWorkbenchGlobalProjection = Exclude<WorkbenchGlobalProjectionState, { status: 'uninitialized' }>;

function initializedGlobalProjection(state: WorkbenchGlobalProjectionState): InitializedWorkbenchGlobalProjection {
  if (state.status === 'uninitialized') throw new Error('Settings feature requires the initial Global snapshot.');
  return state;
}

function globalSettingsWithCanvasTextAppearance(
  settings: DebruteGlobalSettingsView,
  appearance: CanvasTextAppearance
): DebruteGlobalSettingsView {
  return { ...settings, canvas: { textAppearance: appearance } };
}

function localCanvasTextAppearance(
  queue: CanvasTextAppearanceSaveQueue,
  confirmed: CanvasTextAppearance
): CanvasTextAppearance | undefined {
  if (queue.queued) return queue.queued.appearance;
  if (queue.inFlight) {
    return queue.inFlight.confirmed && !sameCanvasTextAppearance(queue.inFlight.appearance, confirmed)
      ? undefined
      : queue.inFlight.appearance;
  }
  return queue.awaitingEvent;
}

function sameCanvasTextAppearance(left: CanvasTextAppearance, right: CanvasTextAppearance): boolean {
  return left.fontId === right.fontId
    && left.fontSizePx === right.fontSizePx
    && left.lineHeightRatio === right.lineHeightRatio
    && left.fontWeight === right.fontWeight
    && left.letterSpacingPx === right.letterSpacingPx
    && left.ligatures === right.ligatures;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function integrationOperationLabelKey(
  operation: 'install' | 'update' | 'uninstall'
): 'settings.integrations.install' | 'settings.integrations.update' | 'settings.integrations.uninstall' {
  if (operation === 'install') return 'settings.integrations.install';
  if (operation === 'update') return 'settings.integrations.update';
  return 'settings.integrations.uninstall';
}
