import { describe, expect, it } from 'vitest';
import {
  assertPhotoshopUploadSucceeded,
  createPhotoshopProjectLinkRequest,
  createPhotoshopUploadRequest,
  downloadPhotoshopImportBytes,
  photoshopImportFailurePayload,
  PhotoshopBridgeTransferError
} from './transferPayloads.js';

describe('createPhotoshopUploadRequest', () => {
  it('creates a PNG upload request scoped to a linked project directory', () => {
    expect(createPhotoshopUploadRequest({
      apiBaseUrl: 'http://127.0.0.1:41001/api/adobe-bridge',
      bearer: 'session-secret',
      pluginInstanceId: 'ps-1',
      projectId: 'project-1',
      transferId: 'transfer-1',
      targetDirectoryProjectRelativePath: 'assets',
      suggestedName: 'Hero',
      pngBytes: new Uint8Array([1, 2, 3])
    })).toMatchObject({
      url: 'http://127.0.0.1:41001/api/adobe-bridge/plugin/projects/project-1/uploads',
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        authorization: 'Bearer session-secret',
        'x-debrute-plugin-instance': 'ps-1',
        'x-debrute-transfer-id': 'transfer-1',
        'x-debrute-target-directory': 'assets',
        'x-debrute-suggested-name': 'Hero'
      }
    });
  });

  it('percent-encodes project paths and Photoshop layer names for HTTP headers', () => {
    const request = createPhotoshopUploadRequest({
      apiBaseUrl: 'http://127.0.0.1:41001/api/adobe-bridge',
      bearer: 'session-secret',
      pluginInstanceId: 'ps-1',
      projectId: 'project-1',
      transferId: 'transfer-1',
      targetDirectoryProjectRelativePath: '资产/参考',
      suggestedName: '图层\n标题',
      pngBytes: new Uint8Array([1, 2, 3])
    });

    expect(request.headers['x-debrute-target-directory']).toBe('%E8%B5%84%E4%BA%A7%2F%E5%8F%82%E8%80%83');
    expect(request.headers['x-debrute-suggested-name']).toBe('%E5%9B%BE%E5%B1%82%0A%E6%A0%87%E9%A2%98');
    expect(() => new Headers(request.headers)).not.toThrow();
  });

  it('rejects structured Runtime upload failures', async () => {
    const response = new Response(JSON.stringify({
      error: {
        code: 'target_directory_missing',
        message: 'Adobe Bridge target directory does not exist: assets/missing'
      }
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });

    await expect(assertPhotoshopUploadSucceeded(response)).rejects.toThrow(
      'Adobe Bridge target directory does not exist: assets/missing'
    );
  });

  it('creates bearer-scoped link and unlink requests', () => {
    expect(createPhotoshopProjectLinkRequest({
      apiBaseUrl: 'http://127.0.0.1:41001/api/adobe-bridge',
      bearer: 'session-secret',
      pluginInstanceId: 'ps-1',
      projectId: 'project-1',
      linked: true
    })).toEqual({
      url: 'http://127.0.0.1:41001/api/adobe-bridge/plugin/projects/project-1/link',
      method: 'POST',
      headers: {
        authorization: 'Bearer session-secret',
        'x-debrute-plugin-instance': 'ps-1'
      }
    });
    expect(createPhotoshopProjectLinkRequest({
      apiBaseUrl: 'http://127.0.0.1:41001/api/adobe-bridge',
      bearer: 'session-secret',
      pluginInstanceId: 'ps-1',
      projectId: 'project-1',
      linked: false
    })).toMatchObject({ method: 'DELETE' });
  });

  it('preserves stable Runtime Bridge error codes from failed import downloads', async () => {
    const response = new Response(JSON.stringify({
      error: {
        code: 'transfer_url_expired',
        message: 'The Adobe Bridge transfer URL expired.'
      }
    }), {
      status: 410,
      headers: { 'content-type': 'application/json' }
    });

    await expect(downloadPhotoshopImportBytes({
      downloadUrl: 'http://127.0.0.1:41001/api/adobe-bridge/transfers/transfer-1/content',
      bearer: 'session-secret',
      pluginInstanceId: 'ps-1',
      fetch: async () => response
    })).rejects.toMatchObject({
      code: 'transfer_url_expired',
      message: 'The Adobe Bridge transfer URL expired.'
    });
  });

  it('maps Runtime import download failures without replacing their Bridge error codes', () => {
    expect(photoshopImportFailurePayload(
      new PhotoshopBridgeTransferError('adobe_bridge_disabled', 'Adobe Bridge is disabled.'),
      { hasActiveDocument: true }
    )).toEqual({
      errorCode: 'adobe_bridge_disabled',
      message: 'Adobe Bridge is disabled.'
    });

    expect(photoshopImportFailurePayload(new Error('Place failed.'), { hasActiveDocument: true })).toEqual({
      errorCode: 'photoshop_place_failed',
      message: 'Place failed.'
    });
    expect(photoshopImportFailurePayload(new Error('No document.'), { hasActiveDocument: false })).toEqual({
      errorCode: 'no_active_document',
      message: 'No document.'
    });
  });
});
