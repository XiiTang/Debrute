import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  adobeBridgeClientDisplayName,
  type AdobeBridgeClient,
  type AdobeBridgeLink,
  type AdobeBridgeSettings,
  type AdobeBridgeErrorCode,
  type AdobeBridgeStateView,
  type AdobeBridgeTransferView,
  type ProjectBridgeClient
} from '@debrute/app-protocol';
import {
  isIgnoredProjectFilePath,
  isProtectedProjectDocumentMutationPath,
  type ProjectFileEntry
} from '@debrute/project-core';
import { AdobeBridgeError, createAdobeBridgeError } from './AdobeBridgeErrors.js';

export { AdobeBridgeError, createAdobeBridgeError } from './AdobeBridgeErrors.js';

export interface AdobeBridgeProjectInput {
  projectId: string;
  projectName: string;
  projectRevision: number;
  connectedWorkbenchClientCount: number;
  files: ProjectFileEntry[];
}

export interface AdobeBridgePhotoshopClientInput {
  adobeClientId: string;
  hostApp: 'photoshop';
  hostVersion: string;
  documentCount: number;
  activeDocumentTitle: string | null;
}

export interface CreateAdobeBridgeTransferInput {
  transferId?: string;
  direction: AdobeBridgeTransferView['direction'];
  projectId: string;
  adobeClientId: string;
  projectRelativePath: string | null;
}

export const ADOBE_BRIDGE_TRANSFER_TIMEOUT_MS = 5 * 60_000;

