import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  getAxisProjectPaths,
  normalizeProjectRelativePath,
  readProjectMetadata,
  readTextFile,
  resolveProjectPath
} from '@axis/project-core';
import {
  reconcileCanvasNodeElements,
  type CanvasDesiredLayoutGroup,
  type CanvasDesiredNode,
  type CanvasDocument,
  type CanvasLayoutSize,
  type CanvasStructureEdgeProjection,
  type Diagnostic
} from '@axis/canvas-core';
import {
  FlowmapError,
  activeFlowmapPath,
  assertPublishedFlowmap,
  draftFlowmapPath,
  expandFlowmap,
  inferFlowmapIdFromDraftPath,
  publishFlowmap,
  type ExpandedFlowmap
} from '@axis/flowmap-core';
import type { ProjectFileEntry } from '@axis/project-core';
import { canvasMediaKindFromPath } from '../canvas/CanvasProjectionService.js';

export interface FlowmapSessionServiceOptions {
  ensureCanvas(projectRoot: string, canvasId: string): Promise<void>;
  resolveCanvasNodeLayoutSize(projectRoot: string, node: CanvasDesiredNode): Promise<CanvasLayoutSize>;
  writeCanvasJson(canvasPath: string, canvas: CanvasDocument): Promise<void>;
  suppressInternalProjectPathEvent(absolutePath: string, content?: string): void;
  clearInternalProjectPathEvent(absolutePath: string): void;
}

export class FlowmapSessionService {
  constructor(private readonly options: FlowmapSessionServiceOptions) {}

  async publishFlowmapDraftForProject(projectRoot: string, input: { sourceDraftPath: string }): Promise<{ ok: true; command: 'flowmap.publish' }> {
    await readProjectMetadata(projectRoot);
    const flowmapId = inferFlowmapIdFromDraftPath(input.sourceDraftPath);
    const expectedDraftPath = draftFlowmapPath(flowmapId);
    if (normalizeProjectRelativePath(input.sourceDraftPath) !== expectedDraftPath) {
      throw new FlowmapError(`Flowmap draft path must be "${expectedDraftPath}".`, 'flowmap_invalid_draft_path');
    }
    const draftPath = resolveProjectPath(projectRoot, expectedDraftPath);
    const activePath = resolveProjectPath(projectRoot, activeFlowmapPath(flowmapId));
    let draftYaml: string;
    try {
      draftYaml = await readTextFile(draftPath);
    } catch {
      throw new FlowmapError('Flowmap draft could not be read.', 'flowmap_draft_read_failed');
    }
    const published = publishFlowmap({
      sourceDraftPath: expectedDraftPath,
      content: draftYaml
    });
    const publishedRootPath = resolveProjectPath(projectRoot, published.rootProjectRelativePath);
    this.options.suppressInternalProjectPathEvent(publishedRootPath);
    await mkdir(publishedRootPath, { recursive: true });
    for (const canvasId of published.canvasIds) {
      await this.options.ensureCanvas(projectRoot, canvasId);
    }
    await this.writeInternalFlowmapTextFile(activePath, published.yaml);
    return { ok: true, command: 'flowmap.publish' };
  }

