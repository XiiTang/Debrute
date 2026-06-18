import type { AdobeBridgeStateView, DaemonBridgeClientMessage } from '@debrute/app-protocol';
import { createPhotoshopHelloMessage, createPhotoshopStatusMessage, parseDaemonBridgeMessage } from './bridgeClient';
import { discoverDebruteBridge } from './discoveryClient';
import { createPhotoshopAdapter } from './photoshopAdapter';
import { availableProjectLinks, linkedProjectTrees } from './projectTreeModel';
import {
  selectionCardIdFromDragPayload,
  selectionCardsFromSnapshot,
  selectionDragPayloadFromCard,
  selectionDragPayloadMimeType,
  type SelectionCard
} from './selectionModel';
import {
  assertPhotoshopUploadSucceeded,
  createPhotoshopProjectLinkRequest,
  createPhotoshopUploadRequest,
  downloadPhotoshopImportBytes,
  photoshopImportFailurePayload
} from './transferPayloads';
import './styles.css';

const root = document.getElementById('app');
const adapter = createPhotoshopAdapter();
let bridgeState: AdobeBridgeStateView | undefined;
let apiBaseUrl: string | undefined;
let uploadErrorMessage: string | undefined;
const adobeClientId = sessionStorage.getItem('debrute.adobeClientId') ?? crypto.randomUUID();
sessionStorage.setItem('debrute.adobeClientId', adobeClientId);

void connect();

async function connect(): Promise<void> {
  render('Searching');
  const discovery = await discoverDebruteBridge();
  if (discovery.status !== 'connected') {
    render(discovery.status === 'disabled' ? 'Bridge disabled' : 'Unavailable');
    window.setTimeout(() => void connect(), 2000);
    return;
  }
  apiBaseUrl = discovery.apiBaseUrl;
  const socket = new WebSocket(discovery.wsUrl);
  let statusInterval: number | undefined;
  socket.addEventListener('open', () => {
    const snapshot = adapter.currentSelectionSnapshot();
    socket.send(JSON.stringify(createPhotoshopHelloMessage({
      adobeClientId,
      hostVersion: adapter.hostVersion(),
      documentTitle: snapshot.documentTitle,
      documentCount: snapshot.documentCount
    })));
    sendPhotoshopStatus(socket);
    statusInterval = window.setInterval(() => sendPhotoshopStatus(socket), 1000);
  });
  socket.addEventListener('message', (event) => {
    void handleDaemonMessage(socket, parseDaemonBridgeMessage(String(event.data)));
  });
  socket.addEventListener('close', () => {
    if (statusInterval !== undefined) {
      window.clearInterval(statusInterval);
    }
    bridgeState = undefined;
    render('Searching');
    window.setTimeout(() => void connect(), 2000);
  });
}

async function handleDaemonMessage(socket: WebSocket, message: DaemonBridgeClientMessage): Promise<void> {
  if (message.type === 'bridge.state') {
    bridgeState = message.state;
    render('Connected');
    return;
  }
  if (message.type === 'transfer.import.request') {
    try {
      const bytes = await downloadPhotoshopImportBytes({ downloadUrl: message.downloadUrl });
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

function render(connectionLabel: string): void {
  if (!root) {
    return;
  }
  const selection = adapter.currentSelectionSnapshot();
  const cards = selectionCardsFromSnapshot(selection);
  root.innerHTML = [
    `<section><h1>Debrute</h1><p>${escapeHtml(connectionLabel)}</p><p>${escapeHtml(selection.documentTitle ?? 'No document open')}</p>${renderUploadError()}</section>`,
    `<section><h2>Current Selection</h2>${cards.map((card) => `<button draggable="${card.draggable}" data-selection-card="${escapeHtml(card.id)}">${escapeHtml(card.label)}</button>`).join('')}</section>`,
    `<section><h2>Debrute Projects</h2>${renderLinkedProjects()}</section>`,
    `<section><h2>Available Projects</h2>${renderAvailableProjects()}</section>`
  ].join('');
  bindSelectionDrags(cards);
  bindDirectoryDrops();
  bindProjectLinkActions();
}

function renderLinkedProjects(): string {
  return linkedProjectTrees(bridgeState, adobeClientId).map((project) => (
    `<article><h3>${escapeHtml(project.projectName)}</h3><button data-disconnect-project="${escapeHtml(project.projectId)}">Disconnect</button>${project.directories.map((directory) => (
      `<button data-project="${escapeHtml(project.projectId)}" data-directory="${escapeHtml(directory.projectRelativePath)}">${escapeHtml(directory.projectRelativePath)}</button>`
    )).join('')}</article>`
  )).join('');
}

function renderAvailableProjects(): string {
  return availableProjectLinks(bridgeState, adobeClientId)
    .map((project) => `<button data-connect-project="${escapeHtml(project.projectId)}">Connect ${escapeHtml(project.projectName)}</button>`)
    .join('');
}

function bindProjectLinkActions(): void {
  root?.querySelectorAll<HTMLButtonElement>('[data-connect-project]').forEach((button) => {
    button.addEventListener('click', () => {
      void setProjectLink(button.dataset.connectProject ?? '', true);
    });
  });
  root?.querySelectorAll<HTMLButtonElement>('[data-disconnect-project]').forEach((button) => {
    button.addEventListener('click', () => {
      void setProjectLink(button.dataset.disconnectProject ?? '', false);
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
          uploadErrorMessage = undefined;
          render('Connected');
        }, (error) => {
          uploadErrorMessage = error instanceof Error ? error.message : String(error);
          render('Connected');
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
      adobeClientId,
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

function renderUploadError(): string {
  return uploadErrorMessage ? `<p class="bridge-status-error">Upload failed: ${escapeHtml(uploadErrorMessage)}</p>` : '';
}

async function setProjectLink(projectId: string, linked: boolean): Promise<void> {
  if (!apiBaseUrl || !projectId) {
    return;
  }
  const request = createPhotoshopProjectLinkRequest({
    apiBaseUrl,
    adobeClientId,
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
  render('Connected');
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
