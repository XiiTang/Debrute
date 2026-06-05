import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchApiClient } from './workbenchApiClient';

describe('workbench API client', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const projectId = '123e4567-e89b-42d3-a456-426614174000';

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    vi.unstubAllGlobals();
  });

  it('creates the browser HTTP client without Electron preload', () => {
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://127.0.0.1:17321', search: '' },
      localStorage: { getItem: () => undefined, setItem: () => undefined },
      sessionStorage: { getItem: () => undefined, setItem: () => undefined }
    };

    expect(createWorkbenchApiClient()).toMatchObject({
      mode: 'web'
    });
  });

  it('uses the current browser origin as the daemon URL', async () => {
    const responses: string[] = [];
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://127.0.0.1:17321', search: '' },
      localStorage: { getItem: () => undefined, setItem: () => undefined },
      sessionStorage: { getItem: () => undefined, setItem: () => undefined }
    };
    vi.stubGlobal('fetch', async (url: string) => {
      responses.push(url);
      return new Response(JSON.stringify({ projectId, snapshot: { canvases: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    await createWorkbenchApiClient().openProject({ projectRoot: '/tmp/project' });

    expect(responses).toEqual(['http://127.0.0.1:17321/api/projects/open']);
  });

  it('keeps URL daemon tokens in memory instead of persisting them in browser storage', async () => {
    const setItem = vi.fn();
    const replaceState = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://127.0.0.1:17321', search: '?debrute-token=secret&view=canvas', pathname: '/', hash: '' },
      localStorage: { getItem: () => undefined, setItem },
      sessionStorage: { getItem: () => undefined, setItem: () => undefined },
      history: { replaceState }
    };
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requests.push(init);
      return new Response(JSON.stringify({ projectId, snapshot: { canvases: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    await createWorkbenchApiClient().openProject({ projectRoot: '/tmp/project' });

    expect(requests[0]!.headers).toMatchObject({ 'x-debrute-daemon-token': 'secret' });
    expect(setItem).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?view=canvas');
  });
});
