import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GLOBAL_WORKBENCH_SETTINGS,
  resolveWorkbenchThemePreference,
  setDocumentTheme,
  subscribeSystemThemeChanges
} from './workbenchTheme';

describe('Workbench theme helpers', () => {
  it('defines the current default global Workbench settings', () => {
    expect(DEFAULT_GLOBAL_WORKBENCH_SETTINGS).toEqual({
      locale: 'en',
      themePreference: 'system',
      defaultFrontend: 'electron'
    });
  });

  it('resolves explicit preferences without consulting system state', () => {
    expect(resolveWorkbenchThemePreference('dark', false)).toBe('dark');
    expect(resolveWorkbenchThemePreference('light', true)).toBe('light');
  });

  it('resolves system preference from the media query state', () => {
    expect(resolveWorkbenchThemePreference('system', true)).toBe('dark');
    expect(resolveWorkbenchThemePreference('system', false)).toBe('light');
  });

  it('writes the resolved theme to the document element', () => {
    const attributes = new Map<string, string>();
    const element = {
      dataset: {} as Record<string, string>,
      setAttribute(name: string, value: string) {
        attributes.set(name, value);
        if (name === 'data-theme') {
          this.dataset.theme = value;
        }
      }
    };
    const doc = { documentElement: element } as Document;

    setDocumentTheme('light', doc);

    expect(element.dataset.theme).toBe('light');
    expect(attributes.get('data-theme')).toBe('light');
  });

  it('subscribes to system color-scheme changes', () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const query = {
      matches: false,
      addEventListener: vi.fn((_type: 'change', listener: (event: MediaQueryListEvent) => void) => {
        listeners.push(listener);
      }),
      removeEventListener: vi.fn()
    } as unknown as MediaQueryList;
    const win = {
      matchMedia: vi.fn(() => query)
    } as unknown as Window;
    const themes: string[] = [];

    const unsubscribe = subscribeSystemThemeChanges((theme) => themes.push(theme), win);
    listeners[0]!({ matches: true } as MediaQueryListEvent);
    unsubscribe();

    expect(win.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(themes).toEqual(['dark']);
    expect(query.removeEventListener).toHaveBeenCalledWith('change', listeners[0]);
  });
});
