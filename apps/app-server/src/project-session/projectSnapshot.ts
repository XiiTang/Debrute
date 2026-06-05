import {
  getDebruteProjectPaths,
  listDebruteProjectFiles,
  readProjectMetadata,
  type ProjectFileEntry
} from '@debrute/project-core';
import type {
  CanvasDocument,
  CanvasProjection,
  CanvasStructureEdgeProjection,
  Diagnostic
} from '@debrute/canvas-core';
import type { ProjectSessionSnapshot } from '@debrute/app-protocol';
import { createProjectHealthSummary } from './projectHealth.js';

export interface LoadProjectSnapshotInput {
  projectRoot: string;
  writeFlowmapCanvasChanges?: boolean;
  loadCanvases(projectRoot: string): Promise<CanvasDocument[]>;
  synchronizeFlowmaps(
    projectRoot: string,
    canvases: CanvasDocument[],
    files: ProjectFileEntry[],
    options: { writeCanvasChanges: boolean }
  ): Promise<{ diagnostics: Diagnostic[]; canvases: CanvasDocument[]; structureEdgesByCanvasId: Map<string, CanvasStructureEdgeProjection[]> }>;
  projectCanvasDocument(
    projectRoot: string,
    canvas: CanvasDocument,
    diagnostics?: Diagnostic[],
    structureEdges?: CanvasStructureEdgeProjection[]
  ): Promise<CanvasProjection>;
}

export async function loadProjectSnapshot(input: LoadProjectSnapshotInput): Promise<ProjectSessionSnapshot> {
  const paths = getDebruteProjectPaths(input.projectRoot);
  const metadata = await readProjectMetadata(input.projectRoot);
  const files = await listDebruteProjectFiles(input.projectRoot);
  const canvases = await input.loadCanvases(input.projectRoot);
  const synchronized = await input.synchronizeFlowmaps(input.projectRoot, canvases, files, {
    writeCanvasChanges: input.writeFlowmapCanvasChanges ?? true
  });
  const projections = await Promise.all(synchronized.canvases.map((canvas) => input.projectCanvasDocument(
    input.projectRoot,
    canvas,
    synchronized.diagnostics,
    synchronized.structureEdgesByCanvasId.get(canvas.id) ?? []
  )));
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
    health: createProjectHealthSummary({
      metadata,
      canvasCount: synchronized.canvases.length,
      diagnostics,
      runtimeDataLocation: paths.globalRuntimeDir,
      checkedAt: new Date().toISOString()
    })
  };
}

function uniqueDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...new Map(diagnostics.map((diagnostic) => [diagnostic.id, diagnostic])).values()];
}
