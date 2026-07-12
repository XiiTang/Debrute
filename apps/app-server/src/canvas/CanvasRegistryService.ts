import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDebruteProjectPaths, projectContentHash } from '@debrute/project-core';
import {
  assertCanvasDocumentId,
  createCanvasDocument,
  normalizeCanvasDocumentName,
  type Diagnostic,
  type CanvasDocument
} from '@debrute/canvas-core';
import type { CanvasRegistryErrorCode, CanvasRegistryState } from '@debrute/app-protocol';
import { serviceError } from '../server/ServiceErrors.js';
import { projectDocumentFileHash } from '../project-documents/ProjectDocumentTransaction.js';

export interface CanvasRegistryDocument {
  canvasOrder: string[];
}

export interface CanvasRegistryReadResult {
  state: CanvasRegistryState;
  sourceHash?: string;
  document?: CanvasRegistryDocument;
}

export interface CanvasRegistryServiceOptions {
  loadCanvasDocuments(projectRoot: string): Promise<{ canvases: CanvasDocument[]; diagnostics: Diagnostic[] }>;
  writeStructuredDocuments(input: {
    projectRoot: string;
    owner: string;
    reads: Array<{ absolutePath: string; expectedHash: string | null }>;
    writes?: Array<{ absolutePath: string; content: string }>;
    deletes?: Array<{ absolutePath: string }>;
  }): Promise<void>;
}

const EMPTY_CANVAS_MAP_SOURCE = 'paths: []\n';

export class CanvasRegistryService {
  private readonly registrySourceHashByProjectRoot = new Map<string, string>();
  private readonly canvasMapSourceHashByProjectCanvas = new Map<string, string>();

  constructor(private readonly options: CanvasRegistryServiceOptions) {}

  async ensureDefaultCanvas(projectRoot: string): Promise<void> {
    const paths = getDebruteProjectPaths(projectRoot);
    if (await hasCanvasJsonFiles(paths.canvasesDir) || await fileExists(paths.canvasIndexFile)) {
      return;
    }

    const canvas = createCanvasDocument({ id: 'canvas-1' });
    await this.writeStructuredDocuments(projectRoot, {
      reads: [
        { absolutePath: join(paths.canvasMapsDir, `${canvas.id}.yaml`), expectedHash: null },
        { absolutePath: join(paths.canvasesDir, `${canvas.id}.json`), expectedHash: null },
        { absolutePath: paths.canvasIndexFile, expectedHash: null }
      ],
      writes: [
        canvasMapWrite(projectRoot, canvas.id, EMPTY_CANVAS_MAP_SOURCE),
        canvasJsonWrite(projectRoot, canvas.id, canvas),
        registryWrite(projectRoot, {
          canvasOrder: [canvas.id]
        })
      ]
    });
    this.canvasMapSourceHashByProjectCanvas.set(projectCanvasKey(projectRoot, canvas.id), projectContentHash(EMPTY_CANVAS_MAP_SOURCE));
  }

  async readRegistry(projectRoot: string): Promise<CanvasRegistryReadResult> {
    const registry = await this.readRegistryFromDisk(projectRoot);
    if (registry.state.status === 'ready' && registry.sourceHash) {
      this.registrySourceHashByProjectRoot.set(projectRoot, registry.sourceHash);
    }
    return registry;
  }

  async orderedCanvases(projectRoot: string): Promise<{ canvases: CanvasDocument[]; registry: CanvasRegistryState; diagnostics: Diagnostic[] }> {
    const { canvases, diagnostics } = await this.options.loadCanvasDocuments(projectRoot);
    const mapIds = await this.currentCanvasMapIds(projectRoot);
    const registry = await this.readRegistry(projectRoot);
    if (registry.state.status === 'invalid' || !registry.document) {
      return { canvases: [], registry: registry.state, diagnostics };
    }
    const validation = validateRegistryPairs(registry.document.canvasOrder, canvases, mapIds);
    if (validation) {
      return { canvases: [], registry: validation, diagnostics };
    }

    const canvasesById = new Map(canvases.map((canvas) => [canvas.id, canvas]));
    await this.recordCanvasMapHashes(projectRoot, registry.document.canvasOrder);
    return {
      canvases: registry.document.canvasOrder.map((id) => canvasesById.get(id)!),
      registry: registry.state,
      diagnostics
    };
  }

