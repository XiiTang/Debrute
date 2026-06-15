import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getDebruteProjectPaths,
  listDebruteProjectFiles,
  normalizeProjectRelativePath,
  readProjectMetadata,
  readProjectTextFile,
  resolveExistingProjectPath,
  resolveProjectPathForWrite,
  type ProjectFileEntry
} from '@debrute/project-core';
import {
  reconcileCanvasNodeElements,
  type CanvasDesiredLayoutRow,
  type CanvasDesiredNode,
  type CanvasDocument,
  type Diagnostic,
  type CanvasLayoutSize
} from '@debrute/canvas-core';
import {
  CanvasMapError,
  canvasMapPath,
  canvasMapSourceHash,
  expandCanvasMap,
  parseCanvasMap,
  serializeCanvasMapWithRule,
  type ExpandedCanvasMap
} from '@debrute/canvas-map-core';
import { canvasMediaKindFromPath } from '../canvas/CanvasProjectionService.js';
import { projectDocumentDiagnostic } from '../project-documents/ProjectDocumentDiagnostics.js';

export interface CanvasMapSessionServiceOptions {
  loadCanvases(projectRoot: string): Promise<CanvasDocument[]>;
  canvasDocumentHash(projectRoot: string, canvasId: string): string | undefined;
  resolveCanvasNodeLayoutSize(projectRoot: string, node: CanvasDesiredNode): Promise<CanvasLayoutSize>;
  writeCanvasMapPush(input: {
    projectRoot: string;
    sourcePath: string;
    expectedSourceHash: string;
    canvasPath: string;
    canvas: CanvasDocument;
    expectedCanvasHash: string;
  }): Promise<void>;
  writeCanvasMapAndCanvasJson(input: {
    projectRoot: string;
    sourcePath: string;
    sourceContent: string;
    canvasPath: string;
    canvas: CanvasDocument;
    expectedSourceHash: string;
    expectedCanvasHash: string;
  }): Promise<void>;
}

export interface CanvasMapPushResult {
  ok: true;
  command: 'canvas-map.push';
  canvasId: string;
}

export interface AddProjectPathToCanvasMapResult {
  canvas: CanvasDocument;
  centerProjectRelativePath: string;
}

export interface SynchronizeCanvasMapsResult {
  canvases: CanvasDocument[];
  diagnostics: Diagnostic[];
}

interface PreparedCanvasMapPush {
  sourceHash: string;
  currentCanvasHash: string;
  currentCanvas: CanvasDocument;
  nextCanvas: CanvasDocument;
}

export class CanvasMapSessionService {
  private readonly sourceHashByCanvasId = new Map<string, string>();

  constructor(private readonly options: CanvasMapSessionServiceOptions) {}

  async pushCanvasMapForProject(projectRoot: string, input: { canvasId: string }): Promise<CanvasMapPushResult> {
    await readProjectMetadata(projectRoot);
    const sourcePath = canvasMapPath(input.canvasId);
    const source = await this.readCanvasMapSource(projectRoot, sourcePath);
    const prepared = await this.prepareCanvasMapPush(projectRoot, {
      canvasId: input.canvasId,
      sourceContent: source.content
    });
    await this.options.writeCanvasMapPush({
      projectRoot,
      sourcePath: source.absolutePath,
      expectedSourceHash: prepared.sourceHash,
      canvasPath: canvasPathFor(projectRoot, input.canvasId),
      canvas: prepared.nextCanvas,
      expectedCanvasHash: prepared.currentCanvasHash
    });
    this.sourceHashByCanvasId.set(input.canvasId, prepared.sourceHash);
    return { ok: true, command: 'canvas-map.push', canvasId: input.canvasId };
  }

  async addProjectPathToCanvasMap(
    projectRoot: string,
    input: { canvasId: string; projectRelativePath: string }
  ): Promise<AddProjectPathToCanvasMapResult> {
    const normalizedProjectPath = normalizeProjectRelativePath(input.projectRelativePath);
    const absolutePath = await resolveExistingProjectPath(projectRoot, normalizedProjectPath).catch(() => {
      throw new CanvasMapError(`Canvas Map target path is missing: ${normalizedProjectPath}`, 'canvas_map_target_missing');
    });
    const targetStat = await stat(absolutePath);
    if (!targetStat.isFile() && !targetStat.isDirectory()) {
      throw new CanvasMapError(`Canvas Map target path must be a file or directory: ${normalizedProjectPath}`, 'canvas_map_target_missing');
    }

    const sourcePath = canvasMapPath(input.canvasId);
    const source = await this.readCanvasMapSource(projectRoot, sourcePath);
    const sourceHash = canvasMapSourceHash(source.content);
    await this.ensureDragSourceHash(projectRoot, input.canvasId, source.content, sourceHash);

    const rule = targetStat.isDirectory()
      ? `${normalizedProjectPath}/`
      : normalizedProjectPath;
    const nextContent = serializeCanvasMapWithRule(source.content, rule);
    const prepared = await this.prepareCanvasMapPush(projectRoot, {
      canvasId: input.canvasId,
      sourceContent: nextContent
    });
    await this.options.writeCanvasMapAndCanvasJson({
      projectRoot,
      sourcePath: await resolveProjectPathForWrite(projectRoot, sourcePath),
      sourceContent: nextContent,
      canvasPath: canvasPathFor(projectRoot, input.canvasId),
      canvas: prepared.nextCanvas,
      expectedSourceHash: sourceHash,
      expectedCanvasHash: prepared.currentCanvasHash
    });
    this.sourceHashByCanvasId.set(input.canvasId, prepared.sourceHash);
    return {
      canvas: prepared.nextCanvas,
      centerProjectRelativePath: normalizedProjectPath
    };
  }

