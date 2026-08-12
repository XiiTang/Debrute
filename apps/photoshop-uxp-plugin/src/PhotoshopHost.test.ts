import { describe, expect, it, vi } from 'vitest';
import {
  PhotoshopHost,
  composeFullCanvasRgba,
  documentSnapshot,
  selectionSnapshot,
  type PhotoshopModule
} from './PhotoshopHost.js';

describe('PhotoshopHost seam', () => {
  it('observes the exact actions that replace the complete layer selection', () => {
    const addNotificationListener = vi.fn();
    const removeNotificationListener = vi.fn();
    const photoshop = {
      app: { documents: [], activeDocument: null },
      action: {
        addNotificationListener,
        removeNotificationListener,
        validateReference: vi.fn(async () => true),
        batchPlay: vi.fn()
      },
      core: { executeAsModal: async <T>(target: () => Promise<T> | T) => target() },
      imaging: { getPixels: vi.fn() }
    } as unknown as PhotoshopModule;
    const host = new PhotoshopHost(photoshop, {} as never);

    const stop = host.observeChanges(vi.fn());
    const events = addNotificationListener.mock.calls[0]?.[0] as string[];

    expect(events).toContain('selectAllLayers');
    expect(events).toContain('selectNoLayers');
    expect(events).not.toContain('all');
    stop();
    expect(removeNotificationListener).toHaveBeenCalledWith(
      events,
      expect.any(Function)
    );
  });

  it('reads the host version from the UXP host environment', () => {
    const photoshop = {
      app: { documents: [], activeDocument: null }
    } as unknown as PhotoshopModule;
    const uxp = {
      host: { version: '27.8.0' }
    };

    expect(new PhotoshopHost(photoshop, uxp as never).hostVersion()).toBe('27.8.0');
  });

  it('declares AVIF placement only for a recognized Photoshop 26.8 or newer host', () => {
    const photoshop = {
      app: { documents: [], activeDocument: null }
    } as unknown as PhotoshopModule;
    const placementMimeTypes = (version: string) => new PhotoshopHost(photoshop, {
      host: { version }
    } as never).placementMimeTypes();

    expect(placementMimeTypes('26.7.9')).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/vnd.adobe.photoshop'
    ]);
    expect(placementMimeTypes('24.4.0')).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/vnd.adobe.photoshop'
    ]);
    expect(placementMimeTypes('26.8.0')).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/vnd.adobe.photoshop',
      'image/avif'
    ]);
    expect(placementMimeTypes('27.0.0')).toContain('image/avif');
    expect(placementMimeTypes('unknown')).not.toContain('image/avif');
    expect(placementMimeTypes('26.8-beta')).not.toContain('image/avif');
  });

  it('publishes every open Document and accepts nested active layers directly', () => {
    const nestedLayer = { id: 8, name: 'Nested Logo', typename: 'Layer', visible: false };
    const group = { id: 7, name: 'Hero Group', typename: 'Layer', visible: true, layers: [nestedLayer] };
    const photoshop = {
      app: {
        version: '27.9.0',
        documents: [
          { id: 42, title: 'poster.psd', width: 3, height: 2, activeLayers: [nestedLayer], layers: [group] },
          { id: 43, title: 'reference.psd', width: 1, height: 1, activeLayers: [], layers: [] }
        ],
        activeDocument: { id: 42, title: 'poster.psd', width: 3, height: 2, activeLayers: [nestedLayer], layers: [group] }
      }
    } as unknown as PhotoshopModule;

    expect(documentSnapshot(photoshop)).toEqual([
      { documentId: 42, title: 'poster.psd' },
      { documentId: 43, title: 'reference.psd' }
    ]);
    expect(selectionSnapshot(photoshop)).toEqual({
      documentId: 42,
      documentTitle: 'poster.psd',
      items: [{ layerId: 8, name: 'Nested Logo', kind: 'layer' }]
    });
  });

  it('places a trimmed RGBA source into the exact full transparent canvas', () => {
    expect([...composeFullCanvasRgba({
      source: new Uint8Array([10, 20, 30, 128]),
      sourceWidth: 1,
      sourceHeight: 1,
      components: 4,
      sourceBounds: { left: 1, top: 0, right: 2, bottom: 1 },
      canvasWidth: 3,
      canvasHeight: 2
    })]).toEqual([
      0, 0, 0, 0, 10, 20, 30, 128, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]);
  });

  it('captures an exact nested hidden layer without changing layer or ancestor visibility', async () => {
    const layer = { id: 8, name: 'Hidden Logo', typename: 'Layer', visible: false };
    const group = { id: 7, name: 'Hidden Group', typename: 'Layer', visible: false, layers: [layer] };
    const document = {
      id: 42,
      title: 'poster.psd',
      width: 1,
      height: 1,
      activeLayers: [layer],
      layers: [group]
    };
    const getPixels = vi.fn(async () => ({
      imageData: {
        width: 1,
        height: 1,
        components: 4,
        getData: vi.fn(async () => new Uint8Array([10, 20, 30, 255])),
        dispose: vi.fn()
      },
      sourceBounds: { left: 0, top: 0, right: 1, bottom: 1 }
    }));
    const photoshop = {
      app: { documents: [document], activeDocument: document },
      action: {
        addNotificationListener: vi.fn(),
        removeNotificationListener: vi.fn(),
        validateReference: vi.fn(async () => true),
        batchPlay: vi.fn()
      },
      core: { executeAsModal: async <T>(target: () => Promise<T> | T) => target() },
      imaging: { getPixels }
    } as unknown as PhotoshopModule;
    const file = {
      name: 'capture.png',
      write: vi.fn(async () => undefined),
      read: vi.fn(async () => new ArrayBuffer(0)),
      delete: vi.fn(async () => undefined)
    };
    const uxp = {
      host: { version: '27.8.0' },
      storage: {
        localFileSystem: {
          getTemporaryFolder: async () => ({ createFile: async () => file }),
          createSessionToken: () => 'session-token'
        },
        formats: { binary: Symbol('binary') }
      }
    };
    const host = new PhotoshopHost(photoshop, uxp as never);

    const result = await host.capturePngs(42, [{
      itemId: 'item-1',
      layerId: 8,
      sourceName: 'Hidden Logo'
    }]);

    expect(getPixels).toHaveBeenCalledWith({
      documentID: 42,
      layerID: 8,
      sourceBounds: { left: 0, top: 0, right: 1, bottom: 1 },
      componentSize: 8,
      colorSpace: 'RGB',
      applyAlpha: false
    });
    expect(group.visible).toBe(false);
    expect(layer.visible).toBe(false);
    expect(result).toHaveLength(1);
    expect(result[0]?.ok).toBe(true);
    if (result[0]?.ok) {
      await result[0].staged.delete();
    }
  });

  it('renders a hidden selected group in an isolated transparent Document and restores the source', async () => {
    let hostChangeListener: (() => void) | undefined;
    const documents: PhotoshopModule['app']['documents'] = [];
    const duplicate = { id: 18, name: 'Group copy', typename: 'Layer', visible: false, layers: [] };
    const temporaryDocument = {
      id: 99,
      title: 'temporary.psd',
      width: 1,
      height: 1,
      resolution: 300,
      mode: 'RGBColorMode',
      activeLayers: [],
      layers: [],
      closeWithoutSaving: vi.fn(() => {
        documents.splice(documents.indexOf(temporaryDocument as never), 1);
        hostChangeListener?.();
      })
    };
    const group = {
      id: 8,
      name: 'Hidden Group',
      typename: 'Layer',
      visible: false,
      layers: [{ id: 9, name: 'Child', typename: 'Layer', visible: true }],
      duplicate: vi.fn(async () => duplicate)
    };
    const sourceDocument = {
      id: 42,
      title: 'poster.psd',
      width: 1,
      height: 1,
      resolution: 300,
      mode: 'RGBColorMode',
      activeLayers: [group],
      layers: [group]
    };
    documents.push(sourceDocument as never);
    const getPixels = vi.fn(async (options: Record<string, unknown>) => {
      if (options.layerID === 8) throw new Error('Unsupported layer type');
      return {
        imageData: {
          width: 1,
          height: 1,
          components: 4,
          getData: vi.fn(async () => new Uint8Array([10, 20, 30, 255])),
          dispose: vi.fn()
        },
        sourceBounds: { left: 0, top: 0, right: 1, bottom: 1 }
      };
    });
    const createDocument = vi.fn(async () => {
      documents.push(temporaryDocument as never);
      hostChangeListener?.();
      return temporaryDocument;
    });
    const removeNotificationListener = vi.fn();
    const photoshop = {
      app: { documents, activeDocument: sourceDocument, createDocument },
      action: {
        addNotificationListener: vi.fn((_events: string[], listener: () => void) => {
          hostChangeListener = listener;
        }),
        removeNotificationListener,
        validateReference: vi.fn(async () => true),
        batchPlay: vi.fn()
      },
      core: { executeAsModal: async <T>(target: () => Promise<T> | T) => target() },
      imaging: { getPixels }
    } as unknown as PhotoshopModule;
    const file = {
      name: 'capture.png',
      write: vi.fn(async () => undefined),
      read: vi.fn(async () => new ArrayBuffer(0)),
      delete: vi.fn(async () => undefined)
    };
    const uxp = {
      host: { version: '27.8.0' },
      storage: {
        localFileSystem: {
          getTemporaryFolder: async () => ({ createFile: async () => file }),
          createSessionToken: () => 'session-token'
        },
        formats: { binary: Symbol('binary') }
      }
    };
    const host = new PhotoshopHost(photoshop, uxp as never);
    const changed = vi.fn();
    const stopObserving = host.observeChanges(changed);

    const result = await host.capturePngs(42, [{
      itemId: 'item-1',
      layerId: 8,
      sourceName: 'Hidden Group'
    }]);

    expect(createDocument).toHaveBeenCalledWith({
      width: 1,
      height: 1,
      resolution: 300,
      mode: 'RGBColorMode',
      fill: 'transparent'
    });
    expect(group.duplicate).toHaveBeenCalledWith(temporaryDocument);
    expect(duplicate.visible).toBe(true);
    expect(getPixels).toHaveBeenCalledWith({
      documentID: 99,
      sourceBounds: { left: 0, top: 0, right: 1, bottom: 1 },
      componentSize: 8,
      colorSpace: 'RGB',
      applyAlpha: false
    });
    expect(temporaryDocument.closeWithoutSaving).toHaveBeenCalledOnce();
    expect(photoshop.app.activeDocument).toBe(sourceDocument);
    expect(host.documents()).toEqual([{ documentId: 42, title: 'poster.psd' }]);
    expect(changed).toHaveBeenCalledOnce();
    expect(group.visible).toBe(false);
    expect(result[0]?.ok).toBe(true);
    if (result[0]?.ok) {
      await result[0].staged.delete();
    }
    stopObserving();
    expect(removeNotificationListener).toHaveBeenCalledOnce();
  });

  it('deletes every staged capture when the enclosing Photoshop modal operation fails', async () => {
    const layer = { id: 8, name: 'Logo', typename: 'Layer', visible: true };
    const document = {
      id: 42,
      title: 'poster.psd',
      width: 1,
      height: 1,
      activeLayers: [layer],
      layers: [layer]
    };
    const imageData = {
      width: 1,
      height: 1,
      components: 4,
      getData: vi.fn(async () => new Uint8Array([10, 20, 30, 255])),
      dispose: vi.fn()
    };
    const photoshop = {
      app: { documents: [document], activeDocument: document },
      action: {
        addNotificationListener: vi.fn(),
        removeNotificationListener: vi.fn(),
        validateReference: vi.fn(async () => true),
        batchPlay: vi.fn()
      },
      core: {
        executeAsModal: async <T>(target: () => Promise<T> | T) => {
          await target();
          throw new Error('Photoshop modal completion failed.');
        }
      },
      imaging: {
        getPixels: vi.fn(async () => ({
          imageData,
          sourceBounds: { left: 0, top: 0, right: 1, bottom: 1 }
        }))
      }
    } as unknown as PhotoshopModule;
    const file = {
      name: 'capture.png',
      write: vi.fn(async () => undefined),
      read: vi.fn(async () => new ArrayBuffer(0)),
      delete: vi.fn(async () => undefined)
    };
    const uxp = {
      host: { version: '27.8.0' },
      storage: {
        localFileSystem: {
          getTemporaryFolder: async () => ({ createFile: async () => file }),
          createSessionToken: () => 'session-token'
        },
        formats: { binary: Symbol('binary') }
      }
    };
    const host = new PhotoshopHost(photoshop, uxp as never);

    await expect(host.capturePngs(42, [{
      itemId: 'item-1',
      layerId: 8,
      sourceName: 'Logo'
    }])).rejects.toThrow('Photoshop modal completion failed.');

    expect(file.delete).toHaveBeenCalledOnce();
  });

  it('reports cleanup failure without hiding the enclosing capture failure', async () => {
    const layer = { id: 8, name: 'Logo', typename: 'Layer', visible: true };
    const document = {
      id: 42,
      title: 'poster.psd',
      width: 1,
      height: 1,
      activeLayers: [layer],
      layers: [layer]
    };
    const photoshop = {
      app: { documents: [document], activeDocument: document },
      action: {
        addNotificationListener: vi.fn(),
        removeNotificationListener: vi.fn(),
        validateReference: vi.fn(async () => true),
        batchPlay: vi.fn()
      },
      core: {
        executeAsModal: async <T>(target: () => Promise<T> | T) => {
          await target();
          throw new Error('Photoshop modal completion failed.');
        }
      },
      imaging: {
        getPixels: vi.fn(async () => ({
          imageData: {
            width: 1,
            height: 1,
            components: 4,
            getData: vi.fn(async () => new Uint8Array([10, 20, 30, 255])),
            dispose: vi.fn()
          },
          sourceBounds: { left: 0, top: 0, right: 1, bottom: 1 }
        }))
      }
    } as unknown as PhotoshopModule;
    const file = {
      name: 'capture.png',
      write: vi.fn(async () => undefined),
      read: vi.fn(async () => new ArrayBuffer(0)),
      delete: vi.fn(async () => { throw new Error('temporary file is locked'); })
    };
    const uxp = {
      host: { version: '27.8.0' },
      storage: {
        localFileSystem: {
          getTemporaryFolder: async () => ({ createFile: async () => file }),
          createSessionToken: () => 'session-token'
        },
        formats: { binary: Symbol('binary') }
      }
    };
    const host = new PhotoshopHost(photoshop, uxp as never);

    await expect(host.capturePngs(42, [{
      itemId: 'item-1',
      layerId: 8,
      sourceName: 'Logo'
    }])).rejects.toThrow(
      'Photoshop modal completion failed. Cleanup could not remove 1 Photoshop temporary file.'
    );
  });

  it('reports cleanup failure after a partial UXP PNG write', async () => {
    const layer = { id: 8, name: 'Logo', typename: 'Layer', visible: true };
    const document = {
      id: 42,
      title: 'poster.psd',
      width: 1,
      height: 1,
      activeLayers: [layer],
      layers: [layer]
    };
    const photoshop = {
      app: { documents: [document], activeDocument: document },
      action: {
        addNotificationListener: vi.fn(),
        removeNotificationListener: vi.fn(),
        validateReference: vi.fn(async () => true),
        batchPlay: vi.fn()
      },
      core: { executeAsModal: async <T>(target: () => Promise<T> | T) => target() },
      imaging: {
        getPixels: vi.fn(async () => ({
          imageData: {
            width: 1,
            height: 1,
            components: 4,
            getData: vi.fn(async () => new Uint8Array([10, 20, 30, 255])),
            dispose: vi.fn()
          },
          sourceBounds: { left: 0, top: 0, right: 1, bottom: 1 }
        }))
      }
    } as unknown as PhotoshopModule;
    const file = {
      name: 'capture.png',
      write: vi.fn(async () => { throw new Error('partial write failed'); }),
      read: vi.fn(async () => new ArrayBuffer(0)),
      delete: vi.fn(async () => { throw new Error('temporary file is locked'); })
    };
    const host = new PhotoshopHost(photoshop, {
      host: { version: '27.8.0' },
      storage: {
        localFileSystem: {
          getTemporaryFolder: async () => ({ createFile: async () => file }),
          createSessionToken: () => 'session-token'
        },
        formats: { binary: Symbol('binary') }
      }
    } as never);

    const [result] = await host.capturePngs(42, [{
      itemId: 'item-1',
      layerId: 8,
      sourceName: 'Logo'
    }]);

    expect(result).toEqual({
      itemId: 'item-1',
      ok: false,
      message: 'partial write failed Cleanup could not remove 1 Photoshop temporary file.'
    });
    expect(file.delete).toHaveBeenCalledOnce();
  });

  it('places through the native local-file parameter and verifies a new Embedded Smart Object', async () => {
    const harness = createPlacementHarness({ smartObject: { linked: false } });

    await harness.host.placeEmbeddedSmartObject({
      documentId: 42,
      fileName: 'hero.webp',
      bytes: new ArrayBuffer(3),
      isSessionCurrent: () => true
    });

    expect(harness.batchPlay).toHaveBeenNthCalledWith(1, [{
      _obj: 'placeEvent',
      null: { _path: 'session-token', _kind: 'local' },
      linked: false,
      _options: { dialogOptions: 'silent' }
    }], { synchronousExecution: false, modalBehavior: 'execute' });
    expect(harness.batchPlay).toHaveBeenNthCalledWith(2, [{
      _obj: 'get',
      _target: [
        { _ref: 'layer', _id: 2 },
        { _ref: 'document', _id: 42 }
      ],
      _options: { dialogOptions: 'silent' }
    }], { synchronousExecution: true, modalBehavior: 'execute' });
    expect(harness.file.delete).toHaveBeenCalledOnce();
  });

  it('rejects a resolved batchPlay error instead of mistaking the old active layer for success', async () => {
    const harness = createPlacementHarness(
      { smartObject: { linked: false } },
      { _obj: 'error', message: 'The place command failed.' }
    );

    await expect(harness.host.placeEmbeddedSmartObject({
      documentId: 42,
      fileName: 'hero.webp',
      bytes: new ArrayBuffer(3),
      isSessionCurrent: () => true
    })).rejects.toThrow('The place command failed.');

    expect(harness.batchPlay).toHaveBeenCalledOnce();
    expect(harness.file.delete).toHaveBeenCalledOnce();
  });

  it('rejects a linked Smart Object descriptor', async () => {
    const harness = createPlacementHarness({ smartObjectMore: { linked: true } });

    await expect(harness.host.placeEmbeddedSmartObject({
      documentId: 42,
      fileName: 'hero.webp',
      bytes: new ArrayBuffer(3),
      isSessionCurrent: () => true
    })).rejects.toThrow('linked Smart Object');
  });

  it('rejects a session lost while staging before entering Photoshop modal', async () => {
    let sessionCurrent = true;
    let finishWrite!: () => void;
    const writePending = new Promise<void>((resolve) => { finishWrite = resolve; });
    const harness = createPlacementHarness(
      { smartObject: { linked: false } },
      {},
      () => writePending
    );

    const placement = harness.host.placeEmbeddedSmartObject({
      documentId: 42,
      fileName: 'hero.webp',
      bytes: new ArrayBuffer(3),
      isSessionCurrent: () => sessionCurrent
    });
    await Promise.resolve();
    await Promise.resolve();
    sessionCurrent = false;
    finishWrite();

    await expect(placement).rejects.toThrow('Photoshop Runtime session was lost.');
    expect(harness.batchPlay).not.toHaveBeenCalled();
    expect(harness.file.delete).toHaveBeenCalledOnce();
  });

  it('logs placement cleanup failure without reversing a successful commit', async () => {
    const harness = createPlacementHarness({ smartObject: { linked: false } });
    harness.file.delete.mockRejectedValue(new Error('temporary file is locked'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await harness.host.placeEmbeddedSmartObject({
      documentId: 42,
      fileName: 'hero.webp',
      bytes: new ArrayBuffer(3),
      isSessionCurrent: () => true
    });

    expect(harness.batchPlay).toHaveBeenCalledTimes(2);
    expect(harness.file.delete).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Cleanup could not remove the Photoshop temporary file.'),
      expect.any(Error)
    );
    log.mockRestore();
  });
});

