import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DebruteGlobalSettingsView, WorkbenchLocale } from '@debrute/app-protocol';
import { createI18n, type WorkbenchI18n } from '../i18n/index';
import {
  resolveWorkbenchThemePreference,
  setDocumentTheme,
  subscribeSystemThemeChanges,
  type WorkbenchResolvedTheme
} from './workbenchTheme';

export interface WorkbenchPresentationController {
  settings: DebruteGlobalSettingsView;
  locale: WorkbenchLocale;
  resolvedTheme: WorkbenchResolvedTheme;
  getCurrentI18n(): WorkbenchI18n;
}

export function useWorkbenchPresentationController(input: {
  settings: DebruteGlobalSettingsView;
}): WorkbenchPresentationController {
  const settings = input.settings;
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
