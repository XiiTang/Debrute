import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join as joinFileSystemPath, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';
import { DebruteAppServer, DebruteGlobalRuntimeServer, GlobalConfigStore, type DebruteAppServerOptions } from '@debrute/app-server';
import { redactRuntimeSecretString, redactRuntimeSecrets } from '@debrute/capability-runtime';
import {
  normalizeDebruteRuntimeInfo,
  type AdobeBridgeSettings,
  type AppServerEvent,
  type DaemonBridgeImportRequestMessage,
  type DaemonCliCommandRequest,
  type DaemonProjectUploadImportPlan,
  type DebruteHttpErrorBody,
  type DebruteRuntimeInfo,
  type GeneratedAssetRecord,
  type GeneratedAssetView,
  type GeneratedAssetsView,
  type ProjectSessionSnapshot,
  type TerminalEvent,
  type WorkbenchEvent,
  type WorkbenchFileWatchEvent,
  type WorkbenchProjectPathEntry,
  type WorkbenchProjectSessionSnapshot,
  type WorkbenchProjectTextFile
} from '@debrute/app-protocol';
import { projectFileRevision, projectImageMimeTypeFromPath, resolveExistingProjectPath, type ProjectUploadImportEntry } from '@debrute/project-core';
import { createAdobeBridgeDiscoveryServer } from '../adobe-bridge/AdobeBridgeDiscoveryServer.js';
import {
  pruneAdobeBridgeTransferContents,
  routeAdobeBridgeHttp,
  syncAdobeBridgeProjects,
  type AdobeBridgeTransferContentEntry,
  writeAdobeBridgeCaughtError
} from '../adobe-bridge/AdobeBridgeHttpRoutes.js';
import { AdobeBridgeService } from '../adobe-bridge/AdobeBridgeService.js';
import { createAdobeBridgeWebSocketRoutes } from '../adobe-bridge/AdobeBridgeWebSocketRoutes.js';
import { ProjectRevisionConflictError, ProjectSessionRegistry, type ProjectSessionRecord } from './ProjectSessionRegistry.js';
import { writeRevisionedFileResponse } from './fileResponse.js';
import { createNodeNativeShell, type DebruteNativeShell } from './nativeShell.js';
import {
  copyProjectAbsolutePaths,
  revealProjectPathInSystemFileManager,
  trashProjectPathsWithNativeShell
} from './projectNativeFileOperations.js';
import { runDaemonCliCommand } from './cliCommandRoutes.js';

export interface DebruteDaemonRuntime extends DebruteRuntimeInfo {
  token: string;
}

export interface DebruteDaemonHttpServerOptions {
  appServerOptions?: DebruteAppServerOptions;
  createAppServer?: () => DebruteAppServer;
  host?: string;
  port?: number;
  token?: string;
  nativeShell?: DebruteNativeShell;
  webBaseUrl?: string | null;
  webDistDir?: string;
  projectIdleTtlMs?: number;
  adobeBridgeDiscoveryPort?: number;
}

export interface DebruteDaemonHttpServer {
  readonly token: string;
  listen(): Promise<DebruteDaemonRuntime>;
  close(): Promise<void>;
  runtime(): DebruteDaemonRuntime | undefined;
  projectRootForProjectId(projectId: string): string | undefined;
}

interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  runtime: DebruteDaemonRuntime;
}

interface ProjectRequestContext extends RequestContext {
  appServer: DebruteAppServer;
  session: ProjectSessionRecord;
  sessions: ProjectSessionRegistry;
}

interface GlobalRuntimeRequestContext extends RequestContext {
  globalRuntime: DebruteGlobalRuntimeServer;
}

