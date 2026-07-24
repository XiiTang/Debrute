import type {
  AdobeBridgeClientRuntime,
  AdobeBridgeStateView,
  PhotoshopBridgeRuntimeMessage
} from '@debrute/app-protocol';
import type { PhotoshopAdapter, PhotoshopSelectionSnapshot } from './adapter.js';
import {
  createPhotoshopStatusMessage,
  parsePhotoshopBridgeMessage
} from './bridgeClient.js';
import {
  createSignedPhotoshopHello,
  loadOrCreatePhotoshopBridgeIdentity,
  setPhotoshopBridgeIdentityPaired,
  type PhotoshopBridgeIdentity,
  type PhotoshopBridgeIdentityStore
} from './bridgeIdentity.js';
import {
  connectionStatusForBridgeError,
  photoshopBridgeConnectionPresentation,
  type PhotoshopBridgeConnectionStatus
} from './connectionPresentation.js';
import { discoverDebruteBridge } from './discoveryClient.js';
import {
  availableProjectLinks,
  linkedProjectTrees
} from './projectTreeModel.js';
import {
  selectionCardIdFromDragPayload,
  selectionCardsFromSnapshot,
  selectionDragPayloadFromCard,
  selectionDragPayloadMimeType,
  type SelectionCard
} from './selectionModel.js';
import {
  assertPhotoshopUploadSucceeded,
  createPhotoshopProjectLinkRequest,
  createPhotoshopUploadRequest,
  downloadPhotoshopImportBytes,
  photoshopImportFailurePayload
} from './transferPayloads.js';

const SELECTION_OBSERVER_INTERVAL_MS = 1000;
const REPLACEMENT_RECONNECT_INTERVAL_MS = 250;
const EMPTY_SELECTION: PhotoshopSelectionSnapshot = {
  documentTitle: null,
  documentCount: 0,
  selectedItems: []
};

export interface PhotoshopBridgePluginApplicationInput {
  root: HTMLElement;
  adapter: PhotoshopAdapter;
  identityStore: PhotoshopBridgeIdentityStore;
  clientRuntime: AdobeBridgeClientRuntime;
}

export function startPhotoshopBridgePlugin(input: PhotoshopBridgePluginApplicationInput): void {
  new PhotoshopBridgePluginApplication(input).start();
}

class PhotoshopBridgePluginApplication {
  private readonly root: HTMLElement;
  private readonly adapter: PhotoshopAdapter;
  private readonly identityStore: PhotoshopBridgeIdentityStore;
  private readonly clientRuntime: AdobeBridgeClientRuntime;
  private bridgeState: AdobeBridgeStateView | undefined;
  private selection = EMPTY_SELECTION;
  private apiBaseUrl: string | undefined;
  private bearer: string | undefined;
  private runtimeIdentityLabel: string | undefined;
  private statusErrorMessage: string | undefined;
  private selectionReadErrorMessage: string | undefined;
  private connectionStatus: PhotoshopBridgeConnectionStatus = 'searching';
  private pairingCode: string | undefined;
  private activeSocket: WebSocket | undefined;
  private readonly messageChains = new WeakMap<WebSocket, Promise<void>>();
  private replacementDeadline: string | undefined;
  private replacementRuntimeInstanceId: string | undefined;
  private replacementTimer: number | undefined;
  private selectionReadPending = false;
  private connectionAttempt = 0;
  private identity: PhotoshopBridgeIdentity | undefined;

  constructor(input: PhotoshopBridgePluginApplicationInput) {
    this.root = input.root;
    this.adapter = input.adapter;
    this.identityStore = input.identityStore;
    this.clientRuntime = input.clientRuntime;
  }

  start(): void {
    void this.initialize().catch((error) => this.showStartupFailure(error));
  }

