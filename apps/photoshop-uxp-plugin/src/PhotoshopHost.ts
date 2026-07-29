import {
  PHOTOSHOP_BASELINE_PLACEMENT_MIME_TYPES,
  PHOTOSHOP_MAX_BATCH_BYTES,
  PHOTOSHOP_MAX_FILE_BYTES,
  type PhotoshopDocumentSnapshot,
  type PhotoshopMimeType
} from '@debrute/app-protocol';
import { encodeRgbaPng } from './pngEncoder.js';

export interface PhotoshopLayer {
  id: number;
  name: string;
  typename: string;
  kind?: string;
  visible: boolean;
  layers?: PhotoshopLayer[];
  duplicate(targetDocument: PhotoshopDocument): Promise<PhotoshopLayer>;
}

export interface PhotoshopDocument {
  id: number;
  title: string;
  width: number;
  height: number;
  resolution: number;
  mode: string;
  layers: PhotoshopLayer[];
  activeLayers: PhotoshopLayer[];
  closeWithoutSaving(): void;
}

export interface PhotoshopModule {
  app: {
    documents: PhotoshopDocument[];
    activeDocument: PhotoshopDocument | null;
    createDocument(options: {
      width: number;
      height: number;
      resolution: number;
      mode: string;
      fill: 'transparent';
    }): Promise<PhotoshopDocument>;
  };
  action: {
    addNotificationListener(events: string[], listener: () => void): void;
    removeNotificationListener(events: string[], listener: () => void): void;
    validateReference(reference: unknown): Promise<boolean>;
    batchPlay(descriptors: unknown[], options: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  };
  core: {
    executeAsModal<T>(targetFunction: () => Promise<T> | T, options: { commandName: string }): Promise<T>;
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
      sourceBounds: PixelBounds;
    }>;
  };
}

interface UxpFile {
  name: string;
  write(content: ArrayBuffer | Uint8Array, options?: { format?: unknown }): Promise<void>;
  read(options?: { format?: unknown }): Promise<ArrayBuffer>;
  delete(): Promise<void>;
}

interface UxpModule {
  host: {
    version: string;
  };
  storage: {
    localFileSystem: {
      getTemporaryFolder(): Promise<{
        createFile(name: string, options?: { overwrite?: boolean }): Promise<UxpFile>;
      }>;
      createSessionToken(entry: UxpFile): string;
    };
    formats: {
      binary: symbol;
    };
  };
}

export interface PhotoshopSelectionSnapshot {
  documentId: number | null;
  documentTitle: string | null;
  items: Array<{ layerId: number; name: string; kind: 'layer' | 'group' }>;
}

export interface PixelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PixelSnapshot {
  data: Uint8Array;
  width: number;
  height: number;
  components: number;
  sourceBounds: PixelBounds;
}

export interface StagedPng {
  itemId: string;
  layerId: number;
  sourceName: string;
  byteLength: number;
  read(): Promise<Uint8Array>;
  delete(): Promise<void>;
}

export type CapturedPng =
  | { itemId: string; ok: true; staged: StagedPng }
  | { itemId: string; ok: false; message: string };

const DOCUMENT_EVENTS = [
  'open',
  'close',
  'select',
  'selectAllLayers',
  'selectNoLayers',
  'set',
  'make',
  'delete'
];

export class PhotoshopHost {
  private readonly changeListeners = new Set<() => void>();
  private changeSuppressionDepth = 0;
  private pendingHostChange = false;
  private readonly hostChangeListener = () => {
    if (this.changeSuppressionDepth > 0) {
      this.pendingHostChange = true;
      return;
    }
    this.publishHostChange();
  };

  constructor(
    private readonly photoshop = requireHostModule<PhotoshopModule>('photoshop'),
    private readonly uxp = requireHostModule<UxpModule>('uxp')
  ) {}

  hostVersion(): string {
    return this.uxp.host.version;
  }

  placementMimeTypes(): PhotoshopMimeType[] {
    const baseline = [...PHOTOSHOP_BASELINE_PLACEMENT_MIME_TYPES];
    return photoshopHostSupportsAvif(this.hostVersion())
      ? [...baseline, 'image/avif']
      : baseline;
  }

  documents(): PhotoshopDocumentSnapshot[] {
    return documentSnapshot(this.photoshop);
  }

  selection(): PhotoshopSelectionSnapshot {
    return selectionSnapshot(this.photoshop);
  }