  async synchronizeFlowmaps(
    projectRoot: string,
    canvases: CanvasDocument[],
    files: ProjectFileEntry[],
    options: { writeCanvasChanges: boolean }
  ): Promise<{ diagnostics: Diagnostic[]; canvases: CanvasDocument[]; structureEdgesByCanvasId: Map<string, CanvasStructureEdgeProjection[]> }> {
    const diagnostics: Diagnostic[] = [];
    const paths = getAxisProjectPaths(projectRoot);
    const activeFlowmaps = files.filter((file) => file.kind === 'file'
      && file.projectRelativePath.startsWith('.axis/flowmaps/')
      && file.projectRelativePath.endsWith('.yaml')
      && !file.projectRelativePath.endsWith('.draft.yaml'));
    const synchronizedCanvasById = new Map(canvases.map((canvas) => [canvas.id, canvas]));
    const desiredByCanvasId = new Map<string, CanvasDesiredNode[]>();
    const structureEdgesByCanvasId = new Map<string, CanvasStructureEdgeProjection[]>();
    const layoutSizesByCanvasId = new Map<string, Map<string, CanvasLayoutSize>>();
    const layoutGroupsByCanvasId = new Map<string, CanvasDesiredLayoutGroup[]>();
    const blockedCanvasIds = new Set<string>();

    for (const file of activeFlowmaps) {
      const flowmapId = basename(file.projectRelativePath, '.yaml');
      const activePath = join(projectRoot, file.projectRelativePath);
      const integrity = assertPublishedFlowmap(await readTextFile(activePath), file.projectRelativePath);
      if (!integrity.ok || !integrity.map) {
        diagnostics.push({
          id: `flowmap.invalid:${flowmapId}`,
          source: 'flowmap',
          severity: 'error',
          code: integrity.error?.code ?? 'flowmap_invalid',
          message: integrity.error?.message ?? 'Invalid Flowmap.',
          filePath: activePath,
          ...(integrity.error?.line !== undefined ? { line: integrity.error.line } : {}),
          ...(integrity.error?.column !== undefined ? { column: integrity.error.column } : {})
        });
        continue;
      }
      const flowmap = integrity.map;
      if (!files.some((entry) => entry.kind === 'directory' && entry.projectRelativePath === flowmap.flowmapId)) {
        diagnostics.push({
          id: `flowmap.root.missing:${flowmapId}`,
          source: 'flowmap',
          severity: 'error',
          code: 'flowmap_root_missing',
          message: `Flowmap root directory is missing: ${flowmap.flowmapId}`,
          filePath: activePath
        });
        continue;
      }
      const expanded = expandFlowmap(flowmap, files);
      if (expanded.layoutGroupErrors.length > 0) {
        for (const error of expanded.layoutGroupErrors) {
          diagnostics.push({
            id: `flowmap.layout_group.duplicate:${flowmapId}:${error.projectRelativePath}`,
            source: 'flowmap',
            severity: 'error',
            code: error.code,
            message: error.message,
            filePath: resolveProjectPath(projectRoot, error.projectRelativePath),
            entityId: error.projectRelativePath
          });
        }
        for (const canvasId of flowmap.canvases) {
          blockedCanvasIds.add(canvasId);
        }
        continue;
      }
      const prepared = await this.prepareExpandedFlowmapProjection(projectRoot, expanded, diagnostics);
      for (const canvasId of flowmap.canvases) {
        if (!synchronizedCanvasById.has(canvasId)) {
          diagnostics.push({
            id: `flowmap.canvas.missing:${flowmapId}:${canvasId}`,
            source: 'flowmap',
            severity: 'error',
            code: 'flowmap_canvas_missing',
            message: `Canvas JSON is missing: .axis/canvases/${canvasId}.json`,
            filePath: activePath
          });
          continue;
        }
        desiredByCanvasId.set(canvasId, [
          ...(desiredByCanvasId.get(canvasId) ?? []),
          ...prepared.desired
        ]);
        structureEdgesByCanvasId.set(canvasId, [
          ...(structureEdgesByCanvasId.get(canvasId) ?? []),
          ...prepared.edges
        ]);
        const canvasLayoutSizes = layoutSizesByCanvasId.get(canvasId) ?? new Map<string, CanvasLayoutSize>();
        for (const [projectRelativePath, size] of prepared.layoutSizes) {
          canvasLayoutSizes.set(projectRelativePath, size);
        }
        layoutSizesByCanvasId.set(canvasId, canvasLayoutSizes);
        layoutGroupsByCanvasId.set(canvasId, [
          ...(layoutGroupsByCanvasId.get(canvasId) ?? []),
          ...prepared.layoutGroups
        ]);
      }
    }

    for (const canvas of canvases) {
      if (blockedCanvasIds.has(canvas.id)) {
        synchronizedCanvasById.set(canvas.id, canvas);
        continue;
      }
      const desired = uniqueDesiredNodes(desiredByCanvasId.get(canvas.id) ?? []);
      const layoutSizes = layoutSizesByCanvasId.get(canvas.id) ?? new Map<string, CanvasLayoutSize>();
      const layoutGroups = layoutGroupsByCanvasId.get(canvas.id) ?? [];
      const nextNodes = reconcileCanvasNodeElements({
        existing: canvas.nodeElements,
        desired,
        layoutGroups,
        layoutSizeForNode: (node) => requiredLayoutSize(layoutSizes, node.projectRelativePath)
      });
      if (JSON.stringify(nextNodes) !== JSON.stringify(canvas.nodeElements)) {
        const nextCanvas = { ...canvas, nodeElements: nextNodes };
        if (options.writeCanvasChanges) {
          const canvasPath = join(paths.canvasesDir, `${canvas.id}.json`);
          await this.options.writeCanvasJson(canvasPath, nextCanvas);
        }
        synchronizedCanvasById.set(canvas.id, nextCanvas);
      }
    }

    return {
      diagnostics,
      canvases: canvases.map((canvas) => synchronizedCanvasById.get(canvas.id)!),
      structureEdgesByCanvasId
    };
  }

