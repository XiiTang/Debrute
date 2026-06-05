import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DebruteAppServer, GlobalConfigStore, type DebruteAppServerOptions } from '@debrute/app-server';
import type { ProjectSessionSnapshot } from '@debrute/app-protocol';

export interface ProjectSessionRegistryOptions {
  appServerOptions?: DebruteAppServerOptions;
  createAppServer?: () => DebruteAppServer;
  idleTtlMs?: number;
}

export type ProjectSessionClientKind = 'sse' | 'electron-window';

export interface ProjectSessionClient {
  clientId: string;
  kind: ProjectSessionClientKind;
}

export interface ProjectSessionRecord {
  projectId: string;
  projectRoot: string;
  appServer: DebruteAppServer;
  clients: Map<string, ProjectSessionClient>;
  activeRequests: number;
  snapshot: ProjectSessionSnapshot;
  cleanupTimer: NodeJS.Timeout | undefined;
  closing: boolean;
}

export class ProjectSessionRegistry {
  private readonly sessionsById = new Map<string, ProjectSessionRecord>();
  private readonly projectIdsByRoot = new Map<string, string>();
  private readonly openingByRoot = new Map<string, Promise<ProjectSessionRecord>>();
  private readonly idleTtlMs: number;
  private readonly createAppServer: () => DebruteAppServer;
  private closed = false;

  constructor(options: ProjectSessionRegistryOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? 30_000;
    if (options.createAppServer) {
      this.createAppServer = options.createAppServer;
      return;
    }

    const sharedConfigStore = options.appServerOptions?.globalConfigStore ?? new GlobalConfigStore();
    this.createAppServer = () => new DebruteAppServer({
      ...options.appServerOptions,
      globalConfigStore: sharedConfigStore
    });
  }

  async openProject(projectRoot: string): Promise<ProjectSessionRecord> {
    this.assertOpen();
    const canonicalRoot = await canonicalProjectRoot(projectRoot);
    this.assertOpen();
    const existingId = this.projectIdsByRoot.get(canonicalRoot);
    if (existingId) {
      const existing = this.get(existingId);
      if (existing) {
        this.extendIdleWindow(existing);
        return existing;
      }
    }

    const opening = this.openingByRoot.get(canonicalRoot);
    if (opening) {
      return opening;
    }

    const nextOpening = this.createSession(canonicalRoot);
    this.openingByRoot.set(canonicalRoot, nextOpening);
    try {
      return await nextOpening;
    } finally {
      if (this.openingByRoot.get(canonicalRoot) === nextOpening) {
        this.openingByRoot.delete(canonicalRoot);
      }
    }
  }

  private async createSession(canonicalRoot: string): Promise<ProjectSessionRecord> {
    const appServer = this.createAppServer();
    let snapshot: ProjectSessionSnapshot;
    try {
      snapshot = await appServer.openProject(canonicalRoot);
    } catch (error) {
      appServer.close();
      throw error;
    }
    if (this.closed) {
      appServer.close();
      throw new Error('Debrute project session registry is closed.');
    }
    const projectId = randomUUID();
    const record: ProjectSessionRecord = {
      projectId,
      projectRoot: snapshot.projectRoot,
      appServer,
      clients: new Map(),
      activeRequests: 0,
      snapshot,
      cleanupTimer: undefined,
      closing: false
    };
    this.sessionsById.set(projectId, record);
    this.projectIdsByRoot.set(canonicalRoot, projectId);
    this.scheduleIdleCleanupIfUnused(record);
    return record;
  }

  get(projectId: string): ProjectSessionRecord | undefined {
    if (this.closed) {
      return undefined;
    }
    const record = this.sessionsById.get(projectId);
    return record && !record.closing ? record : undefined;
  }

  list(): ProjectSessionRecord[] {
    return [...this.sessionsById.values()].filter((record) => !record.closing);
  }

  projectRootForProjectId(projectId: string): string | undefined {
    return this.get(projectId)?.projectRoot;
  }

  registerClient(projectId: string, input: { clientId: string; kind: ProjectSessionClientKind }): (() => void) | undefined {
    const record = this.get(projectId);
    if (!record) {
      return undefined;
    }

    this.cancelIdleCleanup(record);
    const leaseId = randomUUID();
    record.clients.set(leaseId, {
      clientId: input.clientId,
      kind: input.kind
    });
    return once(() => this.releaseClientLease(projectId, leaseId));
  }

  registerRequest(projectId: string): (() => void) | undefined {
    const record = this.get(projectId);
    if (!record) {
      return undefined;
    }

    this.cancelIdleCleanup(record);
    record.activeRequests += 1;
    return once(() => this.releaseRequest(projectId));
  }

  private releaseClientLease(projectId: string, leaseId: string): void {
    const record = this.sessionsById.get(projectId);
    if (!record || record.closing) {
      return;
    }

    record.clients.delete(leaseId);
    this.scheduleIdleCleanupIfUnused(record);
  }

  private releaseRequest(projectId: string): void {
    const record = this.sessionsById.get(projectId);
    if (!record || record.closing) {
      return;
    }

    record.activeRequests = Math.max(0, record.activeRequests - 1);
    this.scheduleIdleCleanupIfUnused(record);
  }

  async close(): Promise<void> {
    this.closed = true;
    const records = [...this.sessionsById.values()];
    this.sessionsById.clear();
    this.projectIdsByRoot.clear();
    this.openingByRoot.clear();
    for (const record of records) {
      if (record.cleanupTimer) {
        clearTimeout(record.cleanupTimer);
      }
      record.appServer.close();
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Debrute project session registry is closed.');
    }
  }

  private scheduleIdleCleanup(record: ProjectSessionRecord): void {
    this.cancelIdleCleanup(record);
    record.cleanupTimer = setTimeout(() => {
      record.cleanupTimer = undefined;
      this.closeIdleSession(record.projectId);
    }, this.idleTtlMs);
  }

  private cancelIdleCleanup(record: ProjectSessionRecord): void {
    if (!record.cleanupTimer) {
      return;
    }

    clearTimeout(record.cleanupTimer);
    record.cleanupTimer = undefined;
  }

  private closeIdleSession(projectId: string): void {
    const record = this.sessionsById.get(projectId);
    if (!record || record.clients.size > 0 || record.activeRequests > 0 || record.closing) {
      return;
    }

    record.closing = true;
    this.sessionsById.delete(projectId);
    this.projectIdsByRoot.delete(record.projectRoot);
    if (record.cleanupTimer) {
      clearTimeout(record.cleanupTimer);
      record.cleanupTimer = undefined;
    }
    record.appServer.close();
  }

  private extendIdleWindow(record: ProjectSessionRecord): void {
    this.cancelIdleCleanup(record);
    this.scheduleIdleCleanupIfUnused(record);
  }

  private scheduleIdleCleanupIfUnused(record: ProjectSessionRecord): void {
    if (record.clients.size > 0 || record.activeRequests > 0 || record.closing) {
      return;
    }
    this.scheduleIdleCleanup(record);
  }
}

async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  return realpath(resolve(projectRoot));
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) {
      return;
    }
    called = true;
    callback();
  };
}
