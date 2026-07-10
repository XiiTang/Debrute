import {
  openProjectFromPickerThroughDaemon,
  projectWebBrowserLaunchUrl,
  openProjectThroughDaemon,
  projectWebShellNavigation,
  type DebruteDaemonRuntimeLike
} from './daemonProjectOpen.js';
import type { DebruteShellNavigation } from './desktopShellLoad.js';
import type { DebruteGlobalSettingsView, WorkbenchTitleBarState } from '@debrute/app-protocol';

type DesktopRuntimeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface DesktopRuntimeClient {
  readonly mode: 'attached';
  runtime(): DebruteDaemonRuntimeLike;
  shellNavigation(projectId?: string): DebruteShellNavigation;
  browserLaunchUrl(projectId?: string): string;
  openProject(projectRoot: string): Promise<{ projectId: string; navigation: DebruteShellNavigation }>;
  openProjectFromPicker(): Promise<{ opened: false } | { opened: true; projectId: string; navigation: DebruteShellNavigation }>;
  getWorkbenchTitleBarState(projectId?: string): Promise<WorkbenchTitleBarState>;
  globalSettingsGet(): Promise<DebruteGlobalSettingsView>;
  clearRecentProjectRoots(): Promise<{ ok: true }>;
  registerElectronProjectWindow(projectId: string, windowId: number): Promise<{ projectRoot: string; release: () => Promise<void> }>;
  close(): Promise<void>;
}

export function createAttachedDesktopRuntimeClient(
  runtime: DebruteDaemonRuntimeLike,
  fetchImpl: DesktopRuntimeFetch = fetch
): DesktopRuntimeClient {
  const attachedRuntime: DebruteDaemonRuntimeLike = {
    daemonUrl: runtime.daemonUrl,
    webBaseUrl: runtime.webBaseUrl,
    platform: runtime.platform ?? process.platform,
    token: runtime.token
  };
  return {
    mode: 'attached',
    runtime: () => attachedRuntime,
    shellNavigation: (projectId) => projectWebShellNavigation(attachedRuntime, projectId),
    browserLaunchUrl: (projectId) => projectWebBrowserLaunchUrl(attachedRuntime, projectId),
    openProject: (projectRoot) => openProjectThroughDaemon(attachedRuntime, projectRoot, fetchImpl),
    openProjectFromPicker: () => openProjectFromPickerThroughDaemon(attachedRuntime, fetchImpl),
    getWorkbenchTitleBarState: (projectId) => getWorkbenchTitleBarState(attachedRuntime, fetchImpl, projectId),
    globalSettingsGet: () => globalSettingsGet(attachedRuntime, fetchImpl),
    clearRecentProjectRoots: () => clearRecentProjectRoots(attachedRuntime, fetchImpl),
    registerElectronProjectWindow: (projectId, windowId) => registerElectronProjectWindow(attachedRuntime, projectId, windowId, fetchImpl),
    close: async () => undefined
  };
}

async function globalSettingsGet(
  runtime: DebruteDaemonRuntimeLike,
  fetchImpl: DesktopRuntimeFetch
): Promise<DebruteGlobalSettingsView> {
  const response = await fetchImpl(new URL('/api/settings/global', runtime.daemonUrl).toString(), {
    headers: { 'x-debrute-daemon-token': runtime.token }
  });
  if (!response.ok) {
    throw new Error(`Debrute daemon global settings request failed: ${response.status}`);
  }
  return response.json() as Promise<DebruteGlobalSettingsView>;
}

async function getWorkbenchTitleBarState(
  runtime: DebruteDaemonRuntimeLike,
  fetchImpl: DesktopRuntimeFetch,
  projectId?: string
): Promise<WorkbenchTitleBarState> {
  const url = new URL('/api/workbench/title-bar', runtime.daemonUrl);
  url.searchParams.set('host', 'desktop');
  if (projectId) {
    url.searchParams.set('projectId', projectId);
  }
  const response = await fetchImpl(url.toString(), {
    headers: { 'x-debrute-daemon-token': runtime.token }
  });
  if (!response.ok) {
    throw new Error(`Debrute daemon title bar state request failed: ${response.status}`);
  }
  return response.json() as Promise<WorkbenchTitleBarState>;
}

async function clearRecentProjectRoots(
  runtime: DebruteDaemonRuntimeLike,
  fetchImpl: DesktopRuntimeFetch
): Promise<{ ok: true }> {
  const response = await fetchImpl(new URL('/api/workbench/recent-projects', runtime.daemonUrl).toString(), {
    method: 'DELETE',
    headers: { 'x-debrute-daemon-token': runtime.token }
  });
  if (!response.ok) {
    throw new Error(`Debrute daemon recent project clear failed: ${response.status}`);
  }
  return response.json() as Promise<{ ok: true }>;
}

async function registerElectronProjectWindow(
  runtime: DebruteDaemonRuntimeLike,
  projectId: string,
  windowId: number,
  fetchImpl: DesktopRuntimeFetch
): Promise<{ projectRoot: string; release: () => Promise<void> }> {
  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/electron-windows/${encodeURIComponent(String(windowId))}`, runtime.daemonUrl).toString();
  const headers = { 'x-debrute-daemon-token': runtime.token };
  const registered = await requestElectronWindowLease(fetchImpl, url, 'PUT', headers);
  let released = false;
  return {
    projectRoot: registered.projectRoot,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await requestElectronWindowLease(fetchImpl, url, 'DELETE', headers);
    }
  };
}

async function requestElectronWindowLease(
  fetchImpl: DesktopRuntimeFetch,
  url: string,
  method: 'PUT' | 'DELETE',
  headers: Record<string, string>
): Promise<{ projectRoot: string }> {
  const response = await fetchImpl(url, { method, headers });
  if (!response.ok) {
    throw new Error(`Debrute daemon Electron window lease failed: ${method} ${response.status}`);
  }
  if (method === 'DELETE') {
    return { projectRoot: '' };
  }
  return response.json() as Promise<{ projectRoot: string }>;
}
