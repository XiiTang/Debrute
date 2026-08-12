import {
  PhotoshopHost,
  type CapturedPng,
  type PhotoshopSelectionSnapshot
} from './PhotoshopHost.js';
import {
  RuntimeConnection,
  RuntimeSessionLostError,
  RuntimeTransferRejectedError,
  RuntimeUploadOutcomeUnknownError,
  type RuntimeSessionLease,
  type RuntimeConnectionState
} from './RuntimeConnection.js';
import {
  PHOTOSHOP_MAX_BATCH_ITEMS,
  type PhotoshopDocumentSnapshot,
  type PhotoshopMimeType,
  type PhotoshopProjectDirectoryPage,
  type PhotoshopProjectSnapshot,
  type PluginMessage,
  type RuntimeMessage
} from '@debrute/app-protocol';

export interface RuntimeConnectionPort {
  start(): void;
  stop(): void;
  requireSession(): RuntimeSessionLease;
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
    onMessage(
      session: RuntimeSessionLease,
      message: Exclude<RuntimeMessage, { type: 'photoshop.session.ready' }>
    ): void;
  }): RuntimeConnectionPort;
  schedule?(callback: () => void, delay: number): unknown;
  cancelSchedule?(handle: unknown): void;
}

export interface PhotoshopProjectDirectoryPageState {
  canonicalRoot: string;
  directory: string;
  projectRevision: number;
  status: 'loading' | 'loaded' | 'missing' | 'error';
  childDirectories: string[];
  message?: string;
}

