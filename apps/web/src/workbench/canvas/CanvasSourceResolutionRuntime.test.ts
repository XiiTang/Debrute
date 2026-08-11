import { describe, expect, it, vi } from 'vitest';
import type { CanvasProjection, ProjectedCanvasNode } from './CanvasScene';
import { createCanvasSourceResolutionRuntime } from './CanvasSourceResolutionRuntime';
import { createCanvasEditorRuntime } from './runtime/CanvasEditorRuntime';

function resolvingNode(path: string, x: number): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    displayName: path,
    nodeKind: 'file',
    mediaKind: 'image',
    x,
    y: 0,
    width: 200,
    height: 120,
    z: 0,
    availability: {
      state: 'resolving',
      size: 4,
      mimeType: 'image/png',
      sourceToken: `source-${path}`
    }
  };
}

function resolvedSource(node: ProjectedCanvasNode) {
  if (node.availability.state !== 'resolving') {
    throw new Error('Expected a resolving node.');
  }
  return {
    sourceToken: node.availability.sourceToken,
    projectRelativePath: node.projectRelativePath,
    availability: {
      state: 'available' as const,
      size: 4,
      mimeType: 'image/png',
      fileUrl: `/raw/${node.projectRelativePath}`,
      revision: `sha256:${node.projectRelativePath}`
    }
  };
}

