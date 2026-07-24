import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AdobeBridgeStateView,
  DebruteGlobalSettingsView,
  WorkbenchApiClient,
  WorkbenchEvent,
  WorkbenchLocale,
  WorkbenchThemePreference
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { createI18n, type WorkbenchI18n } from '../i18n';
import {
  DEFAULT_GLOBAL_WORKBENCH_SETTINGS,
  resolveWorkbenchThemePreference,
  setDocumentTheme,
  subscribeSystemThemeChanges,
  type WorkbenchResolvedTheme
} from '../services/workbenchTheme';

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
  product: WorkbenchState['product'];
  adobeBridge: WorkbenchState['adobeBridge'];
  locale: WorkbenchLocale;
  resolvedTheme: WorkbenchResolvedTheme;
  actions: WorkbenchSettingsActions;
  getCurrentI18n(): WorkbenchI18n;
  applyEvent(event: WorkbenchEvent): void;
}

interface PendingAdobeClientCommand {
  token: number;
  projectId: string | undefined;
  pluginInstanceId: string;
  kind: 'link' | 'unlink';
  activeLinkIds: readonly string[];
  confirmed: boolean;
}

export function useWorkbenchSettingsController(input: {
  api: WorkbenchApiClient;
  projectId: string | undefined;
  notify(message: string): void;
}): WorkbenchSettingsController {
  const [globalSettings, setGlobalSettings] = useState<WorkbenchState['globalSettings']>({ status: 'loading' });
  const [product, setProduct] = useState<WorkbenchState['product']>({ status: 'loading' });
  const [adobeBridge, setAdobeBridge] = useState<WorkbenchState['adobeBridge']>({ status: 'loading' });
  const [locale, setLocale] = useState<WorkbenchLocale>(DEFAULT_GLOBAL_WORKBENCH_SETTINGS.locale);
  const [themePreference, setThemePreference] = useState<WorkbenchThemePreference>(DEFAULT_GLOBAL_WORKBENCH_SETTINGS.themePreference);
  const [resolvedTheme, setResolvedTheme] = useState<WorkbenchResolvedTheme>(() => (
    resolveWorkbenchThemePreference(DEFAULT_GLOBAL_WORKBENCH_SETTINGS.themePreference)
  ));
  const adobeBridgeLoadVersionRef = useRef(0);
  const adobeBridgeValueRef = useRef<AdobeBridgeStateView | undefined>(undefined);
  const adobeClientCommandTokenRef = useRef(0);
  const pendingAdobeClientCommandsRef = useRef(new Map<string, PendingAdobeClientCommand>());
  const localeRef = useRef<WorkbenchLocale>(locale);

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

  const applyGlobalSettingsEffects = useCallback((settings: DebruteGlobalSettingsView): DebruteGlobalSettingsView => {
    localeRef.current = settings.workbench.locale;
    setLocale(settings.workbench.locale);
    setThemePreference(settings.workbench.themePreference);
    return settings;
  }, []);

  const applyLoadedGlobalSettings = useCallback((settings: DebruteGlobalSettingsView) => {
    setGlobalSettings({ status: 'ready', value: applyGlobalSettingsEffects(settings) });
  }, [applyGlobalSettingsEffects]);

  useEffect(() => {
    setResolvedTheme(resolveWorkbenchThemePreference(themePreference));
    if (themePreference !== 'system') return;
    return subscribeSystemThemeChanges(setResolvedTheme);
  }, [themePreference]);

  useLayoutEffect(() => {
    setDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  const reloadAdobeBridge = useCallback(async () => {
    const loadVersion = adobeBridgeLoadVersionRef.current + 1;
    adobeBridgeLoadVersionRef.current = loadVersion;
    pendingAdobeClientCommandsRef.current.clear();
    adobeBridgeValueRef.current = undefined;
    setAdobeBridge({ status: 'loading' });
    try {
      const bridge = await input.api.adobeBridgeGetState();
      if (adobeBridgeLoadVersionRef.current === loadVersion) {
        applyAdobeBridgeState(bridge);
      }
    } catch (error) {
      if (adobeBridgeLoadVersionRef.current === loadVersion) {
        setAdobeBridge({ status: 'error', message: errorMessage(error) });
      }
    }
  }, [applyAdobeBridgeState, input.api]);

  useEffect(() => {
    void reloadAdobeBridge();
    return () => {
      adobeBridgeLoadVersionRef.current += 1;
      pendingAdobeClientCommandsRef.current.clear();
      adobeBridgeValueRef.current = undefined;
    };
  }, [reloadAdobeBridge]);

  const getCurrentI18n = useCallback(() => createI18n(localeRef.current), []);

  const actions = useMemo<WorkbenchSettingsActions>(() => ({
    checkProductUpdate: async () => { await input.api.checkProductUpdate(); },
    applyProductUpdate: async () => { await input.api.applyProductUpdate(); },
    reloadAdobeBridge,
    saveGlobalSettings: async (saveInput) => {
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
        const currentI18n = getCurrentI18n();
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
      const bridge = await input.api.adobeBridgeRemovePairing(pluginInstanceId);
      applyAdobeBridgeState(bridge);
    },
    linkAdobeBridgePhotoshop: async (linkInput) => {
      const command = beginAdobeClientCommand(linkInput.pluginInstanceId, 'link');
      const linkVersion = adobeBridgeLoadVersionRef.current + 1;
      adobeBridgeLoadVersionRef.current = linkVersion;
      try {
        const bridge = await input.api.adobeBridgeLinkPhotoshop(linkInput);
        if (adobeBridgeLoadVersionRef.current === linkVersion) {
          applyAdobeBridgeState(bridge);
        }
        completeAdobeClientCommand(command);
      } catch (error) {
        if (!shouldSuppressAdobeClientCommandError(command)) {
          throw error;
        }
      }
    },
    unlinkAdobeBridgePhotoshop: async (pluginInstanceId) => {
      const command = beginAdobeClientCommand(pluginInstanceId, 'unlink');
      const unlinkVersion = adobeBridgeLoadVersionRef.current + 1;
      adobeBridgeLoadVersionRef.current = unlinkVersion;
      try {
        const bridge = await input.api.adobeBridgeUnlinkPhotoshop(pluginInstanceId);
        if (adobeBridgeLoadVersionRef.current === unlinkVersion) {
          applyAdobeBridgeState(bridge);
        }
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
    getCurrentI18n,
    input.api,
    input.notify,
    reloadAdobeBridge,
    shouldSuppressAdobeClientCommandError
  ]);

  const applyEvent = useCallback((event: WorkbenchEvent) => {
    if (event.type === 'globalSettings.changed') {
      applyLoadedGlobalSettings(event.settings);
      return;
    }
    if (event.type === 'integrations.changed') {
      setGlobalSettings((current) => current.status === 'ready'
        ? { status: 'ready', value: { ...current.value, integrations: event.integrations } }
        : current);
      return;
    }
    if (event.type === 'recentProjects.changed') {
      setGlobalSettings((current) => current.status === 'ready'
        ? {
            status: 'ready',
            value: {
              ...current.value,
              chrome: { ...current.value.chrome, recentProjects: event.recentProjects }
            }
          }
        : current);
      return;
    }
    if (event.type === 'product.changed') {
      setProduct({ status: 'ready', value: event.product });
      return;
    }
    if (event.type === 'adobeBridge.state.changed') {
      adobeBridgeLoadVersionRef.current += 1;
      applyAdobeBridgeState(event.state);
    }
  }, [applyAdobeBridgeState, applyLoadedGlobalSettings]);

  return useMemo(() => ({
    globalSettings,
    product,
    adobeBridge,
    locale,
    resolvedTheme,
    actions,
    getCurrentI18n,
    applyEvent
  }), [actions, adobeBridge, applyEvent, getCurrentI18n, globalSettings, locale, product, resolvedTheme]);
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
