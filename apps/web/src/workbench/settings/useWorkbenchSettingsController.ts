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
  | 'getProductState'
  | 'checkProductUpdate'
  | 'applyProductUpdate'
  | 'reloadGlobalSettings'
  | 'reloadAdobeBridge'
  | 'saveGlobalSettings'
  | 'rescanIntegrations'
  | 'runIntegrationOperation'
  | 'linkAdobeBridgePhotoshop'
  | 'unlinkAdobeBridgePhotoshop'
>;

export interface WorkbenchSettingsController {
  globalSettings: WorkbenchState['globalSettings'];
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
  adobeClientId: string;
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
  const [adobeBridge, setAdobeBridge] = useState<WorkbenchState['adobeBridge']>({ status: 'loading' });
  const [locale, setLocale] = useState<WorkbenchLocale>(DEFAULT_GLOBAL_WORKBENCH_SETTINGS.locale);
  const [themePreference, setThemePreference] = useState<WorkbenchThemePreference>(DEFAULT_GLOBAL_WORKBENCH_SETTINGS.themePreference);
  const [resolvedTheme, setResolvedTheme] = useState<WorkbenchResolvedTheme>(() => (
    resolveWorkbenchThemePreference(DEFAULT_GLOBAL_WORKBENCH_SETTINGS.themePreference)
  ));
  const globalSettingsLoadVersionRef = useRef(0);
  const adobeBridgeLoadVersionRef = useRef(0);
  const adobeBridgeValueRef = useRef<AdobeBridgeStateView | undefined>(undefined);
  const adobeClientCommandTokenRef = useRef(0);
  const pendingAdobeClientCommandsRef = useRef(new Map<string, PendingAdobeClientCommand>());
  const localeRef = useRef<WorkbenchLocale>(locale);