  private async initialize(): Promise<void> {
    const [identity] = await Promise.all([
      loadOrCreatePhotoshopBridgeIdentity({ store: this.identityStore }),
      this.observeSelection()
    ]);
    this.identity = identity;
    window.setInterval(() => {
      void this.observeSelection();
    }, SELECTION_OBSERVER_INTERVAL_MS);
    if (identity.paired) {
      this.connectionStatus = 'paired';
      this.render();
      return;
    }
    this.startConnection();
  }

  private async observeSelection(): Promise<void> {
    if (this.selectionReadPending) return;
    this.selectionReadPending = true;
    try {
      const selection = await this.adapter.selectionSnapshot();
      const changed = !selectionSnapshotsEqual(selection, this.selection);
      const recovered = this.selectionReadErrorMessage !== undefined;
      this.selectionReadErrorMessage = undefined;
      if (changed) this.selection = selection;
      if ((changed || recovered) && this.identity) this.render();
      if (changed && this.connectionStatus === 'connected') this.sendPhotoshopStatus();
    } catch (error) {
      const message = `Photoshop state read failed: ${errorMessage(error)}`;
      if (message !== this.selectionReadErrorMessage) {
        this.selectionReadErrorMessage = message;
        if (this.identity) this.render();
      }
    } finally {
      this.selectionReadPending = false;
    }
  }

  private async connect(): Promise<void> {
    const attempt = ++this.connectionAttempt;
    this.clearReplacementTimer();
    const previousSocket = this.activeSocket;
    this.activeSocket = undefined;
    previousSocket?.close();
    this.bridgeState = undefined;
    this.bearer = undefined;
    this.apiBaseUrl = undefined;
    this.runtimeIdentityLabel = undefined;
    this.connectionStatus = 'searching';
    this.render();

    const discovery = await discoverDebruteBridge();
    if (attempt !== this.connectionAttempt) return;
    if (discovery.status !== 'connected') {
      this.connectionStatus = discovery.status === 'disabled' ? 'disabled' : 'unavailable';
      this.statusErrorMessage = discovery.status === 'unavailable' ? discovery.message : undefined;
      this.render();
      this.scheduleReplacementReconnect();
      return;
    }
    if (this.replacementDeadline && Date.now() > Date.parse(this.replacementDeadline)) {
      this.clearReplacementRecovery();
      this.connectionStatus = 'replacement-timeout';
      this.render();
      return;
    }
    if (
      this.replacementRuntimeInstanceId
      && discovery.runtimeInstanceId !== this.replacementRuntimeInstanceId
    ) {
      this.scheduleReplacementReconnect();
      return;
    }

    this.statusErrorMessage = undefined;
    this.runtimeIdentityLabel = `Debrute ${discovery.productVersion} · ${discovery.runtimeInstanceId}`;
    this.apiBaseUrl = discovery.apiBaseUrl;
    const socket = new WebSocket(discovery.wsUrl);
    this.activeSocket = socket;
    socket.addEventListener('message', (event) => {
      if (this.activeSocket !== socket) return;
      let message: PhotoshopBridgeRuntimeMessage;
      try {
        message = parsePhotoshopBridgeMessage(String(event.data));
      } catch (error) {
        this.failConnection(socket, error);
        return;
      }
      const previous = this.messageChains.get(socket) ?? Promise.resolve();
      const next = previous
        .then(async () => {
          if (this.activeSocket !== socket) return;
          await this.handleBridgeMessage(socket, message);
        })
        .catch((error) => this.failConnection(socket, error));
      this.messageChains.set(socket, next);
    });
    socket.addEventListener('close', () => this.handleSocketClose(socket));
  }

  private handleSocketClose(socket: WebSocket): void {
    if (this.activeSocket !== socket) return;
    this.activeSocket = undefined;
    this.bridgeState = undefined;
    this.bearer = undefined;
    this.apiBaseUrl = undefined;
    if (this.replacementDeadline && Date.now() <= Date.parse(this.replacementDeadline)) {
      this.scheduleReplacementReconnect();
      return;
    }
    this.clearReplacementRecovery();
    if (this.connectionStatus !== 'pairing-required') {
      this.connectionStatus = 'disconnected';
    }
    this.render();
  }

