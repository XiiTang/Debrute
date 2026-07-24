import { describe, expect, it } from 'vitest';
import {
  createPhotoshopStatusMessage,
  parsePhotoshopBridgeMessage
} from './bridgeClient.js';

describe('bridgeClient pure helpers', () => {
  it('parses challenge, ready and error messages and rejects unrelated payloads', () => {
    expect(parsePhotoshopBridgeMessage(JSON.stringify({
      type: 'bridge.challenge',
      bridgeVersion: 1,
      productVersion: '1.0.0',
      runtimeInstanceId: 'runtime-1',
      challenge: 'proof'
    }))).toMatchObject({ type: 'bridge.challenge', runtimeInstanceId: 'runtime-1' });
    expect(parsePhotoshopBridgeMessage(JSON.stringify({
      type: 'bridge.ready',
      pluginSessionId: 'session-1',
      bearer: 'secret',
      state: {}
    }))).toMatchObject({ type: 'bridge.ready', bearer: 'secret' });
    expect(parsePhotoshopBridgeMessage(JSON.stringify({
      type: 'bridge.error',
      code: 'project_not_linked',
      message: 'not linked'
    }))).toMatchObject({ type: 'bridge.error', code: 'project_not_linked' });

    expect(() => parsePhotoshopBridgeMessage(JSON.stringify({
      type: 'bridge.error',
      code: 'unknown_error',
      message: 'unknown code'
    }))).toThrow('Unsupported Photoshop Bridge message');
    expect(() => parsePhotoshopBridgeMessage(JSON.stringify({ type: 'unsupported' }))).toThrow('Unsupported Photoshop Bridge message');
  });

  it('creates Photoshop status messages from the current document title', () => {
    expect(createPhotoshopStatusMessage({ documentTitle: 'poster.psd', documentCount: 2 })).toEqual({
      type: 'photoshop.status',
      documentCount: 2,
      activeDocumentTitle: 'poster.psd'
    });
    expect(createPhotoshopStatusMessage({ documentTitle: null, documentCount: 0 })).toEqual({
      type: 'photoshop.status',
      documentCount: 0,
      activeDocumentTitle: null
    });
  });
});
