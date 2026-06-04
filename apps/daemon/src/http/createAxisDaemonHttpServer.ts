import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxisGlobalRuntimeServer, GlobalConfigStore, type AxisAppServer, type AxisAppServerOptions } from '@axis/app-server';
import {
  isAxisMutatingMethod,
  normalizeAxisRuntimeInfo,
  type AppServerEvent,
  type AxisHttpErrorBody,
  type AxisRuntimeInfo,
  type GeneratedAssetRecord,
  type GeneratedAssetView,
  type GeneratedAssetsView,
  type ProjectSessionSnapshot,
  type WorkbenchEvent,
  type WorkbenchFileWatchEvent,
  type WorkbenchProjectSessionSnapshot,
  type WorkbenchProjectTextFile
} from '@axis/app-protocol';
import { projectFileRevision, resolveExistingProjectPath } from '@axis/project-core';
import { ProjectSessionRegistry, type ProjectSessionRecord } from './ProjectSessionRegistry.js';
import { writeRevisionedFileResponse } from './fileResponse.js';

export interface AxisDaemonRuntime extends AxisRuntimeInfo {
  token: string;
}

export interface AxisDaemonHttpServerOptions {
  appServerOptions?: AxisAppServerOptions;
  createAppServer?: () => AxisAppServer;
  host?: string;
  port?: number;
  token?: string;
  webBaseUrl?: string | null;
  webDistDir?: string;
  projectIdleTtlMs?: number;
}

export interface AxisDaemonHttpServer {
  readonly token: string;
  listen(): Promise<AxisDaemonRuntime>;
  close(): Promise<void>;
  runtime(): AxisDaemonRuntime | undefined;
  projectRootForProjectId(projectId: string): string | undefined;
  registerElectronProjectWindow(projectId: string, windowId: number): (() => void) | undefined;
}

interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  runtime: AxisDaemonRuntime;
}

interface ProjectRequestContext extends RequestContext {
  appServer: AxisAppServer;
}

interface GlobalRuntimeRequestContext extends RequestContext {
  globalRuntime: AxisGlobalRuntimeServer;
}

