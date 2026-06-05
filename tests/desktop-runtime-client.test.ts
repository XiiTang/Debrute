import { describe, expect, it, vi } from 'vitest';
import type { DebruteDaemonHttpServer, DebruteDaemonRuntime } from '@debrute/daemon';
import {
  createAttachedDesktopRuntimeClient,
  createHostedDesktopRuntimeClient
} from '../apps/desktop/src/electron/desktopRuntimeClient';

describe('desktop runtime client', () => {
  it('opens projects through an attached runtime over HTTP', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ projectId: 'project-1' }), { status: 200 });
    });

    await expect(client.openProject('/tmp/debrute-project')).resolves.toEqual({
      projectId: 'project-1',
      url: 'http://127.0.0.1:17322/projects/project-1?debrute-token=secret'
    });
    expect(requests[0]?.url).toBe('http://127.0.0.1:17321/api/projects/open');
    expect((requests[0]?.init?.headers as Record<string, string>)['x-debrute-daemon-token']).toBe('secret');
  });

  it('resolves project paths through an attached runtime over HTTP', async () => {
    const client = createAttachedDesktopRuntimeClient(runtimeFixture(), async (url, init) => {
      expect(String(url)).toBe('http://127.0.0.1:17321/api/projects/project-1/desktop/resolve-path');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ absolutePath: '/tmp/debrute-project/brief.md' }), { status: 200 });
    });

    await expect(client.resolveProjectPath('project-1', 'brief.md', 'file')).resolves.toBe('/tmp/debrute-project/brief.md');
  });

  it('closes only hosted runtime clients', async () => {
    const close = vi.fn(async () => undefined);
    const hosted = createHostedDesktopRuntimeClient({
      runtime: () => runtimeFixture(),
      close,
      projectRootForProjectId: () => '/tmp/debrute-project',
      registerElectronProjectWindow: () => () => undefined
    } as unknown as DebruteDaemonHttpServer);

    await hosted.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

function runtimeFixture(): DebruteDaemonRuntime {
  return {
    daemonUrl: 'http://127.0.0.1:17321',
    webBaseUrl: 'http://127.0.0.1:17322',
    token: 'secret'
  };
}
