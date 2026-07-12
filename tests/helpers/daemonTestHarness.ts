import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  GlobalConfigStore,
  type DebruteAppServer,
  type DebruteAppServerOptions
} from '@debrute/app-server';
import type { ProjectSessionSnapshot, WorkbenchProjectOpenResult } from '@debrute/app-protocol';
import {
  createDebruteDaemonHttpServer,
  type DebruteDaemonHttpServer,
  type DebruteDaemonRuntime,
  type DebruteNativeShell,
  type DebruteProductServices
} from '@debrute/daemon';
import { assertPortCanRebind, createIsolatedDirectory } from './testPaths.js';

export interface DaemonTestHarnessOptions {
  token?: string;
  webBaseUrl?: string | null;
  productServices?: DebruteProductServices;
  nativeShell?: DebruteNativeShell;
  projectIdleTtlMs?: number;
  appServerOptions?: Omit<DebruteAppServerOptions, 'globalConfigStore'>;
  createAppServer?(globalConfigStore: GlobalConfigStore): DebruteAppServer;
}

export interface TestProject {
  readonly rootPath: string;
  projectId: string | undefined;
}

export interface TestJsonResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export interface TestBinaryResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export function createDaemonProjectSnapshotFixture(projectRoot: string): ProjectSessionSnapshot {
  return {
    metadata: {
      project: {
        id: 'project',
        name: 'Project',
        createdAt: '2026-05-26T00:00:00.000Z',
        updatedAt: '2026-05-26T00:00:00.000Z'
      }
    },
    projectRoot,
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    canvasRegistry: { status: 'ready', canvasOrder: [] },
    health: {
      projectName: 'Project',
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
      runtimeDataLocation: '/runtime',
      checkedAt: '2026-05-26T00:00:00.000Z'
    }
  };
}