interface ProjectApiRoute {
  projectId: string;
  tail: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const PHOTOSHOP_UXP_ORIGIN = 'uxp://com.debrute.photoshop.bridge';
const PHOTOSHOP_CEP_ORIGINS = new Set(['null', 'file://']);
const CORS_ALLOWED_HEADERS = [
  'content-type',
  'x-debrute-daemon-token',
  'x-debrute-adobe-client-id',
  'x-debrute-transfer-id',
  'x-debrute-target-directory',
  'x-debrute-suggested-name'
].join(',');

interface MultipartUploadFilePart {
  temporaryPath: string;
}

interface MultipartUploadParts {
  fields: Map<string, string>;
  files: Map<string, MultipartUploadFilePart>;
  cleanup(): Promise<void>;
}

export function createDebruteDaemonHttpServer(options: DebruteDaemonHttpServerOptions = {}): DebruteDaemonHttpServer {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const token = options.token ?? randomUUID();
  const nativeShell = options.nativeShell ?? createNodeNativeShell();
  const sharedConfigStore = options.appServerOptions?.globalConfigStore ?? new GlobalConfigStore();
  const appServerOptions: DebruteAppServerOptions = {
    ...options.appServerOptions,
    globalConfigStore: sharedConfigStore
  };
  const globalRuntime = new DebruteGlobalRuntimeServer(appServerOptions);
  const adobeBridge = new AdobeBridgeService();
  const adobeBridgeTransferContents = new Map<string, AdobeBridgeTransferContentEntry>();
  const adobeBridgeWebSockets = createAdobeBridgeWebSocketRoutes({ bridge: adobeBridge });
  const unsubscribeAdobeBridgeTransferContentPrune = adobeBridge.onEvent((state) => {
    pruneAdobeBridgeTransferContents({
      transferContents: adobeBridgeTransferContents,
      state
    });
  });
  let adobeBridgeProjectSyncQueued = false;
  const sessions = new ProjectSessionRegistry({
    appServerOptions,
    ...(options.createAppServer ? { createAppServer: options.createAppServer } : {}),
    ...(options.projectIdleTtlMs !== undefined ? { idleTtlMs: options.projectIdleTtlMs } : {}),
    onChange: () => scheduleAdobeBridgeProjectSync()
  });
  let runtime: DebruteDaemonRuntime | undefined;
  let server: Server | undefined;
  const adobeBridgeDiscovery = createAdobeBridgeDiscoveryServer({
    ...(options.adobeBridgeDiscoveryPort !== undefined ? { port: options.adobeBridgeDiscoveryPort } : {}),
    snapshot: () => {
      const current = currentRuntime();
      return {
        product: 'debrute',
        bridgeVersion: 1,
        enabled: adobeBridge.state().settings.enabled,
        daemonUrl: current.daemonUrl,
        apiBaseUrl: `${current.daemonUrl}/api/adobe-bridge`,
        wsUrl: current.daemonUrl.replace(/^http:/, 'ws:') + '/api/adobe-bridge/plugin/ws'
      };
    }
  });
  const electronWindowLeases = new Map<string, () => void>();

  async function listen(): Promise<DebruteDaemonRuntime> {
    if (runtime) {
      return runtime;
    }
    assertLoopbackBindHost(host);

    server = createServer((request, response) => {
      void handleRequest(request, response).catch((error) => {
        writeCaughtError(response, error);
      });
    });
    server.on('upgrade', (request, socket, head) => {
      if (adobeBridgeWebSockets.handleUpgrade(request, socket, head)) {
        return;
      }
      socket.destroy();
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
      throw new Error('Debrute daemon did not bind to a TCP address.');
    }
    const daemonUrl = `http://${host}:${address.port}`;
    runtime = {
      ...normalizeDebruteRuntimeInfo({
        daemonUrl,
        webBaseUrl: options.webBaseUrl ?? daemonUrl,
        platform: nativeShell.platform
      }),
      token
    };
    await adobeBridgeDiscovery.listen();
    adobeBridge.setSettings(await adobeBridgeSettings());
    syncAdobeBridgeProjectState();
    return runtime;
  }

  async function close(): Promise<void> {
    for (const release of electronWindowLeases.values()) {
      release();
    }
    electronWindowLeases.clear();
    globalRuntime.close();
    unsubscribeAdobeBridgeTransferContentPrune();
    await adobeBridgeWebSockets.close();
    await adobeBridgeDiscovery.close();
    adobeBridge.dispose();
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
      writeError(response, 503, 'daemon_not_ready', 'Debrute daemon is not ready.');
      return;
    }
    if (!isLoopbackRequest(request)) {
      writeError(response, 403, 'forbidden', 'Debrute daemon only accepts loopback requests.');
      return;
    }
    const url = new URL(request.url ?? '/', runtime.daemonUrl);
    if (url.pathname.startsWith('/api/') && !applyCorsHeaders(request, response, runtime, url.pathname)) {
      writeError(response, 403, 'forbidden', 'Debrute daemon origin is not allowed.');
      return;
    }
    if ((request.method ?? 'GET') === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (requiresDaemonToken(url.pathname) && !hasDaemonToken(request, url, token)) {
      writeError(response, 403, 'forbidden', 'Debrute daemon token is required for API requests.');
      return;
    }

    const context = { request, response, url, runtime };
    response.setHeader('x-debrute-daemon-url', runtime.daemonUrl);

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
    if (path === '/api/runtime') {
      if (method === 'GET') {
        writeJson(context.response, 200, currentPublicRuntime());
      } else {
        writeError(context.response, 405, 'method_not_allowed', 'Unsupported runtime metadata method.');
      }
      return true;
    }
    if (method === 'GET' && path === '/api/projects') {
      writeJson(context.response, 200, {
        projects: sessions.list().map((session) => ({
          projectId: session.projectId,
          projectRevision: session.projectRevision,
          snapshot: snapshotForHttp(session.appServer.currentSnapshot() ?? session.snapshot, currentRuntime().daemonUrl, session.projectId, currentRuntime().token),
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
        projectRevision: session.projectRevision,
        snapshot: snapshotForHttp(session.appServer.currentSnapshot() ?? session.snapshot, currentRuntime().daemonUrl, session.projectId, currentRuntime().token)
      });
      return true;
    }
    if (method === 'POST' && path === '/api/cli/run') {
      const body = await readJsonBody<DaemonCliCommandRequest>(context.request);
      writeJson(context.response, 200, await runCliCommand(body));
      return true;
    }
    if (method === 'POST' && path === '/api/cli/run-stream') {
      const body = await readJsonBody<DaemonCliCommandRequest>(context.request);
      context.response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const result = await runCliCommand(body, {
        onProgress: (command, fields) => {
          context.response.write(`${JSON.stringify({ type: 'progress', command, fields })}\n`);
        }
      });
      context.response.write(`${JSON.stringify({ type: 'result', result })}\n`);
      context.response.end();
      return true;
    }

    if (await routeAdobeBridgeHttp({
      ...context,
      daemonUrl: currentRuntime().daemonUrl,
      bridge: adobeBridge,
      sessions,
      getSettings: adobeBridgeSettings,
      saveSettings: saveAdobeBridgeSettings,
      readJsonBody,
      sendImportRequest: sendAdobeBridgeImportRequest,
      transferContents: adobeBridgeTransferContents
    })) {
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
        await routeProjectApi({ ...context, appServer: session.appServer, session, sessions }, projectRoute, session);
      } finally {
        releaseRequest();
      }
      return true;
    }

    if (path.startsWith('/api/projects/')) {
      writeError(context.response, 404, 'not_found', `Unknown Debrute project API route: ${path}`);
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

  async function runCliCommand(
    body: DaemonCliCommandRequest,
    services: Pick<Parameters<typeof runDaemonCliCommand>[1], 'onProgress'> = {}
  ) {
    const cliServer = options.createAppServer?.() ?? new DebruteAppServer(appServerOptions);
    try {
      return await runDaemonCliCommand(body, {
        server: cliServer,
        ...services
      });
    } finally {
      cliServer.close();
    }
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
      writeEventStream(context, session, globalRuntime, sessions, adobeBridge);
      return;
    }
    if (method === 'GET' && tail === '') {
      writeJson(context.response, 200, {
        projectId: session.projectId,
        projectRevision: session.projectRevision,
        snapshot: snapshotForHttp(context.appServer.getSnapshot(), currentRuntime().daemonUrl, session.projectId, currentRuntime().token)
      });
      return;
    }
    if (method === 'GET' && tail === '/health') {
      writeJson(context.response, 200, context.appServer.getProjectHealth());
      return;
    }
    if (tail.startsWith('/electron-windows/')) {
      handleElectronWindowLeaseRoute(context, projectRoute.projectId, routeTail(tail, '/electron-windows/'), electronWindowLeases);
      return;
    }
    if (tail === '/terminals' || tail.startsWith('/terminals/')) {
      await handleTerminalRoute(context, tail);
      return;
    }
    if (method === 'POST' && tail === '/refresh') {
      const result = await context.sessions.runProjectOperation(session.projectId, async (record) => {
        const snapshot = await record.appServer.refreshProject();
        return {
          snapshot: snapshotForHttp(snapshot, currentRuntime().daemonUrl, session.projectId, currentRuntime().token)
        };
      });
      writeJson(context.response, 200, result);
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
    if (tail === '/files/import/local') {
      await handleExternalLocalImportRoute(context, session);
      return;
    }
    if (tail === '/files/import/uploads') {
      await handleExternalUploadImportRoute(context, session);
      return;
    }
    if (tail.startsWith('/files/batch/')) {
      await handleProjectPathBatchRoute(context, routeTail(tail, '/files/batch/'), session);
      return;
    }
    if (tail.startsWith('/files/path/batch/')) {
      await handleNativeProjectPathBatchRoute(context, routeTail(tail, '/files/path/batch/'), session, nativeShell);
      return;
    }
    const nativeProjectPathRoute = method === 'POST'
      ? parseNativeProjectPathRoute(tail)
      : undefined;
    if (nativeProjectPathRoute) {
      await handleNativeProjectPathRoute(context, nativeProjectPathRoute, session, nativeShell);
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
        projectRoute.projectId,
        currentRuntime().token
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
        const body = await readJsonBody<Record<string, unknown>>(context.request);
        const result = await runRevisionedMutation(context, baseRevisionField(body), async () => ({
          feedback: await context.appServer.updateCanvasFeedbackEntry(body as never)
        }));
        writeJson(context.response, 200, result);
        return;
      }
    }
    if (tail === '/canvases' || tail.startsWith('/canvases/')) {
      await handleCanvasRoute(context, tail, session);
      return;
    }
    if (tail === '/canvas-image-preview') {
      await handleCanvasImagePreviewRoute(context);
      return;
    }
    writeError(context.response, 404, 'not_found', `Unknown Debrute project API route: ${path}`);
  }

  function currentRuntime(): DebruteDaemonRuntime {
    if (!runtime) {
      throw new Error('Debrute daemon runtime is unavailable.');
    }
    return runtime;
  }

  function currentPublicRuntime(): DebruteRuntimeInfo {
    const { token: _token, ...publicRuntime } = currentRuntime();
    return publicRuntime;
  }

  function writeProjectNotOpen(context: RequestContext, projectId: string): void {
    writeError(context.response, 404, 'project_not_open', `Debrute project is not open: ${projectId}`);
  }

  async function adobeBridgeSettings(): Promise<AdobeBridgeSettings> {
    const settings = await globalRuntime.adobeBridgeGetSettings();
    if (!settings.enabled) {
      return { enabled: false, discoveryStatus: 'disabled' };
    }
    return {
      enabled: true,
      discoveryStatus: adobeBridgeDiscovery.status()?.status === 'available' ? 'available' : 'unavailable'
    };
  }

  async function saveAdobeBridgeSettings(input: { enabled: boolean }): Promise<AdobeBridgeSettings> {
    await globalRuntime.adobeBridgeSaveSettings(input);
    return adobeBridgeSettings();
  }

  function syncAdobeBridgeProjectState(): void {
    syncAdobeBridgeProjects({ bridge: adobeBridge, sessions });
  }

  function scheduleAdobeBridgeProjectSync(): void {
    if (adobeBridgeProjectSyncQueued) {
      return;
    }
    adobeBridgeProjectSyncQueued = true;
    queueMicrotask(() => {
      adobeBridgeProjectSyncQueued = false;
      syncAdobeBridgeProjectState();
    });
  }

  function sendAdobeBridgeImportRequest(
    adobeClientId: string,
    message: DaemonBridgeImportRequestMessage
  ): boolean {
    return adobeBridgeWebSockets.sendImportRequest(adobeClientId, message);
  }

  return {
    token,
    listen,
    close,
    runtime: () => runtime ? currentRuntime() : undefined,
    projectRootForProjectId: (projectId) => sessions.projectRootForProjectId(projectId)
  };
}

function handleElectronWindowLeaseRoute(
  context: ProjectRequestContext,
  projectId: string,
  windowId: string,
  electronWindowLeases: Map<string, () => void>
): void {
  if (!windowId) {
    writeError(context.response, 404, 'not_found', 'Electron window id is required.');
    return;
  }
  const key = electronWindowLeaseKey(projectId, windowId);
  if (context.request.method === 'PUT') {
    electronWindowLeases.get(key)?.();
    const release = context.sessions.registerClient(projectId, {
      clientId: `electron-window:${windowId}`,
      kind: 'electron-window'
    });
    if (!release) {
      writeError(context.response, 404, 'project_not_open', `Debrute project is not open: ${projectId}`);
      return;
    }
    electronWindowLeases.set(key, () => {
      release();
      electronWindowLeases.delete(key);
    });
    context.response.writeHead(204);
    context.response.end();
    return;
  }
  if (context.request.method === 'DELETE') {
    electronWindowLeases.get(key)?.();
    context.response.writeHead(204);
    context.response.end();
    return;
  }
  writeError(context.response, 405, 'method_not_allowed', 'Unsupported Electron window lease method.');
}

function electronWindowLeaseKey(projectId: string, windowId: string): string {
  return `${projectId}\0${windowId}`;
}

async function handleTextFileRoute(context: ProjectRequestContext, projectRelativePath: string): Promise<void> {
  if ((context.request.method ?? 'GET') === 'GET') {
    writeJson(context.response, 200, textFileForHttp(await daemonAppServer(context).readProjectTextFile(projectRelativePath)));
    return;
  }
  if (context.request.method === 'PUT') {
    const body = await readJsonBody<Record<string, unknown>>(context.request);
    if (typeof body.content !== 'string') {
      writeError(context.response, 400, 'invalid_input', 'File content must be a string.');
      return;
    }
    const result = await runRevisionedMutation(context, baseRevisionField(body), async () => ({
      file: textFileForHttp(await daemonAppServer(context).writeProjectTextFile(projectRelativePath, body.content as string))
    }));
    writeJson(context.response, 200, result);
    return;
  }
  writeError(context.response, 405, 'method_not_allowed', 'Unsupported text file method.');
}

async function runRevisionedMutation<T extends Record<string, unknown>>(
  context: ProjectRequestContext,
  baseRevision: number,
  mutate: () => Promise<T>
): Promise<T & { projectId: string; projectRevision: number }> {
  try {
    return await context.sessions.runRevisionedMutation(context.session.projectId, baseRevision, async () => mutate());
  } catch (error) {
    if (error instanceof ProjectRevisionConflictError) {
      throw new DebruteDaemonHttpError(409, error.code, error.message, {
        projectId: error.projectId,
        projectRevision: error.projectRevision,
        snapshot: snapshotForHttp(error.snapshot, context.runtime.daemonUrl, context.session.projectId, context.runtime.token)
      });
    }
    throw error;
  }
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

async function handleCreateFileRoute(context: ProjectRequestContext, session: ProjectSessionRecord): Promise<void> {
  if (context.request.method !== 'POST') {
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported file collection method.');
    return;
  }
  const body = await readJsonBody<Record<string, unknown>>(context.request);
  const input = {
    parentProjectRelativePath: stringField(body.parentProjectRelativePath, 'parentProjectRelativePath'),
    name: stringField(body.name, 'name')
  };
  const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
    withHttpSnapshot(
      body.kind === 'directory'
        ? await daemonAppServer(context).createProjectDirectory(input)
        : await daemonAppServer(context).createProjectFile(input),
      context.runtime.daemonUrl,
      session,
      context.runtime.token
    )
  ));
  writeJson(context.response, 200, result);
}

async function handleExternalLocalImportRoute(context: ProjectRequestContext, session: ProjectSessionRecord): Promise<void> {
  if (context.request.method !== 'POST') {
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported external local import method.');
    return;
  }
  const body = await readJsonBody<Record<string, unknown>>(context.request);
  const sources = stringArrayField(body.sources, 'sources');
  const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
    withHttpSnapshot(await daemonAppServer(context).importExternalLocalProjectPaths({
      sources,
      targetDirectoryProjectRelativePath: stringField(body.targetDirectoryProjectRelativePath, 'targetDirectoryProjectRelativePath'),
      ...(typeof body.overwrite === 'boolean' ? { overwrite: body.overwrite } : {})
    }), context.runtime.daemonUrl, session, context.runtime.token)
  ));
  writeJson(context.response, 200, result);
}

async function handleExternalUploadImportRoute(context: ProjectRequestContext, session: ProjectSessionRecord): Promise<void> {
  if (context.request.method !== 'POST') {
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported external upload import method.');
    return;
  }
  const parts = await readMultipartUploadParts(context.request);
  try {
    const plan = daemonUploadImportPlan(parts.fields.get('plan'));
    const result = await runRevisionedMutation(context, plan.baseRevision, async () => (
      withHttpSnapshot(await daemonAppServer(context).importExternalUploadProjectEntries({
        entries: uploadImportEntriesFromMultipartParts(plan, parts.files),
        targetDirectoryProjectRelativePath: plan.targetDirectoryProjectRelativePath,
        ...(plan.overwrite === true ? { overwrite: true } : {})
      }), context.runtime.daemonUrl, session, context.runtime.token)
    ));
    writeJson(context.response, 200, result);
  } finally {
    await parts.cleanup();
  }
}

interface NativeProjectPathRoute {
  operation: 'reveal';
  projectRelativePath: string;
}

function parseNativeProjectPathRoute(tail: string): NativeProjectPathRoute | undefined {
  const prefix = '/files/path/';
  if (!tail.startsWith(prefix)) {
    return undefined;
  }
  for (const operation of ['reveal'] as const) {
    const suffix = `/${operation}`;
    if (tail.endsWith(suffix)) {
      return {
        operation,
        projectRelativePath: routeTail(tail.slice(0, -suffix.length), prefix)
      };
    }
  }
  return undefined;
}

async function handleNativeProjectPathRoute(
  context: ProjectRequestContext,
  route: NativeProjectPathRoute,
  session: ProjectSessionRecord,
  nativeShell: DebruteNativeShell
): Promise<void> {
  if (context.request.method !== 'POST') {
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported native project path method.');
    return;
  }
  const body = await readJsonBody<{ kind?: unknown }>(context.request);
  if (body.kind !== 'file' && body.kind !== 'directory') {
    writeError(context.response, 400, 'invalid_input', 'kind is required.');
    return;
  }
  const kind: 'file' | 'directory' = body.kind;
  const input = {
    projectRoot: session.projectRoot,
    projectRelativePath: route.projectRelativePath,
    kind
  };
  writeJson(context.response, 200, await revealProjectPathInSystemFileManager({
    ...input,
    nativeShell
  }));
}

async function handleNativeProjectPathBatchRoute(
  context: ProjectRequestContext,
  operation: string,
  session: ProjectSessionRecord,
  nativeShell: DebruteNativeShell
): Promise<void> {
  if (context.request.method !== 'POST') {
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported native project path batch method.');
    return;
  }
  const body = await readJsonBody<{ entries?: unknown }>(context.request);
  const entries = projectPathEntriesField(body.entries);
  if (operation === 'copy-path') {
    writeJson(context.response, 200, await copyProjectAbsolutePaths({
      projectRoot: session.projectRoot,
      entries
    }));
    return;
  }
  if (operation === 'trash') {
    const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
      withHttpSnapshot(await trashProjectPathsWithNativeShell({
        projectRoot: session.projectRoot,
        entries,
        nativeShell,
        refreshProject: () => daemonAppServer(context).refreshProject()
      }), context.runtime.daemonUrl, session, context.runtime.token)
    ));
    writeJson(context.response, 200, result);
    return;
  }
  writeError(context.response, 404, 'not_found', `Unknown native project path batch operation: ${operation}`);
}