  observeChanges(listener: () => void): () => void {
    if (this.changeListeners.size === 0) {
      this.photoshop.action.addNotificationListener(DOCUMENT_EVENTS, this.hostChangeListener);
    }
    this.changeListeners.add(listener);
    let observing = true;
    return () => {
      if (!observing) return;
      observing = false;
      this.changeListeners.delete(listener);
      if (this.changeListeners.size === 0) {
        this.photoshop.action.removeNotificationListener(DOCUMENT_EVENTS, this.hostChangeListener);
      }
    };
  }

  async capturePngs(
    documentId: number,
    items: Array<{ itemId: string; layerId: number; sourceName: string }>
  ): Promise<CapturedPng[]> {
    const stagedFiles: StagedPng[] = [];
    try {
      return await this.suppressHostChanges(() => this.photoshop.core.executeAsModal(async () => {
        const document = await this.requireDocument(documentId);
        const captured: CapturedPng[] = [];
        let aggregateBytes = 0;
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index]!;
          try {
            const layer = findLayer(document.layers, item.layerId);
            if (!layer) {
              throw new Error(`Photoshop layer ${item.layerId} is no longer open.`);
            }
            const pixels = await this.readPixels(document, layer);
            if (pixels.width <= 0 || pixels.height <= 0) {
              throw new Error(`Photoshop layer “${item.sourceName}” has no renderable pixels.`);
            }
            const fullCanvas = composeFullCanvasRgba({
              source: pixels.data,
              sourceWidth: pixels.width,
              sourceHeight: pixels.height,
              components: pixels.components,
              sourceBounds: pixels.sourceBounds,
              canvasWidth: document.width,
              canvasHeight: document.height
            });
            if (!hasVisibleAlpha(fullCanvas)) {
              throw new Error(`Photoshop layer “${item.sourceName}” has no renderable pixels.`);
            }
            const png = encodeRgbaPng(fullCanvas, document.width, document.height);
            if (png.byteLength > PHOTOSHOP_MAX_FILE_BYTES) {
              throw new Error(`Photoshop layer “${item.sourceName}” exceeds the 256 MiB file limit.`);
            }
            if (aggregateBytes + png.byteLength > PHOTOSHOP_MAX_BATCH_BYTES) {
              captured.push({
                itemId: item.itemId,
                ok: false,
                message: `Photoshop layer “${item.sourceName}” exceeds the 1 GiB batch limit.`
              });
              for (const remaining of items.slice(index + 1)) {
                captured.push({
                  itemId: remaining.itemId,
                  ok: false,
                  message: `Photoshop layer “${remaining.sourceName}” was not captured because the batch exceeds 1 GiB.`
                });
              }
              break;
            }
            const staged = await this.stagePng(item, png);
            stagedFiles.push(staged);
            aggregateBytes += staged.byteLength;
            captured.push({ itemId: item.itemId, ok: true, staged });
          } catch (error) {
            captured.push({ itemId: item.itemId, ok: false, message: errorMessage(error) });
          }
        }
        return captured;
      }, { commandName: 'Debrute Capture Selected Files' }));
    } catch (error) {
      await Promise.all(stagedFiles.map(async (staged) => staged.delete().catch(() => undefined)));
      throw error;
    }
  }

  private async readPixels(document: PhotoshopDocument, layer: PhotoshopLayer): Promise<PixelSnapshot> {
    if (!Array.isArray(layer.layers)) {
      return this.snapshotPixels({
        documentID: document.id,
        layerID: layer.id,
        sourceBounds: fullCanvasBounds(document),
        componentSize: 8,
        colorSpace: 'RGB',
        applyAlpha: false
      });
    }
    let temporaryDocument: PhotoshopDocument | undefined;
    try {
      temporaryDocument = await this.photoshop.app.createDocument({
        width: document.width,
        height: document.height,
        resolution: document.resolution,
        mode: document.mode,
        fill: 'transparent'
      });
      const duplicate = await layer.duplicate(temporaryDocument);
      duplicate.visible = true;
      return await this.snapshotPixels({
        documentID: temporaryDocument.id,
        sourceBounds: fullCanvasBounds(document),
        componentSize: 8,
        colorSpace: 'RGB',
        applyAlpha: false
      });
    } finally {
      try {
        temporaryDocument?.closeWithoutSaving();
      } finally {
        this.photoshop.app.activeDocument = document;
      }
    }
  }

  private async snapshotPixels(options: Record<string, unknown>): Promise<PixelSnapshot> {
    const pixels = await this.photoshop.imaging.getPixels(options);
    try {
      return {
        data: (await pixels.imageData.getData()).slice(),
        width: pixels.imageData.width,
        height: pixels.imageData.height,
        components: pixels.imageData.components,
        sourceBounds: pixels.sourceBounds
      };
    } finally {
      pixels.imageData.dispose();
    }
  }

  private async suppressHostChanges<T>(operation: () => Promise<T>): Promise<T> {
    this.changeSuppressionDepth += 1;
    try {
      return await operation();
    } finally {
      this.changeSuppressionDepth -= 1;
      if (this.changeSuppressionDepth === 0 && this.pendingHostChange) {
        this.pendingHostChange = false;
        this.publishHostChange();
      }
    }
  }

  private publishHostChange(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  private async stagePng(
    item: { itemId: string; layerId: number; sourceName: string },
    bytes: Uint8Array
  ): Promise<StagedPng> {
    const folder = await this.uxp.storage.localFileSystem.getTemporaryFolder();
    const file = await folder.createFile(temporaryName(`${item.sourceName}.png`), { overwrite: false });
    try {
      await file.write(bytes, { format: this.uxp.storage.formats.binary });
    } catch (error) {
      await file.delete().catch(() => undefined);
      throw error;
    }
    return {
      itemId: item.itemId,
      layerId: item.layerId,
      sourceName: item.sourceName,
      byteLength: bytes.byteLength,
      read: async () => new Uint8Array(await file.read({ format: this.uxp.storage.formats.binary })),
      delete: async () => file.delete()
    };
  }

  async placeEmbeddedSmartObject(input: {
    documentId: number;
    fileName: string;
    bytes: ArrayBuffer;
    isSessionCurrent(): boolean;
  }): Promise<void> {
    const folder = await this.uxp.storage.localFileSystem.getTemporaryFolder();
    const file = await folder.createFile(temporaryName(input.fileName), { overwrite: false });
    try {
      await file.write(input.bytes, { format: this.uxp.storage.formats.binary });
      const token = this.uxp.storage.localFileSystem.createSessionToken(file);
      await this.photoshop.core.executeAsModal(async () => {
        const document = await this.requireDocument(input.documentId);
        if (!input.isSessionCurrent()) {
          throw new Error('Photoshop Runtime session was lost.');
        }
        const existingLayerIds = new Set(flattenLayerIds(document.layers));
        this.photoshop.app.activeDocument = document;
        const [placeResult] = await this.photoshop.action.batchPlay([{
          _obj: 'placeEvent',
          null: { _path: token, _kind: 'local' },
          linked: false,
          _options: { dialogOptions: 'silent' }
        }], { synchronousExecution: false, modalBehavior: 'execute' });
        throwForBatchPlayError(placeResult, 'Photoshop could not place the file.');
        const placed = document.activeLayers[0];
        if (!placed || existingLayerIds.has(placed.id)) {
          throw new Error('Photoshop did not create an Embedded Smart Object.');
        }
        const [descriptor] = await this.photoshop.action.batchPlay([{
          _obj: 'get',
          _target: [
            { _ref: 'layer', _id: placed.id },
            { _ref: 'document', _id: document.id }
          ],
          _options: { dialogOptions: 'silent' }
        }], { synchronousExecution: true, modalBehavior: 'execute' });
        throwForBatchPlayError(descriptor, 'Photoshop could not verify the placed Smart Object.');
        if (!isSmartObjectDescriptor(descriptor)) {
          throw new Error('Photoshop did not create an Embedded Smart Object.');
        }
        if (isLinkedSmartObjectDescriptor(descriptor)) {
          throw new Error('Photoshop created a linked Smart Object instead of an Embedded Smart Object.');
        }
      }, { commandName: 'Debrute Place Embedded Smart Object' });
    } finally {
      await file.delete().catch(() => undefined);
    }
  }

  private async requireDocument(documentId: number): Promise<PhotoshopDocument> {
    const document = this.photoshop.app.documents.find((candidate) => candidate.id === documentId);
    if (!document || !await this.photoshop.action.validateReference({ _ref: 'document', _id: documentId })) {
      throw new Error(`Photoshop Document ${documentId} is no longer open.`);
    }
    return document;
  }
}

