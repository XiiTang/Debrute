import type {
  WorkbenchPreferencesView,
  WorkbenchThemePreference
} from '@debrute/app-protocol';

export type WorkbenchResolvedTheme = 'dark' | 'light';

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferencesView = {
  locale: 'en',
  themePreference: 'system'
};

export function parseWorkbenchThemePreference(value: unknown): WorkbenchThemePreference {
  if (value === 'system' || value === 'dark' || value === 'light') {
    return value;
  }
  throw new Error('Workbench theme preference must be "system", "dark", or "light".');
}

export function resolveWorkbenchThemePreference(
  preference: WorkbenchThemePreference,
  systemPrefersDark = systemPrefersDarkColorScheme()
): WorkbenchResolvedTheme {
  if (preference === 'dark' || preference === 'light') {
    return preference;
  }
  return systemPrefersDark ? 'dark' : 'light';
}

export function systemPrefersDarkColorScheme(win: Window | undefined = globalThis.window): boolean {
  return Boolean(win?.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

export function subscribeSystemThemeChanges(
  listener: (theme: WorkbenchResolvedTheme) => void,
  win: Window | undefined = globalThis.window
): () => void {
  const query = win?.matchMedia?.('(prefers-color-scheme: dark)');
  if (!query) {
    return () => undefined;
  }
  const handleChange = (event: MediaQueryListEvent) => {
    listener(event.matches ? 'dark' : 'light');
  };
  query.addEventListener('change', handleChange);
  return () => query.removeEventListener('change', handleChange);
}

export function setDocumentTheme(
  theme: WorkbenchResolvedTheme,
  doc: Document | undefined = globalThis.document
): void {
  doc?.documentElement.setAttribute('data-theme', theme);
}
