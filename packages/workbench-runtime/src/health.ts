import { normalizeLoopbackHttpUrl } from './ports.js';
import type { WorkbenchRuntimeState } from './state.js';

type RuntimeHealthFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type WorkbenchRuntimeHealthStatus = 'healthy' | 'daemon-unavailable' | 'daemon-mismatch' | 'web-unavailable';

export interface WorkbenchRuntimeHealthServices {
  fetch?: RuntimeHealthFetch;
}

export async function isWorkbenchRuntimeHealthy(
  state: WorkbenchRuntimeState,
  services: WorkbenchRuntimeHealthServices = {}
): Promise<boolean> {
  return await checkWorkbenchRuntimeHealth(state, services) === 'healthy';
}

export async function checkWorkbenchRuntimeHealth(
  state: WorkbenchRuntimeState,
  services: WorkbenchRuntimeHealthServices = {}
): Promise<WorkbenchRuntimeHealthStatus> {
  const fetchImpl = services.fetch ?? fetch;
  let daemon: Response;
  try {
    daemon = await fetchImpl(new URL('/api/runtime', state.daemonUrl).toString(), {
      method: 'POST',
      headers: {
        'x-axis-daemon-token': state.token
      },
      signal: AbortSignal.timeout(1500)
    });
  } catch {
    return 'daemon-unavailable';
  }
  if (daemon.status === 401 || daemon.status === 403) {
    return 'daemon-mismatch';
  }
  if (!daemon.ok) {
    return 'daemon-unavailable';
  }

  let runtimeInfo: unknown;
  try {
    runtimeInfo = await daemon.json();
  } catch {
    return 'daemon-mismatch';
  }
  if (!runtimeMatchesState(runtimeInfo, state)) {
    return 'daemon-mismatch';
  }

  try {
    const web = await fetchImpl(state.webUrl, {
      signal: AbortSignal.timeout(1500)
    });
    return web.ok ? 'healthy' : 'web-unavailable';
  } catch {
    return 'web-unavailable';
  }
}

function runtimeMatchesState(value: unknown, state: WorkbenchRuntimeState): boolean {
  if (!isRecord(value) || typeof value.daemonUrl !== 'string') {
    return false;
  }
  const daemonUrl = normalizeLoopbackHttpUrl(value.daemonUrl);
  const stateDaemonUrl = normalizeLoopbackHttpUrl(state.daemonUrl);
  if (!daemonUrl || !stateDaemonUrl || daemonUrl !== stateDaemonUrl) {
    return false;
  }
  if (typeof value.webBaseUrl !== 'string') {
    return false;
  }
  const normalizedWebBaseUrl = normalizeLoopbackHttpUrl(value.webBaseUrl);
  const stateWebUrl = normalizeLoopbackHttpUrl(state.webUrl);
  return Boolean(normalizedWebBaseUrl && stateWebUrl && normalizedWebBaseUrl === stateWebUrl);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
