import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import type {
  AdobeBridgeStateView,
  CanvasTextAppearance,
  DebruteGlobalSettingsView,
  IntegrationSettingsView,
  WorkbenchApiClient
} from '@debrute/app-protocol';
import type { SettingsResource, WorkbenchActions, WorkbenchState } from '../../types.js';
import type { WorkbenchI18n } from '../i18n/index.js';
import type {
  WorkbenchGlobalProjection,
  WorkbenchGlobalProjectionState
} from '../services/WorkbenchGlobalProjection.js';

export type WorkbenchSettingsActions = Pick<WorkbenchActions,
  | 'checkProductUpdate'
  | 'applyProductUpdate'
  | 'reloadAdobeBridge'
  | 'saveGlobalSettings'
  | 'revealModelApiKey'
  | 'rescanIntegrations'
  | 'runIntegrationOperation'
  | 'createAdobeBridgePairing'
  | 'cancelAdobeBridgePairing'
  | 'removeAdobeBridgePairing'
  | 'linkAdobeBridgePhotoshop'
  | 'unlinkAdobeBridgePhotoshop'
>;

export interface WorkbenchSettingsController {
  globalSettings: WorkbenchState['globalSettings'];
  integrations: SettingsResource<IntegrationSettingsView>;
  product: WorkbenchState['product'];
  adobeBridge: WorkbenchState['adobeBridge'];
  actions: WorkbenchSettingsActions;
}

interface PendingAdobeClientCommand {
  token: number;
  projectId: string | undefined;
  pluginInstanceId: string;
  kind: 'link' | 'unlink';
  activeLinkIds: readonly string[];
  confirmed: boolean;
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
  projectId: string | undefined;
  ensureAdobeBridgeState(): Promise<void>;
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
  const [adobeBridgeLoadError, setAdobeBridgeLoadError] = useState<string>();
  const adobeBridgeLoadVersionRef = useRef(0);
  const adobeClientCommandTokenRef = useRef(0);
  const pendingAdobeClientCommandsRef = useRef(new Map<string, PendingAdobeClientCommand>());
  const canvasTextAppearanceSaveQueueRef = useRef<CanvasTextAppearanceSaveQueue>({
    running: false
  });
  const optionalResourcesRequestedRef = useRef(false);
  const adobeBridgeValue = projection.adobeBridge.status === 'ready'
    ? projection.adobeBridge.value
    : undefined;

  const confirmAdobeClientCommands = useCallback((bridge: AdobeBridgeStateView) => {
    for (const pending of pendingAdobeClientCommandsRef.current.values()) {
      if (adobeClientCommandTargetReached(
        pending,
        activeAdobeLinkIds(bridge, pending.projectId, pending.pluginInstanceId)
      )) {
        pending.confirmed = true;
      }
    }
  }, []);

  const beginAdobeClientCommand = useCallback((pluginInstanceId: string, kind: 'link' | 'unlink') => {
    const token = adobeClientCommandTokenRef.current + 1;
    adobeClientCommandTokenRef.current = token;
    const command: PendingAdobeClientCommand = {
      token,
      projectId: input.projectId,
      pluginInstanceId,
      kind,
      activeLinkIds: activeAdobeLinkIds(adobeBridgeValue, input.projectId, pluginInstanceId),
      confirmed: false
    };
    pendingAdobeClientCommandsRef.current.set(adobeClientCommandKey(input.projectId, pluginInstanceId), command);
    return command;
  }, [adobeBridgeValue, input.projectId]);

  const completeAdobeClientCommand = useCallback((command: PendingAdobeClientCommand) => {
    const key = adobeClientCommandKey(command.projectId, command.pluginInstanceId);
    if (pendingAdobeClientCommandsRef.current.get(key)?.token === command.token) {
      pendingAdobeClientCommandsRef.current.delete(key);
    }
  }, []);

  const shouldSuppressAdobeClientCommandError = useCallback((command: PendingAdobeClientCommand) => {
    const key = adobeClientCommandKey(command.projectId, command.pluginInstanceId);
    const pending = pendingAdobeClientCommandsRef.current.get(key);
    if (!pending || pending.token !== command.token) {
      return true;
    }
    pendingAdobeClientCommandsRef.current.delete(key);
    return pending.confirmed;
  }, []);

  useEffect(() => {
    pendingAdobeClientCommandsRef.current.clear();
  }, [input.projectId]);

  useEffect(() => {
    const settings = projection.settings;
    const queue = canvasTextAppearanceSaveQueueRef.current;
    delete queue.awaitingEvent;
    if (queue.inFlight && sameCanvasTextAppearance(
      queue.inFlight.appearance,
      settings.canvas.textAppearance
    )) {
      queue.inFlight.confirmed = true;
    }
    const localAppearance = localCanvasTextAppearance(queue, settings.canvas.textAppearance);
    setCanvasTextAppearanceOverlay(localAppearance);
  }, [projection.settings]);

  useEffect(() => {
    if (projection.integrations.status === 'ready') {
      setIntegrationsLoadError(undefined);
    }
  }, [projection.integrations]);