async function handleProjectPathBatchRoute(
  context: ProjectRequestContext,
  operation: string,
  session: ProjectSessionRecord
): Promise<void> {
  if (context.request.method !== 'POST') {
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported project path batch method.');
    return;
  }
  const body = await readJsonBody<Record<string, unknown>>(context.request);
  const server = daemonAppServer(context);
  if (operation === 'copy') {
    const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
      withHttpSnapshot(await server.copyProjectPaths({
        entries: projectPathEntriesField(body.entries),
        targetDirectoryProjectRelativePath: stringField(body.targetDirectoryProjectRelativePath, 'targetDirectoryProjectRelativePath')
      }), context.runtime.daemonUrl, session, context.runtime.token)
    ));
    writeJson(context.response, 200, result);
    return;
  }
  if (operation === 'move') {
    const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
      withHttpSnapshot(await server.moveProjectPaths({
        entries: projectPathEntriesField(body.entries),
        targetDirectoryProjectRelativePath: stringField(body.targetDirectoryProjectRelativePath, 'targetDirectoryProjectRelativePath'),
        ...(typeof body.overwrite === 'boolean' ? { overwrite: body.overwrite } : {})
      }), context.runtime.daemonUrl, session, context.runtime.token)
    ));
    writeJson(context.response, 200, result);
    return;
  }
  if (operation === 'delete-permanently') {
    const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
      withHttpSnapshot(await server.deleteProjectPathsPermanently({
        entries: projectPathEntriesField(body.entries)
      }), context.runtime.daemonUrl, session, context.runtime.token)
    ));
    writeJson(context.response, 200, result);
    return;
  }
  writeError(context.response, 404, 'not_found', `Unknown project path batch operation: ${operation}`);
}

