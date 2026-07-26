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
  WorkbenchApiClient
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import type { WorkbenchI18n } from '../i18n';
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
  integrations: WorkbenchState['integrations'];
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
  const initialProjection = initializedGlobalProjection(projectionState);
  const initialSettings = initialProjection.settings;
  const [globalSettings, setGlobalSettings] = useState<WorkbenchState['globalSettings']>({
    status: 'ready',
    value: initialSettings
  });
  const [integrations, setIntegrations] = useState<WorkbenchState['integrations']>(
    initialProjection.integrations
  );
  const [product, setProduct] = useState<WorkbenchState['product']>(initialProjection.product);
  const [adobeBridge, setAdobeBridge] = useState<WorkbenchState['adobeBridge']>(() => (
    settingsAdobeBridgeResource(initialProjection.adobeBridge)
  ));
  const adobeBridgeLoadVersionRef = useRef(0);
  const adobeBridgeValueRef = useRef<AdobeBridgeStateView | undefined>(
    initialProjection.adobeBridge.status === 'ready'
      ? initialProjection.adobeBridge.value
      : undefined
  );
  const adobeClientCommandTokenRef = useRef(0);
  const pendingAdobeClientCommandsRef = useRef(new Map<string, PendingAdobeClientCommand>());
  const confirmedGlobalSettingsRef = useRef<DebruteGlobalSettingsView | undefined>(
    initialSettings
  );
  const canvasTextAppearanceSaveQueueRef = useRef<CanvasTextAppearanceSaveQueue>({
    running: false
  });
  const observedSettingsRef = useRef(initialProjection.settings);
  const observedIntegrationsRef = useRef(initialProjection.integrations);
  const observedProductRef = useRef(initialProjection.product);
  const observedAdobeBridgeRef = useRef(initialProjection.adobeBridge);
  const optionalResourcesRequestedRef = useRef(false);

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

  const applyAdobeBridgeState = useCallback((bridge: AdobeBridgeStateView) => {
    confirmAdobeClientCommands(bridge);
    adobeBridgeValueRef.current = bridge;
    setAdobeBridge({ status: 'ready', value: bridge });
  }, [confirmAdobeClientCommands]);

  const beginAdobeClientCommand = useCallback((pluginInstanceId: string, kind: 'link' | 'unlink') => {
    const token = adobeClientCommandTokenRef.current + 1;
    adobeClientCommandTokenRef.current = token;
    const command: PendingAdobeClientCommand = {
      token,
      projectId: input.projectId,
      pluginInstanceId,
      kind,
      activeLinkIds: activeAdobeLinkIds(adobeBridgeValueRef.current, input.projectId, pluginInstanceId),
      confirmed: false
    };
    pendingAdobeClientCommandsRef.current.set(adobeClientCommandKey(input.projectId, pluginInstanceId), command);
    return command;
  }, [input.projectId]);

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

  const applyLoadedGlobalSettings = useCallback((settings: DebruteGlobalSettingsView) => {
    confirmedGlobalSettingsRef.current = settings;
    const queue = canvasTextAppearanceSaveQueueRef.current;
    delete queue.awaitingEvent;
    if (queue.inFlight && sameCanvasTextAppearance(
      queue.inFlight.appearance,
      settings.canvas.textAppearance
    )) {
      queue.inFlight.confirmed = true;
    }
    const localAppearance = localCanvasTextAppearance(queue, settings.canvas.textAppearance);
    const effectiveSettings = localAppearance
      ? globalSettingsWithCanvasTextAppearance(settings, localAppearance)
      : settings;
    setGlobalSettings({ status: 'ready', value: effectiveSettings });
  }, []);

  useEffect(() => {
    const projection = initializedGlobalProjection(projectionState);
    if (projection.settings !== observedSettingsRef.current) {
      observedSettingsRef.current = projection.settings;
      applyLoadedGlobalSettings(projection.settings);
    }
    if (projection.integrations !== observedIntegrationsRef.current) {
      observedIntegrationsRef.current = projection.integrations;
      setIntegrations(projection.integrations);
    }
    if (projection.product !== observedProductRef.current) {
      observedProductRef.current = projection.product;
      setProduct(projection.product);
    }
    if (projection.adobeBridge === observedAdobeBridgeRef.current) {
      return;
    }
    observedAdobeBridgeRef.current = projection.adobeBridge;
    adobeBridgeLoadVersionRef.current += 1;
    if (projection.adobeBridge.status === 'ready') {
      applyAdobeBridgeState(projection.adobeBridge.value);
      return;
    }
    adobeBridgeValueRef.current = undefined;
    setAdobeBridge(settingsAdobeBridgeResource(projection.adobeBridge));
  }, [applyAdobeBridgeState, applyLoadedGlobalSettings, projectionState]);

  const saveCanvasTextAppearance = useCallback((appearance: CanvasTextAppearance): Promise<void> => {
    const queue = canvasTextAppearanceSaveQueueRef.current;
    setGlobalSettings((current) => current.status === 'ready'
      ? {
          status: 'ready',
          value: globalSettingsWithCanvasTextAppearance(current.value, appearance)
        }
      : current);
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
          const confirmed = confirmedGlobalSettingsRef.current;
          if (confirmed) {
            applyLoadedGlobalSettings(confirmed);
          }
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
        const confirmed = confirmedGlobalSettingsRef.current;
        if (confirmed) {
          applyLoadedGlobalSettings(confirmed);
        }
      }
    })();
    return pending;
  }, [applyLoadedGlobalSettings, input.api]);

  const loadAdobeBridge = useCallback(async (load: () => Promise<unknown>) => {
    const loadVersion = adobeBridgeLoadVersionRef.current + 1;
    adobeBridgeLoadVersionRef.current = loadVersion;
    pendingAdobeClientCommandsRef.current.clear();
    adobeBridgeValueRef.current = undefined;
    setAdobeBridge({ status: 'loading' });
    try {
      await load();
    } catch (error) {
      if (adobeBridgeLoadVersionRef.current === loadVersion) {
        setAdobeBridge({ status: 'error', message: errorMessage(error) });
      }
    }
  }, []);
  const reloadAdobeBridge = useCallback(
    () => loadAdobeBridge(input.api.adobeBridgeRefreshState),
    [input.api.adobeBridgeRefreshState, loadAdobeBridge]
  );

  useEffect(() => {
    if (optionalResourcesRequestedRef.current) {
      return;
    }
    optionalResourcesRequestedRef.current = true;
    if (initialProjection.integrations.status === 'loading') {
      void input.api.integrationsRescan().catch(() => undefined);
    }
    if (initialProjection.adobeBridge.status === 'loading') {
      void loadAdobeBridge(input.ensureAdobeBridgeState);
    }
  }, [
    initialProjection.adobeBridge.status,
    initialProjection.integrations.status,
    input.api,
    input.ensureAdobeBridgeState,
    loadAdobeBridge
  ]);

  useEffect(() => () => {
    adobeBridgeLoadVersionRef.current += 1;
    pendingAdobeClientCommandsRef.current.clear();
    adobeBridgeValueRef.current = undefined;
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
    rescanIntegrations: async () => {
      await input.api.integrationsRescan();
    },
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
    applyAdobeBridgeState,
    beginAdobeClientCommand,
    completeAdobeClientCommand,
    input.api,
    input.getCurrentI18n,
    input.notify,
    reloadAdobeBridge,
    saveCanvasTextAppearance,
    shouldSuppressAdobeClientCommandError
  ]);

  return useMemo(() => ({
    globalSettings,
    integrations,
    product,
    adobeBridge,
    actions
  }), [actions, adobeBridge, globalSettings, integrations, product]);
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

function settingsAdobeBridgeResource(
  resource: InitializedWorkbenchGlobalProjection['adobeBridge']
): WorkbenchState['adobeBridge'] {
  return resource;
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