describe('CanvasSourceResolutionRuntime', () => {
  it('publishes each settled source only to that Project path while preserving geometry', async () => {
    const [a, b, stable] = [
      resolvingNode('flow/a.png', 10),
      resolvingNode('flow/b.png', 20),
      { ...resolvingNode('flow/stable.png', 30), mediaKind: 'unknown' as const }
    ];
    const projection: CanvasProjection = { nodes: [a, b, stable], edges: [] };
    const editor = createCanvasEditorRuntime({
      initialProjection: projection,
      submitManualLayout: async () => undefined
    });
    const resolveCanvasSources = vi.fn(async (request: {
      targets: Array<{ projectRelativePath: string; sourceToken: string }>;
    }) => ({
      sources: request.targets.map(({ projectRelativePath }) => (
        resolvedSource(projectRelativePath === a.projectRelativePath ? a : b)
      ))
    }));
    const runtime = createCanvasSourceResolutionRuntime({
      runtime: editor,
      resolveCanvasSources,
      distanceSquaredForNode: () => 0
    });
    const aListener = vi.fn();
    const bListener = vi.fn();
    const stableListener = vi.fn();
    const detach = runtime.attach();

    runtime.getNodeSnapshot(a);
    runtime.getNodeSnapshot(b);
    runtime.getNodeSnapshot(stable);
    const unsubscribeA = runtime.subscribeNode(a, aListener);
    const unsubscribeB = runtime.subscribeNode(b, bListener);
    const unsubscribeStable = runtime.subscribeNode(stable, stableListener);
    runtime.acceptProjection(projection);

    await vi.waitFor(() => expect(resolveCanvasSources).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(resolveCanvasSources).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(aListener).toHaveBeenCalledTimes(1));
    expect(bListener).toHaveBeenCalledTimes(1);
    expect(stableListener).not.toHaveBeenCalled();
    expect(runtime.getNodeSnapshot(a)).toMatchObject({
      x: 10,
      availability: { state: 'available', revision: 'sha256:flow/a.png' }
    });

    unsubscribeA();
    unsubscribeB();
    unsubscribeStable();
    detach();
    editor.dispose();
  });

  it('ignores a settlement after the source token changes', async () => {
    const node = resolvingNode('flow/a.png', 10);
    const projection: CanvasProjection = { nodes: [node], edges: [] };
    const editor = createCanvasEditorRuntime({
      initialProjection: projection,
      submitManualLayout: async () => undefined
    });
    let settle!: (value: { sources: ReturnType<typeof resolvedSource>[] }) => void;
    const resolveCanvasSources = vi.fn(() => new Promise<{ sources: ReturnType<typeof resolvedSource>[] }>((resolve) => {
      settle = resolve;
    }));
    const runtime = createCanvasSourceResolutionRuntime({
      runtime: editor,
      resolveCanvasSources,
      distanceSquaredForNode: () => 0
    });
    const detach = runtime.attach();
    runtime.acceptProjection(projection);
    await vi.waitFor(() => expect(resolveCanvasSources).toHaveBeenCalledTimes(1));

    const replacement = {
      ...node,
      availability: { ...node.availability, sourceToken: 'replacement-token' }
    };
    runtime.acceptProjection({ nodes: [replacement], edges: [] });
    settle({ sources: [resolvedSource(node)] });
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.getNodeSnapshot(replacement)).toBe(replacement);
    detach();
    editor.dispose();
  });

  it('uses the exact Project path tie-break for equal-distance sources', async () => {
    const composed = resolvingNode('flow/caf\u00e9.png', 10);
    const decomposed = resolvingNode('flow/cafe\u0301.png', 20);
    const projection: CanvasProjection = { nodes: [composed, decomposed], edges: [] };
    const editor = createCanvasEditorRuntime({
      initialProjection: projection,
      submitManualLayout: async () => undefined
    });
    const resolveCanvasSources = vi.fn(async (request: {
      targets: Array<{ projectRelativePath: string; sourceToken: string }>;
    }) => ({
      sources: request.targets.map(({ projectRelativePath }) => (
        resolvedSource(projectRelativePath === composed.projectRelativePath ? composed : decomposed)
      ))
    }));
    const runtime = createCanvasSourceResolutionRuntime({
      runtime: editor,
      resolveCanvasSources,
      distanceSquaredForNode: () => 0
    });
    const detach = runtime.attach();
    runtime.acceptProjection(projection);
    await vi.waitFor(() => expect(resolveCanvasSources).toHaveBeenCalledTimes(2));
    expect(resolveCanvasSources.mock.calls.map(([request]) => request.targets[0]?.projectRelativePath)).toEqual([
      decomposed.projectRelativePath,
      composed.projectRelativePath
    ]);

    detach();
    editor.dispose();
  });

  it('resolves a hidden Feedback video through the same source lane', async () => {
    const projection: CanvasProjection = { nodes: [], edges: [] };
    const projectRelativePath = 'archive/clip.mkv';
    const resource = {
      projectRelativePath,
      nodeKind: 'file' as const,
      mediaKind: 'video' as const,
      availability: {
        state: 'resolving' as const,
        size: 8,
        mimeType: 'video/x-matroska',
        sourceToken: 'source-hidden-video'
      }
    };
    const editor = createCanvasEditorRuntime({
      initialProjection: projection,
      submitManualLayout: async () => undefined
    });
    const resolveCanvasSources = vi.fn(async () => ({
      sources: [{
        sourceToken: 'source-hidden-video',
        projectRelativePath,
        availability: {
          state: 'available' as const,
          size: 8,
          mimeType: 'video/x-matroska',
          fileUrl: `/raw/${projectRelativePath}`,
          revision: 'sha256:hidden-video'
        }
      }]
    }));
    const runtime = createCanvasSourceResolutionRuntime({
      runtime: editor,
      resolveCanvasSources,
      distanceSquaredForNode: () => Number.POSITIVE_INFINITY
    });
    const sourceListener = vi.fn();
    const unsubscribe = runtime.subscribeSources(sourceListener);
    const detach = runtime.attach();

    runtime.acceptProjection(projection, [resource]);

    await vi.waitFor(() => expect(resolveCanvasSources).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(runtime.getResolvedSource(projectRelativePath)).toMatchObject({
      availability: { state: 'available', revision: 'sha256:hidden-video' }
    }));
    expect(sourceListener).toHaveBeenCalled();
    unsubscribe();
    detach();
    editor.dispose();
  });
});