export class AdobeBridgeService {
  private readonly events = new EventEmitter();
  private settings: AdobeBridgeSettings = { enabled: true, discoveryStatus: 'unavailable' };
  private readonly adobeClients = new Map<string, AdobeBridgeClient>();
  private readonly projects = new Map<string, ProjectBridgeClient>();
  private readonly links = new Map<string, AdobeBridgeLink>();
  private readonly transfers = new Map<string, AdobeBridgeTransferView>();
  private readonly transferTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: { now?: () => Date; transferTimeoutMs?: number } = {}) {}

  onEvent(listener: (state: AdobeBridgeStateView) => void): () => void {
    this.events.on('state', listener);
    return () => this.events.off('state', listener);
  }

  setSettings(settings: AdobeBridgeSettings): void {
    this.settings = settings;
    if (!settings.enabled) {
      const disabledError = createAdobeBridgeError('adobe_bridge_disabled');
      const updatedAt = this.nowIso();
      for (const [transferId, transfer] of this.transfers) {
        if (transfer.status === 'pending' || transfer.status === 'running') {
          this.clearTransferTimeout(transferId);
          this.transfers.set(transferId, {
            ...transfer,
            status: 'failed',
            errorCode: disabledError.code,
            message: disabledError.message,
            updatedAt
          });
        }
      }
      this.adobeClients.clear();
      this.links.clear();
    }
    this.emit();
  }

  upsertPhotoshopClient(input: AdobeBridgePhotoshopClientInput): AdobeBridgeClient {
    this.assertEnabled();
    const now = this.nowIso();
    const existing = this.adobeClients.get(input.adobeClientId);
    const client: AdobeBridgeClient = {
      adobeClientId: input.adobeClientId,
      hostApp: input.hostApp,
      hostVersion: input.hostVersion,
      displayName: adobeBridgeClientDisplayName(input),
      documentCount: input.documentCount,
      activeDocumentTitle: input.activeDocumentTitle,
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now
    };
    this.adobeClients.set(client.adobeClientId, client);
    this.emit();
    return client;
  }

  removePhotoshopClient(adobeClientId: string): void {
    this.adobeClients.delete(adobeClientId);
    this.emit();
  }

  replaceProjects(projects: AdobeBridgeProjectInput[]): void {
    this.projects.clear();
    for (const project of projects) {
      this.projects.set(project.projectId, {
        projectId: project.projectId,
        projectName: project.projectName,
        projectRevision: project.projectRevision,
        connectedWorkbenchClientCount: project.connectedWorkbenchClientCount,
        directories: project.files
          .filter((entry) => entry.kind === 'directory' && isAdobeBridgeVisibleProjectDirectory(entry.projectRelativePath))
          .map((entry) => ({
            projectRelativePath: entry.projectRelativePath,
            name: entry.projectRelativePath.split('/').at(-1) ?? entry.projectRelativePath,
            depth: entry.projectRelativePath.split('/').filter(Boolean).length
          }))
      });
    }
    for (const [linkId, link] of this.links) {
      if (!this.projects.has(link.projectId)) {
        this.links.delete(linkId);
      }
    }
    this.emit();
  }

  linkProjectToPhotoshop(projectId: string, adobeClientId: string): AdobeBridgeStateView {
    this.assertEnabled();
    if (!this.projects.has(projectId)) {
      throw createAdobeBridgeError('project_offline', { projectId });
    }
    if (!this.adobeClients.has(adobeClientId)) {
      throw createAdobeBridgeError('adobe_client_offline', { adobeClientId });
    }
    const existing = [...this.links.values()].find((link) => link.projectId === projectId && link.adobeClientId === adobeClientId);
    if (!existing) {
      const link: AdobeBridgeLink = {
        linkId: randomUUID(),
        projectId,
        adobeClientId,
        createdAt: this.nowIso(),
        status: 'active'
      };
      this.links.set(link.linkId, link);
    }
    this.emit();
    return this.state();
  }

  unlinkProjectFromPhotoshop(projectId: string, adobeClientId: string): AdobeBridgeStateView {
    for (const [linkId, link] of this.links) {
      if (link.projectId === projectId && link.adobeClientId === adobeClientId) {
        this.links.delete(linkId);
      }
    }
    this.emit();
    return this.state();
  }

  assertTransferAllowed(projectId: string, adobeClientId: string): void {
    this.assertEnabled();
    if (!this.projects.has(projectId)) {
      throw createAdobeBridgeError('project_offline', { projectId });
    }
    if (!this.isLinked(projectId, adobeClientId)) {
      throw createAdobeBridgeError('project_not_linked', { projectId, adobeClientId });
    }
    if (!this.adobeClients.has(adobeClientId)) {
      throw createAdobeBridgeError('adobe_client_offline', { adobeClientId });
    }
  }

  isLinked(projectId: string, adobeClientId: string): boolean {
    return [...this.links.values()].some((link) => link.projectId === projectId && link.adobeClientId === adobeClientId);
  }

  createTransfer(input: CreateAdobeBridgeTransferInput): AdobeBridgeTransferView {
    const now = this.nowIso();
    const transferId = input.transferId ?? randomUUID();
    this.clearTransferTimeout(transferId);
    const transfer: AdobeBridgeTransferView = {
      transferId,
      direction: input.direction,
      projectId: input.projectId,
      adobeClientId: input.adobeClientId,
      projectRelativePath: input.projectRelativePath,
      status: 'pending',
      createdAt: now,
      updatedAt: now
    };
    this.transfers.set(transfer.transferId, transfer);
    this.scheduleTransferTimeout(transfer.transferId);
    this.emit();
    return transfer;
  }

  updateTransfer(input: {
    transferId: string;
    status: AdobeBridgeTransferView['status'];
    projectRelativePath?: string | null;
    errorCode?: AdobeBridgeErrorCode;
    message?: string;
  }): AdobeBridgeTransferView | undefined {
    const current = this.transfers.get(input.transferId);
    if (!current) {
      return undefined;
    }
    if (current.status === 'failed' || current.status === 'succeeded') {
      return current;
    }
    const updated: AdobeBridgeTransferView = {
      ...current,
      status: input.status,
      ...(input.projectRelativePath === undefined ? {} : { projectRelativePath: input.projectRelativePath }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.message === undefined ? {} : { message: input.message }),
      updatedAt: this.nowIso()
    };
    this.transfers.set(updated.transferId, updated);
    if (updated.status === 'failed' || updated.status === 'succeeded') {
      this.clearTransferTimeout(updated.transferId);
    }
    this.emit();
    return updated;
  }

  updatePhotoshopImportTransfer(
    adobeClientId: string,
    input: {
      transferId: string;
      status: 'succeeded' | 'failed';
      errorCode?: AdobeBridgeErrorCode;
      message?: string;
    }
  ): AdobeBridgeTransferView | undefined {
    const current = this.transfers.get(input.transferId);
    if (!current) {
      return undefined;
    }
    if (current.direction !== 'debrute-to-photoshop' || current.adobeClientId !== adobeClientId) {
      throw createAdobeBridgeError('project_not_linked', {
        transferId: input.transferId,
        adobeClientId
      });
    }
    return this.updateTransfer(input);
  }

  state(): AdobeBridgeStateView {
    return {
      settings: this.settings,
      adobeClients: [...this.adobeClients.values()],
      projects: [...this.projects.values()],
      links: this.linkViews(),
      transfers: [...this.transfers.values()]
    };
  }

  stateForPhotoshopClient(adobeClientId: string): AdobeBridgeStateView {
    const links = this.linkViews().filter((link) => link.adobeClientId === adobeClientId);
    const linkedProjectIds = new Set(links
      .filter((link) => link.status === 'active')
      .map((link) => link.projectId));
    return {
      settings: this.settings,
      adobeClients: [...this.adobeClients.values()].filter((client) => client.adobeClientId === adobeClientId),
      projects: [...this.projects.values()].map((project) => ({
        ...project,
        directories: linkedProjectIds.has(project.projectId) ? project.directories : []
      })),
      links,
      transfers: [...this.transfers.values()].filter((transfer) => transfer.adobeClientId === adobeClientId)
    };
  }

  dispose(): void {
    for (const transferId of this.transferTimeouts.keys()) {
      this.clearTransferTimeout(transferId);
    }
  }

  private assertEnabled(): void {
    if (!this.settings.enabled) {
      throw createAdobeBridgeError('adobe_bridge_disabled');
    }
  }

  private emit(): void {
    this.events.emit('state', this.state());
  }

  private linkViews(): AdobeBridgeLink[] {
    return [...this.links.values()].map((link) => ({
      ...link,
      status: !this.adobeClients.has(link.adobeClientId)
        ? 'adobe-offline'
        : !this.projects.has(link.projectId)
          ? 'project-offline'
          : 'active'
    }));
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private scheduleTransferTimeout(transferId: string): void {
    const timeout = setTimeout(() => {
      const transfer = this.transfers.get(transferId);
      if (!transfer || (transfer.status !== 'pending' && transfer.status !== 'running')) {
        this.transferTimeouts.delete(transferId);
        return;
      }
      const bridgeError = createAdobeBridgeError('transfer_timeout', { transferId });
      this.transfers.set(transferId, {
        ...transfer,
        status: 'failed',
        errorCode: bridgeError.code,
        message: bridgeError.message,
        updatedAt: this.nowIso()
      });
      this.transferTimeouts.delete(transferId);
      this.emit();
    }, this.options.transferTimeoutMs ?? ADOBE_BRIDGE_TRANSFER_TIMEOUT_MS);
    timeout.unref?.();
    this.transferTimeouts.set(transferId, timeout);
  }

  private clearTransferTimeout(transferId: string): void {
    const timeout = this.transferTimeouts.get(transferId);
    if (!timeout) {
      return;
    }
    clearTimeout(timeout);
    this.transferTimeouts.delete(transferId);
  }
}

function isAdobeBridgeVisibleProjectDirectory(projectRelativePath: string): boolean {
  return projectRelativePath !== '.git'
    && !projectRelativePath.startsWith('.git/')
    && !isIgnoredProjectFilePath(projectRelativePath)
    && !isProtectedProjectDocumentMutationPath(projectRelativePath);
}
