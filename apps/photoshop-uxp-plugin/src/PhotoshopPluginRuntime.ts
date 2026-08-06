import {
  PhotoshopHost,
  type CapturedPng,
  type PhotoshopSelectionSnapshot
} from './PhotoshopHost.js';
import {
  RuntimeConnection,
  type RuntimeConnectionState
} from './RuntimeConnection.js';
import {
  PHOTOSHOP_MAX_BATCH_ITEMS,
  type PhotoshopDocumentSnapshot,
  type PhotoshopMimeType,
  type PhotoshopProjectSnapshot,
  type PluginMessage,
  type RuntimeMessage
} from '@debrute/app-protocol';

export interface RuntimeConnectionPort {
  start(): void;
  stop(): void;
  sessionGeneration(): number;
  send(message: PluginMessage): void;
  downloadCommandContent(commandId: string, expectedBytes: number): Promise<ArrayBuffer>;
  uploadExportItem(commandId: string, itemId: string, bytes: Uint8Array): Promise<{ fileName: string }>;
}

export interface PhotoshopHostPort {
  hostVersion(): string;
  placementMimeTypes(): PhotoshopMimeType[];
  documents(): PhotoshopDocumentSnapshot[];
  selection(): PhotoshopSelectionSnapshot;
  observeChanges(listener: () => void): () => void;
  capturePngs(
    documentId: number,
    items: Array<{ itemId: string; layerId: number; sourceName: string }>
  ): Promise<CapturedPng[]>;
  placeEmbeddedSmartObject(input: {
    documentId: number;
    fileName: string;
    bytes: ArrayBuffer;
    isSessionCurrent(): boolean;
  }): Promise<void>;
}

interface PhotoshopPluginRuntimeOptions {
  host?: PhotoshopHostPort;
  createConnection?(callbacks: {
    onState(state: RuntimeConnectionState): void;
    onMessage(message: Exclude<RuntimeMessage, { type: 'photoshop.session.ready' }>): void;
  }): RuntimeConnectionPort;
  schedule?(callback: () => void, delay: number): unknown;
  cancelSchedule?(handle: unknown): void;
}

export interface PhotoshopProjectDirectoryTree {
  canonicalRoot: string;
  projectRevision: number;
  status: 'loading' | 'loaded';
  directories: string[];
}

export interface PhotoshopPluginSnapshot {
  connection: RuntimeConnectionState;
  selection: PhotoshopSelectionSnapshot;
  projects: PhotoshopProjectSnapshot[];
  directoryTrees: PhotoshopProjectDirectoryTree[];
  expandedDirectories: Array<{
    canonicalRoot: string;
    directory: string;
  }>;
  destination: {
    canonicalRoot: string;
    projectName: string;
    projectRevision: number;
    directory: string;
  } | null;
  activeExport: {
    itemCount: number;
    destinationLabel: string;
  } | null;
  busy: boolean;
  result: { tone: 'success' | 'error'; message: string } | null;
}

export function resolvePhotoshopDestination(snapshot: PhotoshopPluginSnapshot): {
  destination: Exclude<PhotoshopPluginSnapshot['destination'], null>;
  project: PhotoshopProjectSnapshot;
} | null {
  const destination = snapshot.destination;
  if (destination === null) return null;
  const project = snapshot.projects.find((candidate) => (
    candidate.canonicalRoot === destination.canonicalRoot
    && candidate.revision === destination.projectRevision
  ));
  if (!project) return null;
  const directoryValid = destination.directory === ''
    || currentDirectoryTree(snapshot, project.canonicalRoot)?.directories.includes(destination.directory) === true;
  return directoryValid ? { destination, project } : null;
}

export class PhotoshopPluginRuntime {
  private readonly host: PhotoshopHostPort;
  private readonly connection: RuntimeConnectionPort;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancelSchedule: (handle: unknown) => void;
  private readonly subscribers = new Set<(snapshot: PhotoshopPluginSnapshot) => void>();
  private stopHostObservation: (() => void) | undefined;
  private hostChangeSchedule: unknown;
  private started = false;
  private snapshotValue: PhotoshopPluginSnapshot;
  private readonly pendingDirectoryRequests = new Map<string, {
    requestId: string;
    canonicalRoot: string;
    revision: number;
  }>();
  private pendingExportReady: { commandId: string; resolve(): void; reject(error: Error): void } | undefined;

