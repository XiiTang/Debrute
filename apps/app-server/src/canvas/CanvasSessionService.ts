import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getAxisProjectPaths,
  listAxisProjectFiles,
  readJsonFile,
  writeJsonAtomic
} from '@axis/project-core';
import {
  createCanvasDocument,
  setCanvasSelection,
  setCanvasViewport,
  updateCanvasNodeLayers,
  updateCanvasNodeLayouts,
  type CanvasDocument,
  type CanvasNodeLayerPatch,
  type CanvasProjection,
  type CanvasSelection,
  type CanvasViewport
} from '@axis/canvas-core';
import type { ProjectSessionSnapshot } from '@axis/app-protocol';
import { assertCurrentCanvasDocument } from './CanvasProjectionService.js';

export interface CanvasSessionServiceOptions {
  suppressInternalProjectPathEvent(absolutePath: string, content?: string): void;
  clearInternalProjectPathEvent(absolutePath: string): void;
  projectCanvasWithKnownAvailability(canvas: CanvasDocument, projection: CanvasProjection): CanvasProjection;
}

export class CanvasSessionService {
  constructor(private readonly options: CanvasSessionServiceOptions) {}

  async updateCanvasViewport(
    current: ProjectSessionSnapshot,
    canvasId: string,
    viewport: CanvasViewport
  ): Promise<{ canvas: CanvasDocument; snapshot: ProjectSessionSnapshot; changed: boolean }> {
    return this.updateVisualCanvas(current, canvasId, (canvas) => setCanvasViewport(canvas, viewport));
  }

  async updateCanvasSelection(
    current: ProjectSessionSnapshot,
    canvasId: string,
    selection: CanvasSelection | undefined
  ): Promise<{ canvas: CanvasDocument; snapshot: ProjectSessionSnapshot; changed: boolean }> {
    return this.updateVisualCanvas(current, canvasId, (canvas) => setCanvasSelection(canvas, selection));
  }

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
      nodeLayers?: CanvasNodeLayerPatch[];
      nodeProjectRelativePathsTopFirst?: string[];
    }
  ): Promise<{ canvas: CanvasDocument; snapshot: ProjectSessionSnapshot; changed: boolean }> {
    return this.updateVisualCanvas(current, input.canvasId, (canvas) => updateCanvasNodeLayers(canvas, input));
  }

  async writeCanvasJson(canvasPath: string, canvas: CanvasDocument): Promise<void> {
    const serialized = `${JSON.stringify(canvas, null, 2)}\n`;
    this.options.suppressInternalProjectPathEvent(canvasPath, serialized);
    await writeJsonAtomic(canvasPath, canvas);
  }

  async ensureDefaultCanvas(projectRoot: string): Promise<void> {
    const paths = getAxisProjectPaths(projectRoot);
    await mkdir(paths.canvasesDir, { recursive: true });
    const existingCanvasFiles = await this.currentCanvasFiles(projectRoot);
    if (existingCanvasFiles.length > 0) {
      return;
    }

    const canvas = createCanvasDocument({
      id: 'production-map',
      title: 'Production Map'
    });
    await writeJsonAtomic(join(paths.canvasesDir, `${canvas.id}.json`), canvas);
  }

  async ensureCanvas(projectRoot: string, canvasId: string, fileExists: (absolutePath: string) => Promise<boolean>): Promise<void> {
    const paths = getAxisProjectPaths(projectRoot);
    await mkdir(paths.canvasesDir, { recursive: true });
    const canvasPath = join(paths.canvasesDir, `${canvasId}.json`);
    if (await fileExists(canvasPath)) {
      return;
    }
    await writeJsonAtomic(canvasPath, createCanvasDocument({ id: canvasId, title: canvasId }));
  }

  async loadCanvases(projectRoot: string): Promise<CanvasDocument[]> {
    const files = await this.currentCanvasFiles(projectRoot);
    const canvases: CanvasDocument[] = [];
    for (const file of files) {
      canvases.push(assertCurrentCanvasDocument(await readJsonFile<unknown>(file), file));
    }
    return canvases;
  }

  async currentCanvasFiles(projectRoot: string): Promise<string[]> {
    return (await listAxisProjectFiles(projectRoot))
      .filter((file) => file.projectRelativePath.startsWith('.axis/canvases/') && file.projectRelativePath.endsWith('.json'))
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

    const paths = getAxisProjectPaths(current.projectRoot);
    const canvasPath = join(paths.canvasesDir, `${canvasId}.json`);
    const next = mutate(existing);
    if (JSON.stringify(next) === JSON.stringify(existing)) {
      return { canvas: existing, snapshot: current, changed: false };
    }
    try {
      await this.writeCanvasJson(canvasPath, next);
    } catch (error) {
      this.options.clearInternalProjectPathEvent(canvasPath);
      throw error;
    }
    const projection = this.options.projectCanvasWithKnownAvailability(next, existingProjection);
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