  async createCanvas(projectRoot: string): Promise<{ canvasId: string }> {
    const { document, sourceHash } = await this.currentRegistryDocumentForWrite(projectRoot);
    const canvasId = nextCanvasId(document.canvasOrder);
    const paths = getDebruteProjectPaths(projectRoot);
    await this.writeStructuredDocuments(projectRoot, {
      reads: [
        { absolutePath: paths.canvasIndexFile, expectedHash: sourceHash },
        { absolutePath: join(paths.canvasMapsDir, `${canvasId}.yaml`), expectedHash: null },
        { absolutePath: join(paths.canvasesDir, `${canvasId}.json`), expectedHash: null }
      ],
      writes: [
        canvasMapWrite(projectRoot, canvasId, EMPTY_CANVAS_MAP_SOURCE),
        canvasJsonWrite(projectRoot, canvasId, createCanvasDocument({ id: canvasId })),
        registryWrite(projectRoot, {
          canvasOrder: [...document.canvasOrder, canvasId]
        })
      ]
    });
    this.canvasMapSourceHashByProjectCanvas.set(projectCanvasKey(projectRoot, canvasId), projectContentHash(EMPTY_CANVAS_MAP_SOURCE));
    return { canvasId };
  }

  async renameCanvas(projectRoot: string, input: { canvasId: string; name: string }): Promise<{ canvasId: string }> {
    assertCanvasDocumentId(input.canvasId);
    const name = normalizeCanvasDocumentName(input.name);
    const { document, sourceHash } = await this.currentRegistryDocumentForWrite(projectRoot);
    if (!document.canvasOrder.includes(input.canvasId)) {
      throw serviceError('canvas_registry_invalid', `Canvas is not in registry: ${input.canvasId}`, { canvas_id: input.canvasId });
    }

    const paths = getDebruteProjectPaths(projectRoot);
    const jsonPath = join(paths.canvasesDir, `${input.canvasId}.json`);
    const canvas = (await this.options.loadCanvasDocuments(projectRoot)).canvases.find((item) => item.id === input.canvasId);
    if (!canvas) {
      throw serviceError('canvas_registry_invalid', `Canvas JSON is missing: ${input.canvasId}`, { canvas_id: input.canvasId });
    }
    const jsonHash = await projectDocumentFileHash(jsonPath);

    await this.writeStructuredDocuments(projectRoot, {
      reads: [
        { absolutePath: paths.canvasIndexFile, expectedHash: sourceHash },
        { absolutePath: jsonPath, expectedHash: jsonHash }
      ],
      writes: [
        canvasJsonWrite(projectRoot, input.canvasId, { ...canvas, name })
      ]
    });
    return { canvasId: input.canvasId };
  }

  async deleteCanvas(projectRoot: string, input: { canvasId: string }): Promise<{ activeCanvasId: string }> {
    assertCanvasDocumentId(input.canvasId);
    const { document, sourceHash } = await this.currentRegistryDocumentForWrite(projectRoot);
    if (document.canvasOrder.length <= 1) {
      throw serviceError('canvas_registry_invalid', 'Cannot delete the final canvas.', { canvas_id: input.canvasId });
    }
    const index = document.canvasOrder.indexOf(input.canvasId);
    if (index < 0) {
      throw serviceError('canvas_registry_invalid', `Canvas is not in registry: ${input.canvasId}`, { canvas_id: input.canvasId });
    }

    const sourceMapContent = await this.assertCanvasMapHash(projectRoot, input.canvasId);
    const paths = getDebruteProjectPaths(projectRoot);
    const mapPath = join(paths.canvasMapsDir, `${input.canvasId}.yaml`);
    const jsonPath = join(paths.canvasesDir, `${input.canvasId}.json`);
    const jsonHash = await projectDocumentFileHash(jsonPath);
    await this.writeStructuredDocuments(projectRoot, {
      reads: [
        { absolutePath: paths.canvasIndexFile, expectedHash: sourceHash },
        { absolutePath: mapPath, expectedHash: projectContentHash(sourceMapContent) },
        { absolutePath: jsonPath, expectedHash: jsonHash }
      ],
      writes: [
        registryWrite(projectRoot, {
          canvasOrder: document.canvasOrder.filter((id) => id !== input.canvasId)
        })
      ],
      deletes: [
        { absolutePath: mapPath },
        { absolutePath: jsonPath }
      ]
    });
    this.canvasMapSourceHashByProjectCanvas.delete(projectCanvasKey(projectRoot, input.canvasId));
    return {
      activeCanvasId: document.canvasOrder[index + 1] ?? document.canvasOrder[index - 1]!
    };
  }