  private async handleBridgeMessage(
    socket: WebSocket,
    message: PhotoshopBridgeRuntimeMessage
  ): Promise<void> {
    if (message.type === 'bridge.challenge') {
      const pairingCode = this.pairingCode;
      this.pairingCode = undefined;
      const hello = await createSignedPhotoshopHello({
        identity: this.requiredIdentity(),
        challenge: message,
        pairingCode,
        hostVersion: this.adapter.hostVersion(),
        clientRuntime: this.clientRuntime,
        activeDocumentTitle: this.selection.documentTitle,
        documentCount: this.selection.documentCount
      });
      if (this.activeSocket === socket) socket.send(JSON.stringify(hello));
      return;
    }
    if (message.type === 'bridge.ready') {
      const identity = await setPhotoshopBridgeIdentityPaired({
        identity: this.requiredIdentity(),
        store: this.identityStore,
        paired: true
      });
      if (this.activeSocket !== socket) return;
      this.identity = identity;
      this.bearer = message.bearer;
      this.bridgeState = message.state;
      this.connectionStatus = 'connected';
      this.clearReplacementRecovery();
      this.pairingCode = undefined;
      this.render();
      this.sendPhotoshopStatus();
      return;
    }
    if (message.type === 'runtime_replacing') {
      this.replacementDeadline = message.deadline;
      this.replacementRuntimeInstanceId = message.runtimeInstanceId;
      socket.close();
      return;
    }
    if (message.type === 'bridge.error') {
      const connectionStatus = connectionStatusForBridgeError(message.code);
      let identity = this.requiredIdentity();
      if (connectionStatus === 'pairing-required') {
        identity = await setPhotoshopBridgeIdentityPaired({
          identity: this.requiredIdentity(),
          store: this.identityStore,
          paired: false
        });
        if (this.activeSocket !== socket) return;
      }
      this.statusErrorMessage = message.message;
      this.pairingCode = undefined;
      this.connectionStatus = connectionStatus;
      this.identity = identity;
      this.render();
      socket.close();
      return;
    }
    if (message.type === 'bridge.state') {
      this.bridgeState = message.state;
      this.render();
      return;
    }
    if (message.type === 'transfer.import.request') {
      await this.handleImportRequest(socket, message);
    }
  }

  private async handleImportRequest(
    socket: WebSocket,
    message: Extract<PhotoshopBridgeRuntimeMessage, { type: 'transfer.import.request' }>
  ): Promise<void> {
    try {
      const bytes = await downloadPhotoshopImportBytes({
        downloadUrl: message.downloadUrl,
        bearer: this.requiredBearer(),
        pluginInstanceId: this.requiredIdentity().pluginInstanceId
      });
      if (this.activeSocket !== socket) return;
      await this.adapter.placeFileAsSmartObject({ fileName: message.fileName, bytes });
      if (this.activeSocket !== socket) return;
      socket.send(JSON.stringify({
        type: 'transfer.import.result',
        transferId: message.transferId,
        ok: true
      }));
    } catch (error) {
      if (this.activeSocket !== socket) return;
      const failure = photoshopImportFailurePayload(error, {
        hasActiveDocument: this.selection.documentTitle !== null
      });
      socket.send(JSON.stringify({
        type: 'transfer.import.result',
        transferId: message.transferId,
        ok: false,
        ...failure
      }));
    }
  }