export async function readDaemonSseEvent<T>(response: Response): Promise<T> {
  if (response.status !== 200) {
    throw new Error(`Expected daemon SSE response status 200, received ${response.status}.`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('SSE response did not include a body.');
  }
  let content = '';
  try {
    while (true) {
      const chunk = await readDaemonSseChunkWithDeadline(reader, 'SSE event');
      if (chunk.done) {
        break;
      }
      content += new TextDecoder().decode(chunk.value);
      const dataLine = content.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine) {
        return JSON.parse(dataLine.slice('data: '.length)) as T;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  throw new Error('SSE response did not include an event payload.');
}

export class DaemonTestHarness implements AsyncDisposable {
  static async create(options: DaemonTestHarnessOptions = {}): Promise<DaemonTestHarness> {
    const homePath = await createIsolatedDirectory('debrute-daemon-test-home-');
    const {
      appServerOptions = {},
      createAppServer,
      nativeShell,
      productServices,
      projectIdleTtlMs,
      token = 'test-token',
      webBaseUrl = null
    } = options;
    const globalConfigStore = new GlobalConfigStore({ debruteHome: homePath });
    const server = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token,
      webBaseUrl,
      adobeBridgeDiscoveryPort: 0,
      ...(nativeShell ? { nativeShell } : {}),
      ...(productServices ? { productServices } : {}),
      ...(projectIdleTtlMs !== undefined ? { projectIdleTtlMs } : {}),
      appServerOptions: {
        ...appServerOptions,
        globalConfigStore,
        integrationEnvPath: appServerOptions.integrationEnvPath ?? ''
      },
      ...(createAppServer
        ? { createAppServer: () => createAppServer(globalConfigStore) }
        : {})
    });

    try {
      const runtime = await server.listen();
      const daemonPort = portFromUrl(runtime.daemonUrl);
      const discoveryStatus = server.adobeBridgeDiscoveryStatus();
      if (!discoveryStatus || discoveryStatus.status !== 'available') {
        throw new Error('Debrute Adobe Bridge discovery server did not bind to a dynamic port.');
      }
      return new DaemonTestHarness({
        homePath,
        daemonPort,
        discoveryPort: discoveryStatus.port,
        daemonUrl: runtime.daemonUrl,
        runtime,
        token,
        server
      });
    } catch (error) {
      await server.close();
      await rm(homePath, { recursive: true, force: true });
      throw error;
    }
  }

  readonly homePath: string;
  readonly daemonPort: number;
  readonly discoveryPort: number;
  readonly daemonUrl: string;
  readonly runtime: DebruteDaemonRuntime;
  readonly token: string;

  private readonly server: DebruteDaemonHttpServer;
  private readonly projectRoots = new Set<string>();
  private disposed = false;

  private constructor(input: {
    homePath: string;
    daemonPort: number;
    discoveryPort: number;
    daemonUrl: string;
    runtime: DebruteDaemonRuntime;
    token: string;
    server: DebruteDaemonHttpServer;
  }) {
    this.homePath = input.homePath;
    this.daemonPort = input.daemonPort;
    this.discoveryPort = input.discoveryPort;
    this.daemonUrl = input.daemonUrl;
    this.runtime = input.runtime;
    this.token = input.token;
    this.server = input.server;
  }

  async createProject(files: Record<string, string | Uint8Array> = {}): Promise<TestProject> {
    const rootPath = await createIsolatedDirectory('debrute-daemon-test-project-');
    this.projectRoots.add(rootPath);
    for (const [projectRelativePath, contents] of Object.entries(files)) {
      const absolutePath = resolve(rootPath, projectRelativePath);
      const relativePath = relative(rootPath, absolutePath);
      if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
        throw new Error(`Test project file escapes its root: ${projectRelativePath}`);
      }
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents);
    }
    return { rootPath, projectId: undefined };
  }

  async openProject(project: TestProject): Promise<ProjectSessionSnapshot> {
    const response = await this.fetchJson<WorkbenchProjectOpenResult>('/api/projects/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: project.rootPath })
    });
    if (response.status !== 200) {
      throw new Error(`Failed to open test project: HTTP ${response.status}.`);
    }
    project.projectId = response.body.projectId;
    return {
      projectRoot: project.rootPath,
      ...response.body.snapshot
    };
  }

  async fetchJson<T>(path: string, init: RequestInit = {}): Promise<TestJsonResponse<T>> {
    const response = await fetch(this.url(path), {
      ...init,
      headers: this.authenticatedHeaders(init.headers)
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json() as T
    };
  }

  async fetchBytes(path: string, init: RequestInit = {}): Promise<TestBinaryResponse> {
    const response = await fetch(this.url(path), {
      ...init,
      headers: this.authenticatedHeaders(init.headers)
    });
    return {
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer())
    };
  }

  async fetchOkJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (typeof init.body === 'string' && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const response = await this.fetchJson<T>(path, { ...init, headers });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Expected successful test response for ${path}, received HTTP ${response.status}.`);
    }
    return response.body;
  }

  closeDaemon(): Promise<void> {
    return this.server.close();
  }

  projectRootForProjectId(projectId: string): string | undefined {
    return this.server.projectRootForProjectId(projectId);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const disposalErrors: unknown[] = [];
    try {
      await this.closeDaemon();
    } catch (error) {
      disposalErrors.push(error);
    }
    try {
      await assertPortCanRebind(this.daemonPort);
    } catch (error) {
      disposalErrors.push(error);
    }
    try {
      await assertPortCanRebind(this.discoveryPort);
    } catch (error) {
      disposalErrors.push(error);
    }
    const removalResults = await Promise.allSettled([
      ...[...this.projectRoots].map((projectRoot) => rm(projectRoot, { recursive: true, force: true })),
      rm(this.homePath, { recursive: true, force: true })
    ]);
    for (const result of removalResults) {
      if (result.status === 'rejected') {
        disposalErrors.push(result.reason);
      }
    }
    if (disposalErrors.length === 1) {
      throw disposalErrors[0];
    }
    if (disposalErrors.length > 1) {
      throw new AggregateError(disposalErrors, 'Debrute daemon test harness disposal failed.');
    }
  }

  private url(path: string): string {
    return new URL(path, `${this.daemonUrl}/`).toString();
  }

  private authenticatedHeaders(headers: HeadersInit | undefined): Headers {
    const authenticated = new Headers(headers);
    authenticated.set('x-debrute-daemon-token', this.token);
    return authenticated;
  }
}

function portFromUrl(url: string): number {
  const port = Number(new URL(url).port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Debrute daemon URL does not contain a bound port: ${url}`);
  }
  return port;
}

export async function readDaemonSseChunkWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  condition: string
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${condition}.`)), 1000);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
