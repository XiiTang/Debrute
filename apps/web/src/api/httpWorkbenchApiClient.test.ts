import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpWorkbenchApiClient } from './httpWorkbenchApiClient.js';

describe('Runtime Workbench connection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses one connection credential for commands and never puts it in a URL', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await expect(client.openProject({ projectRoot: '/tmp/project' })).resolves.toMatchObject({
      projectId: 'project-1',
      workingCopies: {
        text: {
          'draft.md': { content: 'unsaved' }
        }
      }
    });

    expect(harness.calls.map((call) => call.path)).toEqual([
      '/api/workbench/connection',
      '/api/projects/open'
    ]);
    expect(header(harness.calls[1]?.init, 'x-debrute-workbench-connection')).toBe('connection-1');
    expect(harness.calls.every((call) => !call.path.includes('connection-1'))).toBe(true);
    client.dispose();
  });

  it('replaces a bound Project directly without prepare, commit, or unload requests', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await client.openProject({ projectRoot: '/tmp/project-1' });
    await expect(client.openProject({ projectRoot: '/tmp/project-2' })).resolves.toMatchObject({
      projectId: 'project-2'
    });

    expect(harness.calls.map((call) => call.path)).toEqual([
      '/api/workbench/connection',
      '/api/projects/open',
      '/api/projects/replace'
    ]);
    client.dispose();
  });

  it('becomes unbound when another Workbench preempts its Project', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await client.openProject({ projectRoot: '/tmp/project-1' });
    harness.emit({ type: 'project.preempted', projectId: 'project-1' });
    await vi.waitFor(() => expect(client.projectProjection.getState()).toMatchObject({
      status: 'detached',
      projectId: 'project-1'
    }));
    await client.openProject({ projectRoot: '/tmp/project-2' });

    expect(harness.calls.at(-1)?.path).toBe('/api/projects/open');
    client.dispose();
  });

  it('returns a Desktop focus outcome without changing the current Project binding', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await client.openProject({ projectRoot: '/tmp/project-1' });
    harness.focusNextProject();
    await expect(client.openProject({ projectRoot: '/tmp/project-2' })).resolves.toEqual({
      outcome: 'focused_existing_desktop',
      projectId: 'project-2'
    });

    await expect(client.openProject({ projectId: 'project-1' })).resolves.toMatchObject({
      projectId: 'project-1'
    });
    client.dispose();
  });

  it('allows explicit Open Here after the initial Desktop-versus-Web conflict', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.checkProductUpdate();
    harness.emit({
      type: 'project.open_failed',
      projectId: 'project-1',
      error: {
        code: 'project_owned_by_web',
        message: 'Project is active in Web.'
      }
    });

    await vi.waitFor(async () => {
      await expect(client.openProject({ projectId: 'project-1' })).rejects.toMatchObject({
        code: 'project_owned_by_web'
      });
    });
    await expect(client.openProject({
      projectId: 'project-1',
      forceOpenHere: true
    })).resolves.toMatchObject({ projectId: 'project-1' });

    const openRequest = harness.calls.find((call) => call.path === '/api/projects/open');
    expect(JSON.parse(String(openRequest?.init?.body))).toEqual({
      projectId: 'project-1',
      forceOpenHere: true
    });
    client.dispose();
  });

  it('does not reconnect after the Runtime connection ends', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await client.openProject({ projectRoot: '/tmp/project-1' });
    harness.close();
    await vi.waitFor(() => expect(harness.connectionRequests()).toBe(1));
    await expect(client.checkProductUpdate()).rejects.toThrow('ended unexpectedly');
    expect(harness.connectionRequests()).toBe(1);
    client.dispose();
  });

  it('delivers the initial snapshot events when the connection starts before subscription', async () => {
    createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.checkProductUpdate();
    const listener = vi.fn();

    client.onEvent(listener);

    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([
      'globalSettings.changed',
      'adobeBridge.state.changed',
      'product.changed'
    ]);
    expect(listener.mock.calls.at(-1)?.[0]).toEqual({ type: 'product.changed', product: null });
    client.dispose();
  });

  it('reveals a Model API key through the authenticated explicit command', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await expect(client.revealModelApiKey('image/openai/gpt-image-1')).resolves.toEqual({
      apiKey: '  密钥🔑  '
    });

    const reveal = harness.calls.at(-1);
    expect(reveal?.path).toBe('/api/settings/models/api-key/reveal');
    expect(reveal?.init?.method).toBe('POST');
    expect(header(reveal?.init, 'x-debrute-workbench-connection')).toBe('connection-1');
    expect(JSON.parse(String(reveal?.init?.body))).toEqual({
      modelId: 'image/openai/gpt-image-1'
    });
    client.dispose();
  });

  it('targets Working Copy requests at the Project captured by the caller', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await client.openProject({ projectRoot: '/tmp/project-1' });
    await client.openProject({ projectRoot: '/tmp/project-2' });
    await client.clearTextWorkingCopy('project-1', 'draft.md');

    expect(harness.calls.at(-1)?.path).toBe(
      '/api/projects/project-1/working-copies/text/draft.md'
    );
    await client.clearFeedbackWorkingCopy('project-1', 'feedback-a');
    expect(harness.calls.at(-1)?.path).toBe(
      '/api/projects/project-1/working-copies/feedback/feedback-a'
    );
    client.dispose();
  });

  it('completes a Project mutation only after its stream revision is accepted', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.openProject({ projectRoot: '/tmp/project-1' });
    const mutation = client.createCanvas();
    let completed = false;
    void mutation.then(() => { completed = true; });

    await vi.waitFor(() => expect(harness.calls.at(-1)?.path).toBe('/api/projects/project-1/canvases'));
    await Promise.resolve();
    expect(completed).toBe(false);

    harness.emit({
      type: 'project.changed',
      projectId: 'project-1',
      projectRevision: 2,
      snapshot: snapshotFixture('project-1')
    });
    await expect(mutation).resolves.toMatchObject({ projectRevision: 2 });
    client.dispose();
  });

  it('rejects a Project mutation when the connection ends before its stream revision', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.openProject({ projectRoot: '/tmp/project-1' });
    const mutation = client.createCanvas();

    await vi.waitFor(() => expect(harness.calls.at(-1)?.path).toBe('/api/projects/project-1/canvases'));
    harness.close();

    await expect(mutation).rejects.toThrow('ended unexpectedly');
    client.dispose();
  });

  it('also waits for the accepted stream revision after a multipart Project mutation', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.openProject({ projectRoot: '/tmp/project-1' });
    const mutation = client.importExternalProjectUploads({
      entries: [],
      targetDirectoryProjectRelativePath: ''
    });
    let completed = false;
    void mutation.then(() => { completed = true; });

    await vi.waitFor(() => expect(harness.calls.at(-1)?.path).toBe('/api/projects/project-1/files/import/uploads'));
    await Promise.resolve();
    expect(completed).toBe(false);

    harness.emit({
      type: 'project.changed',
      projectId: 'project-1',
      projectRevision: 2,
      snapshot: snapshotFixture('project-1')
    });
    await expect(mutation).resolves.toMatchObject({ projectRevision: 2 });
    client.dispose();
  });

  it('ends the connection when a recognized Project event is malformed', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    const onConnectionEnded = vi.fn();
    client.onConnectionEnded(onConnectionEnded);
    await client.openProject({ projectRoot: '/tmp/project-1' });

    harness.emit({
      type: 'project.changed',
      projectId: 'project-1',
      snapshot: { source: 'missing-revision' }
    });

    await vi.waitFor(() => expect(onConnectionEnded).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('invalid project.changed') })
    ));
    expect(client.projectProjection.getState()).toMatchObject({ status: 'failed' });
    client.dispose();
  });

  it('ends the connection when a project.bound baseline is incomplete', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    const onConnectionEnded = vi.fn();
    client.onConnectionEnded(onConnectionEnded);
    await client.checkProductUpdate();

    harness.emit({
      type: 'project.bound',
      project: {
        projectId: 'project-1',
        projectRevision: 1,
        snapshot: {}
      },
      workingCopies: { text: {}, feedback: {} }
    });

    await vi.waitFor(() => expect(onConnectionEnded).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('invalid project.bound') })
    ));
    client.dispose();
  });
});