function photoshopHostSupportsAvif(version: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 26 || (major === 26 && minor >= 8);
}

export function documentSnapshot(photoshop: Pick<PhotoshopModule, 'app'>): PhotoshopDocumentSnapshot[] {
  return photoshop.app.documents.map((document) => ({
    documentId: document.id,
    title: document.title
  }));
}

export function selectionSnapshot(photoshop: Pick<PhotoshopModule, 'app'>): PhotoshopSelectionSnapshot {
  if (photoshop.app.documents.length === 0 || !photoshop.app.activeDocument) {
    return { documentId: null, documentTitle: null, items: [] };
  }
  const document = photoshop.app.activeDocument;
  return {
    documentId: document.id,
    documentTitle: document.title,
    items: document.activeLayers.map((layer) => ({
      layerId: layer.id,
      name: layer.name,
      kind: Array.isArray(layer.layers) ? 'group' : 'layer'
    }))
  };
}

export function composeFullCanvasRgba(input: {
  source: Uint8Array;
  sourceWidth: number;
  sourceHeight: number;
  components: number;
  sourceBounds: PixelBounds;
  canvasWidth: number;
  canvasHeight: number;
}): Uint8Array {
  if (input.components !== 3 && input.components !== 4) {
    throw new Error(`Unsupported Photoshop pixel component count: ${input.components}.`);
  }
  const result = new Uint8Array(input.canvasWidth * input.canvasHeight * 4);
  const originX = Math.trunc(input.sourceBounds.left);
  const originY = Math.trunc(input.sourceBounds.top);
  for (let sourceY = 0; sourceY < input.sourceHeight; sourceY += 1) {
    const targetY = originY + sourceY;
    if (targetY < 0 || targetY >= input.canvasHeight) {
      continue;
    }
    for (let sourceX = 0; sourceX < input.sourceWidth; sourceX += 1) {
      const targetX = originX + sourceX;
      if (targetX < 0 || targetX >= input.canvasWidth) {
        continue;
      }
      const sourceOffset = (sourceY * input.sourceWidth + sourceX) * input.components;
      const targetOffset = (targetY * input.canvasWidth + targetX) * 4;
      result[targetOffset] = input.source[sourceOffset] ?? 0;
      result[targetOffset + 1] = input.source[sourceOffset + 1] ?? 0;
      result[targetOffset + 2] = input.source[sourceOffset + 2] ?? 0;
      result[targetOffset + 3] = input.components === 4 ? input.source[sourceOffset + 3] ?? 0 : 255;
    }
  }
  return result;
}

