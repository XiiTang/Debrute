import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  getDebruteProjectPaths,
  listDebruteProjectFiles,
} from '@debrute/project-core';
import {
  updateCanvasNodeLayers,
  updateCanvasNodeLayouts,
  updateCanvasTextViewportState,
  updateCanvasVideoPlaybackState,
  type CanvasDocument,
  type CanvasProjection,
  type Diagnostic
} from '@debrute/canvas-core';
import type { ProjectSessionSnapshot } from '@debrute/app-protocol';
import { projectDocumentTextHash } from '../project-documents/ProjectDocumentTransaction.js';
import { projectDocumentDiagnostic } from '../project-documents/ProjectDocumentDiagnostics.js';
import { assertCurrentCanvasDocument } from './CanvasProjectionService.js';

export interface CanvasSessionServiceOptions {
  writeCanvasText(projectRoot: string, canvasPath: string, content: string, expectedHash: string): Promise<void>;
  projectCanvasWithKnownProjection(canvas: CanvasDocument, projection: CanvasProjection): CanvasProjection;
}

export class CanvasSessionService {
  private readonly canvasHashByProjectCanvas = new Map<string, string>();

  constructor(private readonly options: CanvasSessionServiceOptions) {}

  async updateCanvasNodeLayouts(
    current: ProjectSessionSnapshot,
    input: {
      canvasId: string;
      nodeLayouts?: Array<{
        projectRelativePath: string;
        x: number;
        y: number;
        width?: number;
        height?: number;
      }>;
    }
  ): Promise<{ canvas: CanvasDocument; snapshot: ProjectSessionSnapshot; changed: boolean }> {
    return this.updateVisualCanvas(current, input.canvasId, (canvas) => updateCanvasNodeLayouts(canvas, input));
  }

  async updateCanvasNodeLayers(
    current: ProjectSessionSnapshot,
    input: {
      canvasId: string;
      nodeProjectRelativePathsTopFirst?: string[];
    }
  ): Promise<{ canvas: CanvasDocument; snapshot: ProjectSessionSnapshot; changed: boolean }> {
    return this.updateVisualCanvas(current, input.canvasId, (canvas) => updateCanvasNodeLayers(canvas, input));
  }

  async updateCanvasVideoPlaybackState(
    current: ProjectSessionSnapshot,
    input: {
      canvasId: string;
      updates: Array<{
        projectRelativePath: string;
        currentTimeSeconds: number;
      }>;
    }
  ): Promise<{ canvas: CanvasDocument; snapshot: ProjectSessionSnapshot; changed: boolean }> {
    return this.updateVisualCanvas(current, input.canvasId, (canvas) => updateCanvasVideoPlaybackState(canvas, input));
  }

  async updateCanvasTextViewportState(
    current: ProjectSessionSnapshot,
    input: {
      canvasId: string;
      updates: Array<{
        projectRelativePath: string;
        scrollTop: number;
        scrollLeft: number;
      }>;
    }
  ): Promise<{ canvas: CanvasDocument; snapshot: ProjectSessionSnapshot; changed: boolean }> {
    return this.updateVisualCanvas(current, input.canvasId, (canvas) => updateCanvasTextViewportState(canvas, input));
  }

  async writeCanvasJson(projectRoot: string, canvasPath: string, canvas: CanvasDocument, expectedHash: string): Promise<void> {
    const serialized = `${JSON.stringify(canvas, null, 2)}\n`;
    await this.options.writeCanvasText(projectRoot, canvasPath, serialized, expectedHash);
  }

  async loadCanvases(projectRoot: string): Promise<CanvasDocument[]> {
    return (await this.loadCanvasDocuments(projectRoot)).canvases;
  }

  async loadCanvasDocuments(projectRoot: string): Promise<{ canvases: CanvasDocument[]; diagnostics: Diagnostic[] }> {
    const files = await this.currentCanvasFiles(projectRoot);
    const canvases: CanvasDocument[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const file of files) {
      const canvasId = canvasFileId(file);
      try {
        const content = await readFile(file, 'utf8');
        const canvas = assertCurrentCanvasDocument(JSON.parse(content), file);
        if (canvas.id !== canvasId) {
          throw new Error(`Canvas document id must match file name: ${file}`);
        }
        this.recordCanvasDocumentTextHash(projectRoot, canvas.id, content);
        canvases.push(canvas);
      } catch (error) {
        diagnostics.push(projectDocumentDiagnostic({
          id: `document.invalid_pushed:${canvasId}`,
          severity: 'error',
          code: 'document_invalid_pushed',
          message: errorMessage(error),
          filePath: file,
          entityId: canvasId
        }));
      }
    }
    return { canvases, diagnostics };
  }

  canvasDocumentHash(projectRoot: string, canvasId: string): string | undefined {
    return this.canvasHashByProjectCanvas.get(projectCanvasKey(projectRoot, canvasId));
  }

  recordCanvasDocumentTextHash(projectRoot: string, canvasId: string, content: string): void {
    this.canvasHashByProjectCanvas.set(projectCanvasKey(projectRoot, canvasId), projectDocumentTextHash(content));
  }

  async currentCanvasFiles(projectRoot: string): Promise<string[]> {
    return (await listDebruteProjectFiles(projectRoot))
      .filter((file) => file.projectRelativePath.startsWith('.debrute/canvases/') && file.projectRelativePath.endsWith('.json'))
      .filter((file) => file.projectRelativePath !== '.debrute/canvases/index.json')
      .map((file) => join(projectRoot, file.projectRelativePath));
  }

  private async updateVisualCanvas(
    current: ProjectSessionSnapshot,
    canvasId: string,
    mutate: (canvas: CanvasDocument) => CanvasDocument
  ): Promise<{ canvas: CanvasDocument; snapshot: ProjectSessionSnapshot; changed: boolean }> {
    const existing = current.canvases.find((canvas) => canvas.id === canvasId);
    if (!existing) {
      throw new Error(`Canvas is not loaded: ${canvasId}`);
    }
    const existingProjection = current.projections.find((projection) => projection.canvasId === canvasId);
    if (!existingProjection) {
      throw new Error(`Canvas projection is not loaded: ${canvasId}`);
    }

    const paths = getDebruteProjectPaths(current.projectRoot);
    const canvasPath = join(paths.canvasesDir, `${canvasId}.json`);
    const next = mutate(existing);
    if (JSON.stringify(next) === JSON.stringify(existing)) {
      return { canvas: existing, snapshot: current, changed: false };
    }
    const expectedHash = this.canvasDocumentHash(current.projectRoot, canvasId);
    if (!expectedHash) {
      throw new Error(`Canvas document hash is not loaded: ${canvasId}`);
    }
    await this.writeCanvasJson(current.projectRoot, canvasPath, next, expectedHash);
    this.recordCanvasDocumentTextHash(current.projectRoot, canvasId, `${JSON.stringify(next, null, 2)}\n`);
    const projection = this.options.projectCanvasWithKnownProjection(next, existingProjection);
    return {
      canvas: next,
      changed: true,
      snapshot: {
        ...current,
        canvases: current.canvases.map((canvas) => canvas.id === canvasId ? next : canvas),
        projections: current.projections.map((item) => item.canvasId === canvasId ? projection : item)
      }
    };
  }
}

function canvasFileId(filePath: string): string {
  return basename(filePath, '.json');
}

function projectCanvasKey(projectRoot: string, canvasId: string): string {
  return `${projectRoot}\u0000${canvasId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
