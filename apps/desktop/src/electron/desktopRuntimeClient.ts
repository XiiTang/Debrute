import {
  openProjectFromPickerThroughDaemon,
  openProjectThroughDaemon,
  projectWebShellUrl,
  type DebruteDaemonRuntimeLike
} from './daemonProjectOpen.js';

type DesktopRuntimeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface DesktopRuntimeClient {
  readonly mode: 'attached';
  runtime(): DebruteDaemonRuntimeLike;
  shellUrl(projectId?: string): string;
  openProject(projectRoot: string): Promise<{ projectId: string; url: string }>;
  openProjectFromPicker(): Promise<{ opened: false } | { opened: true; projectId: string; url: string }>;
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
    shellUrl: (projectId) => projectWebShellUrl(attachedRuntime, projectId),
    openProject: (projectRoot) => openProjectThroughDaemon(attachedRuntime, projectRoot, fetchImpl),
    openProjectFromPicker: () => openProjectFromPickerThroughDaemon(attachedRuntime, fetchImpl),
    registerElectronProjectWindow: (projectId, windowId) => registerElectronProjectWindow(attachedRuntime, projectId, windowId, fetchImpl),
    close: async () => undefined
  };
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
