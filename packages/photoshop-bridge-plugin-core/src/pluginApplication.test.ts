import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PhotoshopAdapter } from './adapter.js';
import type { PhotoshopBridgeIdentityStore } from './bridgeIdentity.js';
import { startPhotoshopBridgePlugin } from './pluginApplication.js';

describe('PhotoshopBridgePluginApplication', () => {
  afterEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.unstubAllGlobals();
  });

  it('does not restore Connected after the socket closes during paired-identity persistence', async () => {
    let releaseWrite: (() => void) | undefined;
    const identityStore: PhotoshopBridgeIdentityStore = {
      read: async () => JSON.stringify({
        pluginInstanceId: 'plugin-1',
        publicKey: 'public-key',
        privateKey: 'private-key',
        paired: false
      }),
      write: vi.fn(async () => await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }))
    };
    const root = {
      innerHTML: '',
      querySelectorAll: () => [],
      querySelector: () => null
    } as unknown as HTMLElement;
    const adapter: PhotoshopAdapter = {
      hostVersion: () => '2026',
      selectionSnapshot: async () => ({
        documentTitle: null,
        documentCount: 0,
        selectedItems: []
      }),
      exportSelectedTopLevelPngs: async () => [],
      placeFileAsSmartObject: async () => undefined
    };

    vi.stubGlobal('window', {
      setInterval: () => 1,
      setTimeout: () => 1,
      clearTimeout: () => undefined
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      product: 'debrute',
      productVersion: '1.0.0',
      bridgeVersion: 1,
      runtimeInstanceId: 'runtime-1',
      enabled: true,
      workbenchOrigin: 'http://127.0.0.1:41001',
      apiBaseUrl: 'http://127.0.0.1:41001/api/adobe-bridge',
      wsUrl: 'ws://127.0.0.1:41001/api/adobe-bridge/plugin/ws'
    })));
    vi.stubGlobal('WebSocket', FakeWebSocket);

    startPhotoshopBridgePlugin({ root, adapter, identityStore, clientRuntime: 'uxp' });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.emitMessage({
      type: 'bridge.ready',
      pluginSessionId: 'session-1',
      bearer: 'secret',
      state: {}
    });
    await vi.waitFor(() => expect(identityStore.write).toHaveBeenCalledOnce());

    socket.close();
    expect(root.innerHTML).toContain('Disconnected');
    releaseWrite?.();
    await vi.waitFor(() => expect(root.innerHTML).toContain('Disconnected'));
    expect(root.innerHTML).not.toContain('>Connected<');
  });

  it('ignores a Project-link response completed after its socket closes', async () => {
    const identityStore: PhotoshopBridgeIdentityStore = {
      read: async () => JSON.stringify({
        pluginInstanceId: 'plugin-1',
        publicKey: 'public-key',
        privateKey: 'private-key',
        paired: false
      }),
      write: async () => undefined
    };
    const root = new FakeRoot();
    const adapter: PhotoshopAdapter = {
      hostVersion: () => '2026',
      selectionSnapshot: async () => ({
        documentTitle: null,
        documentCount: 0,
        selectedItems: []
      }),
      exportSelectedTopLevelPngs: async () => [],
      placeFileAsSmartObject: async () => undefined
    };
    let releaseLink: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/adobe-bridge/discovery')) return discoveryResponse();
      return await new Promise<Response>((resolve) => {
        releaseLink = resolve;
      });
    });

    installBrowserFakes(fetchImpl);
    startPhotoshopBridgePlugin({
      root: root as unknown as HTMLElement,
      adapter,
      identityStore,
      clientRuntime: 'uxp'
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0]!.emitMessage({
      type: 'bridge.ready',
      pluginSessionId: 'session-1',
      bearer: 'secret',
      state: bridgeState(false)
    });
    await vi.waitFor(() => expect(root.innerHTML).toContain('data-connect-project'));
    root.clickConnect();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    FakeWebSocket.instances[0]!.close();
    expect(root.innerHTML).toContain('Disconnected');
    releaseLink?.(Response.json(bridgeState(true)));
    await vi.waitFor(() => expect(root.innerHTML).toContain('Disconnected'));
    expect(root.innerHTML).not.toContain('<h3>Campaign</h3>');
  });
});

class FakeRoot {
  innerHTML = '';
  private connectButton: FakeButton | undefined;

  querySelectorAll(selector: string): FakeButton[] {
    if (selector === '[data-connect-project]' && this.innerHTML.includes('data-connect-project')) {
      this.connectButton = new FakeButton({ connectProject: 'project-1' });
      return [this.connectButton];
    }
    return [];
  }

  querySelector(): null {
    return null;
  }

  clickConnect(): void {
    if (!this.connectButton) throw new Error('Connect action was not rendered.');
    this.connectButton.click();
  }
}

class FakeButton {
  readonly classList = { add: () => undefined, remove: () => undefined };
  private clickListener: (() => void) | undefined;

  constructor(readonly dataset: DOMStringMap) {}

  addEventListener(type: string, listener: () => void): void {
    if (type === 'click') this.clickListener = listener;
  }

  click(): void {
    this.clickListener?.();
  }
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  emitMessage(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function installBrowserFakes(fetchImpl: typeof fetch): void {
  vi.stubGlobal('window', {
    setInterval: () => 1,
    setTimeout: () => 1,
    clearTimeout: () => undefined
  });
  vi.stubGlobal('fetch', fetchImpl);
  vi.stubGlobal('WebSocket', FakeWebSocket);
}

function discoveryResponse(): Response {
  return Response.json({
    product: 'debrute',
    productVersion: '1.0.0',
    bridgeVersion: 1,
    runtimeInstanceId: 'runtime-1',
    enabled: true,
    workbenchOrigin: 'http://127.0.0.1:41001',
    apiBaseUrl: 'http://127.0.0.1:41001/api/adobe-bridge',
    wsUrl: 'ws://127.0.0.1:41001/api/adobe-bridge/plugin/ws'
  });
}

function bridgeState(linked: boolean) {
  return {
    settings: { enabled: true, discoveryStatus: 'available' },
    pairedPlugins: [],
    clients: [],
    projects: [{
      projectId: 'project-1',
      projectName: 'Campaign',
      projectRevision: 1,
      directories: [{ projectRelativePath: 'assets', name: 'assets', depth: 1 }]
    }],
    links: linked ? [{
      linkId: 'link-1',
      projectId: 'project-1',
      pluginInstanceId: 'plugin-1',
      createdAt: '2026-07-20T00:00:00.000Z',
      status: 'active'
    }] : [],
    transfers: []
  };
}
