import type { WorkbenchGlobalProjection } from '../workbench/services/WorkbenchGlobalProjection';
import {
  resolveWorkbenchThemePreference,
  type WorkbenchResolvedTheme
} from '../workbench/services/workbenchTheme';

export function holdWorkbenchThemeUntilCommit(input: {
  projection: WorkbenchGlobalProjection;
  apply(theme: WorkbenchResolvedTheme): void;
  reveal(): void;
}): () => void {
  let completed = false;
  const applyCurrent = (): void => {
    const state = input.projection.getState();
    if (state.status !== 'uninitialized') {
      input.apply(resolveWorkbenchThemePreference(state.settings.workbench.themePreference));
    }
  };
  const unsubscribe = input.projection.subscribe(applyCurrent);
  applyCurrent();
  return () => {
    if (completed) {
      return;
    }
    completed = true;
    applyCurrent();
    unsubscribe();
    input.reveal();
  };
}