  private render(): void {
    const cards = selectionCardsFromSnapshot(this.selection);
    const connection = photoshopBridgeConnectionPresentation(this.connectionStatus);
    this.root.innerHTML = [
      `<section class="bridge-section bridge-section--status"><h1 class="bridge-section__title">Debrute</h1><p class="bridge-status-line">${escapeHtml(connection.label)}</p>${this.runtimeIdentityLabel ? `<p class="bridge-status-line">Runtime ${escapeHtml(this.runtimeIdentityLabel)}</p>` : ''}<p class="bridge-status-line">${escapeHtml(this.selection.documentTitle ?? 'No document open')}</p>${this.renderConnectionActions(connection.action)}${this.renderStatusError()}</section>`,
      `<section class="bridge-section"><h2 class="bridge-section__title">Current Selection</h2>${cards.map((card) => `<button class="bridge-selection-card" draggable="${card.draggable}" data-selection-card="${escapeHtml(card.id)}">${escapeHtml(card.label)}</button>`).join('')}</section>`,
      `<section class="bridge-section"><h2 class="bridge-section__title">Debrute Projects</h2>${this.renderLinkedProjects()}</section>`,
      `<section class="bridge-section"><h2 class="bridge-section__title">Available Projects</h2>${this.renderAvailableProjects()}</section>`
    ].join('');
    this.bindSelectionDrags(cards);
    this.bindDirectoryDrops();
    this.bindProjectLinkActions();
    this.bindConnectionActions();
  }

  private renderLinkedProjects(): string {
    return linkedProjectTrees(this.bridgeState, this.requiredIdentity().pluginInstanceId)
      .map((project) => (
        `<article class="bridge-project-card"><h3>${escapeHtml(project.projectName)}</h3><button class="bridge-action-button" data-disconnect-project="${escapeHtml(project.projectId)}">Disconnect</button>${project.directories.map((directory) => (
          `<button class="bridge-drop-target" data-project="${escapeHtml(project.projectId)}" data-directory="${escapeHtml(directory.projectRelativePath)}">${escapeHtml(directory.projectRelativePath)}</button>`
        )).join('')}</article>`
      )).join('');
  }

  private renderAvailableProjects(): string {
    return availableProjectLinks(this.bridgeState, this.requiredIdentity().pluginInstanceId)
      .map((project) => `<button class="bridge-action-button" data-connect-project="${escapeHtml(project.projectId)}">Connect ${escapeHtml(project.projectName)}</button>`)
      .join('');
  }

