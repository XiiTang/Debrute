export const DEFAULT_DEBRUTE_DISCOVERY_URL = 'http://127.0.0.1:32124/adobe-bridge/discovery';

export type DiscoveryResult =
  | { status: 'connected'; apiBaseUrl: string; wsUrl: string }
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
      bridgeVersion?: number;
      enabled?: boolean;
      apiBaseUrl?: string;
      wsUrl?: string;
    };
    if (
      payload.product !== 'debrute'
      || payload.bridgeVersion !== 1
      || typeof payload.apiBaseUrl !== 'string'
      || typeof payload.wsUrl !== 'string'
    ) {
      return { status: 'unavailable', message: 'Discovery response is not Debrute Adobe Bridge.' };
    }
    if (payload.enabled !== true) {
      return { status: 'disabled' };
    }
    return { status: 'connected', apiBaseUrl: payload.apiBaseUrl, wsUrl: payload.wsUrl };
  } catch (error) {
    return { status: 'unavailable', message: error instanceof Error ? error.message : String(error) };
  }
}
