import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpWorkbenchApiClient } from './httpWorkbenchApiClient';

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
      bindingId: 'project-1',
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
      pathname: '/open',
      search: '?path=%2Fprojects%2Fproject-initial'
    });
    const mark = vi.fn();
    const client = createHttpWorkbenchApiClient({ startupTimeline: { mark } });

    await client.bootstrapGlobalSettings();

    expect(mark).toHaveBeenCalledWith('project-open-requested');
    client.dispose();
  });

  it('accepts the Runtime-canonical Windows root for the initial Project without replacing it', async () => {
    const requestedProjectRoot = 'E:\\Projects\\reference';
    const canonicalProjectRoot = '\\\\?\\E:\\Projects\\reference';
    const harness = createHarness(1, canonicalProjectRoot);
    vi.stubGlobal('location', {
      origin: 'http://127.0.0.1:41001',
      pathname: '/open',
      search: `?path=${encodeURIComponent(requestedProjectRoot)}`
    });
    const client = createHttpWorkbenchApiClient();

    await expect(client.openProject({ projectRoot: requestedProjectRoot })).resolves.toMatchObject({
      canonicalRoot: canonicalProjectRoot
    });
    expect(harness.calls.map((call) => call.path)).toEqual(['/api/workbench/connection']);
    client.dispose();
  });

  it('preserves the failed initial Project root as an explicit request error field', async () => {
    const requestedProjectRoot = '/projects/missing';
    createHarness(1, undefined, {
      code: 'project_not_found',
      message: `Debrute Project root does not exist: ${requestedProjectRoot}`
    });
    vi.stubGlobal('location', {
      origin: 'http://127.0.0.1:41001',
      pathname: '/open',
      search: `?path=${encodeURIComponent(requestedProjectRoot)}`
    });
    const client = createHttpWorkbenchApiClient();

    await expect(client.openProject({ projectRoot: requestedProjectRoot })).rejects.toMatchObject({
      status: 409,
      code: 'project_not_found',
      message: `Debrute Project root does not exist: ${requestedProjectRoot}`,
      projectRoot: requestedProjectRoot
    });
    client.dispose();
  });

  it('replaces the current Project when reopening the initial Windows path after another Project', async () => {
    const requestedProjectRoot = 'E:\\Projects\\reference';
    const canonicalProjectRoot = '\\\\?\\E:\\Projects\\reference';
    const harness = createHarness(1, canonicalProjectRoot);
    vi.stubGlobal('location', {
      origin: 'http://127.0.0.1:41001',
      pathname: '/open',
      search: `?path=${encodeURIComponent(requestedProjectRoot)}`
    });
    const client = createHttpWorkbenchApiClient();

    await client.openProject({ projectRoot: requestedProjectRoot });
    await client.openProject({ projectRoot: 'E:\\Projects\\second' });
    await expect(client.openProject({ projectRoot: requestedProjectRoot })).resolves.toMatchObject({
      canonicalRoot: requestedProjectRoot
    });
    await expect(client.openProject({ projectRoot: requestedProjectRoot })).resolves.toMatchObject({
      canonicalRoot: requestedProjectRoot
    });

    expect(harness.calls.map((call) => call.path)).toEqual([
      '/api/workbench/connection',
      '/api/projects/replace',
      '/api/projects/replace'
    ]);
    client.dispose();
  });

  it('uses the one-use Desktop launch context for the initial Project', async () => {
    const harness = createHarness();
    vi.stubGlobal('window', {
      debruteShell: {
        takeDesktopLaunchContext: async () => ({
          desktopLaunchTicket: 'ticket-1',
          initialProjectRoot: '/projects/from-desktop'
        })
      }
    });
    const client = createHttpWorkbenchApiClient();

    await client.bootstrapGlobalSettings();

    expect(client.initialProjectRoot()).toBe('/projects/from-desktop');
    expect(JSON.parse(String(harness.calls[0]?.init?.body))).toEqual({
      requestedProjectRoot: '/projects/from-desktop',
      desktopLaunchTicket: 'ticket-1'
    });
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
    expect(call?.path).toBe('/api/workbench/bindings/project-1/files/load-directory');
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
        project: { canonicalRoot: 'project-1', projectName: 'project-1' },
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
        type: 'notice',
        message: { kind: 'canvas-operation-failed', operation: 'save-layout' }
      }
    });
    await vi.waitFor(() => expect(client.activities.getSnapshot().records).toHaveLength(1));
    expect(client.activities.getSnapshot().floatingCards).toEqual([
      expect.objectContaining({ phase: 'present', recordId: 'activity-1' })
    ]);

    await client.reportActivityNotice({
      kind: 'canvas-operation-failed',
      operation: 'save-layout'
    });
    await client.reportActivityNotice({ kind: 'update-install-failed' });
    await client.dismissActivity('activity-1');
    await client.clearTerminalActivities();

    const activityCalls = harness.calls.slice(-4);
    expect(activityCalls.map((call) => [call.init?.method, call.path])).toEqual([
      ['POST', '/api/workbench/bindings/project-1/activities/notices'],
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

  it('reads and saves browser-captured Video Preview sources as Project-scoped commands', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.openProject({ projectRoot: '/tmp/project' });
    const target = {
      projectRelativePath: 'media/clip.mp4',
      sourceRevision: 'sha256:video',
      frameTimeMs: 1_500
    };

    await expect(client.readCanvasVideoPreviewSources({
      targets: [target]
    })).resolves.toEqual({ sources: [] });
    await expect(client.saveCanvasVideoPreviewSource({
      ...target,
      metadata: { width: 1920, height: 1080, durationSeconds: 4 },
      sourcePng: new Blob(['png'], { type: 'image/png' })
    })).resolves.toEqual({
      ok: true,
      source: { ...target, status: 'available', sourceWidth: 1920, metadata: { width: 1920, height: 1080 } }
    });

    const [read, save] = harness.calls.slice(-2);
    expect(read?.path).toBe('/api/workbench/bindings/project-1/canvas-video-previews/sources');
    expect(save?.path).toBe('/api/workbench/bindings/project-1/canvas-video-previews/source');
    expect(JSON.parse(String(read?.init?.body))).toEqual({ targets: [target] });
    expect(save?.init?.body).toBeInstanceOf(FormData);
    client.dispose();
  });

  it('resolves exact Canvas sources through the current Project binding', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.openProject({ projectRoot: '/tmp/project' });
    const input = {
      targets: [{ projectRelativePath: 'media/clip.mp4', sourceToken: 'source-1' }]
    };

    await expect(client.resolveCanvasSources(input)).resolves.toEqual({ sources: [] });

    const call = harness.calls.at(-1);
    expect(call?.path).toBe('/api/workbench/bindings/project-1/canvas-sources/resolve');
    expect(JSON.parse(String(call?.init?.body))).toEqual(input);
    client.dispose();
  });

  it('replaces a bound Project directly without prepare, commit, or unload requests', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await client.openProject({ projectRoot: '/tmp/project-1' });
    await expect(client.openProject({ projectRoot: '/tmp/project-2' })).resolves.toMatchObject({
      bindingId: 'project-2'
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
    harness.emit({ type: 'project.preempted', bindingId: 'project-1' });
    await vi.waitFor(() => expect(client.projectProjection.getState()).toMatchObject({
      status: 'detached',
      bindingId: 'project-1'
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
      canonicalRoot: '/tmp/project-2'
    });

    await expect(client.openProject({ projectRoot: '/tmp/project-1' })).resolves.toMatchObject({
      bindingId: 'project-1'
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

  it('commits Product removal with one explicit preservation decision', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await expect(client.removeProduct({ confirmed: true, keepConfig: true })).resolves.toEqual({
      accepted: true,
      configPreserved: true
    });

    const call = harness.calls.at(-1);
    expect(call?.path).toBe('/api/runtime/product/remove');
    expect(call?.init?.method).toBe('POST');
    expect(JSON.parse(String(call?.init?.body))).toEqual({ confirmed: true, keepConfig: true });
    client.dispose();
  });

  it('reveals a Model API key through the authenticated explicit command', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();

    await expect(client.revealModelApiKey('gpt-image-2')).resolves.toEqual({
      apiKey: '  密钥🔑  '
    });

    const reveal = harness.calls.at(-1);
    expect(reveal?.path).toBe('/api/settings/models/api-key/reveal');
    expect(reveal?.init?.method).toBe('POST');
    expect(header(reveal?.init, 'x-debrute-workbench-connection')).toBe('connection-1');
    expect(JSON.parse(String(reveal?.init?.body))).toEqual({
      modelId: 'gpt-image-2'
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
      '/api/workbench/bindings/project-1/working-copies/text/draft.md'
    );
    await client.clearFeedbackWorkingCopy('project-1', 'feedback-a');
    expect(harness.calls.at(-1)?.path).toBe(
      '/api/workbench/bindings/project-1/working-copies/feedback/feedback-a'
    );
    client.dispose();
  });

  it('completes a Project mutation only after its stream revision is accepted', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.openProject({ projectRoot: '/tmp/project-1' });
    const mutation = client.resetCanvas();
    let completed = false;
    void mutation.then(() => { completed = true; });

    await vi.waitFor(() => expect(harness.calls.at(-1)?.path).toBe('/api/workbench/bindings/project-1/canvas/reset'));
    await Promise.resolve();
    expect(completed).toBe(false);

    harness.emit({
      type: 'project.changed',
      bindingId: 'project-1',
      projectRevision: 2,
      snapshot: snapshotFixture('/tmp/project-1', 'project-1')
    });
    await expect(mutation).resolves.toMatchObject({ projectRevision: 2 });
    client.dispose();
  });

  it('rejects a Project mutation when the connection ends before its stream revision', async () => {
    const harness = createHarness();
    const client = createHttpWorkbenchApiClient();
    await client.openProject({ projectRoot: '/tmp/project-1' });
    const mutation = client.resetCanvas();

    await vi.waitFor(() => expect(harness.calls.at(-1)?.path).toBe('/api/workbench/bindings/project-1/canvas/reset'));
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

    await vi.waitFor(() => expect(harness.calls.at(-1)?.path).toBe('/api/workbench/bindings/project-1/files/import/uploads'));
    await Promise.resolve();
    expect(completed).toBe(false);

    harness.emit({
      type: 'project.changed',
      bindingId: 'project-1',
      projectRevision: 2,
      snapshot: snapshotFixture('/tmp/project-1', 'project-1')
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
      bindingId: 'project-1',
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
        bindingId: 'project-1',
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

function createHarness(
  globalRevision = 1,
  initialCanonicalRoot?: string,
  initialProjectError?: { code: string; message: string }
) {
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  let projectNumber = 0;
  let currentCanonicalRoot = '';
  let focusNext = false;
  let pickerSelection: string | undefined;
  let pendingPickerSelection: Promise<string | undefined> | undefined;
  let resolvePendingPickerSelection: ((projectRoot: string | undefined) => void) | undefined;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    calls.push({ path, init });
    if (path === '/api/workbench/connection') {
      const requestedProjectRoot = (JSON.parse(String(init?.body)) as {
        requestedProjectRoot?: string;
      }).requestedProjectRoot;
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
            state: { status: 'off', transferActive: false, sessions: [] }
          }));
          controller.enqueue(sse(encoder, { type: 'product.changed', revision: 1, product: null }));
          controller.enqueue(sse(encoder, {
            type: 'activity.snapshot',
            activityRevision: 0,
            records: []
          }));
          if (requestedProjectRoot) {
            if (initialProjectError) {
              controller.enqueue(sse(encoder, {
                type: 'project.open_failed',
                canonicalRoot: requestedProjectRoot,
                error: initialProjectError
              }));
              return;
            }
            projectNumber += 1;
            const bindingId = `project-${projectNumber}`;
            currentCanonicalRoot = initialCanonicalRoot ?? requestedProjectRoot;
            controller.enqueue(sse(encoder, {
              type: 'project.bound',
              project: {
                bindingId,
                canonicalRoot: currentCanonicalRoot,
                projectRevision: 1,
                snapshot: snapshotFixture(currentCanonicalRoot, bindingId)
              },
              workingCopies: { text: {}, feedback: {} }
            }));
          }
        }
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === '/api/projects/open' || path === '/api/projects/replace') {
      projectNumber += 1;
      const bindingId = `project-${projectNumber}`;
      const request = JSON.parse(String(init?.body)) as { projectRoot: string };
      const canonicalRoot = request.projectRoot;
      if (focusNext) {
        focusNext = false;
        return Response.json({ outcome: 'focused_existing_desktop', canonicalRoot });
      }
      currentCanonicalRoot = canonicalRoot;
      streamController?.enqueue(sse(encoder, {
        type: 'project.bound',
        project: {
          bindingId,
          canonicalRoot,
          projectRevision: 1,
          snapshot: snapshotFixture(canonicalRoot, bindingId)
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
      return Response.json({ outcome: 'bound', bindingId });
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
    if (path === '/api/runtime/product/remove') {
      const request = JSON.parse(String(init?.body)) as { keepConfig: boolean };
      return Response.json({ accepted: true, configPreserved: request.keepConfig });
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
    if (path === '/api/workbench/bindings/project-1/canvas/reset') {
      return Response.json({
        bindingId: 'project-1',
        projectRevision: 2
      });
    }
    if (path === '/api/workbench/bindings/project-1/files/load-directory') {
      streamController?.enqueue(sse(encoder, {
        type: 'project.changed',
        bindingId: 'project-1',
        projectRevision: 2,
        snapshot: snapshotFixture(currentCanonicalRoot, 'project-1')
      }));
      return Response.json({
        bindingId: 'project-1',
        projectRevision: 2
      });
    }
    if (path === '/api/workbench/bindings/project-1/canvas-video-previews/sources') {
      return Response.json({ sources: [] });
    }
    if (path === '/api/workbench/bindings/project-1/canvas-sources/resolve') {
      return Response.json({ sources: [] });
    }
    if (path === '/api/workbench/bindings/project-1/canvas-video-previews/source') {
      return Response.json({
        ok: true,
        source: {
          projectRelativePath: 'media/clip.mp4',
          sourceRevision: 'sha256:video',
          frameTimeMs: 1_500,
          status: 'available',
          sourceWidth: 1920,
          metadata: { width: 1920, height: 1080 }
        }
      });
    }
    if (path === '/api/workbench/bindings/project-1/files/import/uploads') {
      return Response.json({
        bindingId: 'project-1',
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
    pathname: '/',
    search: ''
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

function snapshotFixture(canonicalRoot: string, projectName: string) {
  return {
    canonicalRoot,
    canvasWorkspace: {
      status: 'available',
      workspace: {
        canonicalRoot,
        expandedDirectories: [],
        nodeStates: {},
        occlusionOrder: []
      },
      canvasResources: { resources: [] },
      feedbackVideoResources: { resources: [] }
    },
    projectTree: [],
    diagnostics: [],
    health: {
      projectName,
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
