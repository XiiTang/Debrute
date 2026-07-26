import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHttpWorkbenchApiClient } from './api/httpWorkbenchApiClient.js';
import {
  resolveWorkbenchThemePreference,
  setDocumentTheme
} from './workbench/services/workbenchTheme.js';
import './styles.css';

declare global {
  interface Window {
    __debruteReactRoot?: Root;
  }
}

setDocumentTheme(resolveWorkbenchThemePreference('system'));

const api = createHttpWorkbenchApiClient();

void api.bootstrapGlobalSettings().then(async ({ settings }) => {
  setDocumentTheme(resolveWorkbenchThemePreference(settings.workbench.themePreference));
  document.documentElement.removeAttribute('data-settings-bootstrap');
  const { WorkbenchApp } = await import('./workbench/WorkbenchApp.js');
  window.__debruteReactRoot ??= createRoot(document.getElementById('root')!);
  window.__debruteReactRoot.render(
    <React.StrictMode>
      <WorkbenchApp api={api} initialGlobalSettings={settings} />
    </React.StrictMode>
  );
}).catch((error: unknown) => {
  document.documentElement.removeAttribute('data-settings-bootstrap');
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