function createPlacementHarness(
  placedDescriptor: Record<string, unknown>,
  placeResult: Record<string, unknown> = {},
  write: () => Promise<void> = async () => undefined
) {
  const oldLayer = { id: 1, name: 'Existing', typename: 'pixel', visible: true };
  const placedLayer = { id: 2, name: 'hero', typename: 'smartObject', visible: true };
  const document = {
    id: 42,
    title: 'poster.psd',
    width: 3,
    height: 2,
    activeLayers: [oldLayer],
    layers: [oldLayer]
  };
  const batchPlay = vi.fn(async (descriptors: Array<Record<string, unknown>>) => {
    if (descriptors[0]?._obj === 'placeEvent') {
      if (placeResult._obj !== 'error') {
        document.activeLayers = [placedLayer];
        document.layers = [oldLayer, placedLayer];
      }
      return [placeResult];
    }
    return [placedDescriptor];
  });
  const photoshop = {
    app: { version: '27.9.0', documents: [document], activeDocument: document },
    action: {
      addNotificationListener: vi.fn(),
      removeNotificationListener: vi.fn(),
      validateReference: vi.fn(async () => true),
      batchPlay
    },
    core: { executeAsModal: async <T>(target: () => Promise<T> | T) => target() },
    imaging: { getPixels: vi.fn() }
  } as unknown as PhotoshopModule;
  const file = {
    name: 'temp-hero.webp',
    write: vi.fn(write),
    read: vi.fn(async () => new ArrayBuffer(0)),
    delete: vi.fn(async () => undefined)
  };
  const uxp = {
    storage: {
      localFileSystem: {
        getTemporaryFolder: async () => ({ createFile: async () => file }),
        createSessionToken: () => 'session-token'
      },
      formats: { binary: Symbol('binary') }
    }
  };
  return {
    host: new PhotoshopHost(photoshop, uxp as never),
    batchPlay,
    file
  };
}