async function handleProjectPathRoute(context: ProjectRequestContext, path: string, session: ProjectSessionRecord): Promise<void> {
  const server = daemonAppServer(context);
  if (context.request.method === 'PATCH') {
    const body = await readJsonBody<Record<string, unknown>>(context.request);
    const operation = stringField(body.operation, 'operation');
    if (operation === 'rename') {
      const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
        withHttpSnapshot(await server.renameProjectPath({
          projectRelativePath: path,
          name: stringField(body.name, 'name')
        }), context.runtime.daemonUrl, session, context.runtime.token)
      ));
      writeJson(context.response, 200, result);
      return;
    }
  }
  writeError(context.response, 405, 'method_not_allowed', 'Unsupported project path method.');
}

async function handleCanvasRoute(
  context: ProjectRequestContext,
  tail: string,
  session: ProjectSessionRecord
): Promise<void> {
  const server = daemonAppServer(context);
  const path = context.url.pathname;
  if (tail === '/canvases') {
    if (context.request.method === 'POST') {
      const body = await readJsonBody<Record<string, unknown>>(context.request);
      const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
        withHttpSnapshot(await server.createCanvas(), context.runtime.daemonUrl, session, context.runtime.token)
      ));
      writeJson(context.response, 200, result);
      return;
    }
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported Canvas collection method.');
    return;
  }
  if (tail === '/canvases/index') {
    if (context.request.method === 'PUT') {
      const body = await readJsonBody<Record<string, unknown>>(context.request);
      const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
        withHttpSnapshot(await server.reorderCanvases({
          canvasOrder: stringArrayField(body.canvasOrder, 'canvasOrder')
        }), context.runtime.daemonUrl, session, context.runtime.token)
      ));
      writeJson(context.response, 200, result);
      return;
    }
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported Canvas registry method.');
    return;
  }
  if (tail === '/canvases/index/repair') {
    if (context.request.method === 'POST') {
      const body = await readJsonBody<Record<string, unknown>>(context.request);
      const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
        withHttpSnapshot(await server.repairCanvasIndex(), context.runtime.daemonUrl, session, context.runtime.token)
      ));
      writeJson(context.response, 200, result);
      return;
    }
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported Canvas registry repair method.');
    return;
  }
  const canvasId = decodePathSegment(tail.slice('/canvases/'.length).split('/')[0]!);
  if (tail === `/canvases/${canvasId}` && context.request.method === 'PATCH') {
    const body = await readJsonBody<Record<string, unknown>>(context.request);
    const operation = stringField(body.operation, 'operation');
    if (operation === 'rename') {
      const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
        withHttpSnapshot(await server.renameCanvas({
          canvasId,
          nextCanvasId: stringField(body.nextCanvasId, 'nextCanvasId')
        }), context.runtime.daemonUrl, session, context.runtime.token)
      ));
      writeJson(context.response, 200, result);
      return;
    }
  }
  if (tail === `/canvases/${canvasId}` && context.request.method === 'DELETE') {
    const body = await readJsonBody<Record<string, unknown>>(context.request);
    const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
      withHttpSnapshot(await server.deleteCanvas({ canvasId }), context.runtime.daemonUrl, session, context.runtime.token)
    ));
    writeJson(context.response, 200, result);
    return;
  }
  if (path.endsWith('/canvas-map/project-paths') && context.request.method === 'POST') {
    const body = await readJsonBody<Record<string, unknown>>(context.request);
    const result = await runRevisionedMutation(context, baseRevisionField(body), async () => (
      withHttpSnapshot(await server.addProjectPathToCanvasMap({
        canvasId,
        projectRelativePath: stringField(body.projectRelativePath, 'projectRelativePath')
      }), context.runtime.daemonUrl, session, context.runtime.token)
    ));
    writeJson(context.response, 200, result);
    return;
  }
  if (path.endsWith('/reset-layout') && context.request.method === 'POST') {
    const body = await readJsonBody<Record<string, unknown>>(context.request);
    const hasAll = body.all === true;
    const hasPathRules = body.pathRules !== undefined;
    if (hasAll === hasPathRules) {
      throw new DebruteDaemonHttpError(400, 'invalid_input', 'reset layout requires exactly one of all or pathRules.');
    }
    const result = await runRevisionedMutation(context, baseRevisionField(body), async () => {
      const updated = await server.resetCanvasNodeLayouts({
        canvasId,
        ...(hasAll
          ? { all: true as const }
          : { pathRules: stringArrayField(body.pathRules, 'pathRules') })
      });
      return {
        canvas: updated.canvas,
        projection: projectionForHttp(updated.projection, context.runtime.daemonUrl, session.projectId, context.runtime.token),
        resetCount: updated.resetCount
      };
    });
    writeJson(context.response, 200, result);
    return;
  }
  if (path.endsWith('/node-layouts') && context.request.method === 'PATCH') {
    const body = await readJsonBody<Record<string, unknown>>(context.request);
    const result = await runRevisionedMutation(context, baseRevisionField(body), async () => {
      const updated = await server.updateCanvasNodeLayouts({
        canvasId,
        nodeLayouts: body.nodeLayouts as never
      });
      return {
        canvas: updated.canvas,
        projection: projectionForHttp(updated.projection, context.runtime.daemonUrl, session.projectId, context.runtime.token)
      };
    });
    writeJson(context.response, 200, result);
    return;
  }
  if (path.endsWith('/node-layers') && context.request.method === 'PATCH') {
    const body = await readJsonBody<Record<string, unknown>>(context.request);
    const result = await runRevisionedMutation(context, baseRevisionField(body), async () => {
      const updated = await server.updateCanvasNodeLayers({
        canvasId,
        nodeProjectRelativePathsTopFirst: body.nodeProjectRelativePathsTopFirst as never
      });
      return {
        canvas: updated.canvas,
        projection: projectionForHttp(updated.projection, context.runtime.daemonUrl, session.projectId, context.runtime.token)
      };
    });
    writeJson(context.response, 200, result);
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
    abortSignal: requestAbortSignal(context.request, context.response, 30_000)
  });
  await writeRevisionedFileResponse({
    request: context.request,
    response: context.response,
    absolutePath: preview.absolutePath,
    contentType: contentTypeFromPath(preview.absolutePath)
  });
}

