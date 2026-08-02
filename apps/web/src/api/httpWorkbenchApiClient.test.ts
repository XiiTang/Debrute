import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpWorkbenchApiClient } from './httpWorkbenchApiClient.js';

describe('Runtime Workbench connection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    StubWebSocket.created = 0;
  });

  it('resolves Global Settings bootstrap without waiting for a Project binding', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await expect(client.bootstrapGlobalSettings()).resolves.toEqual({
      globalRevision: 1,
      settings: {}
    });
    expect(harness.calls.map((call) => call.path)).toEqual(['/api/workbench/connection']);
    client.dispose();
  });

  it.each([-1, 1.5, Number.NaN])(
    'rejects an invalid Global snapshot revision (%s)',
    async (globalRevision) => {
      createHarness(globalRevision);
      const client = createHttpWorkbenchApiClient();

      await expect(client.bootstrapGlobalSettings()).rejects.toThrow('invalid global.snapshot');
      client.dispose();
    }
  );

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
    expect(JSON.parse(String(harness.calls[1]?.init?.body))).toEqual({
      projectRoot: '/tmp/project'
    });
    expect(harness.calls.every((call) => !call.path.includes('connection-1'))).toBe(true);
    client.dispose();
  });

  it('marks the actual path-based Project binding request without activating Terminal transport', async () => {
    createHarness();
    const mark = vi.fn();
    const client = createHttpWorkbenchApiClient({ startupTimeline: { mark } });

    await client.openProject({ projectRoot: '/tmp/project' });

    expect(mark).toHaveBeenCalledWith('project-open-requested');
    expect(StubWebSocket.created).toBe(0);
    client.dispose();
  });

  it('activates Terminal transport when the collection projection is subscribed', async () => {
    createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.openProject({ projectRoot: '/tmp/project' });
    expect(StubWebSocket.created).toBe(0);

    const subscription = client.subscribeTerminalSessions(vi.fn(), vi.fn());

    await vi.waitFor(() => expect(StubWebSocket.created).toBe(1));
    subscription.close();
    client.dispose();
  });

  it('marks a Project binding carried by the initial Workbench connection', async () => {
    createHarness();
    vi.stubGlobal('location', {
      origin: 'http://127.0.0.1:41001',
      pathname: '/projects/project-initial'
    });
    const mark = vi.fn();
    const client = createHttpWorkbenchApiClient({ startupTimeline: { mark } });

    await client.bootstrapGlobalSettings();

    expect(mark).toHaveBeenCalledWith('project-open-requested');
    client.dispose();
  });

  it('chooses a Project root without starting a Project binding', async () => {
    const harness = createHarness();
    const mark = vi.fn();
    const client = createHttpWorkbenchApiClient({ startupTimeline: { mark } });

    const resolveSelection = harness.deferNextProjectRootSelection();
    const firstSelection = client.chooseProjectRoot();
    const repeatedSelection = client.chooseProjectRoot();
    expect(repeatedSelection).toBe(firstSelection);
    await vi.waitFor(() => expect(harness.calls.filter(
      (call) => call.path === '/api/projects/choose'
    )).toHaveLength(1));
    resolveSelection(undefined);
    await expect(firstSelection).resolves.toBeUndefined();
    await expect(repeatedSelection).resolves.toBeUndefined();
    expect(mark).not.toHaveBeenCalledWith('project-open-requested');

    harness.selectNextProjectRoot('/tmp/picked-project');
    await expect(client.chooseProjectRoot()).resolves.toBe('/tmp/picked-project');

    expect(mark).not.toHaveBeenCalledWith('project-open-requested');
    expect(harness.calls.map((call) => call.path)).toEqual([
      '/api/workbench/connection',
      '/api/projects/choose',
      '/api/projects/choose'
    ]);
    client.dispose();
  });

  it('loads an Explorer directory through a revisioned POST command', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await client.openProject({ projectRoot: '/tmp/project' });
    await client.loadProjectDirectory('assets/source files');

    const call = harness.calls.at(-1);
    expect(call?.path).toBe('/api/projects/project-1/files/load-directory');
    expect(call?.init?.method).toBe('POST');
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      projectRelativeDirectory: 'assets/source files'
    });
    client.dispose();
  });

  it('projects Runtime Activity events and routes structured reports by scope', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.openProject({ projectRoot: '/tmp/project' });

    harness.emit({
      type: 'activity.upsert',
      activityRevision: 1,
      record: {
        id: 'activity-1',
        source: 'canvas',
        project: { projectId: 'project-1', projectName: 'project-1' },
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
        type: 'notice',
        message: { kind: 'canvas-operation-failed', operation: 'save-layout' }
      }
    });
    await vi.waitFor(() => expect(client.activities.getSnapshot().records).toHaveLength(1));
    expect(client.activities.getSnapshot().floatingRecordIds).toEqual(['activity-1']);

    await client.reportActivityNotice({
      kind: 'canvas-operation-failed',
      operation: 'save-layout'
    });
    await client.reportActivityNotice({ kind: 'update-install-failed' });
    await client.dismissActivity('activity-1');
    await client.clearTerminalActivities();

    const activityCalls = harness.calls.slice(-4);
    expect(activityCalls.map((call) => [call.init?.method, call.path])).toEqual([
      ['POST', '/api/projects/project-1/activities/notices'],
      ['POST', '/api/activities/notices'],
      ['DELETE', '/api/activities/activity-1'],
      ['DELETE', '/api/activities']
    ]);
    expect(JSON.parse(String(activityCalls[0]?.init?.body))).toEqual({
      kind: 'canvas-operation-failed',
      operation: 'save-layout'
    });
    client.dispose();
  });

  it('sends Video Preview Probe and Ensure as separate Project-scoped commands', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.openProject({ projectRoot: '/tmp/project' });
    const target = {
      projectRelativePath: 'media/clip.mp4',
      videoRevision: 'sha256:video',
      frameTimeMs: 1_500
    };

    await expect(client.probeCanvasVideoPreviewSources({
      canvasId: 'canvas-1',
      targets: [target]
    })).resolves.toEqual({ sources: {} });
    await expect(client.ensureCanvasVideoPreviewSource({
      canvasId: 'canvas-1',
      target,
      sourceKey: 'frame-key'
    })).resolves.toEqual({ status: 'source-changed' });

    const [probe, ensure] = harness.calls.slice(-2);
    expect(probe?.path).toBe('/api/projects/project-1/canvas-video-previews/probe');
    expect(ensure?.path).toBe('/api/projects/project-1/canvas-video-previews/ensure');
    expect(JSON.parse(String(probe?.init?.body))).toEqual({ canvasId: 'canvas-1', targets: [target] });
    expect(JSON.parse(String(ensure?.init?.body))).toEqual({
      canvasId: 'canvas-1',
      target,
      sourceKey: 'frame-key'
    });
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

  it('retains the initial Global resources when the connection starts before subscription', async () => {
    createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.checkProductUpdate();
    const listener = vi.fn();

    client.onEvent(listener);

    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([
      'photoshop.state.changed',
      'product.changed'
    ]);
    expect(listener.mock.calls.at(-1)?.[0]).toEqual({
      type: 'product.changed',
      revision: 1,
      product: null
    });
    expect(client.globalProjection.getState()).toMatchObject({
      status: 'active',
      revision: 1,
      settings: {},
      photoshop: { status: 'ready' },
      product: { status: 'ready', value: null }
    });
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

function createHarness(globalRevision = 1) {
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  let projectNumber = 0;
  let focusNext = false;
  let pickerSelection: string | undefined;
  let pendingPickerSelection: Promise<string | undefined> | undefined;
  let resolvePendingPickerSelection: ((projectRoot: string | undefined) => void) | undefined;
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
            globalRevision,
            snapshot: {
              settings: {}
            }
          }));
          controller.enqueue(sse(encoder, {
            type: 'photoshop.state.changed',
            revision: 1,
            state: { sessions: [] }
          }));
          controller.enqueue(sse(encoder, { type: 'product.changed', revision: 1, product: null }));
          controller.enqueue(sse(encoder, {
            type: 'activity.snapshot',
            activityRevision: 0,
            records: []
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
    if (path === '/api/projects/choose') {
      const selection = pendingPickerSelection;
      const selected = selection ? await selection : pickerSelection;
      if (pendingPickerSelection === selection) {
        pendingPickerSelection = undefined;
        resolvePendingPickerSelection = undefined;
      }
      pickerSelection = undefined;
      return Response.json(selected
        ? { selected: true, projectRoot: selected }
        : { selected: false });
    }
    if (path === '/api/runtime/product/update/check') {
      return Response.json({ ok: true });
    }
    if (path.endsWith('/activities/notices')) {
      return Response.json({ activityId: 'reported-activity' });
    }
    if (path === '/api/activities/activity-1') {
      return Response.json({ ok: true });
    }
    if (path === '/api/activities') {
      return Response.json({ ok: true, cleared: 1 });
    }
    if (path === '/api/projects/project-1/canvases') {
      return Response.json({
        projectId: 'project-1',
        projectRevision: 2
      });
    }
    if (path === '/api/projects/project-1/files/load-directory') {
      streamController?.enqueue(sse(encoder, {
        type: 'project.changed',
        projectId: 'project-1',
        projectRevision: 2,
        snapshot: snapshotFixture('project-1')
      }));
      return Response.json({
        projectId: 'project-1',
        projectRevision: 2
      });
    }
    if (path === '/api/projects/project-1/canvas-video-previews/probe') {
      return Response.json({ sources: {} });
    }
    if (path === '/api/projects/project-1/canvas-video-previews/ensure') {
      return Response.json({ status: 'source-changed' });
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
    },
    deferNextProjectRootSelection() {
      pendingPickerSelection = new Promise((resolve) => {
        resolvePendingPickerSelection = resolve;
      });
      return (projectRoot: string | undefined) => {
        resolvePendingPickerSelection?.(projectRoot);
      };
    },
    selectNextProjectRoot(projectRoot: string) {
      pickerSelection = projectRoot;
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
  static created = 0;
  readonly readyState = 0;

  constructor() {
    StubWebSocket.created += 1;
  }

  addEventListener(): void {}
  send(): void {}
  close(): void {}
}