  constructor(options: PhotoshopPluginRuntimeOptions = {}) {
    this.host = options.host ?? new PhotoshopHost();
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle as number));
    this.snapshotValue = {
      connection: { status: 'disconnected' },
      selection: this.host.selection(),
      projects: [],
      directoryTrees: [],
      expandedDirectories: [],
      destination: null,
      activeExport: null,
      busy: false,
      result: null
    };
    const createConnection = options.createConnection ?? ((callbacks) => new RuntimeConnection({
      hostVersion: () => this.host.hostVersion(),
      placementMimeTypes: () => this.host.placementMimeTypes(),
      documents: () => this.host.documents(),
      onState: callbacks.onState,
      onMessage: callbacks.onMessage
    }));
    this.connection = createConnection({
      onState: (state) => this.handleConnectionState(state),
      onMessage: (message) => this.handleMessage(message)
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopHostObservation = this.host.observeChanges(() => this.scheduleHostSnapshot());
    this.connection.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopHostObservation?.();
    this.stopHostObservation = undefined;
    if (this.hostChangeSchedule !== undefined) {
      this.cancelSchedule(this.hostChangeSchedule);
      this.hostChangeSchedule = undefined;
    }
    this.connection.stop();
  }

  snapshot(): PhotoshopPluginSnapshot {
    return this.snapshotValue;
  }

  subscribe(subscriber: (snapshot: PhotoshopPluginSnapshot) => void): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.snapshotValue);
    return () => this.subscribers.delete(subscriber);
  }

  requestDirectories(canonicalRoot: string): void {
    const project = this.snapshotValue.projects.find((candidate) => candidate.canonicalRoot === canonicalRoot);
    if (!project || this.snapshotValue.connection.status !== 'ready') return;
    const currentTree = this.snapshotValue.directoryTrees.find((tree) => (
      tree.canonicalRoot === project.canonicalRoot && tree.projectRevision === project.revision
    ));
    if (currentTree?.status === 'loaded') return;
    const currentPending = this.pendingDirectoryRequests.get(project.canonicalRoot);
    if (currentPending?.revision === project.revision) return;
    const pending = {
      requestId: uniqueId(),
      canonicalRoot: project.canonicalRoot,
      revision: project.revision
    };
    this.pendingDirectoryRequests.set(project.canonicalRoot, pending);
    this.patch({
      directoryTrees: upsertDirectoryTree(this.snapshotValue.directoryTrees, {
        canonicalRoot: project.canonicalRoot,
        projectRevision: project.revision,
        status: 'loading',
        directories: []
      })
    });
    try {
      this.connection.send({
        type: 'photoshop.projectDirectories.request',
        ...pending
      });
    } catch {
      if (this.pendingDirectoryRequests.get(project.canonicalRoot) === pending) {
        this.pendingDirectoryRequests.delete(project.canonicalRoot);
      }
    }
  }

  activateDestination(canonicalRoot: string, directory: string): void {
    const expanded = this.snapshotValue.expandedDirectories.some((entry) => (
      entry.canonicalRoot === canonicalRoot && entry.directory === directory
    ));
    if (!this.selectDestination(canonicalRoot, directory)) return;
    if (expanded) {
      this.collapseDestination(canonicalRoot, directory);
    } else {
      this.expandDestination(canonicalRoot, directory);
    }
  }

  selectDestination(canonicalRoot: string, directory: string): boolean {
    const project = this.snapshotValue.projects.find((candidate) => candidate.canonicalRoot === canonicalRoot);
    if (!project) return false;
    if (directory !== '') {
      const tree = currentDirectoryTree(this.snapshotValue, canonicalRoot);
      if (!tree?.directories.includes(directory)) return false;
    }
    this.patch({
      destination: {
        canonicalRoot: project.canonicalRoot,
        projectName: project.name,
        projectRevision: project.revision,
        directory
      },
      expandedDirectories: withExpandedAncestors(
        this.snapshotValue.expandedDirectories,
        canonicalRoot,
        directory
      )
    });
    return true;
  }

  expandDestination(canonicalRoot: string, directory: string): void {
    const project = this.snapshotValue.projects.find((candidate) => candidate.canonicalRoot === canonicalRoot);
    if (!project) return;
    if (directory !== '') {
      const tree = currentDirectoryTree(this.snapshotValue, canonicalRoot);
      if (!tree?.directories.includes(directory) || !hasDirectChild(tree.directories, directory)) return;
    }
    if (this.snapshotValue.expandedDirectories.some((entry) => (
      entry.canonicalRoot === canonicalRoot && entry.directory === directory
    ))) return;
    this.patch({
      expandedDirectories: [
        ...withExpandedAncestors(this.snapshotValue.expandedDirectories, canonicalRoot, directory),
        { canonicalRoot, directory }
      ]
    });
    if (directory === '') this.requestDirectories(canonicalRoot);
  }

  collapseDestination(canonicalRoot: string, directory: string): void {
    if (!this.snapshotValue.expandedDirectories.some((entry) => (
      entry.canonicalRoot === canonicalRoot && entry.directory === directory
    ))) return;
    this.patch({
      expandedDirectories: this.snapshotValue.expandedDirectories.filter((entry) => !(
        entry.canonicalRoot === canonicalRoot && entry.directory === directory
      ))
    });
  }

  async sendSelection(): Promise<void> {
    const resolvedDestination = resolvePhotoshopDestination(this.snapshotValue);
    const selection = this.host.selection();
    if (this.snapshotValue.connection.status !== 'ready') {
      throw new Error('Debrute Runtime is not connected.');
    }
    if (this.snapshotValue.busy) throw new Error('Photoshop is already transferring files.');
    if (resolvedDestination === null) throw new Error('Select a live Debrute Project Directory.');
    const { destination, project } = resolvedDestination;
    if (selection.documentId === null || selection.items.length === 0) {
      throw new Error('Select at least one Photoshop layer or group.');
    }
    if (selection.items.length > PHOTOSHOP_MAX_BATCH_ITEMS) {
      throw new Error('Select no more than 50 Photoshop layers or groups.');
    }
    const commandId = uniqueId();
    const items = selection.items.map((item) => ({
      itemId: uniqueId(),
      layerId: item.layerId,
      sourceName: item.name
    }));
    const destinationLabel = destination.directory === ''
      ? project.name
      : `${project.name} / ${destination.directory}`;
    let exportAdmitted = false;
    let exportFinished = false;
    this.patch({
      selection,
      activeExport: { itemCount: items.length, destinationLabel },
      busy: true,
      result: null
    });
    try {
      const ready = new Promise<void>((resolve, reject) => {
        this.pendingExportReady = { commandId, resolve, reject };
      });
      this.connection.send({
        type: 'photoshop.export.start',
        commandId,
        canonicalRoot: project.canonicalRoot,
        projectRevision: project.revision,
        directory: destination.directory,
        items: items.map(({ itemId, sourceName }) => ({ itemId, sourceName }))
      });
      await ready;
      exportAdmitted = true;
      const captures = await this.host.capturePngs(selection.documentId, items);
      const results = await this.uploadCaptured(commandId, captures);
      this.connection.send({ type: 'photoshop.export.finish', commandId, items: results });
      exportFinished = true;
      const failures = results.filter((result) => !result.ok);
      const firstFailureMessage = failures[0]?.message ?? 'Photoshop export failed.';
      this.patch({
        result: failures.length === 0
          ? {
              tone: 'success',
              message: `Sent ${results.length} file${results.length === 1 ? '' : 's'} to ${destinationLabel}.`
            }
          : {
              tone: 'error',
              message: `Sent ${results.length - failures.length} to ${destinationLabel}; failed ${failures.length}: ${firstFailureMessage}`
            }
      });
    } catch (error) {
      if (exportAdmitted && !exportFinished) {
        const message = errorMessage(error);
        try {
          this.connection.send({
            type: 'photoshop.export.finish',
            commandId,
            items: items.map((item) => ({
              itemId: item.itemId,
              ok: false,
              errorCode: 'photoshop_export_failed',
              message
            }))
          });
        } catch {
          // Socket loss settles the Runtime admission and invalidates its bearer.
        }
      }
      this.patch({
        result: {
          tone: 'error',
          message: `${errorMessage(error)} Target: ${destinationLabel}.`
        }
      });
      throw error;
    } finally {
      if (this.pendingExportReady?.commandId === commandId) this.pendingExportReady = undefined;
      this.patch({ activeExport: null, busy: false });
    }
  }

  private async uploadCaptured(
    commandId: string,
    captures: CapturedPng[]
  ): Promise<Array<{ itemId: string; ok: boolean; fileName?: string; errorCode?: string; message?: string }>> {
    const results = [];
    for (const capture of captures) {
      if (!capture.ok) {
        results.push({
          itemId: capture.itemId,
          ok: false,
          errorCode: 'photoshop_export_failed',
          message: capture.message
        });
        continue;
      }
      try {
        const bytes = await capture.staged.read();
        const uploaded = await this.connection.uploadExportItem(commandId, capture.itemId, bytes);
        results.push({ itemId: capture.itemId, ok: true, fileName: uploaded.fileName });
      } catch (error) {
        results.push({
          itemId: capture.itemId,
          ok: false,
          errorCode: 'photoshop_export_failed',
          message: errorMessage(error)
        });
      } finally {
        await capture.staged.delete().catch(() => undefined);
      }
    }
    return results;
  }

  private handleConnectionState(state: RuntimeConnectionState): void {
    this.patch({ connection: state });
    if (state.status !== 'ready') {
      this.pendingDirectoryRequests.clear();
      this.pendingExportReady?.reject(new Error('Debrute Runtime disconnected.'));
      this.pendingExportReady = undefined;
      this.patch({
        projects: [],
        directoryTrees: []
      });
    }
  }

  private handleMessage(message: Exclude<RuntimeMessage, { type: 'photoshop.session.ready' }>): void {
    if (message.type === 'photoshop.projects.snapshot') {
      for (const [canonicalRoot, pending] of this.pendingDirectoryRequests) {
        if (!message.projects.some((project) => (
          project.canonicalRoot === canonicalRoot && project.revision === pending.revision
        ))) {
          this.pendingDirectoryRequests.delete(canonicalRoot);
        }
      }
      const destination = this.snapshotValue.destination;
      const destinationProject = destination === null
        ? undefined
        : message.projects.find((project) => project.canonicalRoot === destination.canonicalRoot);
      const nextDestination: PhotoshopPluginSnapshot['destination'] = destination === null
        || destinationProject === undefined
        ? null
        : {
            canonicalRoot: destination.canonicalRoot,
            projectName: destinationProject.name,
            projectRevision: destination.directory === ''
              ? destinationProject.revision
              : destination.projectRevision,
            directory: destination.directory
          };
      this.patch({
        projects: message.projects,
        destination: nextDestination,
        directoryTrees: this.snapshotValue.directoryTrees.filter((tree) => message.projects.some((project) => (
          project.canonicalRoot === tree.canonicalRoot && project.revision === tree.projectRevision
        ))),
        expandedDirectories: this.snapshotValue.expandedDirectories.filter((entry) => (
          message.projects.some((project) => project.canonicalRoot === entry.canonicalRoot)
        ))
      });
      for (const expanded of this.snapshotValue.expandedDirectories) {
        if (expanded.directory === ''
          && message.projects.some((project) => project.canonicalRoot === expanded.canonicalRoot)) {
          this.requestDirectories(expanded.canonicalRoot);
        }
      }
      if (destinationProject !== undefined && destination?.directory !== '') {
        this.requestDirectories(destinationProject.canonicalRoot);
      }
      return;
    }
    if (message.type === 'photoshop.projectDirectories.snapshot') {
      const pending = this.pendingDirectoryRequests.get(message.canonicalRoot);
      if (pending
        && pending.requestId === message.requestId
        && pending.canonicalRoot === message.canonicalRoot
        && pending.revision === message.revision) {
        this.pendingDirectoryRequests.delete(message.canonicalRoot);
        const directories = ['', ...message.directories.filter((directory) => directory.length > 0).sort()];
        const destination = this.snapshotValue.destination;
        const destinationStillValid = destination === null
          || destination.canonicalRoot !== message.canonicalRoot
          || directories.includes(destination.directory);
        this.patch({
          directoryTrees: upsertDirectoryTree(this.snapshotValue.directoryTrees, {
            canonicalRoot: message.canonicalRoot,
            projectRevision: message.revision,
            status: 'loaded',
            directories
          }),
          expandedDirectories: this.snapshotValue.expandedDirectories.filter((entry) => (
            entry.canonicalRoot !== message.canonicalRoot
            || entry.directory === ''
            || directories.includes(entry.directory)
          )),
          ...(destination === null || destination.canonicalRoot !== message.canonicalRoot
            ? {}
            : destinationStillValid
              ? { destination: { ...destination, projectRevision: message.revision } }
              : {
                  destination: null
                })
        });
      }
      return;
    }
    if (message.type === 'photoshop.export.ready') {
      if (this.pendingExportReady?.commandId === message.commandId) {
        const pending = this.pendingExportReady;
        this.pendingExportReady = undefined;
        pending.resolve();
      }
      return;
    }
    if (message.type === 'photoshop.place.request') {
      void this.placeIncoming(message);
    }
  }

  private async placeIncoming(message: Extract<RuntimeMessage, { type: 'photoshop.place.request' }>): Promise<void> {
    if (this.snapshotValue.busy) {
      this.connection.send({
        type: 'photoshop.place.result',
        commandId: message.commandId,
        ok: false,
        errorCode: 'photoshop_busy',
        message: 'Photoshop is already transferring files.'
      });
      return;
    }
    this.patch({ busy: true });
    const sessionGeneration = this.connection.sessionGeneration();
    let result: Extract<PluginMessage, { type: 'photoshop.place.result' }>;
    try {
      const bytes = await this.connection.downloadCommandContent(message.commandId, message.byteLength);
      if (this.connection.sessionGeneration() !== sessionGeneration
        || this.snapshotValue.connection.status !== 'ready') {
        throw new Error('Photoshop Runtime session was lost.');
      }
      await this.host.placeEmbeddedSmartObject({
        documentId: message.documentId,
        fileName: message.fileName,
        bytes,
        isSessionCurrent: () => this.connection.sessionGeneration() === sessionGeneration
          && this.snapshotValue.connection.status === 'ready'
      });
      result = { type: 'photoshop.place.result', commandId: message.commandId, ok: true };
    } catch (error) {
      result = {
        type: 'photoshop.place.result',
        commandId: message.commandId,
        ok: false,
        errorCode: errorMessage(error).includes('no longer open')
          ? 'photoshop_document_closed'
          : 'photoshop_place_failed',
        message: errorMessage(error)
      };
    }
    try {
      this.connection.send(result);
    } catch {
      // The Runtime already settles the command when this socket session is lost.
    }
    this.patch({ busy: false, selection: this.host.selection() });
  }

  private scheduleHostSnapshot(): void {
    this.patch({ selection: this.host.selection() });
    if (this.hostChangeSchedule !== undefined) return;
    this.hostChangeSchedule = this.schedule(() => {
      this.hostChangeSchedule = undefined;
      if (this.snapshotValue.connection.status === 'ready') {
        this.connection.send({ type: 'photoshop.documents.snapshot', documents: this.host.documents() });
      }
      this.patch({ selection: this.host.selection() });
    }, 50);
  }

  private patch(patch: Partial<PhotoshopPluginSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    for (const subscriber of this.subscribers) subscriber(this.snapshotValue);
  }
}