  const confirmAdobeClientCommands = useCallback((bridge: AdobeBridgeStateView) => {
    for (const pending of pendingAdobeClientCommandsRef.current.values()) {
      if (adobeClientCommandTargetReached(
        pending,
        activeAdobeLinkIds(bridge, pending.projectId, pending.adobeClientId)
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

  const beginAdobeClientCommand = useCallback((adobeClientId: string, kind: 'link' | 'unlink') => {
    const token = adobeClientCommandTokenRef.current + 1;
    adobeClientCommandTokenRef.current = token;
    const command: PendingAdobeClientCommand = {
      token,
      projectId: input.projectId,
      adobeClientId,
      kind,
      activeLinkIds: activeAdobeLinkIds(adobeBridgeValueRef.current, input.projectId, adobeClientId),
      confirmed: false
    };
    pendingAdobeClientCommandsRef.current.set(adobeClientCommandKey(input.projectId, adobeClientId), command);
    return command;
  }, [input.projectId]);

  const completeAdobeClientCommand = useCallback((command: PendingAdobeClientCommand) => {
    const key = adobeClientCommandKey(command.projectId, command.adobeClientId);
    if (pendingAdobeClientCommandsRef.current.get(key)?.token === command.token) {
      pendingAdobeClientCommandsRef.current.delete(key);
    }
  }, []);

  const shouldSuppressAdobeClientCommandError = useCallback((command: PendingAdobeClientCommand) => {
    const key = adobeClientCommandKey(command.projectId, command.adobeClientId);
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
    globalSettingsLoadVersionRef.current += 1;
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

  const reloadGlobalSettings = useCallback(async () => {
    const loadVersion = globalSettingsLoadVersionRef.current + 1;
    globalSettingsLoadVersionRef.current = loadVersion;
    setGlobalSettings({ status: 'loading' });
    try {
      const settings = await input.api.globalSettingsGet();
      if (globalSettingsLoadVersionRef.current !== loadVersion) {
        return;
      }
      setGlobalSettings({ status: 'ready', value: applyGlobalSettingsEffects(settings) });
    } catch (error) {
      if (globalSettingsLoadVersionRef.current !== loadVersion) {
        return;
      }
      setGlobalSettings({ status: 'error', message: errorMessage(error) });
    }
  }, [applyGlobalSettingsEffects, input.api]);

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
    void reloadGlobalSettings();
    void reloadAdobeBridge();
    return () => {
      globalSettingsLoadVersionRef.current += 1;
      adobeBridgeLoadVersionRef.current += 1;
      pendingAdobeClientCommandsRef.current.clear();
      adobeBridgeValueRef.current = undefined;
    };
  }, [reloadAdobeBridge, reloadGlobalSettings]);

  const applyIntegrationSettings = useCallback((
    version: number,
    integrations: DebruteGlobalSettingsView['integrations']
  ) => {
    setGlobalSettings((current) => {
      if (globalSettingsLoadVersionRef.current !== version || current.status !== 'ready') {
        return current;
      }
      return { status: 'ready', value: { ...current.value, integrations } };
    });
  }, []);

  const getCurrentI18n = useCallback(() => createI18n(localeRef.current), []);

  const actions = useMemo<WorkbenchSettingsActions>(() => ({
    getProductState: () => input.api.getProductState(),
    checkProductUpdate: () => input.api.checkProductUpdate(),
    applyProductUpdate: () => input.api.applyProductUpdate(),
    reloadGlobalSettings,
    reloadAdobeBridge,
    saveGlobalSettings: async (saveInput) => {
      const saveVersion = globalSettingsLoadVersionRef.current + 1;
      globalSettingsLoadVersionRef.current = saveVersion;
      const settings = await input.api.globalSettingsSave(saveInput);
      if (globalSettingsLoadVersionRef.current === saveVersion) {
        applyLoadedGlobalSettings(settings);
      }
    },
    rescanIntegrations: async () => {
      const rescanVersion = globalSettingsLoadVersionRef.current + 1;
      globalSettingsLoadVersionRef.current = rescanVersion;
      const settings = await input.api.integrationsRescan();
      applyIntegrationSettings(rescanVersion, settings);
      return settings;
    },
    runIntegrationOperation: async (operationInput) => {
      const operationVersion = globalSettingsLoadVersionRef.current + 1;
      globalSettingsLoadVersionRef.current = operationVersion;
      const result = await input.api.integrationsRunOperation(operationInput);
      applyIntegrationSettings(operationVersion, result.settings);
      if (globalSettingsLoadVersionRef.current === operationVersion && !result.ok) {
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
    linkAdobeBridgePhotoshop: async (linkInput) => {
      const command = beginAdobeClientCommand(linkInput.adobeClientId, 'link');
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
    unlinkAdobeBridgePhotoshop: async (adobeClientId) => {
      const command = beginAdobeClientCommand(adobeClientId, 'unlink');
      const unlinkVersion = adobeBridgeLoadVersionRef.current + 1;
      adobeBridgeLoadVersionRef.current = unlinkVersion;
      try {
        const bridge = await input.api.adobeBridgeUnlinkPhotoshop(adobeClientId);
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
    applyLoadedGlobalSettings,
    applyAdobeBridgeState,
    beginAdobeClientCommand,
    completeAdobeClientCommand,
    getCurrentI18n,
    input.api,
    input.notify,
    reloadAdobeBridge,
    reloadGlobalSettings,
    applyIntegrationSettings,
    shouldSuppressAdobeClientCommandError
  ]);

  const applyEvent = useCallback((event: WorkbenchEvent) => {
    if (event.type === 'globalSettings.changed') {
      applyLoadedGlobalSettings(event.settings);
      return;
    }
    if (event.type === 'adobeBridge.state.changed') {
      adobeBridgeLoadVersionRef.current += 1;
      applyAdobeBridgeState(event.state);
    }
  }, [applyAdobeBridgeState, applyLoadedGlobalSettings]);

  return useMemo(() => ({
    globalSettings,
    adobeBridge,
    locale,
    resolvedTheme,
    actions,
    getCurrentI18n,
    applyEvent
  }), [actions, adobeBridge, applyEvent, getCurrentI18n, globalSettings, locale, resolvedTheme]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeAdobeLinkIds(
  bridge: AdobeBridgeStateView | undefined,
  projectId: string | undefined,
  adobeClientId: string
): string[] {
  return (bridge?.links ?? [])
    .filter((link) => (
      link.projectId === projectId
      && link.adobeClientId === adobeClientId
      && link.status === 'active'
    ))
    .map((link) => link.linkId)
    .sort();
}

function adobeClientCommandKey(projectId: string | undefined, adobeClientId: string): string {
  return JSON.stringify([projectId, adobeClientId]);
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
