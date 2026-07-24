import { describe, expect, it } from 'vitest';
import {
  connectionStatusForBridgeError,
  photoshopBridgeConnectionPresentation
} from './connectionPresentation';

describe('Photoshop Bridge connection presentation', () => {
  it('offers Pair only after Runtime asks for pairing', () => {
    expect(photoshopBridgeConnectionPresentation('searching')).toEqual({
      label: 'Searching',
      action: 'none'
    });
    expect(photoshopBridgeConnectionPresentation('pairing-required')).toEqual({
      label: 'Pairing required',
      action: 'pair'
    });
  });

  it('offers only explicit Reconnect after ordinary loss or replacement timeout', () => {
    expect(photoshopBridgeConnectionPresentation('paired')).toEqual({ label: 'Paired', action: 'connect' });
    expect(photoshopBridgeConnectionPresentation('disconnected').action).toBe('reconnect');
    expect(photoshopBridgeConnectionPresentation('replacement-timeout').action).toBe('reconnect');
    expect(connectionStatusForBridgeError('pairing_expired')).toBe('pairing-required');
    expect(connectionStatusForBridgeError('pairing_capacity_reached')).toBe('disconnected');
    expect(connectionStatusForBridgeError('plugin_session_replaced')).toBe('disconnected');
  });
});
