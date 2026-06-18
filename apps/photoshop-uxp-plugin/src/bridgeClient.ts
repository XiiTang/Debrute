import {
  isAdobeBridgeErrorCode,
  type DaemonBridgeClientMessage,
  type PhotoshopBridgeHelloMessage,
  type PhotoshopBridgeStatusMessage
} from '@debrute/app-protocol';

export function createPhotoshopHelloMessage(input: {
  adobeClientId: string;
  hostVersion: string;
  documentTitle: string | null;
  documentCount: number;
}): PhotoshopBridgeHelloMessage {
  return {
    type: 'hello',
    adobeClientId: input.adobeClientId,
    hostApp: 'photoshop',
    hostVersion: input.hostVersion,
    documentCount: input.documentCount,
    activeDocumentTitle: input.documentTitle
  };
}

export function createPhotoshopStatusMessage(input: {
  documentTitle: string | null;
  documentCount: number;
}): PhotoshopBridgeStatusMessage {
  return {
    type: 'photoshop.status',
    documentCount: input.documentCount,
    activeDocumentTitle: input.documentTitle
  };
}

export function parseDaemonBridgeMessage(raw: string): DaemonBridgeClientMessage {
  const parsed = JSON.parse(raw) as Partial<DaemonBridgeClientMessage>;
  if (parsed.type === 'bridge.state' && parsed.state) {
    return parsed as DaemonBridgeClientMessage;
  }
  if (parsed.type === 'transfer.import.request' && typeof parsed.transferId === 'string') {
    return parsed as DaemonBridgeClientMessage;
  }
  if (
    parsed.type === 'bridge.error'
    && typeof parsed.code === 'string'
    && isAdobeBridgeErrorCode(parsed.code)
    && typeof parsed.message === 'string'
  ) {
    return parsed as DaemonBridgeClientMessage;
  }
  throw new Error('Unsupported daemon bridge message.');
}