function findLayer(layers: PhotoshopLayer[], layerId: number): PhotoshopLayer | undefined {
  for (const layer of layers) {
    if (layer.id === layerId) {
      return layer;
    }
    const nested = layer.layers ? findLayer(layer.layers, layerId) : undefined;
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function fullCanvasBounds(document: Pick<PhotoshopDocument, 'width' | 'height'>): PixelBounds {
  return { left: 0, top: 0, right: document.width, bottom: document.height };
}

function flattenLayerIds(layers: PhotoshopLayer[]): number[] {
  return layers.flatMap((layer) => [layer.id, ...flattenLayerIds(layer.layers ?? [])]);
}

function hasVisibleAlpha(rgba: Uint8Array): boolean {
  for (let offset = 3; offset < rgba.length; offset += 4) {
    if (rgba[offset] !== 0) {
      return true;
    }
  }
  return false;
}

function temporaryName(fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._ -]+/g, '_').slice(-160) || 'Debrute File';
  return `${uniqueId()}-${safe}`;
}

function uniqueId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function isSmartObjectDescriptor(descriptor: Record<string, unknown> | undefined): boolean {
  return Boolean(descriptor && ('smartObject' in descriptor || 'smartObjectMore' in descriptor));
}

function isLinkedSmartObjectDescriptor(descriptor: Record<string, unknown> | undefined): boolean {
  return descriptorBoolean(descriptor, 'linked') === true;
}

function descriptorBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'boolean') return record[key];
  for (const child of Object.values(record)) {
    const nested = descriptorBoolean(child, key);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function throwForBatchPlayError(
  descriptor: Record<string, unknown> | undefined,
  fallbackMessage: string
): void {
  if (descriptor?._obj?.toString().toLowerCase() !== 'error') return;
  throw new Error(typeof descriptor.message === 'string' ? descriptor.message : fallbackMessage);
}

function requireHostModule<T>(id: 'photoshop' | 'uxp'): T {
  return (globalThis as unknown as { require(moduleId: string): unknown }).require(id) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Photoshop capture failed.';
}