  private async prepareExpandedFlowmapProjection(
    projectRoot: string,
    expanded: ExpandedFlowmap,
    diagnostics: Diagnostic[]
  ): Promise<{
    desired: CanvasDesiredNode[];
    edges: CanvasStructureEdgeProjection[];
    layoutSizes: Map<string, CanvasLayoutSize>;
    layoutGroups: CanvasDesiredLayoutGroup[];
  }> {
    const candidates = expanded.nodes.map((node): CanvasDesiredNode => ({
      projectRelativePath: node.projectRelativePath,
      nodeKind: node.nodeKind,
      ...(node.nodeKind === 'file' ? { mediaKind: canvasMediaKindFromPath(node.projectRelativePath) } : {})
    }));
    const layoutSizes = new Map<string, CanvasLayoutSize>();
    const readableNodes: CanvasDesiredNode[] = [];
    for (const node of candidates) {
      if (node.mediaKind === 'image' || node.mediaKind === 'video') {
        try {
          layoutSizes.set(node.projectRelativePath, await this.options.resolveCanvasNodeLayoutSize(projectRoot, node));
          readableNodes.push(node);
        } catch (error) {
          diagnostics.push({
            id: `flowmap.node.layout_unreadable:${expanded.flowmapId}:${node.projectRelativePath}`,
            source: 'flowmap',
            severity: 'error',
            code: 'flowmap_node_layout_unreadable',
            message: `Flowmap node layout could not be read: ${node.projectRelativePath}: ${errorMessage(error)}`,
            filePath: resolveProjectPath(projectRoot, node.projectRelativePath)
          });
        }
        continue;
      }
      layoutSizes.set(node.projectRelativePath, await this.options.resolveCanvasNodeLayoutSize(projectRoot, node));
      readableNodes.push(node);
    }
    const desired = pruneDesiredNodesWithoutReadableFiles(readableNodes);
    const desiredPaths = new Set(desired.map((node) => node.projectRelativePath));
    return {
      desired,
      edges: expanded.edges.filter((edge) => desiredPaths.has(edge.sourceProjectRelativePath) && desiredPaths.has(edge.targetProjectRelativePath)),
      layoutSizes,
      layoutGroups: expanded.layoutGroups
        .map((group) => ({
          parentProjectRelativePath: group.parentProjectRelativePath,
          memberProjectRelativePaths: group.memberProjectRelativePaths.filter((path) => desiredPaths.has(path))
        }))
        .filter((group) => desiredPaths.has(group.parentProjectRelativePath) && group.memberProjectRelativePaths.length > 0)
    };
  }

  private async writeInternalFlowmapTextFile(absolutePath: string, content: string): Promise<void> {
    this.options.suppressInternalProjectPathEvent(absolutePath, content);
    try {
      await writeFlowmapTextFile(absolutePath, content);
    } catch (error) {
      this.options.clearInternalProjectPathEvent(absolutePath);
      throw error;
    }
  }
}

async function writeFlowmapTextFile(absolutePath: string, content: string): Promise<void> {
  let staged: Awaited<ReturnType<typeof stageFileAtomicText>> | undefined;
  try {
    staged = await stageFileAtomicText(absolutePath, content);
    await staged.commit();
  } catch (error) {
    if (staged) {
      await staged.cleanup();
    }
    throw new FlowmapError(`Flowmap file could not be written: ${errorMessage(error)}`, 'flowmap_write_failed');
  }
}

async function stageFileAtomicText(absolutePath: string, content: string): Promise<{ commit: () => Promise<void>; cleanup: () => Promise<void> }> {
  await mkdir(dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  return {
    commit: () => rename(tempPath, absolutePath),
    cleanup: () => rm(tempPath, { force: true })
  };
}

function uniqueDesiredNodes(nodes: CanvasDesiredNode[]): CanvasDesiredNode[] {
  return [...new Map(nodes.map((node) => [node.projectRelativePath, node])).values()];
}

function pruneDesiredNodesWithoutReadableFiles(nodes: CanvasDesiredNode[]): CanvasDesiredNode[] {
  const readableFilePaths = nodes
    .filter((node) => node.nodeKind === 'file')
    .map((node) => node.projectRelativePath);
  if (readableFilePaths.length === 0) {
    return [];
  }
  return nodes.filter((node) => node.nodeKind === 'file'
    || readableFilePaths.some((filePath) => filePath.startsWith(`${node.projectRelativePath}/`)));
}

function requiredLayoutSize(layoutSizes: Map<string, CanvasLayoutSize>, projectRelativePath: string): CanvasLayoutSize {
  const size = layoutSizes.get(projectRelativePath);
  if (!size) {
    throw new Error(`Canvas node layout is missing: ${projectRelativePath}`);
  }
  return size;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
