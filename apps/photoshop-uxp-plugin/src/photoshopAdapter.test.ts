import { describe, expect, it } from 'vitest';
import {
  currentPhotoshopDocument,
  photoshopSelectionSnapshot,
  photoshopHostVersion,
  type PhotoshopRuntime,
  type PhotoshopRuntimeDocument
} from './photoshopAdapter';

describe('currentPhotoshopDocument', () => {
  it('does not read activeDocument when Photoshop has no open documents', () => {
    const runtime: PhotoshopRuntime = {
      app: {
        version: '27.0.0',
        documents: [],
        get activeDocument(): PhotoshopRuntimeDocument | null {
          throw new Error('activeDocument should not be read without documents.');
        }
      }
    };

    expect(currentPhotoshopDocument(runtime)).toBeNull();
  });

  it('reads the Photoshop host version from the runtime', () => {
    expect(photoshopHostVersion({ app: { version: '27.0.0', activeDocument: null, documents: [] } })).toBe('27.0.0');
  });

  it('uses Photoshop activeLayers for the current top-level selection', () => {
    const runtime: PhotoshopRuntime = {
      app: {
        version: '27.0.0',
        documents: [{}, {}],
        activeDocument: {
          id: 42,
          title: 'poster.psd',
          layers: [
            { id: 7, name: 'Hero Group', typename: 'Layer', layers: [] },
            { id: 8, name: 'Logo', typename: 'Layer' },
            { id: 1, name: 'Background', typename: 'Layer' }
          ],
          activeLayers: [
            { id: 7, name: 'Hero Group', typename: 'Layer', layers: [] },
            { id: 8, name: 'Logo', typename: 'Layer' }
          ]
        }
      }
    };

    expect(photoshopSelectionSnapshot(runtime)).toEqual({
      documentTitle: 'poster.psd',
      documentCount: 2,
      selectedItems: [
        { layerId: 7, name: 'Hero Group', kind: 'group' },
        { layerId: 8, name: 'Logo', kind: 'layer' }
      ]
    });
  });
});