function uniqueId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function upsertDirectoryTree(
  trees: readonly PhotoshopProjectDirectoryTree[],
  nextTree: PhotoshopProjectDirectoryTree
): PhotoshopProjectDirectoryTree[] {
  const existingIndex = trees.findIndex((tree) => tree.canonicalRoot === nextTree.canonicalRoot);
  if (existingIndex === -1) return [...trees, nextTree];
  return trees.map((tree, index) => index === existingIndex ? nextTree : tree);
}

function currentDirectoryTree(
  snapshot: PhotoshopPluginSnapshot,
  canonicalRoot: string
): PhotoshopProjectDirectoryTree | undefined {
  const project = snapshot.projects.find((candidate) => candidate.canonicalRoot === canonicalRoot);
  if (!project) return undefined;
  return snapshot.directoryTrees.find((tree) => (
    tree.canonicalRoot === project.canonicalRoot
    && tree.projectRevision === project.revision
    && tree.status === 'loaded'
  ));
}

function hasDirectChild(directories: readonly string[], directory: string): boolean {
  const prefix = directory === '' ? '' : `${directory}/`;
  return directories.some((candidate) => {
    if (!candidate.startsWith(prefix) || candidate === directory) return false;
    return !candidate.slice(prefix.length).includes('/');
  });
}

function withExpandedAncestors(
  expanded: readonly { canonicalRoot: string; directory: string }[],
  canonicalRoot: string,
  directory: string
): Array<{ canonicalRoot: string; directory: string }> {
  if (directory === '') return [...expanded];
  const required = ['', ...parentDirectories(directory)];
  const next = [...expanded];
  for (const ancestor of required) {
    if (!next.some((entry) => entry.canonicalRoot === canonicalRoot && entry.directory === ancestor)) {
      next.push({ canonicalRoot, directory: ancestor });
    }
  }
  return next;
}

function parentDirectories(directory: string): string[] {
  const segments = directory.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Photoshop transfer failed.';
}
