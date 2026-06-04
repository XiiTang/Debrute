import type { AxisDaemonHttpServer, AxisDaemonRuntime } from '@axis/daemon';
import { openProjectThroughDaemon, projectWebShellUrl, type AxisDaemonRuntimeLike } from './daemonProjectOpen.js';

type DesktopRuntimeFetch = (url: string, init?: RequestInit) => Promise<Response>;

const releaseWindow = () => undefined;

export interface DesktopRuntimeClient {
  readonly mode: 'hosted' | 'attached';
  runtime(): AxisDaemonRuntime;
  shellUrl(projectId?: string): string;
  openProject(projectRoot: string): Promise<{ projectId: string; url: string }>;
  resolveProjectPath(projectId: string, projectRelativePath: string, kind: 'file' | 'directory'): Promise<string>;
  registerElectronProjectWindow(projectId: string, windowId: number): () => void;
  close(): Promise<void>;
}

export function createAttachedDesktopRuntimeClient(
  runtime: AxisDaemonRuntimeLike,
  fetchImpl: DesktopRuntimeFetch = fetch
): DesktopRuntimeClient {
  const daemonRuntime: AxisDaemonRuntime = {
    daemonUrl: runtime.daemonUrl,
    webBaseUrl: runtime.webBaseUrl,
    token: runtime.token
  };
  return {
    mode: 'attached',
    runtime: () => daemonRuntime,
    shellUrl: (projectId) => projectWebShellUrl(daemonRuntime, projectId),
    openProject: (projectRoot) => openProjectThroughDaemon(daemonRuntime, projectRoot, fetchImpl),
    resolveProjectPath: (projectId, projectRelativePath, kind) => resolveProjectPathThroughDaemon(daemonRuntime, projectId, projectRelativePath, kind, fetchImpl),
    registerElectronProjectWindow: () => releaseWindow,
    close: async () => undefined
  };
}

export function createHostedDesktopRuntimeClient(daemon: AxisDaemonHttpServer): DesktopRuntimeClient {
  const requireRuntime = () => {
    const runtime = daemon.runtime();
    if (!runtime) {
      throw new Error('AXIS daemon runtime is not ready.');
    }
    return runtime;
  };
  return {
    mode: 'hosted',
    runtime: requireRuntime,
    shellUrl: (projectId) => projectWebShellUrl(requireRuntime(), projectId),
    openProject: (projectRoot) => openProjectThroughDaemon(requireRuntime(), projectRoot),
    resolveProjectPath: (projectId, projectRelativePath, kind) => resolveProjectPathThroughDaemon(requireRuntime(), projectId, projectRelativePath, kind),
    registerElectronProjectWindow: (projectId, windowId) => daemon.registerElectronProjectWindow(projectId, windowId) ?? releaseWindow,
    close: () => daemon.close()
  };
}

async function resolveProjectPathThroughDaemon(
  runtime: AxisDaemonRuntime,
  projectId: string,
  projectRelativePath: string,
  kind: 'file' | 'directory',
  fetchImpl: DesktopRuntimeFetch = fetch
): Promise<string> {
  const response = await fetchImpl(new URL(`/api/projects/${encodeURIComponent(projectId)}/desktop/resolve-path`, runtime.daemonUrl).toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-axis-daemon-token': runtime.token
    },
    body: JSON.stringify({ projectRelativePath, kind })
  });
  if (!response.ok) {
    throw new Error(`AXIS daemon project path resolution failed: ${response.status}`);
  }
  const parsed = await response.json() as { absolutePath?: unknown };
  if (typeof parsed.absolutePath !== 'string') {
    throw new Error('AXIS daemon project path response did not include absolutePath.');
  }
  return parsed.absolutePath;
}
