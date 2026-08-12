import { describe, expect, it } from 'vitest';
import {
  decodePhotoshopHttpErrorEnvelope,
  parseRuntimeMessage,
  photoshopPlacementFormatForPath,
  serializePluginMessage
} from './photoshopPlugin.js';

describe('Photoshop v1 Runtime message parser', () => {
  it('accepts only the closed session-ready shape', () => {
    const message = {
      type: 'photoshop.session.ready',
      runtimeInstanceId: 'runtime-1',
      pluginSessionId: 'session-1',
      bearer: 'bearer-1'
    };

    expect(parseRuntimeMessage(JSON.stringify(message))).toEqual(message);
    expect(() => parseRuntimeMessage(JSON.stringify({ ...message, extra: true }))).toThrow(/invalid/i);
  });

  it('accepts exact Project snapshots and placement requests', () => {
    expect(parseRuntimeMessage(JSON.stringify({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: '/projects/project-1', name: 'Campaign', revision: 4 }]
    }))).toEqual({
      type: 'photoshop.projects.snapshot',
      projects: [{ canonicalRoot: '/projects/project-1', name: 'Campaign', revision: 4 }]
    });

    expect(parseRuntimeMessage(JSON.stringify({
      type: 'photoshop.place.request',
      commandId: 'command-1',
      documentId: 27,
      fileName: 'cover.psd',
      mimeType: 'image/vnd.adobe.photoshop',
      byteLength: 1024
    }))).toEqual({
      type: 'photoshop.place.request',
      commandId: 'command-1',
      documentId: 27,
      fileName: 'cover.psd',
      mimeType: 'image/vnd.adobe.photoshop',
      byteLength: 1024
    });

    expect(parseRuntimeMessage(JSON.stringify({
      type: 'photoshop.place.request',
      commandId: 'command-2',
      documentId: 28,
      fileName: 'cover.avif',
      mimeType: 'image/avif',
      byteLength: 2048
    }))).toEqual({
      type: 'photoshop.place.request',
      commandId: 'command-2',
      documentId: 28,
      fileName: 'cover.avif',
      mimeType: 'image/avif',
      byteLength: 2048
    });
  });

  it('accepts only the exact shallow Project directory batch result', () => {
    const loaded = {
      type: 'photoshop.projectDirectories.result',
      requestId: 'directories-1',
      canonicalRoot: '/projects/project-1',
      baseProjectRevision: 4,
      projectRevision: 5,
      outcome: 'loaded',
      pages: [
        { directory: '', outcome: 'loaded', childDirectories: ['exports', 'folder2'] },
        { directory: 'exports', outcome: 'loaded', childDirectories: [] },
        { directory: 'removed', outcome: 'missing' },
        { directory: 'unreadable', outcome: 'error', message: 'Access denied.' }
      ]
    };
    const stale = {
      type: 'photoshop.projectDirectories.result',
      requestId: 'directories-2',
      canonicalRoot: '/projects/project-1',
      baseProjectRevision: 4,
      projectRevision: 6,
      outcome: 'stale'
    };

    expect(parseRuntimeMessage(JSON.stringify(loaded))).toEqual(loaded);
    expect(parseRuntimeMessage(JSON.stringify(stale))).toEqual(stale);
    expect(() => parseRuntimeMessage(JSON.stringify({
      ...loaded,
      pages: [{ directory: '', outcome: 'loaded', childDirectories: [], extra: true }]
    }))).toThrow(/invalid/i);
    for (const childDirectories of [
      ['exports', 'exports'],
      ['exports/deep'],
      ['.debrute'],
      ['exports/.DeBrute']
    ]) {
      expect(() => parseRuntimeMessage(JSON.stringify({
        ...loaded,
        pages: [{ directory: '', outcome: 'loaded', childDirectories }]
      }))).toThrow(/invalid/i);
    }
    expect(() => parseRuntimeMessage(JSON.stringify({
      ...loaded,
      pages: [
        { directory: '', outcome: 'missing' },
        { directory: '', outcome: 'loaded', childDirectories: [] }
      ]
    }))).toThrow(/invalid/i);
    expect(() => parseRuntimeMessage(JSON.stringify({
      type: 'photoshop.projectDirectories.snapshot',
      requestId: 'directories-1',
      canonicalRoot: '/projects/project-1',
      revision: 4,
      directories: []
    }))).toThrow(/invalid/i);
  });

  it('serializes one exact shallow Project directory batch request', () => {
    expect(JSON.parse(serializePluginMessage({
      type: 'photoshop.projectDirectories.request',
      requestId: 'directories-1',
      canonicalRoot: '/projects/project-1',
      baseProjectRevision: 4,
      directories: ['', 'exports']
    }))).toEqual({
      type: 'photoshop.projectDirectories.request',
      requestId: 'directories-1',
      canonicalRoot: '/projects/project-1',
      baseProjectRevision: 4,
      directories: ['', 'exports']
    });
  });

  it('serializes export completion with the closed success-or-failure shape', () => {
    expect(JSON.parse(serializePluginMessage({
      type: 'photoshop.export.finish',
      commandId: 'export-1',
      items: [
        { itemId: 'one', ok: true, fileName: 'Layer.png' },
        { itemId: 'two', ok: false }
      ]
    }))).toEqual({
      type: 'photoshop.export.finish',
      commandId: 'export-1',
      items: [
        { itemId: 'one', ok: true, fileName: 'Layer.png' },
        { itemId: 'two', ok: false }
      ]
    });

  });

  it('rejects unknown messages, fields, MIME types, and invalid identities', () => {
    expect(() => parseRuntimeMessage('{"type":"bridge.ready"}')).toThrow(/invalid/i);
    expect(() => parseRuntimeMessage(JSON.stringify({
      type: 'photoshop.place.request',
      commandId: 'command-1',
      documentId: -1,
      fileName: 'cover.gif',
      mimeType: 'image/gif',
      byteLength: 1
    }))).toThrow(/invalid/i);
    expect(() => parseRuntimeMessage('not-json')).toThrow(/invalid/i);
  });
});