  sourceHash(canvasId: string): string | undefined {
    return this.sourceHashByCanvasId.get(canvasId);
  }

  async synchronizeCanvasMaps(
    projectRoot: string,
    canvases: CanvasDocument[],
    files: ProjectFileEntry[],
    options: { writeCanvasChanges: boolean; reportDrift: boolean }
  ): Promise<SynchronizeCanvasMapsResult> {
    const diagnostics: Diagnostic[] = [];
    const synchronizedCanvasById = new Map(canvases.map((canvas) => [canvas.id, canvas]));

    for (const canvas of canvases) {
      const sourcePath = canvasMapPath(canvas.id);
      try {
        const source = await this.readCanvasMapSource(projectRoot, sourcePath);
        const prepared = await this.prepareCanvasMapForCanvas(projectRoot, {
          canvas,
          sourceContent: source.content,
          projectFiles: files
        });
        if (JSON.stringify(prepared.nextCanvas.nodeElements) !== JSON.stringify(canvas.nodeElements)) {
          if (options.writeCanvasChanges) {
            await this.options.writeCanvasMapPush({
              projectRoot,
              sourcePath: source.absolutePath,
              expectedSourceHash: prepared.sourceHash,
              canvasPath: canvasPathFor(projectRoot, canvas.id),
              canvas: prepared.nextCanvas,
              expectedCanvasHash: prepared.currentCanvasHash
            });
            synchronizedCanvasById.set(canvas.id, prepared.nextCanvas);
          } else if (options.reportDrift) {
            diagnostics.push(projectDocumentDiagnostic({
              id: `document.drift:${canvas.id}`,
              severity: 'warning',
              code: 'document_drift',
              message: `Canvas Map has changes that have not been pushed: ${sourcePath}`,
              filePath: join(projectRoot, sourcePath),
              entityId: canvas.id
            }));
          }
        }
        this.sourceHashByCanvasId.set(canvas.id, prepared.sourceHash);
      } catch (error) {
        if (!(error instanceof CanvasMapError)) {
          throw error;
        }
        diagnostics.push(canvasMapDiagnostic(projectRoot, canvas.id, sourcePath, error));
      }
    }

    return {
      canvases: canvases.map((canvas) => synchronizedCanvasById.get(canvas.id)!),
      diagnostics
    };
  }

  private async readCanvasMapSource(projectRoot: string, sourcePath: string): Promise<{ absolutePath: string; content: string }> {
    try {
      return await readProjectTextFile(projectRoot, sourcePath);
    } catch {
      throw new CanvasMapError('Canvas Map source could not be read.', 'canvas_map_read_failed');
    }
  }

  private async readCanvas(projectRoot: string, canvasId: string): Promise<CanvasDocument> {
    const canvas = (await this.options.loadCanvases(projectRoot)).find((item) => item.id === canvasId);
    if (!canvas) {
      throw new CanvasMapError(`Canvas JSON is missing: .debrute/canvases/${canvasId}.json`, 'canvas_map_canvas_missing');
    }
    return canvas;
  }

  private async prepareCanvasMapPush(
    projectRoot: string,
    input: { canvasId: string; sourceContent: string }
  ): Promise<PreparedCanvasMapPush> {
    const currentCanvas = await this.readCanvas(projectRoot, input.canvasId);
    return this.prepareCanvasMapForCanvas(projectRoot, {
      canvas: currentCanvas,
      sourceContent: input.sourceContent,
      projectFiles: await listDebruteProjectFiles(projectRoot)
    });
  }