  useEffect(() => {
    if (projection.adobeBridge.status !== 'ready') {
      return;
    }
    adobeBridgeLoadVersionRef.current += 1;
    setAdobeBridgeLoadError(undefined);
    confirmAdobeClientCommands(projection.adobeBridge.value);
  }, [confirmAdobeClientCommands, projection.adobeBridge]);

  const saveCanvasTextAppearance = useCallback((appearance: CanvasTextAppearance): Promise<void> => {
    const queue = canvasTextAppearanceSaveQueueRef.current;
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
    if (queue.running) {
      return pending;
    }
    queue.running = true;
    void (async () => {
      while (queue.queued) {
        const task = queue.queued;
        delete queue.queued;
        const inFlight = { ...task, confirmed: false };
        queue.inFlight = inFlight;
        try {
          await input.api.globalSettingsSave({
            canvas: { textAppearance: task.appearance }
          });
        } catch (error) {
          delete queue.inFlight;
          const queued = canvasTextAppearanceSaveQueueRef.current.queued as
            | CanvasTextAppearanceSaveTask
            | undefined;
          delete queue.queued;
          delete queue.awaitingEvent;
          queue.running = false;
          task.waiters.forEach((waiter) => waiter.reject(error));
          queued?.waiters.forEach((waiter) => waiter.reject(error));
          setCanvasTextAppearanceOverlay(undefined);
          return;
        }
        task.waiters.forEach((waiter) => waiter.resolve());
        delete queue.inFlight;
        if (!queue.queued && !inFlight.confirmed) {
          queue.awaitingEvent = task.appearance;
        }
      }
      queue.running = false;
      if (!queue.awaitingEvent) {
        setCanvasTextAppearanceOverlay(undefined);
      }
    })();
    return pending;
  }, [input.api]);

  const loadAdobeBridge = useCallback(async (load: () => Promise<unknown>) => {
    const loadVersion = adobeBridgeLoadVersionRef.current + 1;
    adobeBridgeLoadVersionRef.current = loadVersion;
    pendingAdobeClientCommandsRef.current.clear();
    setAdobeBridgeLoadError(undefined);
    try {
      await load();
    } catch (error) {
      if (adobeBridgeLoadVersionRef.current === loadVersion) {
        setAdobeBridgeLoadError(errorMessage(error));
      }
    }
  }, []);
  const reloadAdobeBridge = useCallback(
    () => loadAdobeBridge(input.api.adobeBridgeRefreshState),
    [input.api.adobeBridgeRefreshState, loadAdobeBridge]
  );
  const rescanIntegrations = useCallback(async () => {
    setIntegrationsLoadError(undefined);
    try {
      await input.api.integrationsRescan();
    } catch (error) {
      setIntegrationsLoadError(errorMessage(error));
    }
  }, [input.api.integrationsRescan]);

  useEffect(() => {
    if (optionalResourcesRequestedRef.current) {
      return;
    }
    optionalResourcesRequestedRef.current = true;
    if (projection.integrations.status === 'loading') {
      void rescanIntegrations();
    }
    if (projection.adobeBridge.status === 'loading') {
      void loadAdobeBridge(input.ensureAdobeBridgeState);
    }
  }, [
    input.ensureAdobeBridgeState,
    loadAdobeBridge,
    projection.adobeBridge.status,
    projection.integrations.status,
    rescanIntegrations
  ]);

  useEffect(() => () => {
    adobeBridgeLoadVersionRef.current += 1;
    pendingAdobeClientCommandsRef.current.clear();
  }, []);

