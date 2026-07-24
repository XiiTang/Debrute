import type {
  DebruteGlobalSettingsView,
  WorkbenchThemePreference
} from '@debrute/app-protocol';

export type WorkbenchResolvedTheme = 'dark' | 'light';

export const DEFAULT_GLOBAL_WORKBENCH_SETTINGS: DebruteGlobalSettingsView['workbench'] = {
  locale: 'en',
  themePreference: 'system',
  defaultFrontend: 'desktop'
};

export function resolveWorkbenchThemePreference(
  preference: WorkbenchThemePreference,
  systemPrefersDark = systemPrefersDarkColorScheme()
): WorkbenchResolvedTheme {
  if (preference === 'dark' || preference === 'light') {
    return preference;
  }
  return systemPrefersDark ? 'dark' : 'light';
}

export function systemPrefersDarkColorScheme(win: Window = window): boolean {
  return win.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function subscribeSystemThemeChanges(
  listener: (theme: WorkbenchResolvedTheme) => void,
  win: Window = window
): () => void {
  const query = win.matchMedia('(prefers-color-scheme: dark)');
  const handleChange = (event: MediaQueryListEvent) => {
    listener(event.matches ? 'dark' : 'light');
  };
  query.addEventListener('change', handleChange);
  return () => query.removeEventListener('change', handleChange);
}

export function setDocumentTheme(
  theme: WorkbenchResolvedTheme,
  doc: Document = document
): void {
  doc.documentElement.setAttribute('data-theme', theme);
}
