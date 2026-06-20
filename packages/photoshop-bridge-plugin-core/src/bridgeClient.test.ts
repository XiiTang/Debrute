import { describe, expect, it } from 'vitest';
import {
  createPhotoshopHelloMessage,
  createPhotoshopStatusMessage,
  parseDaemonBridgeMessage
} from './bridgeClient';

describe('bridgeClient pure helpers', () => {
  it('creates Photoshop hello messages with stable client identity', () => {
    expect(createPhotoshopHelloMessage({
      adobeClientId: 'ps-1',
      hostVersion: '2026',
      documentTitle: null,
      documentCount: 3
    })).toEqual({
      type: 'hello',
      adobeClientId: 'ps-1',
      hostApp: 'photoshop',
      hostVersion: '2026',
      documentCount: 3,
      activeDocumentTitle: null
    });
  });

  it('includes optional client runtime metadata in hello messages', () => {
    expect(createPhotoshopHelloMessage({
      adobeClientId: 'ps-1',
      hostVersion: '26.0.0',
      clientRuntime: 'cep',
      documentTitle: 'poster.psd',
      documentCount: 1
    })).toMatchObject({
      type: 'hello',
      adobeClientId: 'ps-1',
      hostApp: 'photoshop',
      hostVersion: '26.0.0',
      clientRuntime: 'cep',
      documentCount: 1,
      activeDocumentTitle: 'poster.psd'
    });
  });

  it('parses daemon bridge messages and rejects unrelated payloads', () => {
    expect(parseDaemonBridgeMessage(JSON.stringify({
      type: 'bridge.error',
      code: 'project_not_linked',
      message: 'not linked'
    }))).toMatchObject({ type: 'bridge.error', code: 'project_not_linked' });

    expect(() => parseDaemonBridgeMessage(JSON.stringify({ type: 'unsupported' }))).toThrow('Unsupported daemon bridge message');
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