  async reorderCanvases(projectRoot: string, input: { canvasOrder: string[] }): Promise<void> {
    const { document, sourceHash } = await this.currentRegistryDocumentForWrite(projectRoot);
    assertCompletePermutation(input.canvasOrder, document.canvasOrder);
    await this.writeStructuredDocuments(projectRoot, {
      reads: [{ absolutePath: getDebruteProjectPaths(projectRoot).canvasIndexFile, expectedHash: sourceHash }],
      writes: [
        registryWrite(projectRoot, {
          canvasOrder: input.canvasOrder
        })
      ]
    });
  }

  async repairCanvasIndex(projectRoot: string): Promise<{ activeCanvasId: string }> {
    const { canvases } = await this.options.loadCanvasDocuments(projectRoot);
    const mapIds = await this.currentCanvasMapIds(projectRoot);
    const canvasIds = canvases
      .map((canvas) => canvas.id)
      .filter((id) => mapIds.has(id))
      .sort((left, right) => left.localeCompare(right));
    if (canvasIds.length === 0) {
      throw serviceError('canvas_registry_repair_failed', 'Canvas registry repair found no valid canvas pairs.');
    }

    await this.writeStructuredDocuments(projectRoot, {
      reads: [],
      writes: [
        registryWrite(projectRoot, {
          canvasOrder: canvasIds
        })
      ]
    });
    await this.recordCanvasMapHashes(projectRoot, canvasIds);
    return { activeCanvasId: canvasIds[0]! };
  }

  private async currentRegistryDocumentForWrite(projectRoot: string): Promise<{ document: CanvasRegistryDocument; sourceHash: string }> {
    const registry = await this.readRegistryFromDisk(projectRoot);
    if (registry.state.status === 'invalid') {
      throw serviceError(registry.state.code, registry.state.message);
    }
    if (!registry.document) {
      throw serviceError('canvas_registry_invalid', 'Canvas registry document is missing.');
    }
    const expected = this.registrySourceHashByProjectRoot.get(projectRoot);
    if (!expected || registry.sourceHash !== expected) {
      throw serviceError('canvas_registry_conflict', 'Canvas registry changed on disk. Refresh or repair before retrying.');
    }

    const validation = validateRegistryPairs(
      registry.document.canvasOrder,
      (await this.options.loadCanvasDocuments(projectRoot)).canvases,
      await this.currentCanvasMapIds(projectRoot)
    );
    if (validation) {
      throw serviceError(validation.code, validation.message);
    }
    return { document: registry.document, sourceHash: registry.sourceHash! };
  }

  private async readRegistryFromDisk(projectRoot: string): Promise<CanvasRegistryReadResult> {
    const path = getDebruteProjectPaths(projectRoot).canvasIndexFile;
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (isMissingPathError(error)) {
        return invalidRegistry('canvas_registry_missing', 'Canvas registry is missing.');
      }
      throw error;
    }

    try {
      const document = normalizeCanvasRegistryDocument(JSON.parse(content));
      const sourceHash = projectContentHash(content);
      return {
        state: { status: 'ready', canvasOrder: document.canvasOrder },
        sourceHash,
        document
      };
    } catch (error) {
      return invalidRegistry('canvas_registry_invalid', errorMessage(error));
    }
  }

  private async writeStructuredDocuments(
    projectRoot: string,
    input: {
      reads: Array<{ absolutePath: string; expectedHash: string | null }>;
      writes?: Array<{ absolutePath: string; content: string }>;
      deletes?: Array<{ absolutePath: string }>;
    }
  ): Promise<void> {
    await this.options.writeStructuredDocuments({
      projectRoot,
      owner: 'canvas-registry',
      ...input
    });
    for (const write of input.writes ?? []) {
      if (write.absolutePath === getDebruteProjectPaths(projectRoot).canvasIndexFile) {
        this.registrySourceHashByProjectRoot.set(projectRoot, projectContentHash(write.content));
      }
    }
  }

  private async currentCanvasMapIds(projectRoot: string): Promise<Set<string>> {
    const dir = getDebruteProjectPaths(projectRoot).canvasMapsDir;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (isMissingPathError(error)) {
        entries = [];
      } else {
        throw error;
      }
    }
    return new Set(entries
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => name.slice(0, -'.yaml'.length)));
  }

  private async recordCanvasMapHashes(projectRoot: string, canvasIds: string[]): Promise<void> {
    for (const canvasId of canvasIds) {
      const content = await readFile(join(getDebruteProjectPaths(projectRoot).canvasMapsDir, `${canvasId}.yaml`), 'utf8');
      this.canvasMapSourceHashByProjectCanvas.set(projectCanvasKey(projectRoot, canvasId), projectContentHash(content));
    }
  }

  private async assertCanvasMapHash(projectRoot: string, canvasId: string): Promise<string> {
    const path = join(getDebruteProjectPaths(projectRoot).canvasMapsDir, `${canvasId}.yaml`);
    const content = await readFile(path, 'utf8');
    const current = projectContentHash(content);
    const expected = this.canvasMapSourceHashByProjectCanvas.get(projectCanvasKey(projectRoot, canvasId));
    if (expected !== current) {
      throw serviceError('canvas_map_conflict', 'Canvas Map changed on disk. Push or refresh before retrying.', {
        canvas_id: canvasId,
        file_path: `.debrute/canvas-maps/${canvasId}.yaml`
      });
    }
    return content;
  }
}