describe('Photoshop placement format contract', () => {
  it('maps AVIF to one shared MIME and host requirement', () => {
    expect(photoshopPlacementFormatForPath('data/deep/cover.AVIF')).toEqual({
      mimeType: 'image/avif',
      requirement: 'photoshop_26_8_for_avif'
    });
    expect(photoshopPlacementFormatForPath('cover.png')).toEqual({
      mimeType: 'image/png'
    });
    expect(photoshopPlacementFormatForPath('cover.gif')).toBeUndefined();
  });

  it('serializes the exact session placement capability list', () => {
    expect(JSON.parse(serializePluginMessage({
      type: 'photoshop.session.start',
      hostVersion: '26.8.0',
      placementMimeTypes: [
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/vnd.adobe.photoshop',
        'image/avif'
      ],
      documents: [{ documentId: 7, title: 'Poster.psd' }]
    }))).toEqual({
      type: 'photoshop.session.start',
      hostVersion: '26.8.0',
      placementMimeTypes: [
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/vnd.adobe.photoshop',
        'image/avif'
      ],
      documents: [{ documentId: 7, title: 'Poster.psd' }]
    });
  });
});

describe('Photoshop v1 HTTP error decoder', () => {
  it('accepts only a closed error code and non-blank user message', () => {
    const envelope = {
      error: {
        code: 'photoshop_export_failed',
        message: 'Photoshop export could not be saved to the selected Debrute Project.'
      }
    };
    expect(decodePhotoshopHttpErrorEnvelope(envelope)).toEqual(envelope);
    expect(decodePhotoshopHttpErrorEnvelope({
      error: { ...envelope.error, code: 'unknown_error' }
    })).toBeUndefined();
    expect(decodePhotoshopHttpErrorEnvelope({
      error: { ...envelope.error, message: '   ' }
    })).toBeUndefined();
  });

  it('rejects fields outside the exact HTTP error envelope', () => {
    expect(decodePhotoshopHttpErrorEnvelope({
      error: {
        code: 'photoshop_export_failed',
        message: 'Export failed.',
        details: {}
      }
    })).toBeUndefined();
    expect(decodePhotoshopHttpErrorEnvelope({
      error: {
        code: 'photoshop_export_failed',
        message: 'Export failed.'
      },
      requestId: 'request-1'
    })).toBeUndefined();
  });
});