  const actions = useMemo<WorkbenchSettingsActions>(() => ({
    checkProductUpdate: async () => { await input.api.checkProductUpdate(); },
    applyProductUpdate: async () => { await input.api.applyProductUpdate(); },
    reloadAdobeBridge,
    saveGlobalSettings: async (saveInput) => {
      if (saveInput.canvas && Object.keys(saveInput).length === 1) {
        await saveCanvasTextAppearance(saveInput.canvas.textAppearance);
        return;
      }
      await input.api.globalSettingsSave(saveInput);
    },
    revealModelApiKey: async (modelId) => {
      const response = await input.api.revealModelApiKey(modelId);
      return response.apiKey;
    },
    rescanIntegrations,
    runIntegrationOperation: async (operationInput) => {
      const result = await input.api.integrationsRunOperation(operationInput);
      if (!result.ok) {
        const currentI18n = input.getCurrentI18n();
        const diagnostic = result.diagnostic?.stderrTail
          ?? result.diagnostic?.stdoutTail
          ?? result.diagnostic?.errorKind
          ?? currentI18n.t('settings.integrations.unknownOperationFailure');
        input.notify(currentI18n.t('settings.integrations.operationFailedNotification', {
          operation: currentI18n.t(integrationOperationLabelKey(result.operation)),
          integration: result.integrationId,
          message: diagnostic
        }));
      }
      return result;
    },
    createAdobeBridgePairing: () => input.api.adobeBridgeCreatePairing(),
    cancelAdobeBridgePairing: (pairingId) => input.api.adobeBridgeCancelPairing(pairingId),
    removeAdobeBridgePairing: async (pluginInstanceId) => {
      await input.api.adobeBridgeRemovePairing(pluginInstanceId);
    },
    linkAdobeBridgePhotoshop: async (linkInput) => {
      const command = beginAdobeClientCommand(linkInput.pluginInstanceId, 'link');
      try {
        await input.api.adobeBridgeLinkPhotoshop(linkInput);
        completeAdobeClientCommand(command);
      } catch (error) {
        if (!shouldSuppressAdobeClientCommandError(command)) {
          throw error;
        }
      }
    },
    unlinkAdobeBridgePhotoshop: async (pluginInstanceId) => {
      const command = beginAdobeClientCommand(pluginInstanceId, 'unlink');
      try {
        await input.api.adobeBridgeUnlinkPhotoshop(pluginInstanceId);
        completeAdobeClientCommand(command);
      } catch (error) {
        if (!shouldSuppressAdobeClientCommandError(command)) {
          throw error;
        }
      }
    }
  }), [
    beginAdobeClientCommand,
    completeAdobeClientCommand,
    input.api,
    input.getCurrentI18n,
    input.notify,
    reloadAdobeBridge,
    rescanIntegrations,
    saveCanvasTextAppearance,
    shouldSuppressAdobeClientCommandError
  ]);

  const globalSettings = useMemo<WorkbenchState['globalSettings']>(() => ({
    status: 'ready',
    value: canvasTextAppearanceOverlay
      ? globalSettingsWithCanvasTextAppearance(projection.settings, canvasTextAppearanceOverlay)
      : projection.settings
  }), [canvasTextAppearanceOverlay, projection.settings]);
  const integrations = integrationsLoadError
    ? { status: 'error' as const, message: integrationsLoadError }
    : projection.integrations;
  const adobeBridge = adobeBridgeLoadError
    ? { status: 'error' as const, message: adobeBridgeLoadError }
    : projection.adobeBridge;

  return useMemo(() => ({
    globalSettings,
    integrations,
    product: projection.product,
    adobeBridge,
    actions
  }), [actions, adobeBridge, globalSettings, integrations, projection.product]);
}

type InitializedWorkbenchGlobalProjection = Exclude<
  WorkbenchGlobalProjectionState,
  { status: 'uninitialized' }
>;

function initializedGlobalProjection(
  state: WorkbenchGlobalProjectionState
): InitializedWorkbenchGlobalProjection {
  if (state.status === 'uninitialized') {
    throw new Error('Settings feature requires the initial Global snapshot.');
  }
  return state;
}

function globalSettingsWithCanvasTextAppearance(
  settings: DebruteGlobalSettingsView,
  appearance: CanvasTextAppearance
): DebruteGlobalSettingsView {
  return {
    ...settings,
    canvas: { textAppearance: appearance }
  };
}

function localCanvasTextAppearance(
  queue: CanvasTextAppearanceSaveQueue,
  confirmed: CanvasTextAppearance
): CanvasTextAppearance | undefined {
  if (queue.queued) {
    return queue.queued.appearance;
  }
  if (queue.inFlight) {
    return queue.inFlight.confirmed
      && !sameCanvasTextAppearance(queue.inFlight.appearance, confirmed)
      ? undefined
      : queue.inFlight.appearance;
  }
  return queue.awaitingEvent;
}

function sameCanvasTextAppearance(
  left: CanvasTextAppearance,
  right: CanvasTextAppearance
): boolean {
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

function activeAdobeLinkIds(
  bridge: AdobeBridgeStateView | undefined,
  projectId: string | undefined,
  pluginInstanceId: string
): string[] {
  return (bridge?.links ?? [])
    .filter((link) => (
      link.projectId === projectId
      && link.pluginInstanceId === pluginInstanceId
      && link.status === 'active'
    ))
    .map((link) => link.linkId)
    .sort();
}

function adobeClientCommandKey(projectId: string | undefined, pluginInstanceId: string): string {
  return JSON.stringify([projectId, pluginInstanceId]);
}

function adobeClientCommandTargetReached(
  pending: PendingAdobeClientCommand,
  activeLinkIds: readonly string[]
): boolean {
  const initialActiveLinkIds = new Set(pending.activeLinkIds);
  const nextActiveLinkIds = new Set(activeLinkIds);
  return pending.kind === 'link'
    ? activeLinkIds.some((linkId) => !initialActiveLinkIds.has(linkId))
    : pending.activeLinkIds.some((linkId) => !nextActiveLinkIds.has(linkId));
}

function integrationOperationLabelKey(operation: 'install' | 'update' | 'uninstall'): 'settings.integrations.install' | 'settings.integrations.update' | 'settings.integrations.uninstall' {
  if (operation === 'install') return 'settings.integrations.install';
  if (operation === 'update') return 'settings.integrations.update';
  return 'settings.integrations.uninstall';
}