function createHarness() {
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  let projectNumber = 0;
  let focusNext = false;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    calls.push({ path, init });
    if (path === '/api/workbench/connection') {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(sse(encoder, {
            type: 'connection.opened',
            connectionCredential: 'connection-1'
          }));
          controller.enqueue(sse(encoder, {
            type: 'global.snapshot',
            globalRevision: 1,
            snapshot: {
              settings: {},
              photoshop: {},
              product: null
            }
          }));
        }
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/api/projects/open' || path === '/api/projects/replace') {
      projectNumber += 1;
      const projectId = `project-${projectNumber}`;
      if (focusNext) {
        focusNext = false;
        return Response.json({ outcome: 'focused_existing_desktop', projectId });
      }
      streamController?.enqueue(sse(encoder, {
        type: 'project.bound',
        project: {
          projectId,
          projectRevision: 1,
          snapshot: snapshotFixture(projectId)
        },
        workingCopies: {
          text: projectNumber === 1
            ? {
                'draft.md': {
                  projectRelativePath: 'draft.md',
                  content: 'unsaved',
                  language: 'markdown',
                  baseRevision: 'revision-1'
                }
              }
            : {},
          feedback: {}
        }
      }));
      return Response.json({ outcome: 'bound', projectId });
    }
    if (path === '/api/runtime/product/update/check') {
      return Response.json({ ok: true });
    }
    if (path === '/api/projects/project-1/canvases') {
      return Response.json({
        projectId: 'project-1',
        projectRevision: 2
      });
    }
    if (path === '/api/projects/project-1/files/import/uploads') {
      return Response.json({
        projectId: 'project-1',
        projectRevision: 2,
        results: []
      });
    }
    if (path === '/api/settings/models/api-key/reveal') {
      return Response.json({ apiKey: '  密钥🔑  ' });
    }
    if (path.includes('/working-copies/')) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchImpl);
  vi.stubGlobal('WebSocket', StubWebSocket);
  vi.stubGlobal('window', {});
  vi.stubGlobal('location', {
    origin: 'http://127.0.0.1:41001',
    pathname: '/'
  });
  return {
    calls,
    emit(value: unknown) {
      streamController?.enqueue(sse(encoder, value));
    },
    close() {
      streamController?.close();
    },
    connectionRequests() {
      return calls.filter((call) => call.path === '/api/workbench/connection').length;
    },
    focusNextProject() {
      focusNext = true;
    }
  };
}

function snapshotFixture(projectId: string) {
  return {
    metadata: {
      project: {
        id: projectId,
        name: projectId,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z'
      }
    },
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    canvasRegistry: { status: 'ready', canvasOrder: [] },
    health: {
      projectName: projectId,
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-07-23T00:00:00.000Z'
    }
  };
}

function sse(encoder: TextEncoder, value: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

class StubWebSocket {
  static readonly OPEN = 1;
  readonly readyState = 0;

  addEventListener(): void {}
  send(): void {}
  close(): void {}
}
