import { describe, expect, it, vi } from 'vitest';
import { createCepPhotoshopAdapter } from './cepPhotoshopAdapter';
import type { CepHost } from './cepHost';

describe('CEP Photoshop adapter', () => {
  it('returns cached selection snapshots synchronously', () => {
    const host = hostWithResponses({
      'debruteBridge.hostVersion()': '26.0.0',
      'debruteBridge.currentSelectionSnapshot()': {
        documentTitle: 'poster.psd',
        documentCount: 1,
        selectedItems: [{ layerId: 9, name: 'Hero', kind: 'layer' }]
      }
    });
    const adapter = createCepPhotoshopAdapter({ host });

    expect(adapter.hostVersion()).toBe('CEP');
    expect(adapter.currentSelectionSnapshot()).toEqual({
      documentTitle: null,
      documentCount: 0,
      selectedItems: []
    });
  });

  it('refreshes selection snapshots through one ExtendScript command', async () => {
    const host = hostWithResponses({
      'debruteBridge.hostVersion()': '26.0.0',
      'debruteBridge.currentSelectionSnapshot()': {
        documentTitle: 'poster.psd',
        documentCount: 1,
        selectedItems: [{ layerId: 9, name: 'Hero', kind: 'layer' }]
      }
    });
    const adapter = createCepPhotoshopAdapter({ host });

    await adapter.refreshSelectionSnapshot();

    expect(adapter.hostVersion()).toBe('26.0.0');
    expect(adapter.currentSelectionSnapshot().selectedItems).toEqual([
      { layerId: 9, name: 'Hero', kind: 'layer' }
    ]);
    expect(host.evalJson).toHaveBeenCalledWith('debruteBridge.hostVersion()');
    expect(host.evalJson).toHaveBeenCalledWith('debruteBridge.currentSelectionSnapshot()');
  });

  it('exports selected PNGs by reading the exact paths returned by ExtendScript', async () => {
    const host = hostWithResponses({
      'debruteBridge.hostVersion()': '26.0.0',
      'debruteBridge.currentSelectionSnapshot()': {
        documentTitle: 'poster.psd',
        documentCount: 1,
        selectedItems: []
      },
      'debruteBridge.exportSelectedTopLevelPngs()': [
        { suggestedName: 'Hero', path: '/tmp/hero.png' }
      ]
    });
    const adapter = createCepPhotoshopAdapter({ host });

    await expect(adapter.exportSelectedTopLevelPngs()).resolves.toEqual([
      { suggestedName: 'Hero', bytes: new Uint8Array([1, 2, 3]) }
    ]);
    expect(host.readFileBytes).toHaveBeenCalledWith('/tmp/hero.png');
  });

  it('writes import bytes once and calls the placement command once', async () => {
    const host = hostWithResponses({
      'debruteBridge.hostVersion()': '26.0.0',
      'debruteBridge.currentSelectionSnapshot()': {
        documentTitle: 'poster.psd',
        documentCount: 1,
        selectedItems: []
      },
      'debruteBridge.temporaryImportPath("asset.png")': '/tmp/asset.png',
      'debruteBridge.placeFileAsSmartObject("/tmp/asset.png")': true
    });
    const adapter = createCepPhotoshopAdapter({ host });

    await adapter.placeFileAsSmartObject({ fileName: 'asset.png', bytes: new Uint8Array([7, 8, 9]) });

    expect(host.writeFileBytes).toHaveBeenCalledWith('/tmp/asset.png', new Uint8Array([7, 8, 9]));
    expect(host.evalJson).toHaveBeenCalledWith('debruteBridge.placeFileAsSmartObject("/tmp/asset.png")');
    expect(host.deleteFile).toHaveBeenCalledWith('/tmp/asset.png');
  });
});

function hostWithResponses(responses: Record<string, unknown>): CepHost {
  return {
    evalJson: vi.fn(async (script: string) => responses[script] as never),
    readFileBytes: vi.fn((_path: string) => new Uint8Array([1, 2, 3])),
    writeFileBytes: vi.fn(),
    deleteFile: vi.fn()
  };
}
