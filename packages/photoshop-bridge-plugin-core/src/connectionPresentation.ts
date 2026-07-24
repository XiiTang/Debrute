import type { AdobeBridgeErrorCode } from '@debrute/app-protocol';

export type PhotoshopBridgeConnectionStatus =
  | 'searching'
  | 'paired'
  | 'connected'
  | 'pairing-required'
  | 'unavailable'
  | 'disabled'
  | 'disconnected'
  | 'replacement-timeout';

export interface PhotoshopBridgeConnectionPresentation {
  label: string;
  action: 'none' | 'pair' | 'connect' | 'reconnect';
}

export function photoshopBridgeConnectionPresentation(
  status: PhotoshopBridgeConnectionStatus
): PhotoshopBridgeConnectionPresentation {
  switch (status) {
    case 'searching':
      return { label: 'Searching', action: 'none' };
    case 'paired':
      return { label: 'Paired', action: 'connect' };
    case 'connected':
      return { label: 'Connected', action: 'none' };
    case 'pairing-required':
      return { label: 'Pairing required', action: 'pair' };
    case 'disabled':
      return { label: 'Bridge disabled', action: 'reconnect' };
    case 'unavailable':
      return { label: 'Unavailable', action: 'reconnect' };
    case 'replacement-timeout':
      return { label: 'Runtime replacement timed out', action: 'reconnect' };
    case 'disconnected':
      return { label: 'Disconnected', action: 'reconnect' };
  }
}

export function connectionStatusForBridgeError(
  code: AdobeBridgeErrorCode
): PhotoshopBridgeConnectionStatus {
  return PAIRING_INPUT_ERROR_CODES.has(code) ? 'pairing-required' : 'disconnected';
}

const PAIRING_INPUT_ERROR_CODES = new Set<AdobeBridgeErrorCode>([
  'pairing_not_found',
  'pairing_expired',
  'pairing_code_invalid',
  'pairing_attempts_exceeded',
  'pairing_key_invalid',
  'pairing_signature_invalid'
]);
