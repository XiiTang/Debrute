import {
  getDebruteProjectPaths,
  listDebruteProjectFiles,
  readProjectMetadata,
  type ProjectFileEntry
} from '@debrute/project-core';
import type {
  CanvasDocument,
  CanvasProjection,
  Diagnostic
} from '@debrute/canvas-core';
import type { ProjectSessionSnapshot } from '@debrute/app-protocol';
import { createProjectHealthSummary } from './projectHealth.js';

export interface LoadProjectSnapshotInput {
  projectRoot: string;
  loadOrderedCanvases(projectRoot: string): Promise<{
    canvases: CanvasDocument[];
    registry: ProjectSessionSnapshot['canvasRegistry'];
  }>;
  synchronizeCanvasMaps(
    projectRoot: string,
    canvases: CanvasDocument[],
    files: ProjectFileEntry[],
    options: { writeCanvasChanges: boolean }
  ): Promise<{ canvases: CanvasDocument[]; diagnostics: Diagnostic[] }>;
  writeCanvasMapChanges?: boolean;
  projectCanvasDocument(
    projectRoot: string,
    canvas: CanvasDocument,
    diagnostics?: Diagnostic[]
  ): Promise<CanvasProjection>;
}

export async function loadProjectSnapshot(input: LoadProjectSnapshotInput): Promise<ProjectSessionSnapshot> {
  const paths = getDebruteProjectPaths(input.projectRoot);
  const metadata = await readProjectMetadata(input.projectRoot);
  const files = await listDebruteProjectFiles(input.projectRoot);
  const { canvases, registry } = await input.loadOrderedCanvases(input.projectRoot);
  const synchronized = registry.status === 'ready'
    ? await input.synchronizeCanvasMaps(input.projectRoot, canvases, files, {
        writeCanvasChanges: input.writeCanvasMapChanges ?? true
      })
    : { canvases, diagnostics: [] };
  const projections = registry.status === 'ready'
    ? await Promise.all(synchronized.canvases.map((canvas) => input.projectCanvasDocument(
        input.projectRoot,
        canvas,
        synchronized.diagnostics
      )))
    : [];
  const diagnostics = uniqueDiagnostics([
    ...synchronized.diagnostics,
    ...projections.flatMap((projection) => projection.diagnostics)
  ]);

  return {
    projectRoot: input.projectRoot,
    metadata,
    files,
    canvases: synchronized.canvases,
    projections,
    diagnostics,
    canvasRegistry: registry,
    health: createProjectHealthSummary({
      metadata,
      canvasCount: canvases.length,
      diagnostics,
      runtimeDataLocation: paths.globalRuntimeDir,
      checkedAt: new Date().toISOString()
    })
  };
}

function uniqueDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...new Map(diagnostics.map((diagnostic) => [diagnostic.id, diagnostic])).values()];
}