  private bindProjectLinkActions(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-connect-project]').forEach((button) => {
      button.addEventListener('click', () => {
        const socket = this.requiredActiveSocket();
        void this.setProjectLink(socket, this.requiredData(button, 'connectProject'), true)
          .then((applied) => {
            if (!applied || this.activeSocket !== socket) return;
            this.statusErrorMessage = undefined;
            this.render();
          }, (error) => {
            if (this.activeSocket !== socket) return;
            this.statusErrorMessage = `Project link failed: ${errorMessage(error)}`;
            this.render();
          });
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-disconnect-project]').forEach((button) => {
      button.addEventListener('click', () => {
        const socket = this.requiredActiveSocket();
        void this.setProjectLink(socket, this.requiredData(button, 'disconnectProject'), false)
          .then((applied) => {
            if (!applied || this.activeSocket !== socket) return;
            this.statusErrorMessage = undefined;
            this.render();
          }, (error) => {
            if (this.activeSocket !== socket) return;
            this.statusErrorMessage = `Project unlink failed: ${errorMessage(error)}`;
            this.render();
          });
      });
    });
  }

  private bindDirectoryDrops(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-project][data-directory]').forEach((button) => {
      button.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types.includes(selectionDragPayloadMimeType)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        button.classList.add('is-drop-active');
      });
      button.addEventListener('dragleave', () => button.classList.remove('is-drop-active'));
      button.addEventListener('drop', (event) => {
        const cardId = selectionCardIdFromDragPayload(
          event.dataTransfer?.getData(selectionDragPayloadMimeType) ?? ''
        );
        if (!cardId) return;
        event.preventDefault();
        button.classList.remove('is-drop-active');
        const socket = this.requiredActiveSocket();
        void this.uploadSelectionToDirectory(
          socket,
          this.requiredData(button, 'project'),
          this.requiredData(button, 'directory')
        ).then((completed) => {
          if (!completed || this.activeSocket !== socket) return;
          this.statusErrorMessage = undefined;
          this.render();
        }, (error) => {
          if (this.activeSocket !== socket) return;
          this.statusErrorMessage = `Upload failed: ${errorMessage(error)}`;
          this.render();
        });
      });
    });
  }

  private bindSelectionDrags(cards: SelectionCard[]): void {
    const cardsById = new Map(cards.map((card) => [card.id, card]));
    this.root.querySelectorAll<HTMLButtonElement>('[data-selection-card]').forEach((button) => {
      button.addEventListener('dragstart', (event) => {
        const card = cardsById.get(this.requiredData(button, 'selectionCard'));
        if (!card?.draggable || !event.dataTransfer) return;
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData(selectionDragPayloadMimeType, selectionDragPayloadFromCard(card));
      });
    });
  }

  private async uploadSelectionToDirectory(
    socket: WebSocket,
    projectId: string,
    targetDirectoryProjectRelativePath: string
  ): Promise<boolean> {
    const apiBaseUrl = this.requiredApiBaseUrl();
    const exported = await this.adapter.exportSelectedTopLevelPngs();
    if (this.activeSocket !== socket) return false;
    for (const item of exported) {
      const request = createPhotoshopUploadRequest({
        apiBaseUrl,
        bearer: this.requiredBearer(),
        pluginInstanceId: this.requiredIdentity().pluginInstanceId,
        projectId,
        transferId: crypto.randomUUID(),
        targetDirectoryProjectRelativePath,
        suggestedName: item.suggestedName,
        pngBytes: item.bytes
      });
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body
      });
      if (this.activeSocket !== socket) return false;
      await assertPhotoshopUploadSucceeded(response);
      if (this.activeSocket !== socket) return false;
    }
    return true;
  }

  private async setProjectLink(
    socket: WebSocket,
    projectId: string,
    linked: boolean
  ): Promise<boolean> {
    const request = createPhotoshopProjectLinkRequest({
      apiBaseUrl: this.requiredApiBaseUrl(),
      bearer: this.requiredBearer(),
      pluginInstanceId: this.requiredIdentity().pluginInstanceId,
      projectId,
      linked
    });
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers
    });
    if (this.activeSocket !== socket) return false;
    if (!response.ok) throw new Error(await response.text());
    const bridgeState = await response.json() as AdobeBridgeStateView;
    if (this.activeSocket !== socket) return false;
    this.bridgeState = bridgeState;
    return true;
  }

  private renderStatusError(): string {
    const message = this.statusErrorMessage ?? this.selectionReadErrorMessage;
    return message
      ? `<p class="bridge-status-error">${escapeHtml(message)}</p>`
      : '';
  }

  private renderConnectionActions(action: 'none' | 'pair' | 'connect' | 'reconnect'): string {
    if (action === 'pair') {
      return `<div class="bridge-connection-actions"><input data-pairing-code type="text" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX" value="${escapeHtml(this.pairingCode ?? '')}"><button class="bridge-action-button" data-pair>Pair with Debrute</button></div>`;
    }
    if (action === 'connect') {
      return '<div class="bridge-connection-actions"><button class="bridge-action-button" data-connect>Connect</button></div>';
    }
    return action === 'reconnect'
      ? '<div class="bridge-connection-actions"><button class="bridge-action-button" data-reconnect>Reconnect</button></div>'
      : '';
  }

  private bindConnectionActions(): void {
    this.root.querySelector<HTMLButtonElement>('[data-pair]')?.addEventListener('click', () => {
      const input = this.root.querySelector<HTMLInputElement>('[data-pairing-code]');
      if (!input) throw new Error('Pairing action requires a pairing code input.');
      this.pairingCode = input.value.trim();
      this.clearReplacementRecovery();
      this.startConnection();
    });
    this.root.querySelector<HTMLButtonElement>('[data-reconnect]')?.addEventListener('click', () => {
      this.pairingCode = undefined;
      this.clearReplacementRecovery();
      this.startConnection();
    });
    this.root.querySelector<HTMLButtonElement>('[data-connect]')?.addEventListener('click', () => {
      this.pairingCode = undefined;
      this.clearReplacementRecovery();
      this.startConnection();
    });
  }

  private scheduleReplacementReconnect(): void {
    if (!this.replacementDeadline || Date.now() > Date.parse(this.replacementDeadline)) {
      if (this.replacementDeadline) {
        this.clearReplacementRecovery();
        this.connectionStatus = 'replacement-timeout';
        this.render();
      }
      return;
    }
    if (this.replacementTimer === undefined) {
      this.replacementTimer = window.setTimeout(() => {
        this.replacementTimer = undefined;
        this.startConnection();
      }, REPLACEMENT_RECONNECT_INTERVAL_MS);
    }
  }

  private clearReplacementTimer(): void {
    if (this.replacementTimer === undefined) return;
    window.clearTimeout(this.replacementTimer);
    this.replacementTimer = undefined;
  }

  private clearReplacementRecovery(): void {
    this.clearReplacementTimer();
    this.replacementDeadline = undefined;
    this.replacementRuntimeInstanceId = undefined;
  }

  private startConnection(): void {
    void this.connect().catch((error) => {
      this.statusErrorMessage = errorMessage(error);
      this.connectionStatus = 'disconnected';
      this.render();
    });
  }

  private failConnection(socket: WebSocket, error: unknown): void {
    if (this.activeSocket !== socket) return;
    this.statusErrorMessage = errorMessage(error);
    this.connectionStatus = 'disconnected';
    this.render();
    socket.close();
  }

  private sendPhotoshopStatus(): void {
    const socket = this.activeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Connected Photoshop Bridge requires an open socket.');
    }
    socket.send(JSON.stringify(createPhotoshopStatusMessage({
      documentTitle: this.selection.documentTitle,
      documentCount: this.selection.documentCount
    })));
  }

  private requiredApiBaseUrl(): string {
    if (!this.apiBaseUrl) throw new Error('Photoshop Bridge API is not ready.');
    return this.apiBaseUrl;
  }

  private requiredBearer(): string {
    if (!this.bearer) throw new Error('Photoshop Bridge session is not ready.');
    return this.bearer;
  }

  private requiredActiveSocket(): WebSocket {
    const socket = this.activeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Photoshop Bridge action requires the active session.');
    }
    return socket;
  }

  private requiredIdentity(): PhotoshopBridgeIdentity {
    if (!this.identity) throw new Error('Photoshop Bridge identity is not ready.');
    return this.identity;
  }

  private requiredData(element: HTMLElement, key: keyof DOMStringMap): string {
    const value = element.dataset[key];
    if (!value) throw new Error(`Photoshop Bridge action requires data-${String(key)}.`);
    return value;
  }

  private showStartupFailure(error: unknown): void {
    this.connectionStatus = 'disconnected';
    this.statusErrorMessage = errorMessage(error);
    this.root.innerHTML = `<section class="bridge-section bridge-section--status"><h1 class="bridge-section__title">Debrute</h1><p class="bridge-status-error">${escapeHtml(this.statusErrorMessage)}</p></section>`;
  }
}

function selectionSnapshotsEqual(
  left: PhotoshopSelectionSnapshot,
  right: PhotoshopSelectionSnapshot
): boolean {
  return left.documentTitle === right.documentTitle
    && left.documentCount === right.documentCount
    && left.selectedItems.length === right.selectedItems.length
    && left.selectedItems.every((item, index) => {
      const other = right.selectedItems[index];
      return item.layerId === other?.layerId
        && item.name === other.name
        && item.kind === other.kind;
    });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
