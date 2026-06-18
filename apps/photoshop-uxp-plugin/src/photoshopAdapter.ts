import type { PhotoshopSelectionSnapshot } from './selectionModel';

export interface ExportedSelectionPng {
  suggestedName: string;
  bytes: Uint8Array;
}

export interface PhotoshopAdapter {
  hostVersion(): string;
  currentSelectionSnapshot(): PhotoshopSelectionSnapshot;
  exportSelectedTopLevelPngs(): Promise<ExportedSelectionPng[]>;
  placeFileAsSmartObject(input: { fileName: string; bytes: Uint8Array }): Promise<void>;
}

export interface PhotoshopRuntimeLayer {
  id: number;
  name: string;
  typename: string;
  layers?: PhotoshopRuntimeLayer[];
}

export interface PhotoshopRuntimeDocument {
  id: number;
  title: string;
  layers: PhotoshopRuntimeLayer[];
  activeLayers: PhotoshopRuntimeLayer[];
}

export interface PhotoshopRuntime {
  app: {
    version: string;
    activeDocument: PhotoshopRuntimeDocument | null;
    documents: unknown[];
  };
}

interface PhotoshopModule extends PhotoshopRuntime {
  action: {
    batchPlay(descriptors: unknown[], options: Record<string, unknown>): Promise<unknown[]>;
  };
  core: {
    executeAsModal<T>(targetFunction: () => Promise<T> | T, options: { commandName: string; timeOut?: number }): Promise<T>;
  };
  imaging: {
    getPixels(options: Record<string, unknown>): Promise<{
      imageData: {
        width: number;
        height: number;
        components: number;
        getData(): Promise<Uint8Array>;
        dispose(): void;
      };
      sourceBounds: { left: number; top: number; right: number; bottom: number };
    }>;
  };
}

interface UxpModule {
  storage: {
    localFileSystem: {
      getTemporaryFolder(): Promise<{
        createFile(name: string, options?: { overwrite?: boolean }): Promise<{
          nativePath?: string;
          write(content: ArrayBuffer | Uint8Array, options?: { format?: unknown }): Promise<void>;
        }>;
      }>;
      createSessionToken(entry: unknown): string;
    };
    formats: {
      binary: symbol;
    };
  };
}

export function currentPhotoshopDocument(photoshop: PhotoshopRuntime): PhotoshopRuntimeDocument | null {
  if (photoshop.app.documents.length === 0) {
    return null;
  }
  return photoshop.app.activeDocument ?? null;
}

export function photoshopHostVersion(photoshop: PhotoshopRuntime): string {
  return photoshop.app.version;
}

export function photoshopSelectionSnapshot(photoshop: PhotoshopRuntime): PhotoshopSelectionSnapshot {
  const document = currentPhotoshopDocument(photoshop);
  if (!document) {
    return { documentTitle: null, documentCount: photoshop.app.documents.length, selectedItems: [] };
  }
  const activeLayersById = new Map(document.activeLayers.map((layer) => [layer.id, layer]));
  return {
    documentTitle: document.title,
    documentCount: photoshop.app.documents.length,
    selectedItems: document.layers
      .filter((layer) => activeLayersById.has(layer.id))
      .map((layer) => ({
        layerId: layer.id,
        name: activeLayersById.get(layer.id)?.name ?? layer.name,
        kind: Array.isArray(layer.layers) ? 'group' as const : 'layer' as const
      }))
  };
}

export function createPhotoshopAdapter(): PhotoshopAdapter {
  const photoshop = requireUxpHostModule<PhotoshopModule>('photoshop');
  const uxp = requireUxpHostModule<UxpModule>('uxp');

  return {
    hostVersion() {
      return photoshopHostVersion(photoshop);
    },
    currentSelectionSnapshot() {
      return photoshopSelectionSnapshot(photoshop);
    },
    async exportSelectedTopLevelPngs() {
      const snapshot = this.currentSelectionSnapshot();
      const document = currentPhotoshopDocument(photoshop);
      if (!document) {
        return [];
      }
      const exported: ExportedSelectionPng[] = [];
      for (const item of snapshot.selectedItems) {
        const pixels = await photoshop.imaging.getPixels({
          documentID: document.id,
          layerID: item.layerId,
          componentSize: 8,
          colorSpace: 'RGB'
        });
        try {
          const bytes = await rgbaPixelsToPngBytes({
            data: await pixels.imageData.getData(),
            width: pixels.imageData.width,
            height: pixels.imageData.height,
            components: pixels.imageData.components
          });
          exported.push({ suggestedName: item.name, bytes });
        } finally {
          pixels.imageData.dispose();
        }
      }
      return exported;
    },
    async placeFileAsSmartObject(input) {
      const folder = await uxp.storage.localFileSystem.getTemporaryFolder();
      const file = await folder.createFile(input.fileName, { overwrite: true });
      await file.write(input.bytes, { format: uxp.storage.formats.binary });
      const token = uxp.storage.localFileSystem.createSessionToken(file);
      await photoshop.core.executeAsModal(async () => {
        await photoshop.action.batchPlay([{
          _obj: 'placeEvent',
          target: { _path: token, _kind: 'local' },
          linked: false
        }], {});
      }, { commandName: 'Debrute Place Smart Object', timeOut: 5 });
    }
  };
}

function requireUxpHostModule<T>(id: string): T {
  return (globalThis as unknown as { require(moduleId: string): unknown }).require(id) as T;
}

async function rgbaPixelsToPngBytes(input: {
  data: Uint8Array;
  width: number;
  height: number;
  components: number;
}): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = input.width;
  canvas.height = input.height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas 2D context is unavailable.');
  }
  const rgba = input.components === 4
    ? input.data
    : rgbToRgba(input.data, input.width, input.height);
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), input.width, input.height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error('PNG encoding failed.')), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function rgbToRgba(data: Uint8Array, width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < data.length; source += 3, target += 4) {
    rgba[target] = data[source] ?? 0;
    rgba[target + 1] = data[source + 1] ?? 0;
    rgba[target + 2] = data[source + 2] ?? 0;
    rgba[target + 3] = 255;
  }
  return rgba;
}
