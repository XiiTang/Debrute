import {
  isAdobeBridgeErrorCode,
  type PhotoshopBridgeRuntimeMessage,
  type PhotoshopBridgeStatusMessage
} from '@debrute/app-protocol';

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

export function parsePhotoshopBridgeMessage(raw: string): PhotoshopBridgeRuntimeMessage {
  const parsed = JSON.parse(raw) as Partial<PhotoshopBridgeRuntimeMessage>;
  if (
    parsed.type === 'bridge.challenge'
    && parsed.bridgeVersion === 1
    && typeof parsed.productVersion === 'string'
    && typeof parsed.runtimeInstanceId === 'string'
    && typeof parsed.challenge === 'string'
  ) {
    return parsed as PhotoshopBridgeRuntimeMessage;
  }
  if (
    parsed.type === 'bridge.ready'
    && typeof parsed.pluginSessionId === 'string'
    && typeof parsed.bearer === 'string'
    && isRecord(parsed.state)
  ) {
    return parsed as PhotoshopBridgeRuntimeMessage;
  }
  if (parsed.type === 'bridge.state' && isRecord(parsed.state)) {
    return parsed as PhotoshopBridgeRuntimeMessage;
  }
  if (
    parsed.type === 'transfer.import.request'
    && typeof parsed.transferId === 'string'
    && typeof parsed.downloadUrl === 'string'
    && typeof parsed.fileName === 'string'
  ) {
    return parsed as PhotoshopBridgeRuntimeMessage;
  }
  if (
    parsed.type === 'runtime_replacing'
    && typeof parsed.runtimeInstanceId === 'string'
    && typeof parsed.deadline === 'string'
    && Number.isFinite(Date.parse(parsed.deadline))
  ) {
    return parsed as PhotoshopBridgeRuntimeMessage;
  }
  if (
    parsed.type === 'bridge.error'
    && typeof parsed.code === 'string'
    && isAdobeBridgeErrorCode(parsed.code)
    && typeof parsed.message === 'string'
  ) {
    return parsed as PhotoshopBridgeRuntimeMessage;
  }
  throw new Error('Unsupported Photoshop Bridge message.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