  private async prepareCanvasMapForCanvas(
    projectRoot: string,
    input: { canvas: CanvasDocument; sourceContent: string; projectFiles: ProjectFileEntry[] }
  ): Promise<PreparedCanvasMapPush> {
    const sourcePath = canvasMapPath(input.canvas.id);
    const map = parseCanvasMap({
      canvasId: input.canvas.id,
      sourcePath,
      content: input.sourceContent
    });
    const expanded = expandCanvasMap(map, input.projectFiles);
    const prepared = await this.prepareExpandedCanvasMapProjection(projectRoot, expanded);
    return {
      sourceHash: canvasMapSourceHash(input.sourceContent),
      currentCanvasHash: this.requiredCanvasHash(projectRoot, input.canvas.id),
      currentCanvas: input.canvas,
      nextCanvas: {
        ...input.canvas,
        nodeElements: reconcileCanvasNodeElements({
          existing: input.canvas.nodeElements,
          desired: prepared.desired,
          layoutRows: prepared.layoutRows,
          layoutSizeForNode: (node) => requiredLayoutSize(prepared.layoutSizes, node.projectRelativePath)
        })
      }
    };
  }

  private async ensureDragSourceHash(
    projectRoot: string,
    canvasId: string,
    sourceContent: string,
    sourceHash: string
  ): Promise<void> {
    const previousHash = this.sourceHashByCanvasId.get(canvasId);
    if (previousHash === sourceHash) {
      return;
    }
    if (previousHash) {
      throwCanvasMapConflict();
    }
    const prepared = await this.prepareCanvasMapPush(projectRoot, {
      canvasId,
      sourceContent
    });
    if (!canvasHasExactlyPushedNodeElements(prepared.currentCanvas, prepared.nextCanvas.nodeElements)) {
      throwCanvasMapConflict();
    }
    this.sourceHashByCanvasId.set(canvasId, sourceHash);
  }

  private async prepareExpandedCanvasMapProjection(
    projectRoot: string,
    expanded: ExpandedCanvasMap
  ): Promise<{ desired: CanvasDesiredNode[]; layoutRows: CanvasDesiredLayoutRow[]; layoutSizes: Map<string, CanvasLayoutSize> }> {
    const candidates = expanded.nodes.map((node): CanvasDesiredNode => ({
      projectRelativePath: node.projectRelativePath,
      nodeKind: node.nodeKind,
      ...(node.nodeKind === 'file' ? { mediaKind: canvasMediaKindFromPath(node.projectRelativePath) } : {})
    }));
    const layoutSizes = new Map<string, CanvasLayoutSize>();
    for (const node of candidates) {
      try {
        layoutSizes.set(node.projectRelativePath, await this.options.resolveCanvasNodeLayoutSize(projectRoot, node));
      } catch (error) {
        throw new CanvasMapError(
          `Canvas Map node layout could not be read: ${node.projectRelativePath}: ${errorMessage(error)}`,
          'canvas_map_invalid_path'
        );
      }
    }
    return {
      desired: candidates,
      layoutRows: expanded.layoutRows,
      layoutSizes
    };
  }

  private requiredCanvasHash(projectRoot: string, canvasId: string): string {
    const hash = this.options.canvasDocumentHash(projectRoot, canvasId);
    if (!hash) {
      throw new CanvasMapError(`Canvas document hash is not loaded: ${canvasId}`, 'canvas_map_canvas_missing');
    }
    return hash;
  }

}

function requiredLayoutSize(layoutSizes: Map<string, CanvasLayoutSize>, projectRelativePath: string): CanvasLayoutSize {
  const size = layoutSizes.get(projectRelativePath);
  if (!size) {
    throw new Error(`Canvas node layout is missing: ${projectRelativePath}`);
  }
  return size;
}

function canvasPathFor(projectRoot: string, canvasId: string): string {
  return join(getDebruteProjectPaths(projectRoot).canvasesDir, `${canvasId}.json`);
}

function canvasMapDiagnostic(projectRoot: string, canvasId: string, sourcePath: string, error: CanvasMapError): Diagnostic {
  return projectDocumentDiagnostic({
    id: `document.invalid-source:${canvasId}`,
    severity: 'error',
    code: 'document_invalid_source',
    message: error.message,
    filePath: join(projectRoot, sourcePath),
    entityId: canvasId,
    ...(error.line !== undefined ? { line: error.line } : {}),
    ...(error.column !== undefined ? { column: error.column } : {})
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canvasHasExactlyPushedNodeElements(
  canvas: CanvasDocument,
  nextNodeElements: CanvasDocument['nodeElements']
): boolean {
  const current = canvas.nodeElements.map(canvasNodeElementSignature).sort();
  const expected = nextNodeElements.map(canvasNodeElementSignature).sort();
  return current.length === expected.length
    && current.every((signature, index) => signature === expected[index]);
}

function canvasNodeElementSignature(node: CanvasDocument['nodeElements'][number]): string {
  return [
    node.projectRelativePath,
    node.nodeKind,
    node.mediaKind ?? '',
    node.x,
    node.y,
    node.width,
    node.height,
    node.z,
    node.visible ? '1' : '0',
    node.locked ? '1' : '0',
    node.layoutMode ?? ''
  ].join('\u0000');
}

function throwCanvasMapConflict(): never {
  throw new CanvasMapError(
    'Canvas Map changed since the last successful push. Push the map, then retry.',
    'canvas_map_conflict'
  );
}
