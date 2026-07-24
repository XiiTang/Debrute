export const DEFAULT_DEBRUTE_DISCOVERY_URL = 'http://127.0.0.1:32124/adobe-bridge/discovery';

export type DiscoveryResult =
  | {
      status: 'connected';
      productVersion: string;
      runtimeInstanceId: string;
      workbenchOrigin: string;
      apiBaseUrl: string;
      wsUrl: string;
    }
  | { status: 'disabled' }
  | { status: 'unavailable'; message: string };

export async function discoverDebruteBridge(input: {
  fetch?: typeof fetch;
  discoveryUrl?: string;
} = {}): Promise<DiscoveryResult> {
  const fetchImpl = input.fetch ?? fetch;
  const discoveryUrl = input.discoveryUrl ?? DEFAULT_DEBRUTE_DISCOVERY_URL;
  try {
    const response = await fetchImpl(discoveryUrl, { cache: 'no-store' });
    if (!response.ok) {
      return { status: 'unavailable', message: `Discovery failed: ${response.status}` };
    }
    const payload = await response.json() as {
      product?: string;
      productVersion?: string;
      bridgeVersion?: number;
      runtimeInstanceId?: string;
      enabled?: boolean;
      workbenchOrigin?: string;
      apiBaseUrl?: string;
      wsUrl?: string;
    };
    if (
      payload.product !== 'debrute'
      || payload.bridgeVersion !== 1
      || typeof payload.productVersion !== 'string'
      || typeof payload.runtimeInstanceId !== 'string'
      || typeof payload.workbenchOrigin !== 'string'
      || typeof payload.apiBaseUrl !== 'string'
      || typeof payload.wsUrl !== 'string'
      || !validDynamicBridgeUrls(payload.workbenchOrigin, payload.apiBaseUrl, payload.wsUrl)
    ) {
      return { status: 'unavailable', message: 'Discovery response is not Debrute Adobe Bridge.' };
    }
    if (payload.enabled !== true) {
      return { status: 'disabled' };
    }
    return {
      status: 'connected',
      productVersion: payload.productVersion,
      runtimeInstanceId: payload.runtimeInstanceId,
      workbenchOrigin: payload.workbenchOrigin,
      apiBaseUrl: payload.apiBaseUrl,
      wsUrl: payload.wsUrl
    };
  } catch (error) {
    return { status: 'unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}

function validDynamicBridgeUrls(workbenchOrigin: string, apiBaseUrl: string, wsUrl: string): boolean {
  try {
    const origin = new URL(workbenchOrigin);
    const api = new URL(apiBaseUrl);
    const socket = new URL(wsUrl);
    return origin.protocol === 'http:'
      && origin.hostname === '127.0.0.1'
      && origin.pathname === '/'
      && origin.username === ''
      && origin.password === ''
      && origin.search === ''
      && origin.hash === ''
      && api.origin === origin.origin
      && api.pathname === '/api/adobe-bridge'
      && api.search === ''
      && api.hash === ''
      && socket.protocol === 'ws:'
      && socket.hostname === origin.hostname
      && socket.port === origin.port
      && socket.pathname === '/api/adobe-bridge/plugin/ws'
      && socket.search === ''
      && socket.hash === '';
  } catch {
    return false;
  }
}
