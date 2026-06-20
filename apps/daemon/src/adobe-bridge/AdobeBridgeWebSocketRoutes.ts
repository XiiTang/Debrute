import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  AdobeBridgeErrorCode,
  DaemonBridgeImportRequestMessage,
  PhotoshopBridgeClientMessage
} from '@debrute/app-protocol';
import { AdobeBridgeError, createAdobeBridgeError } from './AdobeBridgeErrors.js';
import type { AdobeBridgeService } from './AdobeBridgeService.js';

export interface AdobeBridgeWebSocketRoutes {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  sendImportRequest(adobeClientId: string, message: DaemonBridgeImportRequestMessage): boolean;
  close(): Promise<void>;
}

export function createAdobeBridgeWebSocketRoutes(input: {
  bridge: AdobeBridgeService;
}): AdobeBridgeWebSocketRoutes {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const clientIdsBySocket = new Map<WebSocket, string>();
  const socketsByClientId = new Map<string, WebSocket>();

  wss.on('connection', (socket) => {
    sockets.add(socket);
    const unsubscribe = input.bridge.onEvent((state) => {
      const adobeClientId = clientIdsBySocket.get(socket);
      if (!adobeClientId) {
        return;
      }
      sendJson(socket, { type: 'bridge.state', state: input.bridge.stateForPhotoshopClient(adobeClientId) });
      if (!state.settings.enabled) {
        socket.close(1000, 'Adobe Bridge disabled');
      }
    });
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(String(data)) as PhotoshopBridgeClientMessage;
        if (message.type === 'hello') {
          const adobeClientId = message.adobeClientId?.trim() || randomUUID();
          input.bridge.upsertPhotoshopClient({
            adobeClientId,
            hostApp: message.hostApp,
            hostVersion: message.hostVersion,
            ...(message.clientRuntime === undefined ? {} : { clientRuntime: message.clientRuntime }),
            documentCount: message.documentCount,
            activeDocumentTitle: message.activeDocumentTitle
          });
          clientIdsBySocket.set(socket, adobeClientId);
          socketsByClientId.set(adobeClientId, socket);
          sendJson(socket, { type: 'bridge.state', state: input.bridge.stateForPhotoshopClient(adobeClientId) });
          return;
        }
        if (message.type === 'photoshop.status') {
          const adobeClientId = clientIdsBySocket.get(socket);
          const current = adobeClientId
            ? input.bridge.state().adobeClients.find((client) => client.adobeClientId === adobeClientId)
            : undefined;
          if (current) {
            input.bridge.upsertPhotoshopClient({
              adobeClientId: current.adobeClientId,
              hostApp: 'photoshop',
              hostVersion: current.hostVersion,
              ...(current.clientRuntime === undefined ? {} : { clientRuntime: current.clientRuntime }),
              documentCount: message.documentCount,
              activeDocumentTitle: message.activeDocumentTitle
            });
          }
          return;
        }
        if (message.type === 'transfer.import.result') {
          const adobeClientId = clientIdsBySocket.get(socket);
          if (!adobeClientId) {
            throw createAdobeBridgeError('invalid_transfer_payload');
          }
          input.bridge.updatePhotoshopImportTransfer(adobeClientId, {
            transferId: message.transferId,
            status: message.ok ? 'succeeded' : 'failed',
            ...(message.errorCode ? { errorCode: message.errorCode } : {}),
            ...(message.message ? { message: message.message } : {})
          });
          return;
        }
      } catch (error) {
        sendBridgeError(socket, error);
      }
    });
    socket.once('close', () => {
      const adobeClientId = clientIdsBySocket.get(socket);
      sockets.delete(socket);
      clientIdsBySocket.delete(socket);
      if (adobeClientId && socketsByClientId.get(adobeClientId) === socket) {
        socketsByClientId.delete(adobeClientId);
        input.bridge.removePhotoshopClient(adobeClientId);
      }
      unsubscribe();
    });
  });

  return {
    handleUpgrade(request, socket, head) {
      if (request.url !== '/api/adobe-bridge/plugin/ws') {
        return false;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
      return true;
    },
    sendImportRequest(adobeClientId, message) {
      const socket = socketsByClientId.get(adobeClientId);
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      sendJson(socket, message);
      return true;
    },
    close: async () => {
      for (const socket of sockets) {
        socket.close(1000, 'daemon closing');
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  };
}

function sendBridgeError(socket: WebSocket, error: unknown): void {
  const code: AdobeBridgeErrorCode = error instanceof AdobeBridgeError ? error.code : 'invalid_transfer_payload';
  const message = error instanceof Error ? error.message : 'The Adobe Bridge WebSocket payload is invalid.';
  sendJson(socket, { type: 'bridge.error', code, message }, () => {
    if (code === 'adobe_bridge_disabled') {
      socket.close(1000, 'Adobe Bridge disabled');
    }
  });
}

function sendJson(socket: WebSocket, message: unknown, afterSend?: () => void): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message), () => afterSend?.());
  }
}
