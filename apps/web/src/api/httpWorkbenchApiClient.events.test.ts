import { describe, expect, it } from 'vitest';
import { createHttpWorkbenchApiClient } from './httpWorkbenchApiClient.js';
import { captureEventSources, emitProjectChanged, jsonResponse, projectId, routeResponse, workbenchSnapshot } from './httpWorkbenchApiClient.testFixtures.js';

describe('HTTP workbench API client events', () => {
  it('opens the global event stream before adding the project event stream for an opaque project id', async () => {
    const eventSourceUrls: string[] = [];
    const client = createHttpWorkbenchApiClient({
      fetch: async (url, init) => {
        const body = routeResponse(String(url), init);
        if (new URL(String(url), 'http://127.0.0.1:17456').pathname === '/api/projects/open') {
          expect(JSON.stringify(body)).not.toContain('projectRoot');
          expect(JSON.stringify(body)).not.toContain('/tmp/project');
        }
        return jsonResponse(body);
      }
    });
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        eventSourceUrls.push(String(url));
      }
      close() {}
    } as unknown as typeof EventSource;
    try {
      const unsubscribe = client.onEvent(() => {});
      expect(eventSourceUrls).toHaveLength(1);
      const globalEventUrl = new URL(eventSourceUrls[0]!, 'http://127.0.0.1:17456');
      expect(globalEventUrl.pathname).toBe('/api/workbench/events');
      expect(globalEventUrl.searchParams.get('clientId')).toMatch(/^web:/);
      expect([...globalEventUrl.searchParams.keys()]).toEqual(['clientId']);

      await client.openProject({ projectRoot: '/tmp/project' });
      expect(eventSourceUrls).toHaveLength(2);
      const eventUrl = new URL(eventSourceUrls[1]!, 'http://127.0.0.1:17456');
      expect(eventUrl.pathname).toBe(`/api/projects/${projectId}/events`);
      const clientId = eventUrl.searchParams.get('clientId');
      expect(clientId).not.toBeNull();
      expect(clientId!).toMatch(/^web:/);
      expect([...eventUrl.searchParams.keys()]).toEqual(['clientId']);

      unsubscribe();
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });

  it('does not report terminal event stream errors after a terminal closed event', async () => {
    let terminalListener: ((event: MessageEvent) => void) | undefined;
    let eventSource: EventSource | undefined;
    let sourceClosed = false;
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = class extends EventTarget {
      onerror: ((event: Event) => void) | null = null;

      constructor(_url: string | URL) {
        super();
        eventSource = this as unknown as EventSource;
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (type === 'terminal') {
          terminalListener = listener as (event: MessageEvent) => void;
        }
      }

      close(): void {
        sourceClosed = true;
      }
    } as unknown as typeof EventSource;
    try {
      const client = createHttpWorkbenchApiClient({
        fetch: async (url, init) => jsonResponse(routeResponse(String(url), init))
      });
      await client.openProject({ projectRoot: '/tmp/project' });
      const terminalEvents: unknown[] = [];
      const errors: string[] = [];
      const subscription = client.subscribeTerminalEvents(
        'terminal-1',
        (event) => terminalEvents.push(event),
        (error) => errors.push(error.message)
      );

      terminalListener?.(new MessageEvent('terminal', {
        data: JSON.stringify({ type: 'closed', terminalId: 'terminal-1' })
      }));
      eventSource?.onerror?.(new Event('error'));

      subscription.close();

      expect(terminalEvents).toEqual([{ type: 'closed', terminalId: 'terminal-1' }]);
      expect(sourceClosed).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });

  it('updates its base revision from project events before the next mutation', async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    let eventSourceInstance: { onmessage: ((event: MessageEvent) => void) | null; close(): void } | undefined;
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        eventSourceInstance = this;
      }
      close() {}
    } as unknown as typeof EventSource;
    try {
      const client = createHttpWorkbenchApiClient({
        fetch: async (url, init) => {
          const parsed = new URL(String(url), 'http://127.0.0.1:17456');
          requests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          return jsonResponse(routeResponse(String(url), init));
        }
      });
      client.onEvent(() => undefined);
      await client.openProject({ projectRoot: '/tmp/project' });
      eventSourceInstance!.onmessage!(new MessageEvent('message', {
        data: JSON.stringify({
          type: 'project.changed',
          projectId,
          projectRevision: 7,
          snapshot: workbenchSnapshot()
        })
      }));

      await client.createCanvas();

      expect(requests).toContainEqual({
        path: `/api/projects/${projectId}/canvases`,
        body: { baseRevision: 7 }
      });
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });

  it('ignores older project events while still delivering events at the current revision', async () => {
    const eventSources = captureEventSources();
    try {
      const client = createHttpWorkbenchApiClient({
        fetch: async (url, init) => jsonResponse(routeResponse(String(url), init))
      });
      const revisions: number[] = [];
      client.onEvent((event) => {
        if ('projectRevision' in event) {
          revisions.push(event.projectRevision);
        }
      });
      await client.openProject({ projectRoot: '/tmp/project' });
      const projectEvents = eventSources.sources[1]!;

      for (const revision of [7, 6, 7]) {
        emitProjectChanged(projectEvents, projectId, revision);
      }

      expect(revisions).toEqual([7, 7]);
    } finally {
      eventSources.restore();
    }
  });

  it('ignores events from a project stream that was replaced by another project', async () => {
    const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const requests: Array<{ path: string; body?: unknown }> = [];
    const eventSources = captureEventSources();
    try {
      const client = createHttpWorkbenchApiClient({
        fetch: async (url, init) => {
          const parsed = new URL(String(url), 'http://127.0.0.1:17456');
          requests.push({
            path: parsed.pathname,
            body: init?.body ? JSON.parse(String(init.body)) : undefined
          });
          if (parsed.pathname === '/api/projects/open') {
            return jsonResponse({ projectId: projectA, projectRevision: 1, snapshot: workbenchSnapshot() });
          }
          if (parsed.pathname === `/api/projects/${projectB}`) {
            return jsonResponse({ projectId: projectB, projectRevision: 10, snapshot: workbenchSnapshot() });
          }
          if (parsed.pathname === `/api/projects/${projectB}/files`) {
            return jsonResponse({
              projectId: projectB,
              projectRevision: 11,
              projectRelativePath: 'project-b.md',
              kind: 'file',
              snapshot: workbenchSnapshot()
            });
          }
          throw new Error(`Unexpected request: ${parsed.pathname}`);
        }
      });
      const projectEvents: unknown[] = [];
      client.onEvent((event) => projectEvents.push(event));
      await client.openProject({ projectRoot: '/tmp/project-a' });
      const projectAEventSource = eventSources.sources[1]!;
      await client.openProject({ projectId: projectB });

      emitProjectChanged(projectAEventSource, projectA, 99);
      await client.createProjectFile({ parentProjectRelativePath: '', name: 'project-b.md' });

      expect(projectEvents).toEqual([]);
      expect(requests).toContainEqual({
        path: `/api/projects/${projectB}/files`,
        body: {
          baseRevision: 10,
          kind: 'file',
          parentProjectRelativePath: '',
          name: 'project-b.md'
        }
      });
    } finally {
      eventSources.restore();
    }
  });
});