async function handleTerminalRoute(context: ProjectRequestContext, tail: string): Promise<void> {
  const method = context.request.method ?? 'GET';
  if (tail === '/terminals') {
    if (method === 'GET') {
      writeJson(context.response, 200, daemonAppServer(context).listTerminalSessions());
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody<Record<string, unknown>>(context.request);
      writeJson(context.response, 201, await daemonAppServer(context).createTerminalSession({
        ...optionalStringBodyField(body, 'cwdProjectRelativePath'),
        ...optionalTerminalDimensionBodyField(body, 'cols'),
        ...optionalTerminalDimensionBodyField(body, 'rows')
      }));
      return;
    }
    writeError(context.response, 405, 'method_not_allowed', 'Unsupported terminal collection method.');
    return;
  }

  const route = parseTerminalRoute(tail);
  if (!route) {
    writeError(context.response, 404, 'not_found', `Unknown terminal route: ${tail}`);
    return;
  }

  if (route.operation === 'events') {
    if (method !== 'GET') {
      writeError(context.response, 405, 'method_not_allowed', 'Unsupported terminal event stream method.');
      return;
    }
    writeTerminalEventStream(context, route.terminalId);
    return;
  }

  if (route.operation === 'input') {
    if (method !== 'POST') {
      writeError(context.response, 405, 'method_not_allowed', 'Unsupported terminal input method.');
      return;
    }
    const body = await readJsonBody<Record<string, unknown>>(context.request);
    writeJson(context.response, 200, daemonAppServer(context).writeTerminalInput({
      terminalId: route.terminalId,
      data: stringField(body.data, 'data')
    }));
    return;
  }

  if (route.operation === 'resize') {
    if (method !== 'POST') {
      writeError(context.response, 405, 'method_not_allowed', 'Unsupported terminal resize method.');
      return;
    }
    const body = await readJsonBody<Record<string, unknown>>(context.request);
    writeJson(context.response, 200, daemonAppServer(context).resizeTerminal({
      terminalId: route.terminalId,
      cols: terminalDimensionField(body.cols, 'cols'),
      rows: terminalDimensionField(body.rows, 'rows')
    }));
    return;
  }

  if (route.operation === 'restart') {
    if (method !== 'POST') {
      writeError(context.response, 405, 'method_not_allowed', 'Unsupported terminal restart method.');
      return;
    }
    writeJson(context.response, 200, await daemonAppServer(context).restartTerminalSession({
      terminalId: route.terminalId
    }));
    return;
  }

  if (route.operation === 'session') {
    if (method !== 'DELETE') {
      writeError(context.response, 405, 'method_not_allowed', 'Unsupported terminal session method.');
      return;
    }
    writeJson(context.response, 200, daemonAppServer(context).closeTerminalSession({
      terminalId: route.terminalId
    }));
    return;
  }
}

