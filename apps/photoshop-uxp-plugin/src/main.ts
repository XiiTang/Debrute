import {
  assertPhotoshopUploadSucceeded,
  availableProjectLinks,
  createSignedPhotoshopHello,
  createPhotoshopProjectLinkRequest,
  createPhotoshopStatusMessage,
  createPhotoshopUploadRequest,
  connectionStatusForBridgeError,
  discoverDebruteBridge,
  downloadPhotoshopImportBytes,
  linkedProjectTrees,
  loadOrCreatePhotoshopBridgeIdentity,
  parsePhotoshopBridgeMessage,
  photoshopBridgeConnectionPresentation,
  photoshopImportFailurePayload,
  selectionCardIdFromDragPayload,
  selectionCardsFromSnapshot,
  selectionDragPayloadFromCard,
  selectionDragPayloadMimeType,
  setPhotoshopBridgeIdentityPaired,
  type AdobeBridgeStateView,
  type PhotoshopBridgeRuntimeMessage,
  type PhotoshopBridgeIdentity,
  type PhotoshopBridgeConnectionStatus,
  type SelectionCard
} from '@debrute/photoshop-bridge-plugin-core';
import { createPhotoshopAdapter } from './photoshopAdapter';
import { createUxpPhotoshopBridgeIdentityStore } from './identityStore';
import './styles.css';

const root = document.getElementById('app');
const adapter = createPhotoshopAdapter();
let bridgeState: AdobeBridgeStateView | undefined;
let apiBaseUrl: string | undefined;
let bearer: string | undefined;
let runtimeIdentityLabel: string | undefined;
let statusErrorMessage: string | undefined;
let connectionStatus: PhotoshopBridgeConnectionStatus = 'searching';
let pairingCode: string | undefined;
let activeSocket: WebSocket | undefined;
let replacementDeadline: string | undefined;
let replacementRuntimeInstanceId: string | undefined;
let replacementTimer: number | undefined;
let connectionAttempt = 0;
const identityStore = createUxpPhotoshopBridgeIdentityStore();
const identityPromise = loadOrCreatePhotoshopBridgeIdentity({ store: identityStore });
let identity: PhotoshopBridgeIdentity | undefined;

initializeConnection();

function initializeConnection(): void {
  void identityPromise.then((loaded) => {
    identity = loaded;
    if (loaded.paired) {
      connectionStatus = 'paired';
      render();
    } else {
      startConnection();
    }
  }).catch((error) => {
    statusErrorMessage = error instanceof Error ? error.message : String(error);
    connectionStatus = 'disconnected';
    if (root) root.textContent = statusErrorMessage;
  });
}