export interface PhotoshopPluginSnapshot {
  connection: RuntimeConnectionState;
  selection: PhotoshopSelectionSnapshot;
  projects: PhotoshopProjectSnapshot[];
  directoryPages: PhotoshopProjectDirectoryPageState[];
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
    || directoryIsLoadedChild(snapshot, project.canonicalRoot, destination.directory);
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
    baseProjectRevision: number;
    directories: string[];
    session: RuntimeSessionLease;
    deferredResult?: Extract<RuntimeMessage, { type: 'photoshop.projectDirectories.result' }>;
  }>();
  private pendingExportReady: {
    commandId: string;
    session: RuntimeSessionLease;
    resolve(): void;
    reject(error: Error): void;
  } | undefined;

  constructor(options: PhotoshopPluginRuntimeOptions = {}) {
    this.host = options.host ?? new PhotoshopHost();
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle as number));
    this.snapshotValue = {
      connection: { status: 'disconnected' },
      selection: this.host.selection(),
      projects: [],
      directoryPages: [],
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
      onMessage: (session, message) => this.handleMessage(session, message)
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

  requestDirectories(canonicalRoot: string, requestedDirectories?: string[]): void {
    const project = this.snapshotValue.projects.find((candidate) => candidate.canonicalRoot === canonicalRoot);
    if (!project || this.snapshotValue.connection.status !== 'ready') return;
    if (this.pendingDirectoryRequests.has(project.canonicalRoot)) return;
    const directories = uniqueDirectories(
      requestedDirectories ?? requiredDirectoryPages(this.snapshotValue, project.canonicalRoot)
    ).filter((directory) => {
      const page = currentDirectoryPage(this.snapshotValue, project.canonicalRoot, directory);
      return requestedDirectories !== undefined
        ? page?.status !== 'loading' && page?.status !== 'loaded'
        : page === undefined || page.status === 'missing';
    });
    if (directories.length === 0) return;
    let session: RuntimeSessionLease;
    try {
      session = this.connection.requireSession();
    } catch {
      return;
    }
    const pending = {
      requestId: uniqueId(),
      canonicalRoot: project.canonicalRoot,
      baseProjectRevision: project.revision,
      directories,
      session
    };
    this.pendingDirectoryRequests.set(project.canonicalRoot, pending);
    this.patch({
      directoryPages: upsertDirectoryPages(
        this.snapshotValue.directoryPages.filter((page) => (
          page.canonicalRoot !== canonicalRoot || page.projectRevision === project.revision
        )),
        directories.map((directory) => ({
          canonicalRoot,
          directory,
          projectRevision: project.revision,
          status: 'loading' as const,
          childDirectories: []
        }))
      )
    });
    try {
      session.send({
        type: 'photoshop.projectDirectories.request',
        requestId: pending.requestId,
        canonicalRoot: pending.canonicalRoot,
        baseProjectRevision: pending.baseProjectRevision,
        directories: pending.directories
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
    if (directory !== '' && !directoryIsLoadedChild(this.snapshotValue, canonicalRoot, directory)) return false;
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
    if (directory !== '' && !directoryIsLoadedChild(this.snapshotValue, canonicalRoot, directory)) return;
    if (this.snapshotValue.expandedDirectories.some((entry) => (
      entry.canonicalRoot === canonicalRoot && entry.directory === directory
    ))) return;
    this.patch({
      expandedDirectories: [
        ...withExpandedAncestors(this.snapshotValue.expandedDirectories, canonicalRoot, directory),
        { canonicalRoot, directory }
      ]
    });
    this.requestDirectories(canonicalRoot, [directory]);
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
    const session = this.connection.requireSession();
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
    let captures: CapturedPng[] = [];
    let settlements: ExportItemSettlement[] = [];
    let thrown: unknown;
    this.patch({
      selection,
      activeExport: { itemCount: items.length, destinationLabel },
      busy: true,
      result: null
    });
    try {
      const ready = new Promise<void>((resolve, reject) => {
        this.pendingExportReady = { commandId, session, resolve, reject };
      });
      session.send({
        type: 'photoshop.export.start',
        commandId,
        canonicalRoot: project.canonicalRoot,
        projectRevision: project.revision,
        directory: destination.directory,
        items: items.map(({ itemId, sourceName }) => ({ itemId, sourceName }))
      });
      await ready;
      exportAdmitted = true;
      captures = await this.host.capturePngs(selection.documentId, items);
      settlements = await this.uploadCaptured(session, commandId, items, captures);
      if (session.isLive() && settlements.every((settlement) => (
        settlement.state === 'committed' || settlement.state === 'failed'
      ))) {
        session.send({
          type: 'photoshop.export.finish',
          commandId,
          items: settlements.map((settlement) => settlement.state === 'committed'
            ? { itemId: settlement.itemId, ok: true, fileName: settlement.fileName }
            : { itemId: settlement.itemId, ok: false })
        });
      }
    } catch (error) {
      thrown = error;
      if (exportAdmitted && settlements.length === 0) {
        settlements = items.map((item) => ({
          itemId: item.itemId,
          state: session.isLive() ? 'failed' as const : 'notAttempted' as const,
          message: errorMessage(error)
        }));
      }
      if (exportAdmitted && session.isLive() && settlements.every((settlement) => (
        settlement.state === 'failed'
      ))) {
        try {
          session.send({
            type: 'photoshop.export.finish',
            commandId,
            items: settlements.map((settlement) => ({ itemId: settlement.itemId, ok: false }))
          });
        } catch {
          // Session revocation already retires the Runtime admission.
        }
      }
    } finally {
      if (this.pendingExportReady?.commandId === commandId) this.pendingExportReady = undefined;
      const cleanupFailures = await cleanupCapturedPngs(captures);
      const result = exportResultPresentation(
        settlements,
        destinationLabel,
        cleanupFailures,
        thrown
      );
      this.patch({ result, activeExport: null, busy: false });
    }
    if (thrown !== undefined) throw thrown;
  }

  private async uploadCaptured(
    session: RuntimeSessionLease,
    commandId: string,
    items: Array<{ itemId: string }>,
    captures: CapturedPng[]
  ): Promise<ExportItemSettlement[]> {
    const capturesByItem = new Map(captures.map((capture) => [capture.itemId, capture]));
    const results: ExportItemSettlement[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const capture = capturesByItem.get(item.itemId);
      if (!capture) {
        results.push({
          itemId: item.itemId,
          state: 'failed',
          message: 'Photoshop did not capture this export item.'
        });
        continue;
      }
      if (!capture.ok) {
        results.push({
          itemId: capture.itemId,
          state: 'failed',
          message: capture.message
        });
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await capture.staged.read();
      } catch (error) {
        results.push({
          itemId: capture.itemId,
          state: 'failed',
          message: errorMessage(error)
        });
        continue;
      }
      try {
        const uploaded = await session.uploadExportItem(commandId, capture.itemId, bytes);
        results.push({ itemId: capture.itemId, state: 'committed', fileName: uploaded.fileName });
      } catch (error) {
        if (error instanceof RuntimeUploadOutcomeUnknownError) {
          results.push({ itemId: capture.itemId, state: 'unknown', message: error.message });
          appendNotAttempted(results, items.slice(index + 1), error.message);
          break;
        }
        if (error instanceof RuntimeTransferRejectedError) {
          results.push({
            itemId: capture.itemId,
            state: 'failed',
            message: error.message
          });
          continue;
        }
        if (error instanceof RuntimeSessionLostError || !session.isLive()) {
          const message = 'Debrute Runtime disconnected before this item was attempted.';
          results.push({ itemId: capture.itemId, state: 'notAttempted', message });
          appendNotAttempted(results, items.slice(index + 1), message);
          break;
        }
        results.push({
          itemId: capture.itemId,
          state: 'failed',
          message: errorMessage(error)
        });
      }
    }
    return results;
  }

  private handleConnectionState(state: RuntimeConnectionState): void {
    this.patch({ connection: state });
    if (state.status !== 'ready') {
      this.pendingDirectoryRequests.clear();
      this.pendingExportReady?.reject(new RuntimeSessionLostError());
      this.pendingExportReady = undefined;
      this.patch({
        projects: [],
        directoryPages: []
      });
    }
  }

  private handleMessage(
    session: RuntimeSessionLease,
    message: Exclude<RuntimeMessage, { type: 'photoshop.session.ready' }>
  ): void {
    let currentSession: RuntimeSessionLease;
    try {
      currentSession = this.connection.requireSession();
    } catch {
      return;
    }
    if (currentSession !== session || !session.isLive()) return;
    if (message.type === 'photoshop.projects.snapshot') {
      this.handleProjectsSnapshot(message.projects);
      return;
    }
    if (message.type === 'photoshop.projectDirectories.result') {
      this.handleDirectoryResult(session, message);
      return;
    }
    if (message.type === 'photoshop.export.ready') {
      if (this.pendingExportReady?.commandId === message.commandId
        && this.pendingExportReady.session === session) {
        const pending = this.pendingExportReady;
        this.pendingExportReady = undefined;
        pending.resolve();
      }
      return;
    }
    if (message.type === 'photoshop.place.request') {
      void this.placeIncoming(session, message);
    }
  }

  private handleProjectsSnapshot(projects: PhotoshopProjectSnapshot[]): void {
    let directoryPages = this.snapshotValue.directoryPages;
    for (const [canonicalRoot, pending] of this.pendingDirectoryRequests) {
      const project = projects.find((candidate) => candidate.canonicalRoot === canonicalRoot);
      if (project === undefined || project.revision > pending.baseProjectRevision + 1) {
        this.pendingDirectoryRequests.delete(canonicalRoot);
        directoryPages = directoryPages.filter((page) => page.canonicalRoot !== canonicalRoot);
      }
    }
    for (const previous of this.snapshotValue.projects) {
      const current = projects.find((project) => project.canonicalRoot === previous.canonicalRoot);
      if (current === undefined) {
        directoryPages = directoryPages.filter((page) => page.canonicalRoot !== previous.canonicalRoot);
        this.pendingDirectoryRequests.delete(previous.canonicalRoot);
      } else if (current.revision !== previous.revision
        && !this.pendingDirectoryRequests.has(previous.canonicalRoot)) {
        directoryPages = directoryPages.filter((page) => page.canonicalRoot !== previous.canonicalRoot);
      }
    }
    let destination = this.snapshotValue.destination;
    if (destination !== null) {
      const project = projects.find((candidate) => candidate.canonicalRoot === destination?.canonicalRoot);
      if (project === undefined) {
        destination = null;
      } else if (destination.directory === '') {
        destination = { ...destination, projectName: project.name, projectRevision: project.revision };
      } else {
        destination = {
          ...destination,
          projectName: project.name,
          projectRevision: project.revision
        };
      }
    }
    this.patch({
      projects,
      directoryPages,
      destination,
      expandedDirectories: this.snapshotValue.expandedDirectories.filter((entry) => (
        projects.some((project) => project.canonicalRoot === entry.canonicalRoot)
      ))
    });
    for (const project of projects) {
      const pending = this.pendingDirectoryRequests.get(project.canonicalRoot);
      if (pending?.deferredResult?.projectRevision === project.revision) {
        this.applyDirectoryResult(pending.deferredResult);
      }
    }
    for (const project of projects) this.requestDirectories(project.canonicalRoot);
  }

  private handleDirectoryResult(
    session: RuntimeSessionLease,
    message: Extract<RuntimeMessage, { type: 'photoshop.projectDirectories.result' }>
  ): void {
    const pending = this.pendingDirectoryRequests.get(message.canonicalRoot);
    if (pending === undefined
      || pending.session !== session
      || pending.requestId !== message.requestId
      || pending.baseProjectRevision !== message.baseProjectRevision) return;
    const project = this.snapshotValue.projects.find((candidate) => (
      candidate.canonicalRoot === message.canonicalRoot
    ));
    if (project === undefined) {
      this.pendingDirectoryRequests.delete(message.canonicalRoot);
      return;
    }
    if (message.projectRevision > project.revision) {
      pending.deferredResult = message;
      return;
    }
    if (message.projectRevision < project.revision) {
      this.pendingDirectoryRequests.delete(message.canonicalRoot);
      this.patch({
        directoryPages: this.snapshotValue.directoryPages.filter((page) => (
          page.canonicalRoot !== message.canonicalRoot
        ))
      });
      queueMicrotask(() => this.requestDirectories(message.canonicalRoot));
      return;
    }
    this.applyDirectoryResult(message);
  }

  private applyDirectoryResult(
    message: Extract<RuntimeMessage, { type: 'photoshop.projectDirectories.result' }>
  ): void {
    const pending = this.pendingDirectoryRequests.get(message.canonicalRoot);
    if (pending === undefined || pending.requestId !== message.requestId) return;
    this.pendingDirectoryRequests.delete(message.canonicalRoot);
    if (message.outcome === 'stale') {
      this.patch({
        directoryPages: this.snapshotValue.directoryPages.filter((page) => (
          page.canonicalRoot !== message.canonicalRoot
        ))
      });
      queueMicrotask(() => this.requestDirectories(message.canonicalRoot));
      return;
    }
    if (!sameDirectorySet(pending.directories, message.pages.map((page) => page.directory))) {
      this.patch({
        directoryPages: this.snapshotValue.directoryPages.filter((page) => (
          page.canonicalRoot !== message.canonicalRoot
        ))
      });
      return;
    }
    let directoryPages = this.snapshotValue.directoryPages.map((page) => (
      page.canonicalRoot === message.canonicalRoot
        && page.projectRevision === message.baseProjectRevision
        ? { ...page, projectRevision: message.projectRevision }
        : page
    ));
    directoryPages = upsertDirectoryPages(directoryPages, message.pages.map((page) => ({
      canonicalRoot: message.canonicalRoot,
      directory: page.directory,
      projectRevision: message.projectRevision,
      ...protocolDirectoryPageState(page)
    })));
    let destination = this.snapshotValue.destination;
    if (destination?.canonicalRoot === message.canonicalRoot) {
      if (destination.directory === '') {
        destination = { ...destination, projectRevision: message.projectRevision };
      } else if (directoryProvenMissing(directoryPages, destination)) {
        destination = null;
      } else {
        destination = { ...destination, projectRevision: message.projectRevision };
      }
    }
    const expandedDirectories = this.snapshotValue.expandedDirectories.filter((entry) => (
      entry.canonicalRoot !== message.canonicalRoot
      || entry.directory === ''
      || !directoryProvenMissing(directoryPages, {
        canonicalRoot: entry.canonicalRoot,
        directory: entry.directory,
        projectRevision: message.projectRevision
      })
    ));
    this.patch({ directoryPages, destination, expandedDirectories });
    queueMicrotask(() => this.requestDirectories(message.canonicalRoot));
  }

  private async placeIncoming(
    session: RuntimeSessionLease,
    message: Extract<RuntimeMessage, { type: 'photoshop.place.request' }>
  ): Promise<void> {
    if (this.snapshotValue.busy) {
      try {
        session.send({
          type: 'photoshop.place.result',
          commandId: message.commandId,
          ok: false,
          errorCode: 'photoshop_busy',
          message: 'Photoshop is already transferring files.'
        });
      } catch {
        // The Runtime already settles the command when this socket session is lost.
      }
      return;
    }
    this.patch({ busy: true });
    let result: Extract<PluginMessage, { type: 'photoshop.place.result' }>;
    try {
      const bytes = await session.downloadCommandContent(message.commandId, message.byteLength);
      if (!session.isLive()) throw new RuntimeSessionLostError();
      await this.host.placeEmbeddedSmartObject({
        documentId: message.documentId,
        fileName: message.fileName,
        bytes,
        isSessionCurrent: () => session.isLive()
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
      session.send(result);
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
        try {
          this.connection.requireSession().send({
            type: 'photoshop.documents.snapshot',
            documents: this.host.documents()
          });
        } catch {
          // The current connection state callback will publish the disconnect.
        }
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

type ExportItemSettlement =
  | { itemId: string; state: 'committed'; fileName: string }
  | { itemId: string; state: 'failed' | 'unknown' | 'notAttempted'; message: string };

function appendNotAttempted(
  results: ExportItemSettlement[],
  items: Array<{ itemId: string }>,
  message: string
): void {
  for (const item of items) results.push({ itemId: item.itemId, state: 'notAttempted', message });
}

async function cleanupCapturedPngs(captures: CapturedPng[]): Promise<number> {
  const cleanup = await Promise.allSettled(captures.flatMap((capture) => (
    capture.ok ? [capture.staged.delete()] : []
  )));
  return cleanup.filter((result) => result.status === 'rejected').length;
}

function exportResultPresentation(
  settlements: ExportItemSettlement[],
  destinationLabel: string,
  cleanupFailures: number,
  thrown: unknown
): { tone: 'success' | 'error'; message: string } {
  const committed = settlements.filter((settlement) => settlement.state === 'committed');
  const failed = settlements.filter((settlement) => settlement.state === 'failed');
  const unknown = settlements.filter((settlement) => settlement.state === 'unknown');
  const notAttempted = settlements.filter((settlement) => settlement.state === 'notAttempted');
  let tone: 'success' | 'error' = 'error';
  let message: string;
  if (settlements.length > 0 && committed.length === settlements.length) {
    tone = 'success';
    message = `Sent ${committed.length} item${committed.length === 1 ? '' : 's'} to ${destinationLabel}.`;
  } else if (unknown.length > 0) {
    message = `${committed.length} item${committed.length === 1 ? '' : 's'} were confirmed in ${destinationLabel}; ${unknown.length} item has an unknown outcome and may have been saved; ${notAttempted.length} item${notAttempted.length === 1 ? ' was' : 's were'} not attempted.`;
  } else if (failed.length > 0 || committed.length > 0 || notAttempted.length > 0) {
    const firstFailure = settlements.find((settlement) => settlement.state !== 'committed');
    message = `Sent ${committed.length} item${committed.length === 1 ? '' : 's'} to ${destinationLabel}; ${failed.length} failed; ${notAttempted.length} not attempted. ${firstFailure?.message ?? errorMessage(thrown)}`;
  } else {
    message = `${errorMessage(thrown)} Target: ${destinationLabel}.`;
  }
  if (cleanupFailures > 0) {
    message += ` Cleanup could not remove ${cleanupFailures} Photoshop temporary file${cleanupFailures === 1 ? '' : 's'}.`;
  }
  return { tone, message };
}

function uniqueDirectories(directories: readonly string[]): string[] {
  return [...new Set(directories)].sort((left, right) => left.localeCompare(right));
}

function requiredDirectoryPages(
  snapshot: PhotoshopPluginSnapshot,
  canonicalRoot: string
): string[] {
  const directories = snapshot.expandedDirectories
    .filter((entry) => entry.canonicalRoot === canonicalRoot)
    .map((entry) => entry.directory);
  const destination = snapshot.destination;
  if (destination?.canonicalRoot === canonicalRoot && destination.directory !== '') {
    directories.push(parentDirectory(destination.directory));
  }
  return uniqueDirectories(directories);
}

function currentDirectoryPage(
  snapshot: PhotoshopPluginSnapshot,
  canonicalRoot: string,
  directory: string
): PhotoshopProjectDirectoryPageState | undefined {
  const project = snapshot.projects.find((candidate) => candidate.canonicalRoot === canonicalRoot);
  if (!project) return undefined;
  return snapshot.directoryPages.find((page) => (
    page.canonicalRoot === canonicalRoot
    && page.directory === directory
    && page.projectRevision === project.revision
  ));
}

function directoryIsLoadedChild(
  snapshot: PhotoshopPluginSnapshot,
  canonicalRoot: string,
  directory: string
): boolean {
  const page = currentDirectoryPage(snapshot, canonicalRoot, parentDirectory(directory));
  return page?.status === 'loaded' && page.childDirectories.includes(directory);
}

function directoryProvenMissing(
  pages: readonly PhotoshopProjectDirectoryPageState[],
  candidate: { canonicalRoot: string; directory: string; projectRevision: number }
): boolean {
  const exact = pages.find((page) => (
    page.canonicalRoot === candidate.canonicalRoot
    && page.directory === candidate.directory
    && page.projectRevision === candidate.projectRevision
  ));
  if (exact?.status === 'missing') return true;
  const parent = pages.find((page) => (
    page.canonicalRoot === candidate.canonicalRoot
    && page.directory === parentDirectory(candidate.directory)
    && page.projectRevision === candidate.projectRevision
  ));
  return parent?.status === 'loaded' && !parent.childDirectories.includes(candidate.directory);
}

function upsertDirectoryPages(
  pages: readonly PhotoshopProjectDirectoryPageState[],
  nextPages: readonly PhotoshopProjectDirectoryPageState[]
): PhotoshopProjectDirectoryPageState[] {
  const replacements = new Map(nextPages.map((page) => [
    `${page.canonicalRoot}\u0000${page.directory}`,
    page
  ]));
  const retained = pages.filter((page) => !replacements.has(`${page.canonicalRoot}\u0000${page.directory}`));
  return [...retained, ...nextPages].sort((left, right) => (
    left.canonicalRoot.localeCompare(right.canonicalRoot)
    || left.directory.localeCompare(right.directory)
  ));
}

function protocolDirectoryPageState(
  page: PhotoshopProjectDirectoryPage
): Pick<PhotoshopProjectDirectoryPageState, 'status' | 'childDirectories' | 'message'> {
  if (page.outcome === 'loaded') {
    return { status: 'loaded', childDirectories: [...page.childDirectories] };
  }
  if (page.outcome === 'error') {
    return { status: 'error', childDirectories: [], message: page.message };
  }
  return { status: 'missing', childDirectories: [] };
}

function sameDirectorySet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && uniqueDirectories(left).every((directory, index) => directory === uniqueDirectories(right)[index]);
}

function parentDirectory(directory: string): string {
  const separator = directory.lastIndexOf('/');
  return separator === -1 ? '' : directory.slice(0, separator);
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
