import { describe, expect, it } from 'vitest';
import { openProjectFromPickerThroughDaemon, openProjectThroughDaemon, projectWebShellNavigation } from './daemonProjectOpen.js';
import type { DebruteDaemonRuntimeLike } from './daemonProjectOpen.js';

describe('desktop daemon project open', () => {
  it('opens menu-selected projects through the daemon route', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const runtime = daemonRuntimeFixture();
    expectWorkbenchNavigation(
      projectWebShellNavigation(runtime, '123e4567-e89b-42d3-a456-426614174000'),
      '/projects/123e4567-e89b-42d3-a456-426614174000'
    );

    const opened = await openProjectThroughDaemon(runtime, '/tmp/debrute-project', async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        projectId: '123e4567-e89b-42d3-a456-426614174000',
        snapshot: { canvases: [] }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(opened.projectId).toBe('123e4567-e89b-42d3-a456-426614174000');
    expectWorkbenchNavigation(opened.navigation, '/projects/123e4567-e89b-42d3-a456-426614174000');

    expect(requests).toEqual([{
      url: 'http://127.0.0.1:17321/api/projects/open',
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': 'secret'
        },
        body: JSON.stringify({ projectRoot: '/tmp/debrute-project' })
      }
    }]);
  });

  it('opens menu picker projects through the daemon picker route', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const runtime = daemonRuntimeFixture();

    const opened = await openProjectFromPickerThroughDaemon(runtime, async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        opened: true,
        projectId: '123e4567-e89b-42d3-a456-426614174000',
        projectRevision: 1,
        snapshot: { canvases: [] }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(opened).toMatchObject({
      opened: true,
      projectId: '123e4567-e89b-42d3-a456-426614174000'
    });
    if (opened.opened) {
      expectWorkbenchNavigation(opened.navigation, '/projects/123e4567-e89b-42d3-a456-426614174000');
    }

    expect(requests).toEqual([{
      url: 'http://127.0.0.1:17321/api/projects/open-picker',
      init: {
        method: 'POST',
        headers: { 'x-debrute-daemon-token': 'secret' }
      }
    }]);
  });
});

function daemonRuntimeFixture(): DebruteDaemonRuntimeLike {
  return {
    daemonUrl: 'http://127.0.0.1:17321',
    webBaseUrl: 'http://127.0.0.1:17322',
    platform: 'darwin',
    token: 'secret'
  };
}

function expectWorkbenchNavigation(navigation: { readyUrl: string; loadUrl: string }, next: string): void {
  expect(navigation.readyUrl).toBe(`http://127.0.0.1:17322${next}`);
  const parsed = new URL(navigation.loadUrl);
  expect(parsed.origin).toBe('http://127.0.0.1:17322');
  expect(parsed.pathname).toMatch(/^\/__debrute\/session\/.+/);
  expect(parsed.searchParams.get('next')).toBe(next);
}