async function connect(): Promise<void> {
  const attempt = ++connectionAttempt;
  if (replacementTimer !== undefined) {
    window.clearTimeout(replacementTimer);
    replacementTimer = undefined;
  }
  identity ??= await identityPromise;
  if (attempt !== connectionAttempt) return;
  activeSocket?.close();
  activeSocket = undefined;
  bridgeState = undefined;
  bearer = undefined;
  apiBaseUrl = undefined;
  runtimeIdentityLabel = undefined;
  connectionStatus = 'searching';
  render();
  const discovery = await discoverDebruteBridge();
  if (attempt !== connectionAttempt) return;
  if (discovery.status !== 'connected') {
    connectionStatus = discovery.status === 'disabled' ? 'disabled' : 'unavailable';
    statusErrorMessage = discovery.status === 'unavailable' ? discovery.message : undefined;
    render();
    scheduleReplacementReconnect();
    return;
  }
  if (replacementDeadline && Date.now() > Date.parse(replacementDeadline)) {
    replacementDeadline = undefined;
    replacementRuntimeInstanceId = undefined;
    connectionStatus = 'replacement-timeout';
    render();
    return;
  }
  if (replacementRuntimeInstanceId && discovery.runtimeInstanceId !== replacementRuntimeInstanceId) {
    scheduleReplacementReconnect();
    return;
  }
  statusErrorMessage = undefined;
  runtimeIdentityLabel = `Debrute ${discovery.productVersion} · ${discovery.runtimeInstanceId}`;
  apiBaseUrl = discovery.apiBaseUrl;
  const socket = new WebSocket(discovery.wsUrl);
  activeSocket = socket;
  let statusInterval: number | undefined;
  socket.addEventListener('message', (event) => {
    if (activeSocket !== socket) return;
    try {
      void handleBridgeMessage(socket, parsePhotoshopBridgeMessage(String(event.data))).catch((error) => {
        failConnection(socket, error);
      });
    } catch (error) {
      failConnection(socket, error);
    }
  });
  socket.addEventListener('close', () => {
    if (statusInterval !== undefined) {
      window.clearInterval(statusInterval);
    }
    if (activeSocket !== socket) return;
    activeSocket = undefined;
    bridgeState = undefined;
    bearer = undefined;
    apiBaseUrl = undefined;
    if (replacementDeadline && Date.now() <= Date.parse(replacementDeadline)) {
      scheduleReplacementReconnect();
      return;
    }
    replacementDeadline = undefined;
    replacementRuntimeInstanceId = undefined;
    if (connectionStatus !== 'pairing-required') connectionStatus = 'disconnected';
    render();
  });

  async function markReady(): Promise<void> {
    identity = await setPhotoshopBridgeIdentityPaired({
      identity: requiredIdentity(),
      store: identityStore,
      paired: true
    });
    connectionStatus = 'connected';
    replacementDeadline = undefined;
    replacementRuntimeInstanceId = undefined;
    pairingCode = undefined;
    sendPhotoshopStatus(socket);
    statusInterval = window.setInterval(() => sendPhotoshopStatus(socket), 1000);
    render();
  }

  async function handleBridgeMessage(socket: WebSocket, message: PhotoshopBridgeRuntimeMessage): Promise<void> {
    if (message.type === 'bridge.challenge') {
      const identity = await identityPromise;
      const snapshot = adapter.currentSelectionSnapshot();
      const submittedPairingCode = pairingCode;
      pairingCode = undefined;
      socket.send(JSON.stringify(await createSignedPhotoshopHello({
        identity,
        challenge: message,
        pairingCode: submittedPairingCode,
        hostVersion: adapter.hostVersion(),
        clientRuntime: 'uxp',
        activeDocumentTitle: snapshot.documentTitle,
        documentCount: snapshot.documentCount
      })));
      return;
    }
    if (message.type === 'bridge.ready') {
      bearer = message.bearer;
      bridgeState = message.state;
      await markReady();
      return;
    }
    if (message.type === 'runtime_replacing') {
      replacementDeadline = message.deadline;
      replacementRuntimeInstanceId = message.runtimeInstanceId;
      socket.close();
      return;
    }
    if (message.type === 'bridge.error') {
      statusErrorMessage = message.message;
      pairingCode = undefined;
      connectionStatus = connectionStatusForBridgeError(message.code);
      if (connectionStatus === 'pairing-required') {
        identity = await setPhotoshopBridgeIdentityPaired({
          identity: requiredIdentity(),
          store: identityStore,
          paired: false
        });
      }
      render();
      socket.close();
      return;
    }
    await handleConnectedMessage(socket, message);
  }
}

async function handleConnectedMessage(socket: WebSocket, message: PhotoshopBridgeRuntimeMessage): Promise<void> {
  if (message.type === 'bridge.state') {
    bridgeState = message.state;
    render();
    return;
  }
  if (message.type === 'transfer.import.request') {
    try {
      const bytes = await downloadPhotoshopImportBytes({
        downloadUrl: message.downloadUrl,
        bearer: requiredBearer(),
        pluginInstanceId: requiredIdentity().pluginInstanceId
      });
      await adapter.placeFileAsSmartObject({ fileName: message.fileName, bytes });
      socket.send(JSON.stringify({ type: 'transfer.import.result', transferId: message.transferId, ok: true }));
    } catch (error) {
      const failure = photoshopImportFailurePayload(error, {
        hasActiveDocument: adapter.currentSelectionSnapshot().documentTitle !== null
      });
      socket.send(JSON.stringify({
        type: 'transfer.import.result',
        transferId: message.transferId,
        ok: false,
        ...failure
      }));
    }
  }
}