interface TerminalRoute {
  terminalId: string;
  operation: 'session' | 'events' | 'input' | 'resize' | 'restart';
}

function parseTerminalRoute(tail: string): TerminalRoute | undefined {
  const segments = tail.split('/').filter(Boolean);
  if (segments[0] !== 'terminals' || !segments[1]) {
    return undefined;
  }
  const terminalId = decodePathSegment(segments[1]);
  if (segments.length === 2) {
    return { terminalId, operation: 'session' };
  }
  if (
    segments.length === 3
    && (segments[2] === 'events' || segments[2] === 'input' || segments[2] === 'resize' || segments[2] === 'restart')
  ) {
    return { terminalId, operation: segments[2] };
  }
  return undefined;
}

function writeTerminalEventStream(context: ProjectRequestContext, terminalId: string): void {
  const bufferedEvents: TerminalEvent[] = [];
  let streamOpen = false;
  let closeStream = (): void => {};
  const writeEvent = (event: TerminalEvent): void => {
    if (!streamOpen) {
      bufferedEvents.push(event);
      return;
    }
    context.response.write(`event: terminal\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'closed') {
      closeStream();
    }
  };
  const subscription = daemonAppServer(context).subscribeTerminalEvents(terminalId, writeEvent);
  context.response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  streamOpen = true;
  context.response.write('\n');
  for (const event of bufferedEvents) {
    writeEvent(event);
  }
  const keepalive = setInterval(() => {
    context.response.write(': keepalive\n\n');
  }, 15_000);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    clearInterval(keepalive);
    subscription.close();
  };
  closeStream = (): void => {
    cleanup();
    if (!context.response.writableEnded) {
      context.response.end();
    }
  };
  context.request.once('close', cleanup);
}

function requestAbortSignal(request: IncomingMessage, response: ServerResponse, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => {
    controller.abort();
  };
  const abortIfResponseClosedEarly = () => {
    if (!response.writableEnded) {
      abort();
    }
  };
  const cleanup = () => {
    request.off('aborted', abort);
    response.off('close', abortIfResponseClosedEarly);
    response.off('finish', cleanup);
    clearTimeout(timeout);
  };
  request.once('aborted', abort);
  response.once('close', abortIfResponseClosedEarly);
  response.once('finish', cleanup);
  controller.signal.addEventListener('abort', cleanup, { once: true });
  return controller.signal;
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
  writeJson(context.response, 200, generatedAssetForHttp(record, context.runtime.daemonUrl, projectId, context.runtime.token));
}

async function handleSettingsRoute(context: GlobalRuntimeRequestContext): Promise<void> {
  const server = context.globalRuntime;
  const method = context.request.method ?? 'GET';
  const path = context.url.pathname;
  if (method === 'GET' && path === '/api/settings') {
    writeJson(context.response, 200, {
      llm: await server.llmGetSettings(),
      imageModels: await server.imageModelGetSettings(),
      videoModels: await server.videoModelGetSettings(),
      integrations: await server.integrationsListStatus()
    });
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
  writeError(context.response, 404, 'not_found', `Unknown Debrute API route: ${path}`);
}

function writeEventStream(
  context: RequestContext,
  session: ProjectSessionRecord,
  globalRuntime: DebruteGlobalRuntimeServer,
  sessions: ProjectSessionRegistry,
  bridge?: AdobeBridgeService
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
    context.response.write(`event: message\ndata: ${JSON.stringify(eventForHttp(
      event,
      context.runtime.daemonUrl,
      session.projectId,
      session.projectRevision,
      context.runtime.token
    ))}\n\n`);
  });
  const unsubscribeGlobal = globalRuntime.onEvent((event) => {
    if (!isGlobalEvent(event)) {
      return;
    }
    context.response.write(`event: message\ndata: ${JSON.stringify(eventForHttp(
      event,
      context.runtime.daemonUrl,
      session.projectId,
      session.projectRevision,
      context.runtime.token
    ))}\n\n`);
  });
  const unsubscribeBridge = bridge?.onEvent((state) => {
    context.response.write(`event: message\ndata: ${JSON.stringify({
      type: 'adobeBridge.state.changed',
      state
    } satisfies WorkbenchEvent)}\n\n`);
  }) ?? (() => undefined);
  const keepalive = setInterval(() => {
    context.response.write(': keepalive\n\n');
  }, 15_000);
  const cleanup = (): void => {
    clearInterval(keepalive);
    unsubscribeProject();
    unsubscribeGlobal();
    unsubscribeBridge();
    releaseClient?.();
  };
  context.request.once('close', cleanup);
}

function isGlobalEvent(event: AppServerEvent): boolean {
  return event.type === 'llm.settings.changed'
    || event.type === 'imageModel.settings.changed'
    || event.type === 'videoModel.settings.changed'
    || event.type === 'integrations.settings.changed'
    || event.type === 'adobeBridge.settings.changed';
}

async function serveWebAsset(context: RequestContext, configuredWebDistDir: string | undefined): Promise<void> {
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    writeError(context.response, 404, 'not_found', `Unknown Debrute route: ${context.url.pathname}`);
    return;
  }
  const webDistDir = configuredWebDistDir ?? defaultWebDistDir();
  const path = context.url.pathname === '/' || shouldServeIndex(context.url.pathname)
    ? 'index.html'
    : context.url.pathname.replace(/^\/+/, '');
  const absolutePath = resolve(webDistDir, path);
  if (!absolutePath.startsWith(resolve(webDistDir))) {
    writeError(context.response, 404, 'not_found', 'Asset path is outside the Debrute web directory.');
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
    writeError(context.response, 404, 'not_found', `Debrute web asset is missing: ${context.url.pathname}`);
  }
}

function snapshotForHttp(
  snapshot: ProjectSessionSnapshot,
  daemonUrl: string,
  projectId: string,
  daemonToken: string
): WorkbenchProjectSessionSnapshot {
  const { projectRoot: _projectRoot, ...publicSnapshot } = snapshot;
  return {
    ...publicSnapshot,
    projections: snapshot.projections.map((projection) => projectionForHttp(projection, daemonUrl, projectId, daemonToken))
  };
}

function projectionForHttp(
  projection: ProjectSessionSnapshot['projections'][number],
  daemonUrl: string,
  projectId: string,
  daemonToken: string
): ProjectSessionSnapshot['projections'][number] {
  return {
    ...projection,
    nodes: projection.nodes.map((node) => ({
      ...node,
      availability: node.availability.state === 'available'
        ? {
            ...node.availability,
            fileUrl: rawFileUrl(daemonUrl, projectId, node.projectRelativePath, node.availability.revision, daemonToken)
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
  projectId: string,
  projectRevision: number,
  daemonToken: string
): WorkbenchEvent {
  if (event.type === 'project.opened' || event.type === 'project.changed' || event.type === 'project.fileChanged') {
    if (event.type === 'project.fileChanged') {
      const { absolutePath: _absolutePath, ...publicEvent } = event.event;
      return {
        ...event,
        projectId,
        projectRevision,
        event: publicEvent satisfies WorkbenchFileWatchEvent,
        snapshot: snapshotForHttp(event.snapshot, daemonUrl, projectId, daemonToken)
      };
    }
    return {
      ...event,
      projectId,
      projectRevision,
      snapshot: snapshotForHttp(event.snapshot, daemonUrl, projectId, daemonToken)
    };
  }
  if (event.type === 'canvas.changed') {
    return {
      ...event,
      projectId,
      projectRevision,
      projection: projectionForHttp(event.projection, daemonUrl, projectId, daemonToken)
    };
  }
  if (event.type === 'canvas.feedback.changed' || event.type === 'generatedAsset.metadata.changed') {
    return {
      ...event,
      projectId,
      projectRevision
    };
  }
  return event;
}

function withHttpSnapshot<T extends { snapshot: ProjectSessionSnapshot }>(
  result: T,
  daemonUrl: string,
  session: ProjectSessionRecord,
  daemonToken: string
): Omit<T, 'snapshot'> & { snapshot: WorkbenchProjectSessionSnapshot } {
  return {
    ...result,
    snapshot: snapshotForHttp(result.snapshot, daemonUrl, session.projectId, daemonToken)
  };
}

function generatedAssetsForHttp(
  records: GeneratedAssetRecord[],
  daemonUrl: string,
  projectId: string,
  daemonToken: string
): GeneratedAssetsView {
  return {
    assets: records.map((record) => generatedAssetForHttp(record, daemonUrl, projectId, daemonToken))
  };
}

function generatedAssetForHttp(
  record: GeneratedAssetRecord,
  daemonUrl: string,
  projectId: string,
  daemonToken: string
): GeneratedAssetView {
  return {
    assetId: record.recordId,
    projectRelativePath: record.projectRelativePath,
    rawUrl: generatedAssetRawUrl(daemonUrl, projectId, record.recordId, daemonToken),
    record
  };
}

function generatedAssetRawUrl(daemonUrl: string, projectId: string, recordId: string, daemonToken: string): string {
  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/generated-assets/${encodeURIComponent(recordId)}/raw`, daemonUrl);
  url.searchParams.set('debrute-token', daemonToken);
  return url.toString();
}

function rawFileUrl(
  daemonUrl: string,
  projectId: string,
  projectRelativePath: string,
  revision: string,
  daemonToken: string
): string {
  const encodedPath = projectRelativePath.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/files/raw/${encodedPath}`, daemonUrl);
  url.searchParams.set('v', revision);
  url.searchParams.set('debrute-token', daemonToken);
  return url.toString();
}

function applyCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DebruteDaemonRuntime,
  path: string
): boolean {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  const allowedOrigin = origin === runtime.daemonUrl
    || origin === runtime.webBaseUrl
    || (isPhotoshopPluginBridgeRoute(path) && (
      origin === PHOTOSHOP_UXP_ORIGIN
      || PHOTOSHOP_CEP_ORIGINS.has(origin)
    ));
  if (!allowedOrigin) {
    return false;
  }
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader('access-control-allow-headers', CORS_ALLOWED_HEADERS);
  response.setHeader('access-control-max-age', '600');
  response.setHeader('vary', 'origin');
  return true;
}

function isPhotoshopPluginBridgeRoute(path: string): boolean {
  return path.startsWith('/api/adobe-bridge/plugin/')
    || path.startsWith('/api/adobe-bridge/transfers/');
}

function requiresDaemonToken(path: string): boolean {
  if (!path.startsWith('/api/')) {
    return false;
  }
  if (path === '/api/status') {
    return false;
  }
  if (path === '/api/adobe-bridge/plugin/ws') {
    return false;
  }
  if (path.startsWith('/api/adobe-bridge/plugin/')) {
    return false;
  }
  if (path.startsWith('/api/adobe-bridge/transfers/')) {
    return false;
  }
  return path !== '/api/runtime';
}

function hasDaemonToken(request: IncomingMessage, url: URL, token: string): boolean {
  return request.headers['x-debrute-daemon-token'] === token || url.searchParams.get('debrute-token') === token;
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function assertLoopbackBindHost(host: string): void {
  if (host !== DEFAULT_HOST) {
    throw new Error(`Debrute daemon host must be loopback: ${host}`);
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
    throw new Error(`Invalid Debrute route: ${path}`);
  }
  return path.slice(marker.length).split('/').map(decodePathSegment).join('/');
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > BODY_LIMIT_BYTES) {
      throw new DebruteDaemonHttpError(413, 'request_body_too_large', 'Debrute API request body is too large.');
    }
  }
  if (!body.trim()) {
    return {} as T;
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new DebruteDaemonHttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

async function readMultipartUploadParts(request: IncomingMessage): Promise<MultipartUploadParts> {
  const temporaryDirectory = await mkdtemp(joinFileSystemPath(tmpdir(), 'debrute-upload-'));
  const cleanup = async () => rm(temporaryDirectory, { recursive: true, force: true });
  const fields = new Map<string, string>();
  const files = new Map<string, MultipartUploadFilePart>();
  const writes: Array<Promise<void>> = [];

  return new Promise((resolveParts, rejectParts) => {
    let settled = false;
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      void cleanup().finally(() => rejectParts(error));
    };
    let parser: NodeJS.WritableStream;
    try {
      parser = Busboy({ headers: request.headers });
    } catch (error) {
      rejectOnce(error);
      return;
    }

    parser.on('field', (name, value) => {
      fields.set(name, value);
    });
    parser.on('file', (name, stream) => {
      const temporaryPath = joinFileSystemPath(temporaryDirectory, `${randomUUID()}.upload`);
      files.set(name, {
        temporaryPath
      });
      const write = pipeline(stream, createWriteStream(temporaryPath, { flags: 'wx' }));
      writes.push(write);
      write.catch(rejectOnce);
    });
    parser.on('error', rejectOnce);
    parser.on('finish', () => {
      void Promise.all(writes).then(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolveParts({ fields, files, cleanup });
      }, rejectOnce);
    });
    request.pipe(parser);
  });
}

function daemonUploadImportPlan(value: string | undefined): DaemonProjectUploadImportPlan {
  if (typeof value !== 'string') {
    throw new DebruteDaemonHttpError(400, 'invalid_input', 'Upload import plan is required.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DebruteDaemonHttpError(400, 'invalid_json', 'Upload import plan is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DebruteDaemonHttpError(400, 'invalid_input', 'Upload import plan must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.entries)) {
    throw new DebruteDaemonHttpError(400, 'invalid_input', 'Upload import plan entries must be an array.');
  }
  return {
    baseRevision: baseRevisionField(record),
    entries: record.entries.map((entry, index) => daemonUploadImportPlanEntry(entry, index)),
    targetDirectoryProjectRelativePath: stringField(record.targetDirectoryProjectRelativePath, 'targetDirectoryProjectRelativePath'),
    ...(typeof record.overwrite === 'boolean' ? { overwrite: record.overwrite } : {})
  };
}

function daemonUploadImportPlanEntry(value: unknown, index: number): DaemonProjectUploadImportPlan['entries'][number] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DebruteDaemonHttpError(400, 'invalid_input', `entries[${index}] must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const projectRelativePath = stringField(record.projectRelativePath, `entries[${index}].projectRelativePath`);
  if (record.kind === 'directory') {
    return { kind: 'directory', projectRelativePath };
  }
  if (record.kind === 'file') {
    return {
      kind: 'file',
      projectRelativePath,
      fileField: stringField(record.fileField, `entries[${index}].fileField`)
    };
  }
  throw new DebruteDaemonHttpError(400, 'invalid_input', `entries[${index}].kind must be file or directory.`);
}

function uploadImportEntriesFromMultipartParts(
  plan: DaemonProjectUploadImportPlan,
  files: Map<string, MultipartUploadFilePart>
): ProjectUploadImportEntry[] {
  return plan.entries.map((entry): ProjectUploadImportEntry => {
    if (entry.kind === 'directory') {
      return { kind: 'directory', projectRelativePath: entry.projectRelativePath };
    }
    const file = files.get(entry.fileField);
    if (!file) {
      throw new DebruteDaemonHttpError(400, 'invalid_input', `Upload file field is missing: ${entry.fileField}`);
    }
    return {
      kind: 'file',
      projectRelativePath: entry.projectRelativePath,
      content: createReadStream(file.temporaryPath)
    };
  });
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): void {
  const body: DebruteHttpErrorBody = {
    error: {
      code,
      message: redactRuntimeSecretString(message),
      ...(details ? { details: redactRuntimeSecrets(details) as Record<string, unknown> } : {})
    }
  };
  writeJson(response, statusCode, body);
}

function writeCaughtError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  if (error instanceof DebruteDaemonHttpError) {
    writeError(response, error.statusCode, error.code, error.message, error.details);
    return;
  }
  if (writeAdobeBridgeCaughtError(response, error)) {
    return;
  }
  if (isServiceError(error)) {
    writeError(response, serviceErrorStatusCode(error.code), error.code, error.message, error.fields);
    return;
  }
  if (isNodeError(error) && error.code === 'ENOENT') {
    writeError(response, 404, 'not_found', 'Debrute project path was not found.');
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

function isServiceError(error: unknown): error is Error & { code: string; fields: Record<string, unknown> } {
  return error instanceof Error
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { fields?: unknown }).fields === 'object'
    && (error as { fields?: unknown }).fields !== null;
}

function serviceErrorStatusCode(code: string): number {
  if (code === 'canvas_map_conflict' || code === 'canvas_registry_conflict') {
    return 409;
  }
  if (code === 'canvas_map_canvas_missing' || code === 'canvas_map_target_missing' || code === 'terminal_not_found') {
    return 404;
  }
  return 400;
}

function optionalStringBodyField(body: Record<string, unknown>, name: string): Record<string, string> {
  return body[name] === undefined ? {} : { [name]: stringField(body[name], name) };
}

function optionalTerminalDimensionBodyField(body: Record<string, unknown>, name: string): Record<string, number> {
  return body[name] === undefined ? {} : { [name]: terminalDimensionField(body[name], name) };
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new DebruteDaemonHttpError(400, 'invalid_input', `${name} must be a string.`);
  }
  return value;
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new DebruteDaemonHttpError(400, 'invalid_input', `${name} must be a positive integer.`);
  }
  return value;
}

