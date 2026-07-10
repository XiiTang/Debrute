import type { DebruteGlobalSettingsView } from '@debrute/app-protocol';

export const WORKBENCH_DARK_BACKGROUND = '#181818';
export const WORKBENCH_LIGHT_BACKGROUND = '#f4f5f7';

export interface WorkbenchStartupBackgroundRuntime {
  globalSettingsGet(): Promise<DebruteGlobalSettingsView>;
}

export interface WorkbenchNativeThemeState {
  shouldUseDarkColors: boolean;
}

export function workbenchStartupBackgroundColor(input: {
  workbench: DebruteGlobalSettingsView['workbench'];
  nativeTheme: WorkbenchNativeThemeState;
}): string {
  if (input.workbench.themePreference === 'dark') {
    return WORKBENCH_DARK_BACKGROUND;
  }
  if (input.workbench.themePreference === 'light') {
    return WORKBENCH_LIGHT_BACKGROUND;
  }
  return input.nativeTheme.shouldUseDarkColors ? WORKBENCH_DARK_BACKGROUND : WORKBENCH_LIGHT_BACKGROUND;
}

export async function workbenchStartupBackgroundColorForRuntime(
  runtime: WorkbenchStartupBackgroundRuntime,
  nativeTheme: WorkbenchNativeThemeState
): Promise<string> {
  const settings = await runtime.globalSettingsGet();
  return workbenchStartupBackgroundColor({
    workbench: settings.workbench,
    nativeTheme
  });
}
