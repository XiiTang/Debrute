import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import type { DebruteGlobalSettingsView, WorkbenchLocale } from '@debrute/app-protocol';
import { createI18n, type WorkbenchI18n } from '../i18n/index.js';
import type { WorkbenchGlobalProjection } from './WorkbenchGlobalProjection.js';
import {
  resolveWorkbenchThemePreference,
  setDocumentTheme,
  subscribeSystemThemeChanges,
  type WorkbenchResolvedTheme
} from './workbenchTheme.js';

export interface WorkbenchPresentationController {
  settings: DebruteGlobalSettingsView;
  locale: WorkbenchLocale;
  resolvedTheme: WorkbenchResolvedTheme;
  getCurrentI18n(): WorkbenchI18n;
}

export function useWorkbenchPresentationController(input: {
  globalProjection: WorkbenchGlobalProjection;
}): WorkbenchPresentationController {
  const projection = useSyncExternalStore(
    input.globalProjection.subscribe,
    input.globalProjection.getState
  );
  if (projection.status === 'uninitialized') {
    throw new Error('Workbench presentation requires the initial Global snapshot.');
  }
  const settings = projection.settings;
  const localeRef = useRef(settings.workbench.locale);
  localeRef.current = settings.workbench.locale;
  const [systemTheme, setSystemTheme] = useState<WorkbenchResolvedTheme>(() => (
    resolveWorkbenchThemePreference('system')
  ));
  const resolvedTheme = settings.workbench.themePreference === 'system'
    ? systemTheme
    : settings.workbench.themePreference;

  useEffect(() => subscribeSystemThemeChanges(setSystemTheme), []);

  useLayoutEffect(() => {
    setDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  const getCurrentI18n = useCallback(() => createI18n(localeRef.current), []);

  return {
    settings,
    locale: settings.workbench.locale,
    resolvedTheme,
    getCurrentI18n
  };
}