function terminalDimensionField(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DebruteDaemonHttpError(400, 'invalid_input', `${name} must be a finite number.`);
  }
  return value;
}

function baseRevisionField(body: Record<string, unknown>): number {
  return numberField(body.baseRevision, 'baseRevision');
}

function stringArrayField(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new DebruteDaemonHttpError(400, 'invalid_input', `${name} must be an array.`);
  }
  return value.map((item, index) => stringField(item, `${name}[${index}]`));
}

function projectPathEntriesField(value: unknown): WorkbenchProjectPathEntry[] {
  if (!Array.isArray(value)) {
    throw new DebruteDaemonHttpError(400, 'invalid_input', 'entries must be an array.');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new DebruteDaemonHttpError(400, 'invalid_input', `entries[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const projectRelativePath = stringField(record.projectRelativePath, `entries[${index}].projectRelativePath`);
    if (record.kind !== 'file' && record.kind !== 'directory') {
      throw new DebruteDaemonHttpError(400, 'invalid_input', `entries[${index}].kind must be file or directory.`);
    }
    return { projectRelativePath, kind: record.kind };
  });
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

function daemonAppServer(context: ProjectRequestContext): DebruteAppServer {
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
  const imageMimeType = projectImageMimeTypeFromPath(path);
  if (imageMimeType) return imageMimeType;
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new DebruteDaemonHttpError(400, 'invalid_path_encoding', 'Debrute API path segment is not valid percent-encoding.');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

class DebruteDaemonHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}