function render(): void {
  if (!root) {
    return;
  }
  const selection = adapter.currentSelectionSnapshot();
  const cards = selectionCardsFromSnapshot(selection);
  const connection = photoshopBridgeConnectionPresentation(connectionStatus);
  root.innerHTML = [
    `<section class="bridge-section bridge-section--status"><h1 class="bridge-section__title">Debrute</h1><p class="bridge-status-line">${escapeHtml(connection.label)}</p>${runtimeIdentityLabel ? `<p class="bridge-status-line">Runtime ${escapeHtml(runtimeIdentityLabel)}</p>` : ''}<p class="bridge-status-line">${escapeHtml(selection.documentTitle ?? 'No document open')}</p>${renderConnectionActions(connection.action)}${renderStatusError()}</section>`,
    `<section class="bridge-section"><h2 class="bridge-section__title">Current Selection</h2>${cards.map((card) => `<button class="bridge-selection-card" draggable="${card.draggable}" data-selection-card="${escapeHtml(card.id)}">${escapeHtml(card.label)}</button>`).join('')}</section>`,
    `<section class="bridge-section"><h2 class="bridge-section__title">Debrute Projects</h2>${renderLinkedProjects()}</section>`,
    `<section class="bridge-section"><h2 class="bridge-section__title">Available Projects</h2>${renderAvailableProjects()}</section>`
  ].join('');
  bindSelectionDrags(cards);
  bindDirectoryDrops();
  bindProjectLinkActions();
  bindConnectionActions();
}

function renderLinkedProjects(): string {
  return linkedProjectTrees(bridgeState, requiredIdentity().pluginInstanceId).map((project) => (
    `<article class="bridge-project-card"><h3>${escapeHtml(project.projectName)}</h3><button class="bridge-action-button" data-disconnect-project="${escapeHtml(project.projectId)}">Disconnect</button>${project.directories.map((directory) => (
      `<button class="bridge-drop-target" data-project="${escapeHtml(project.projectId)}" data-directory="${escapeHtml(directory.projectRelativePath)}">${escapeHtml(directory.projectRelativePath)}</button>`
    )).join('')}</article>`
  )).join('');
}

function renderAvailableProjects(): string {
  return availableProjectLinks(bridgeState, requiredIdentity().pluginInstanceId)
    .map((project) => `<button class="bridge-action-button" data-connect-project="${escapeHtml(project.projectId)}">Connect ${escapeHtml(project.projectName)}</button>`)
    .join('');
}

function bindProjectLinkActions(): void {
  root?.querySelectorAll<HTMLButtonElement>('[data-connect-project]').forEach((button) => {
    button.addEventListener('click', () => {
      void setProjectLink(button.dataset.connectProject ?? '', true)
        .then(() => {
          statusErrorMessage = undefined;
        }, (error) => {
          statusErrorMessage = `Project link failed: ${error instanceof Error ? error.message : String(error)}`;
          render();
        });
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-disconnect-project]').forEach((button) => {
    button.addEventListener('click', () => {
      void setProjectLink(button.dataset.disconnectProject ?? '', false)
        .then(() => {
          statusErrorMessage = undefined;
        }, (error) => {
          statusErrorMessage = `Project unlink failed: ${error instanceof Error ? error.message : String(error)}`;
          render();
        });
    });
  });
}

function bindDirectoryDrops(): void {
  root?.querySelectorAll<HTMLButtonElement>('[data-project][data-directory]').forEach((button) => {
    button.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes(selectionDragPayloadMimeType)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      button.classList.add('is-drop-active');
    });
    button.addEventListener('dragleave', () => {
      button.classList.remove('is-drop-active');
    });
    button.addEventListener('drop', (event) => {
      const selectionCardId = selectionCardIdFromDragPayload(event.dataTransfer?.getData(selectionDragPayloadMimeType) ?? '');
      if (!selectionCardId) {
        return;
      }
      event.preventDefault();
      button.classList.remove('is-drop-active');
      void uploadSelectionToDirectory(button.dataset.project ?? '', button.dataset.directory ?? '')
        .then(() => {
          statusErrorMessage = undefined;
          render();
        }, (error) => {
          statusErrorMessage = `Upload failed: ${error instanceof Error ? error.message : String(error)}`;
          render();
        });
    });
  });
}

function bindSelectionDrags(cards: SelectionCard[]): void {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  root?.querySelectorAll<HTMLButtonElement>('[data-selection-card]').forEach((button) => {
    button.addEventListener('dragstart', (event) => {
      const card = cardsById.get(button.dataset.selectionCard ?? '');
      if (!card?.draggable || !event.dataTransfer) {
        return;
      }
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(selectionDragPayloadMimeType, selectionDragPayloadFromCard(card));
    });
  });
}