function normalizeCanvasRegistryDocument(value: unknown): CanvasRegistryDocument {
  if (!isRecord(value)
    || !Array.isArray(value.canvasOrder)) {
    throw new Error('Invalid Canvas registry document.');
  }
  const ids = value.canvasOrder.map((item) => {
    if (typeof item !== 'string') {
      throw new Error('Canvas registry ids must be strings.');
    }
    return assertCanvasDocumentId(item);
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error('Canvas registry contains duplicate canvas ids.');
  }
  return {
    canvasOrder: ids
  };
}

function validateRegistryPairs(
  canvasOrder: string[],
  canvases: CanvasDocument[],
  mapIds: Set<string>
): Extract<CanvasRegistryState, { status: 'invalid' }> | undefined {
  const canvasIds = new Set(canvases.map((canvas) => canvas.id));
  const orderedIds = new Set(canvasOrder);
  for (const id of canvasOrder) {
    if (!canvasIds.has(id) || !mapIds.has(id)) {
      return { status: 'invalid', code: 'canvas_registry_invalid', message: `Canvas registry references missing canvas: ${id}` };
    }
  }
  for (const id of canvasIds) {
    if (!orderedIds.has(id)) {
      return { status: 'invalid', code: 'canvas_registry_invalid', message: `Canvas registry is missing canvas: ${id}` };
    }
  }
  for (const id of mapIds) {
    if (!orderedIds.has(id)) {
      return { status: 'invalid', code: 'canvas_registry_invalid', message: `Canvas registry is missing Canvas Map: ${id}` };
    }
  }
  return undefined;
}

function nextCanvasId(canvasIds: string[]): string {
  const max = canvasIds.reduce((current, id) => {
    const match = /^canvas-(\d+)$/.exec(id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `canvas-${max + 1}`;
}

function assertCompletePermutation(input: string[], existing: string[]): void {
  if (input.length !== existing.length) {
    throw serviceError('canvas_registry_invalid', 'Canvas order must include every canvas exactly once.');
  }
  const expected = new Set(existing);
  const seen = new Set<string>();
  for (const id of input) {
    assertCanvasDocumentId(id);
    if (!expected.has(id) || seen.has(id)) {
      throw serviceError('canvas_registry_invalid', 'Canvas order must be a complete canvas id permutation.');
    }
    seen.add(id);
  }
}

function invalidRegistry(code: CanvasRegistryErrorCode, message: string): CanvasRegistryReadResult {
  return { state: { status: 'invalid', code, message } };
}

function registryWrite(projectRoot: string, document: CanvasRegistryDocument): { absolutePath: string; content: string } {
  return {
    absolutePath: getDebruteProjectPaths(projectRoot).canvasIndexFile,
    content: `${JSON.stringify(document, null, 2)}\n`
  };
}

function canvasMapWrite(projectRoot: string, canvasId: string, content: string): { absolutePath: string; content: string } {
  return {
    absolutePath: join(getDebruteProjectPaths(projectRoot).canvasMapsDir, `${canvasId}.yaml`),
    content
  };
}

function canvasJsonWrite(projectRoot: string, canvasId: string, canvas: CanvasDocument): { absolutePath: string; content: string } {
  return {
    absolutePath: join(getDebruteProjectPaths(projectRoot).canvasesDir, `${canvasId}.json`),
    content: `${JSON.stringify(canvas, null, 2)}\n`
  };
}

function projectCanvasKey(projectRoot: string, canvasId: string): string {
  return `${projectRoot}\u0000${canvasId}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function hasCanvasJsonFiles(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
  return entries.some((name) => name.endsWith('.json') && name !== 'index.json');
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
