import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHttpWorkbenchApiClient } from './api/httpWorkbenchApiClient.js';
import {
  resolveWorkbenchThemePreference,
  setDocumentTheme
} from './workbench/services/workbenchTheme.js';
import './styles.css';
import { workbenchStartupTimeline } from './startup/workbenchStartupTimeline.js';
import { holdWorkbenchThemeUntilCommit } from './startup/workbenchBootstrapTheme.js';
import { waitForWorkbenchShellFonts } from './startup/workbenchShellFonts.js';

declare global {
  interface Window {
    __debruteReactRoot?: Root;
  }
}

workbenchStartupTimeline.mark('main-evaluated');
setDocumentTheme(resolveWorkbenchThemePreference('system'));

const api = createHttpWorkbenchApiClient();
let completeThemeHandoff: (() => void) | undefined;

void api.bootstrapGlobalSettings().then(async ({ settings }) => {
  workbenchStartupTimeline.mark('global-snapshot-ready');
  setDocumentTheme(resolveWorkbenchThemePreference(settings.workbench.themePreference));
  workbenchStartupTimeline.mark('theme-ready');
  completeThemeHandoff = holdWorkbenchThemeUntilCommit({
    projection: api.globalProjection,
    apply: setDocumentTheme,
    reveal: () => document.documentElement.removeAttribute('data-settings-bootstrap')
  });
  await waitForWorkbenchShellFonts(document.fonts);
  workbenchStartupTimeline.mark('shell-fonts-ready');
  const { WorkbenchApp } = await import('./workbench/WorkbenchApp.js');
  workbenchStartupTimeline.mark('workbench-chunk-ready');
  window.__debruteReactRoot ??= createRoot(document.getElementById('root')!);
  window.__debruteReactRoot.render(
    <React.StrictMode>
      <WorkbenchApp api={api} onCommitted={completeThemeHandoff} />
    </React.StrictMode>
  );
}).catch((error: unknown) => {
  api.dispose();
  if (completeThemeHandoff) {
    completeThemeHandoff();
  } else {
    document.documentElement.removeAttribute('data-settings-bootstrap');
  }
  const root = document.getElementById('root');
  if (root) {
    const main = document.createElement('main');
    main.className = 'boot-screen';
    main.setAttribute('role', 'alert');
    const title = document.createElement('strong');
    title.textContent = 'Debrute Workbench could not start.';
    const message = document.createElement('span');
    message.textContent = error instanceof Error ? error.message : String(error);
    main.append(title, message);
    root.replaceChildren(main);
  }
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => api.dispose());
}