async function uploadSelectionToDirectory(projectId: string, targetDirectoryProjectRelativePath: string): Promise<void> {
  if (!apiBaseUrl || !projectId) {
    return;
  }
  const exported = await adapter.exportSelectedTopLevelPngs();
  for (const item of exported) {
    const request = createPhotoshopUploadRequest({
      apiBaseUrl,
      bearer: requiredBearer(),
      pluginInstanceId: requiredIdentity().pluginInstanceId,
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
    await assertPhotoshopUploadSucceeded(response);
  }
}

function renderStatusError(): string {
  return statusErrorMessage ? `<p class="bridge-status-error">${escapeHtml(statusErrorMessage)}</p>` : '';
}

async function setProjectLink(projectId: string, linked: boolean): Promise<void> {
  if (!apiBaseUrl || !projectId) {
    return;
  }
  const request = createPhotoshopProjectLinkRequest({
    apiBaseUrl,
    bearer: requiredBearer(),
    pluginInstanceId: requiredIdentity().pluginInstanceId,
    projectId,
    linked
  });
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  bridgeState = await response.json() as AdobeBridgeStateView;
  render();
}

function renderConnectionActions(action: 'none' | 'pair' | 'connect' | 'reconnect'): string {
  if (action === 'pair') {
    return `<div class="bridge-connection-actions"><input data-pairing-code type="text" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX" value="${escapeHtml(pairingCode ?? '')}"><button class="bridge-action-button" data-pair>Pair with Debrute</button></div>`;
  }
  if (action === 'connect') {
    return '<div class="bridge-connection-actions"><button class="bridge-action-button" data-connect>Connect</button></div>';
  }
  return action === 'reconnect'
    ? '<div class="bridge-connection-actions"><button class="bridge-action-button" data-reconnect>Reconnect</button></div>'
    : '';
}

function bindConnectionActions(): void {
  root?.querySelector<HTMLButtonElement>('[data-pair]')?.addEventListener('click', () => {
    pairingCode = root.querySelector<HTMLInputElement>('[data-pairing-code]')?.value.trim();
    clearReplacementRecovery();
    startConnection();
  });
  root?.querySelector<HTMLButtonElement>('[data-reconnect]')?.addEventListener('click', () => {
    pairingCode = undefined;
    clearReplacementRecovery();
    startConnection();
  });
  root?.querySelector<HTMLButtonElement>('[data-connect]')?.addEventListener('click', () => {
    pairingCode = undefined;
    clearReplacementRecovery();
    startConnection();
  });
}

function scheduleReplacementReconnect(): void {
  if (!replacementDeadline || Date.now() > Date.parse(replacementDeadline)) {
    if (replacementDeadline) {
      clearReplacementRecovery();
      connectionStatus = 'replacement-timeout';
      render();
    }
    return;
  }
  if (replacementTimer === undefined) {
    replacementTimer = window.setTimeout(() => {
      replacementTimer = undefined;
      startConnection();
    }, 250);
  }
}

function clearReplacementRecovery(): void {
  if (replacementTimer !== undefined) {
    window.clearTimeout(replacementTimer);
    replacementTimer = undefined;
  }
  replacementDeadline = undefined;
  replacementRuntimeInstanceId = undefined;
}

function startConnection(): void {
  void connect().catch((error) => {
    statusErrorMessage = error instanceof Error ? error.message : String(error);
    connectionStatus = 'disconnected';
    if (identity) {
      render();
    } else if (root) {
      root.innerHTML = `<section class="bridge-section bridge-section--status"><h1 class="bridge-section__title">Debrute</h1><p class="bridge-status-error">${escapeHtml(statusErrorMessage)}</p><button class="bridge-action-button" data-reconnect>Reconnect</button></section>`;
      bindConnectionActions();
    }
  });
}

function failConnection(socket: WebSocket, error: unknown): void {
  if (activeSocket !== socket) return;
  statusErrorMessage = error instanceof Error ? error.message : String(error);
  connectionStatus = 'disconnected';
  render();
  socket.close();
}

function requiredBearer(): string {
  if (!bearer) throw new Error('Photoshop Bridge session is not ready.');
  return bearer;
}

function requiredIdentity(): PhotoshopBridgeIdentity {
  if (!identity) throw new Error('Photoshop Bridge identity is not ready.');
  return identity;
}

function sendPhotoshopStatus(socket: WebSocket): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const snapshot = adapter.currentSelectionSnapshot();
  socket.send(JSON.stringify(createPhotoshopStatusMessage({
    documentTitle: snapshot.documentTitle,
    documentCount: snapshot.documentCount
  })));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