interface ProjectApiRoute {
  projectId: string;
  tail: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export function createAxisDaemonHttpServer(options: AxisDaemonHttpServerOptions = {}): AxisDaemonHttpServer {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const token = options.token ?? randomUUID();
  const sharedConfigStore = options.appServerOptions?.globalConfigStore ?? new GlobalConfigStore();
  const appServerOptions: AxisAppServerOptions = {
    ...options.appServerOptions,
    globalConfigStore: sharedConfigStore
  };
  const globalRuntime = new AxisGlobalRuntimeServer(appServerOptions);
  const sessions = new ProjectSessionRegistry({
    appServerOptions,
    ...(options.createAppServer ? { createAppServer: options.createAppServer } : {}),
    ...(options.projectIdleTtlMs !== undefined ? { idleTtlMs: options.projectIdleTtlMs } : {})
  });
  let runtime: AxisDaemonRuntime | undefined;
  let server: Server | undefined;

  async function listen(): Promise<AxisDaemonRuntime> {
    if (runtime) {
      return runtime;
    }
    assertLoopbackBindHost(host);

    server = createServer((request, response) => {
      void handleRequest(request, response).catch((error) => {
        writeCaughtError(response, error);
      });
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once('error', rejectListen);
      server!.listen(port, host, () => {
        server!.off('error', rejectListen);
        resolveListen();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('AXIS daemon did not bind to a TCP address.');
    }
    const daemonUrl = `http://${host}:${address.port}`;
    runtime = {
      ...normalizeAxisRuntimeInfo({
        daemonUrl,
        webBaseUrl: options.webBaseUrl ?? daemonUrl
      }),
      token
    };
    return runtime;
  }

  async function close(): Promise<void> {
    globalRuntime.close();
    await sessions.close();
    if (!server) {
      return;
    }
    await new Promise<void>((resolveClose, rejectClose) => {
      server!.close((error) => error ? rejectClose(error) : resolveClose());
    });
    server = undefined;
    runtime = undefined;
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!runtime) {
      writeError(response, 503, 'daemon_not_ready', 'AXIS daemon is not ready.');
      return;
    }
    if (!isLoopbackRequest(request)) {
      writeError(response, 403, 'forbidden', 'AXIS daemon only accepts loopback requests.');
      return;
    }
    const url = new URL(request.url ?? '/', runtime.daemonUrl);
    if (url.pathname.startsWith('/api/') && !applyCorsHeaders(request, response, runtime)) {
      writeError(response, 403, 'forbidden', 'AXIS daemon origin is not allowed.');
      return;
    }
    if ((request.method ?? 'GET') === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (isAxisMutatingMethod(request.method ?? 'GET') && !hasDaemonToken(request, token)) {
      writeError(response, 403, 'forbidden', 'AXIS daemon token is required for mutating requests.');
      return;
    }

    const context = { request, response, url, runtime };
    response.setHeader('x-axis-daemon-url', runtime.daemonUrl);

    const handled = await routeApi(context);
    if (handled) {
      return;
    }
    await serveWebAsset(context, options.webDistDir);
  }

  async function routeApi(context: RequestContext): Promise<boolean> {
    const method = context.request.method ?? 'GET';
    const path = context.url.pathname;

    if (method === 'GET' && path === '/api/status') {
      writeJson(context.response, 200, { ok: true, runtime: currentPublicRuntime() });
      return true;
    }
    if ((method === 'GET' || method === 'POST') && path === '/api/runtime') {
      writeJson(context.response, 200, currentPublicRuntime());
      return true;
    }
    if (method === 'GET' && path === '/api/projects') {
      writeJson(context.response, 200, {
        projects: sessions.list().map((session) => ({
          projectId: session.projectId,
          snapshot: snapshotForHttp(session.appServer.currentSnapshot() ?? session.snapshot, currentRuntime().daemonUrl, session.projectId),
          clients: { liveCount: session.clients.size }
        }))
      });
      return true;
    }
    if (method === 'POST' && path === '/api/projects/open') {
      const body = await readJsonBody<{ projectRoot?: unknown }>(context.request);
      const projectRoot = typeof body.projectRoot === 'string' && body.projectRoot.trim()
        ? body.projectRoot
        : undefined;
      if (!projectRoot) {
        writeError(context.response, 400, 'invalid_input', 'projectRoot must be a non-empty string.');
        return true;
      }
      if (!await isDirectoryProjectRoot(projectRoot)) {
        writeError(context.response, 400, 'invalid_input', 'projectRoot must resolve to a directory.');
        return true;
      }
      const session = await sessions.openProject(projectRoot);
      writeJson(context.response, 200, {
        projectId: session.projectId,
        snapshot: snapshotForHttp(session.appServer.currentSnapshot() ?? session.snapshot, currentRuntime().daemonUrl, session.projectId)
      });
      return true;
    }

    const projectRoute = projectApiRoute(path);
    if (projectRoute) {
      const releaseRequest = sessions.registerRequest(projectRoute.projectId);
      const session = sessions.get(projectRoute.projectId);
      if (!releaseRequest || !session) {
        writeProjectNotOpen(context, projectRoute.projectId);
        return true;
      }
      try {
        await routeProjectApi({ ...context, appServer: session.appServer }, projectRoute, session);
      } finally {
        releaseRequest();
      }
      return true;
    }

    if (path.startsWith('/api/projects/')) {
      writeError(context.response, 404, 'not_found', `Unknown AXIS project API route: ${path}`);
      return true;
    }

    if (
      path.startsWith('/api/settings')
      || path.startsWith('/api/models')
      || path.startsWith('/api/integrations')
    ) {
      await handleSettingsRoute({ ...context, globalRuntime });
      return true;
    }
    return false;
  }

  async function routeProjectApi(
    context: ProjectRequestContext,
    projectRoute: ProjectApiRoute,
    session: ProjectSessionRecord
  ): Promise<void> {
    const method = context.request.method ?? 'GET';
    const path = context.url.pathname;
    const tail = projectRoute.tail;
    if (method === 'GET' && tail === '/events') {
      writeEventStream(context, session, globalRuntime, sessions);
      return;
    }
    if (method === 'GET' && tail === '') {
      writeJson(context.response, 200, {
        projectId: session.projectId,
        snapshot: snapshotForHttp(context.appServer.getSnapshot(), currentRuntime().daemonUrl, session.projectId)
      });
      return;
    }
    if (method === 'GET' && tail === '/health') {
      writeJson(context.response, 200, context.appServer.getProjectHealth());
      return;
    }
    if (method === 'POST' && tail === '/refresh') {
      const snapshot = await context.appServer.refreshProject();
      session.snapshot = snapshot;
      writeJson(context.response, 200, snapshotForHttp(snapshot, currentRuntime().daemonUrl, session.projectId));
      return;
    }
    if (method === 'POST' && tail === '/desktop/resolve-path') {
      await handleDesktopResolvePathRoute(context, session);
      return;
    }
    if (tail.startsWith('/files/text/')) {
      await handleTextFileRoute(context, routeTail(tail, '/files/text/'));
      return;
    }
    if (tail.startsWith('/files/raw/')) {
      await handleRawFileRoute(context, routeTail(tail, '/files/raw/'));
      return;
    }
    if (tail === '/files') {
      await handleCreateFileRoute(context, session);
      return;
    }
    if (tail.startsWith('/files/path/')) {
      await handleProjectPathRoute(context, routeTail(tail, '/files/path/'), session);
      return;
    }
    if (tail === '/generated-assets/lookup') {
      if (method !== 'POST') {
        writeError(context.response, 405, 'method_not_allowed', 'Unsupported generated asset lookup method.');
        return;
      }
      const body = await readJsonBody<{ projectRelativePath: string }>(context.request);
      writeJson(context.response, 200, await context.appServer.lookupGeneratedAssetMetadata(body));
      return;
    }
    if (tail === '/generated-assets') {
      if (method !== 'GET') {
        writeError(context.response, 405, 'method_not_allowed', 'Unsupported generated assets collection method.');
        return;
      }
      writeJson(context.response, 200, generatedAssetsForHttp(
        await context.appServer.listGeneratedAssets(),
        currentRuntime().daemonUrl,
        projectRoute.projectId
      ));
      return;
    }
    if (tail.startsWith('/generated-assets/')) {
      await handleGeneratedAssetRoute(context, projectRoute.projectId, routeTail(tail, '/generated-assets/'));
      return;
    }
    if (tail === '/canvas-feedback') {
      if (method === 'GET') {
        writeJson(context.response, 200, await context.appServer.readCanvasFeedback());
        return;
      }
      if (method === 'PATCH') {
        writeJson(context.response, 200, await context.appServer.updateCanvasFeedbackEntry(await readJsonBody(context.request)));
        return;
      }
    }
    if (tail.startsWith('/canvases/')) {
      await handleCanvasRoute(context, tail);
      return;
    }
    if (tail === '/canvas-image-preview') {
      await handleCanvasImagePreviewRoute(context);
      return;
    }
    writeError(context.response, 404, 'not_found', `Unknown AXIS project API route: ${path}`);
  }

  function currentRuntime(): AxisDaemonRuntime {
    if (!runtime) {
      throw new Error('AXIS daemon runtime is unavailable.');
    }
    return runtime;
  }

  function currentPublicRuntime(): AxisRuntimeInfo {
    const { token: _token, ...publicRuntime } = currentRuntime();
    return publicRuntime;
  }

  function writeProjectNotOpen(context: RequestContext, projectId: string): void {
    writeError(context.response, 404, 'project_not_open', `AXIS project is not open: ${projectId}`);
  }

  return {
    token,
    listen,
    close,
    runtime: () => runtime ? currentRuntime() : undefined,
    projectRootForProjectId: (projectId) => sessions.projectRootForProjectId(projectId),
    registerElectronProjectWindow: (projectId, windowId) => sessions.registerClient(projectId, {
      clientId: `electron-window:${windowId}`,
      kind: 'electron-window'
    })
  };
}

async function handleTextFileRoute(context: ProjectRequestContext, projectRelativePath: string): Promise<void> {
  if ((context.request.method ?? 'GET') === 'GET') {
    writeJson(context.response, 200, textFileForHttp(await daemonAppServer(context).readProjectTextFile(projectRelativePath)));
    return;
  }
  if (context.request.method === 'PUT') {
    const body = await readJsonBody<{ content?: unknown }>(context.request);
    if (typeof body.content !== 'string') {
      writeError(context.response, 400, 'invalid_input', 'File content must be a string.');
      return;
    }
    writeJson(context.response, 200, textFileForHttp(await daemonAppServer(context).writeProjectTextFile(projectRelativePath, body.content)));
    return;
  }
  writeError(context.response, 405, 'method_not_allowed', 'Unsupported text file method.');
}

async function handleRawFileRoute(context: ProjectRequestContext, projectRelativePath: string): Promise<void> {
  if ((context.request.method ?? 'GET') !== 'GET') {
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported raw file method.');
    return;
  }
  const snapshot = daemonAppServer(context).getSnapshot();
  const absolutePath = await resolveExistingProjectPath(snapshot.projectRoot, projectRelativePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    writeError(context.response, 404, 'not_found', `Project path is not a file: ${projectRelativePath}`);
    return;
  }
  const revision = context.url.searchParams.get('v');
  if (!revision) {
    writeError(context.response, 400, 'missing_revision', `Project file revision is required for raw file responses: ${projectRelativePath}`);
    return;
  }
  if (revision !== projectFileRevision(fileStat.size, fileStat.mtimeMs)) {
    writeError(context.response, 409, 'stale_revision', `Project file revision does not match source: ${projectRelativePath}`);
    return;
  }
  await writeRevisionedFileResponse({
    request: context.request,
    response: context.response,
    absolutePath,
    contentType: contentTypeFromPath(projectRelativePath)
  });
}

async function handleDesktopResolvePathRoute(context: ProjectRequestContext, session: ProjectSessionRecord): Promise<void> {
  const body = await readJsonBody<{ projectRelativePath?: unknown; kind?: unknown }>(context.request);
  const projectRelativePath = typeof body.projectRelativePath === 'string' && body.projectRelativePath.trim()
    ? body.projectRelativePath
    : undefined;
  const kind = body.kind === 'file' || body.kind === 'directory' ? body.kind : undefined;
  if (!projectRelativePath || !kind) {
    writeError(context.response, 400, 'invalid_input', 'projectRelativePath and kind are required.');
    return;
  }
  const absolutePath = await resolveExistingProjectPath(session.projectRoot, projectRelativePath);
  const resolvedStats = await stat(absolutePath);
  if (kind === 'file' && !resolvedStats.isFile()) {
    writeError(context.response, 400, 'invalid_input', 'Resolved project path is not a file.');
    return;
  }
  if (kind === 'directory' && !resolvedStats.isDirectory()) {
    writeError(context.response, 400, 'invalid_input', 'Resolved project path is not a directory.');
    return;
  }
  writeJson(context.response, 200, { absolutePath });
}

async function handleCreateFileRoute(context: ProjectRequestContext, session: ProjectSessionRecord): Promise<void> {
  if (context.request.method !== 'POST') {
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported file collection method.');
    return;
  }
  const body = await readJsonBody<{ kind?: unknown; parentProjectRelativePath?: unknown; name?: unknown }>(context.request);
  const input = {
    parentProjectRelativePath: stringField(body.parentProjectRelativePath, 'parentProjectRelativePath'),
    name: stringField(body.name, 'name')
  };
  const result = body.kind === 'directory'
    ? await daemonAppServer(context).createProjectDirectory(input)
    : await daemonAppServer(context).createProjectFile(input);
  writeJson(context.response, 200, withHttpSnapshot(result, context.runtime.daemonUrl, session));
}

async function handleProjectPathRoute(context: ProjectRequestContext, path: string, session: ProjectSessionRecord): Promise<void> {
  const server = daemonAppServer(context);
  if (context.request.method === 'PATCH') {
    const body = await readJsonBody<Record<string, unknown>>(context.request);
    const operation = stringField(body.operation, 'operation');
    if (operation === 'rename') {
      writeJson(context.response, 200, withHttpSnapshot(await server.renameProjectPath({
        projectRelativePath: path,
        name: stringField(body.name, 'name')
      }), context.runtime.daemonUrl, session));
      return;
    }
    if (operation === 'copy') {
      writeJson(context.response, 200, withHttpSnapshot(await server.copyProjectPath({
        sourceProjectRelativePath: path,
        targetDirectoryProjectRelativePath: stringField(body.targetDirectoryProjectRelativePath, 'targetDirectoryProjectRelativePath')
      }), context.runtime.daemonUrl, session));
      return;
    }
    if (operation === 'move') {
      writeJson(context.response, 200, withHttpSnapshot(await server.moveProjectPath({
        sourceProjectRelativePath: path,
        targetDirectoryProjectRelativePath: stringField(body.targetDirectoryProjectRelativePath, 'targetDirectoryProjectRelativePath')
      }), context.runtime.daemonUrl, session));
      return;
    }
  }
  if (context.request.method === 'DELETE') {
    writeJson(context.response, 200, withHttpSnapshot(await server.deleteProjectPathPermanently({ projectRelativePath: path }), context.runtime.daemonUrl, session));
    return;
  }
  writeError(context.response, 405, 'method_not_allowed', 'Unsupported project path method.');
}

async function handleCanvasRoute(context: ProjectRequestContext, tail: string): Promise<void> {
  const server = daemonAppServer(context);
  const path = context.url.pathname;
  const canvasId = decodePathSegment(tail.slice('/canvases/'.length).split('/')[0]!);
  if (path.endsWith('/node-layouts') && context.request.method === 'PATCH') {
    writeJson(context.response, 200, await server.updateCanvasNodeLayouts({
      canvasId,
      ...await readJsonBody<object>(context.request)
    }));
    return;
  }
  if (path.endsWith('/node-layers') && context.request.method === 'PATCH') {
    writeJson(context.response, 200, await server.updateCanvasNodeLayers({
      canvasId,
      ...await readJsonBody<object>(context.request)
    }));
    return;
  }
  if (context.request.method === 'GET') {
    const snapshot = server.getSnapshot();
    writeJson(context.response, 200, snapshot.canvases.find((canvas) => canvas.id === canvasId));
    return;
  }
  writeError(context.response, 405, 'method_not_allowed', 'Unsupported Canvas method.');
}

async function handleCanvasImagePreviewRoute(context: ProjectRequestContext): Promise<void> {
  if ((context.request.method ?? 'GET') !== 'GET') {
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported Canvas image preview method.');
    return;
  }
  const projectRelativePath = context.url.searchParams.get('path') ?? '';
  const revision = context.url.searchParams.get('v') ?? '';
  const width = Number(context.url.searchParams.get('w') ?? '');
  const preview = await daemonAppServer(context).resolveCanvasImagePreview({
    projectRelativePath,
    revision,
    width,
    abortSignal: AbortSignal.timeout(30_000)
  });
  await writeRevisionedFileResponse({
    request: context.request,
    response: context.response,
    absolutePath: preview.absolutePath,
    contentType: contentTypeFromPath(preview.absolutePath)
  });
}

async function handleGeneratedAssetRoute(context: ProjectRequestContext, projectId: string, tail: string): Promise<void> {
  const [assetId, operation] = tail.split('/');
  if (!assetId) {
    writeError(context.response, 404, 'not_found', 'Generated asset id is required.');
    return;
  }
  const recordId = decodePathSegment(assetId);
  if (operation === 'raw') {
    if ((context.request.method ?? 'GET') !== 'GET') {
      writeError(context.response, 405, 'method_not_allowed', 'Unsupported generated asset raw method.');
      return;
    }
    const absolutePath = await daemonAppServer(context).resolveGeneratedAssetRawPath(recordId);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      writeError(context.response, 404, 'not_found', `Generated asset raw path is not a file: ${recordId}`);
      return;
    }
    context.response.writeHead(200, {
      'content-length': String(fileStat.size),
      'content-type': contentTypeFromPath(absolutePath)
    });
    await new Promise<void>((resolvePipe, rejectPipe) => {
      createReadStream(absolutePath)
        .once('error', rejectPipe)
        .once('end', resolvePipe)
        .pipe(context.response);
    });
    return;
  }
  if (operation) {
    writeError(context.response, 404, 'not_found', `Unknown generated asset route: ${tail}`);
    return;
  }
  if ((context.request.method ?? 'GET') !== 'GET') {
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported generated asset method.');
    return;
  }
  const record = await daemonAppServer(context).readGeneratedAsset(recordId);
  writeJson(context.response, 200, generatedAssetForHttp(record, context.runtime.daemonUrl, projectId));
}

async function handleSettingsRoute(context: GlobalRuntimeRequestContext): Promise<void> {
  const server = context.globalRuntime;
  const method = context.request.method ?? 'GET';
  const path = context.url.pathname;
  if (method === 'GET' && path === '/api/settings') {
    writeJson(context.response, 200, {
      canvas: await server.canvasSettingsGet(),
      llm: await server.llmGetSettings(),
      imageModels: await server.imageModelGetSettings(),
      videoModels: await server.videoModelGetSettings(),
      integrations: await server.integrationsListStatus()
    });
    return;
  }
  if (method === 'GET' && path === '/api/settings/canvas') {
    writeJson(context.response, 200, await server.canvasSettingsGet());
    return;
  }
  if (method === 'PUT' && path === '/api/settings/canvas') {
    writeJson(context.response, 200, await server.canvasSettingsSave(await readJsonBody(context.request)));
    return;
  }
  if (method === 'GET' && path === '/api/settings/llm') {
    writeJson(context.response, 200, await server.llmGetSettings());
    return;
  }
  if (method === 'PUT' && path.startsWith('/api/settings/llm/providers/')) {
    writeJson(context.response, 200, await server.llmSaveProviderSetting(await readJsonBody(context.request), decodePathSegment(path.split('/').at(-1)!)));
    return;
  }
  if (method === 'POST' && path === '/api/settings/llm/providers') {
    writeJson(context.response, 200, await server.llmSaveProviderSetting(await readJsonBody(context.request)));
    return;
  }
  if (method === 'DELETE' && path.startsWith('/api/settings/llm/providers/')) {
    writeJson(context.response, 200, await server.llmDeleteProviderSetting(decodePathSegment(path.split('/').at(-1)!)));
    return;
  }
  if (method === 'PUT' && path === '/api/settings/llm/default-model') {
    const body = await readJsonBody<{ modelKey?: string | null }>(context.request);
    writeJson(context.response, 200, await server.llmSetDefaultModelKey(body.modelKey ?? null));
    return;
  }
  if (method === 'POST' && path === '/api/settings/llm/discover-models') {
    const body = await readJsonBody<{ input?: unknown; providerId?: string }>(context.request);
    writeJson(context.response, 200, await server.llmDiscoverProviderModels(body.input as never, body.providerId));
    return;
  }
  if (method === 'GET' && path === '/api/models/image') {
    writeJson(context.response, 200, await server.imageModelGetSettings());
    return;
  }
  if (method === 'PUT' && path.startsWith('/api/models/image/')) {
    writeJson(context.response, 200, await server.imageModelSaveSetting(decodePathSegment(path.split('/').at(-1)!), await readJsonBody(context.request)));
    return;
  }
  if (method === 'GET' && path === '/api/models/video') {
    writeJson(context.response, 200, await server.videoModelGetSettings());
    return;
  }
  if (method === 'PUT' && path.startsWith('/api/models/video/')) {
    writeJson(context.response, 200, await server.videoModelSaveSetting(decodePathSegment(path.split('/').at(-1)!), await readJsonBody(context.request)));
    return;
  }
  if (method === 'GET' && path === '/api/integrations') {
    writeJson(context.response, 200, await server.integrationsListStatus());
    return;
  }
  if (method === 'POST' && path === '/api/integrations/rescan') {
    writeJson(context.response, 200, await server.integrationsRescan());
    return;
  }
  writeError(context.response, 404, 'not_found', `Unknown AXIS API route: ${path}`);
}

function writeEventStream(
  context: RequestContext,
  session: ProjectSessionRecord,
  globalRuntime: AxisGlobalRuntimeServer,
  sessions: ProjectSessionRegistry
): void {
  const clientId = context.url.searchParams.get('clientId') || randomUUID();
  const releaseClient = sessions.registerClient(session.projectId, { clientId, kind: 'sse' });
  context.response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  context.response.write('\n');
  const unsubscribeProject = session.appServer.onEvent((event) => {
    updateSessionSnapshotFromEvent(session, event);
    context.response.write(`event: message\ndata: ${JSON.stringify(eventForHttp(event, context.runtime.daemonUrl, session.projectId))}\n\n`);
  });
  const unsubscribeGlobal = globalRuntime.onEvent((event) => {
    if (!isGlobalEvent(event)) {
      return;
    }
    context.response.write(`event: message\ndata: ${JSON.stringify(eventForHttp(event, context.runtime.daemonUrl, session.projectId))}\n\n`);
  });
  const keepalive = setInterval(() => {
    context.response.write(': keepalive\n\n');
  }, 15_000);
  const cleanup = (): void => {
    clearInterval(keepalive);
    unsubscribeProject();
    unsubscribeGlobal();
    releaseClient?.();
  };
  context.request.once('close', cleanup);
}

function isGlobalEvent(event: AppServerEvent): boolean {
  return event.type === 'llm.settings.changed'
    || event.type === 'imageModel.settings.changed'
    || event.type === 'videoModel.settings.changed'
    || event.type === 'integrations.settings.changed'
    || event.type === 'canvas.settings.changed';
}

function updateSessionSnapshotFromEvent(session: ProjectSessionRecord, event: AppServerEvent): void {
  if (event.type === 'project.opened' || event.type === 'project.changed' || event.type === 'project.fileChanged') {
    session.snapshot = event.snapshot;
  }
}

async function serveWebAsset(context: RequestContext, configuredWebDistDir: string | undefined): Promise<void> {
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    writeError(context.response, 404, 'not_found', `Unknown AXIS route: ${context.url.pathname}`);
    return;
  }
  const webDistDir = configuredWebDistDir ?? defaultWebDistDir();
  const path = context.url.pathname === '/' || shouldServeIndex(context.url.pathname)
    ? 'index.html'
    : context.url.pathname.replace(/^\/+/, '');
  const absolutePath = resolve(webDistDir, path);
  if (!absolutePath.startsWith(resolve(webDistDir))) {
    writeError(context.response, 404, 'not_found', 'Asset path is outside the AXIS web directory.');
    return;
  }
  try {
    const asset = await readFile(absolutePath);
    context.response.writeHead(200, { 'content-type': contentTypeFromPath(absolutePath) });
    if (context.request.method !== 'HEAD') {
      context.response.end(asset);
    } else {
      context.response.end();
    }
  } catch {
    if (path !== 'index.html' && shouldServeIndex(context.url.pathname)) {
      const asset = await readFile(resolve(webDistDir, 'index.html'));
      context.response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      context.response.end(asset);
      return;
    }
    writeError(context.response, 404, 'not_found', `AXIS web asset is missing: ${context.url.pathname}`);
  }
}

function snapshotForHttp(snapshot: ProjectSessionSnapshot, daemonUrl: string, projectId: string): WorkbenchProjectSessionSnapshot {
  const { projectRoot: _projectRoot, ...publicSnapshot } = snapshot;
  return {
    ...publicSnapshot,
    projections: snapshot.projections.map((projection) => projectionForHttp(projection, daemonUrl, projectId))
  };
}

function projectionForHttp(
  projection: ProjectSessionSnapshot['projections'][number],
  daemonUrl: string,
  projectId: string
): ProjectSessionSnapshot['projections'][number] {
  return {
    ...projection,
    nodes: projection.nodes.map((node) => ({
      ...node,
      availability: node.availability.state === 'available'
        ? {
            ...node.availability,
            fileUrl: rawFileUrl(daemonUrl, projectId, node.projectRelativePath, node.availability.revision)
          }
        : node.availability
    }))
  };
}

function textFileForHttp(file: { absolutePath: string } & WorkbenchProjectTextFile): WorkbenchProjectTextFile {
  const { absolutePath: _absolutePath, ...publicFile } = file;
  return publicFile;
}

function eventForHttp(
  event: AppServerEvent,
  daemonUrl: string,
  projectId: string
): WorkbenchEvent {
  if (event.type === 'project.opened' || event.type === 'project.changed' || event.type === 'project.fileChanged') {
    if (event.type === 'project.fileChanged') {
      const { absolutePath: _absolutePath, ...publicEvent } = event.event;
      return {
        ...event,
        event: publicEvent satisfies WorkbenchFileWatchEvent,
        snapshot: snapshotForHttp(event.snapshot, daemonUrl, projectId)
      };
    }
    return {
      ...event,
      snapshot: snapshotForHttp(event.snapshot, daemonUrl, projectId)
    };
  }
  if (event.type === 'canvas.changed') {
    return {
      ...event,
      projection: projectionForHttp(event.projection, daemonUrl, projectId)
    };
  }
  return event;
}

function withHttpSnapshot<T extends { snapshot: ProjectSessionSnapshot }>(
  result: T,
  daemonUrl: string,
  session: ProjectSessionRecord
): Omit<T, 'snapshot'> & { snapshot: WorkbenchProjectSessionSnapshot } {
  session.snapshot = result.snapshot;
  return {
    ...result,
    snapshot: snapshotForHttp(result.snapshot, daemonUrl, session.projectId)
  };
}

function generatedAssetsForHttp(records: GeneratedAssetRecord[], daemonUrl: string, projectId: string): GeneratedAssetsView {
  return {
    assets: records.map((record) => generatedAssetForHttp(record, daemonUrl, projectId))
  };
}

function generatedAssetForHttp(record: GeneratedAssetRecord, daemonUrl: string, projectId: string): GeneratedAssetView {
  return {
    assetId: record.recordId,
    projectRelativePath: record.projectRelativePath,
    rawUrl: generatedAssetRawUrl(daemonUrl, projectId, record.recordId),
    record
  };
}

function generatedAssetRawUrl(daemonUrl: string, projectId: string, recordId: string): string {
  return new URL(`/api/projects/${encodeURIComponent(projectId)}/generated-assets/${encodeURIComponent(recordId)}/raw`, daemonUrl).toString();
}

function rawFileUrl(daemonUrl: string, projectId: string, projectRelativePath: string, revision: string): string {
  const encodedPath = projectRelativePath.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/files/raw/${encodedPath}`, daemonUrl);
  url.searchParams.set('v', revision);
  return url.toString();
}

function applyCorsHeaders(request: IncomingMessage, response: ServerResponse, runtime: AxisDaemonRuntime): boolean {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  if (origin !== runtime.daemonUrl && origin !== runtime.webBaseUrl) {
    return false;
  }
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type,x-axis-daemon-token');
  response.setHeader('access-control-max-age', '600');
  response.setHeader('vary', 'origin');
  return true;
}

function hasDaemonToken(request: IncomingMessage, token: string): boolean {
  return request.headers['x-axis-daemon-token'] === token;
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function assertLoopbackBindHost(host: string): void {
  if (host !== DEFAULT_HOST) {
    throw new Error(`AXIS daemon host must be loopback: ${host}`);
  }
}

function projectApiRoute(path: string): ProjectApiRoute | undefined {
  const match = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!match?.[1]) {
    return undefined;
  }
  return {
    projectId: decodePathSegment(match[1]),
    tail: match[2] ? `/${match[2]}` : ''
  };
}

function routeTail(path: string, marker: string): string {
  if (!path.startsWith(marker)) {
    throw new Error(`Invalid AXIS route: ${path}`);
  }
  return path.slice(marker.length).split('/').map(decodePathSegment).join('/');
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > BODY_LIMIT_BYTES) {
      throw new AxisDaemonHttpError(413, 'request_body_too_large', 'AXIS API request body is too large.');
    }
  }
  if (!body.trim()) {
    return {} as T;
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new AxisDaemonHttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function writeError(response: ServerResponse, statusCode: number, code: string, message: string): void {
  const body: AxisHttpErrorBody = {
    error: { code, message }
  };
  writeJson(response, statusCode, body);
}

function writeCaughtError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  if (error instanceof AxisDaemonHttpError) {
    writeError(response, error.statusCode, error.code, error.message);
    return;
  }
  if (isNodeError(error) && error.code === 'ENOENT') {
    writeError(response, 404, 'not_found', 'AXIS project path was not found.');
    return;
  }
  const message = errorMessage(error);
  if (message.includes('escapes project root through a symlink')) {
    writeError(response, 403, 'project_path_forbidden', message);
    return;
  }
  if (message.startsWith('Project path must')) {
    writeError(response, 400, 'invalid_project_path', message);
    return;
  }
  writeError(response, 500, 'internal_error', message);
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new AxisDaemonHttpError(400, 'invalid_input', `${name} must be a string.`);
  }
  return value;
}

async function isDirectoryProjectRoot(projectRoot: string): Promise<boolean> {
  try {
    return (await stat(projectRoot)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

function daemonAppServer(context: ProjectRequestContext): AxisAppServer {
  return context.appServer;
}

function shouldServeIndex(path: string): boolean {
  return !path.startsWith('/api/') && !extname(path);
}

function defaultWebDistDir(): string {
  return resolve(fileURLToPath(new URL('../../../../apps/web/dist', import.meta.url)));
}

function contentTypeFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new AxisDaemonHttpError(400, 'invalid_path_encoding', 'AXIS API path segment is not valid percent-encoding.');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

class AxisDaemonHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
