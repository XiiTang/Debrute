import type {
  CanvasResourceView,
  CanvasState,
  WorkbenchApiClient
} from '@debrute/app-protocol';
import { describe, expect, it } from 'vitest';
import type { WorkbenchProjectProjectionState } from '../services/WorkbenchProjectProjection.js';
import { createCanvasOcclusionOrderWrites } from './CanvasOcclusionOrderWrites.js';

type CanvasStatePatch = Parameters<WorkbenchApiClient['patchCanvasState']>[0];
type BoundProject = Extract<WorkbenchProjectProjectionState, { status: 'bound' }>;

describe('Canvas Occlusion Order Writes', () => {
  it('commits final rectangles and the selection-raised order after moving into overlap', async () => {
    const state = canvasState({
      'a.png': { x: 5_000, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_200, y: 0, width: 100, height: 100 }
    });
    const patches: CanvasStatePatch[] = [];
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async (patch) => {
        patches.push(patch);
      }
    });

    await writes.commitManualLayouts({
      selectedProjectRelativePaths: ['a.png'],
      nodeLayouts: [{
        projectRelativePath: 'a.png',
        x: 5_150,
        y: 0,
        width: 100,
        height: 100
      }]
    });

    expect(patches).toEqual([{
      nodeStateUpdates: [{
        projectRelativePath: 'a.png',
        manualLayout: { x: 5_150, y: 0, width: 100, height: 100 }
      }],
      occlusionOrder: ['b.png', 'a.png']
    }]);
  });

  it('atomically removes stale overlap order when final rectangles no longer overlap', async () => {
    const state = canvasState({
      'a.png': { x: 5_150, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_200, y: 0, width: 100, height: 100 }
    }, ['b.png', 'a.png']);
    const patches: CanvasStatePatch[] = [];
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async (patch) => {
        patches.push(patch);
      }
    });

    await writes.commitManualLayouts({
      selectedProjectRelativePaths: ['a.png'],
      nodeLayouts: [{
        projectRelativePath: 'a.png',
        x: 5_000,
        y: 0,
        width: 100,
        height: 100
      }]
    });

    expect(patches).toEqual([{
      nodeStateUpdates: [{
        projectRelativePath: 'a.png',
        manualLayout: { x: 5_000, y: 0, width: 100, height: 100 }
      }],
      occlusionOrder: []
    }]);
  });

  it('persists a selection raise even when submitted geometry is unchanged', async () => {
    const state = canvasState({
      'a.png': { x: 5_000, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_050, y: 0, width: 100, height: 100 }
    }, ['a.png', 'b.png']);
    const patches: CanvasStatePatch[] = [];
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async (patch) => {
        patches.push(patch);
      }
    });

    await writes.commitManualLayouts({
      selectedProjectRelativePaths: ['a.png'],
      nodeLayouts: [{
        projectRelativePath: 'a.png',
        x: 5_000,
        y: 0,
        width: 100,
        height: 100
      }]
    });

    expect(patches).toEqual([{ occlusionOrder: ['b.png', 'a.png'] }]);
  });

  it('raises selection by stable-partitioning the latest confirmed order', async () => {
    const state = canvasState({
      'a.png': { x: 5_000, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_050, y: 0, width: 100, height: 100 }
    }, ['a.png', 'b.png']);
    const patches: CanvasStatePatch[] = [];
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async (patch) => {
        patches.push(patch);
      }
    });

    await writes.raiseSelection(['a.png']);

    expect(patches).toEqual([{ occlusionOrder: ['b.png', 'a.png'] }]);
  });

  it('resets every latest manual rectangle, including hidden node state, in one patch', async () => {
    const state = canvasState({
      'a.png': { x: 5_000, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_050, y: 0, width: 100, height: 100 },
      'hidden.png': { x: 5_000, y: 0, width: 100, height: 100 }
    }, ['a.png', 'b.png']);
    const patches: CanvasStatePatch[] = [];
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async (patch) => {
        patches.push(patch);
      }
    });

    await writes.resetManualLayouts({ all: true });

    expect(patches).toEqual([{
      nodeStateUpdates: [
        { projectRelativePath: 'a.png', manualLayout: null },
        { projectRelativePath: 'b.png', manualLayout: null },
        { projectRelativePath: 'hidden.png', manualLayout: null }
      ],
      occlusionOrder: []
    }]);
  });

  it('resets only requested paths that still have Manual Layout', async () => {
    const state = canvasState({
      'a.png': { x: 5_000, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_050, y: 0, width: 100, height: 100 }
    }, ['a.png', 'b.png']);
    const patches: CanvasStatePatch[] = [];
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async (patch) => {
        patches.push(patch);
      }
    });

    await writes.resetManualLayouts({
      nodePaths: ['a.png', 'missing.png']
    });

    expect(patches).toEqual([{
      nodeStateUpdates: [
        { projectRelativePath: 'a.png', manualLayout: null }
      ],
      occlusionOrder: []
    }]);
  });

  it('raises only newly visible paths that still belong to the latest scene', async () => {
    const state = canvasState({
      'a.png': { x: 5_000, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_050, y: 0, width: 100, height: 100 }
    }, ['a.png', 'b.png']);
    const patches: CanvasStatePatch[] = [];
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async (patch) => {
        patches.push(patch);
      }
    });

    await writes.reconcileVisibility(['missing.png', 'a.png']);

    expect(patches).toEqual([{ occlusionOrder: ['b.png', 'a.png'] }]);
  });

  it('cleans stale overlap order even when no path became visible', async () => {
    const state = canvasState({
      'a.png': { x: 5_000, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_200, y: 0, width: 100, height: 100 }
    }, ['a.png', 'b.png']);
    const patches: CanvasStatePatch[] = [];
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async (patch) => {
        patches.push(patch);
      }
    });

    await writes.reconcileVisibility([]);

    expect(patches).toEqual([{ occlusionOrder: [] }]);
  });

  it('serializes writes and derives each intent from the preceding confirmed state', async () => {
    let state = canvasState({
      'a.png': { x: 5_000, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_050, y: 0, width: 100, height: 100 }
    }, ['a.png', 'b.png']);
    const firstWrite = deferred<void>();
    const patches: CanvasStatePatch[] = [];
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async (patch) => {
        patches.push(patch);
        state = stateWithPatch(state, patch);
        if (patches.length === 1) {
          await firstWrite.promise;
        }
      }
    });

    const first = writes.raiseSelection(['a.png']);
    const second = writes.raiseSelection(['b.png']);
    await Promise.resolve();
    await Promise.resolve();
    expect(patches).toEqual([{ occlusionOrder: ['b.png', 'a.png'] }]);

    firstWrite.resolve();
    await Promise.all([first, second]);
    expect(patches).toEqual([
      { occlusionOrder: ['b.png', 'a.png'] },
      { occlusionOrder: ['a.png', 'b.png'] }
    ]);
  });

  it('reports one failed write without blocking the next queued intent', async () => {
    const state = canvasState({
      'a.png': { x: 5_000, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_050, y: 0, width: 100, height: 100 }
    }, ['a.png', 'b.png']);
    let attempts = 0;
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('write failed');
        }
      }
    });

    const failed = writes.raiseSelection(['a.png']);
    const succeeded = writes.raiseSelection(['a.png']);

    await expect(failed).rejects.toThrow('write failed');
    await expect(succeeded).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('rejects an intent from a retired Project generation without writing', async () => {
    const patches: CanvasStatePatch[] = [];
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(
        canvasState({}, []),
        2
      ),
      patchCanvasState: async (patch) => {
        patches.push(patch);
      }
    });

    await expect(writes.raiseSelection(['a.png']))
      .rejects.toThrow('Canvas mutation belongs to an inactive Project.');
    expect(patches).toEqual([]);
  });

  it('rejects writes while the latest Canvas workspace is unavailable', async () => {
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: unavailableProject,
      patchCanvasState: async () => undefined
    });

    await expect(writes.reconcileVisibility([])).rejects.toThrow('Canvas state is unreadable.');
  });

  it('copies command inputs before they wait in the transaction lane', async () => {
    const state = canvasState({
      'a.png': { x: 5_000, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_200, y: 0, width: 100, height: 100 }
    });
    const patches: CanvasStatePatch[] = [];
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async (patch) => {
        patches.push(patch);
      }
    });
    const selected = ['a.png'];
    const layouts = [{
      projectRelativePath: 'a.png',
      x: 5_150,
      y: 0,
      width: 100,
      height: 100
    }];

    const write = writes.commitManualLayouts({
      selectedProjectRelativePaths: selected,
      nodeLayouts: layouts
    });
    selected[0] = 'b.png';
    layouts[0]!.x = 0;
    await write;

    expect(patches).toEqual([{
      nodeStateUpdates: [{
        projectRelativePath: 'a.png',
        manualLayout: { x: 5_150, y: 0, width: 100, height: 100 }
      }],
      occlusionOrder: ['b.png', 'a.png']
    }]);
  });

  it('skips persistence when the complete derived patch is empty', async () => {
    const patches: CanvasStatePatch[] = [];
    const state = canvasState({
      'a.png': { x: 5_000, y: 0, width: 100, height: 100 },
      'b.png': { x: 5_050, y: 0, width: 100, height: 100 }
    }, ['b.png', 'a.png']);
    const writes = createCanvasOcclusionOrderWrites({
      generation: 1,
      readProjectProjection: () => boundProject(state),
      patchCanvasState: async (patch) => {
        patches.push(patch);
      }
    });

    await writes.raiseSelection(['a.png']);

    expect(patches).toEqual([]);
  });
});

const RESOURCES: CanvasResourceView = {
  resources: [
    {
      projectRelativePath: '',
      nodeKind: 'file',
      mediaKind: 'image',
      imageDimensions: { width: 100, height: 100 },
      availability: {
        state: 'available',
        size: 1,
        mimeType: 'image/png',
        fileUrl: '/root.png',
        revision: 'revision-1'
      }
    },
    ...['a.png', 'b.png'].map((projectRelativePath) => ({
      projectRelativePath,
      nodeKind: 'file' as const,
      mediaKind: 'image' as const,
      imageDimensions: { width: 100, height: 100 },
      availability: {
        state: 'available' as const,
        size: 1,
        mimeType: 'image/png',
        fileUrl: `/${projectRelativePath}`,
        revision: 'revision-1'
      }
    }))
  ]
};

function canvasState(
  layouts: Record<string, { x: number; y: number; width: number; height: number }>,
  occlusionOrder: string[] = []
): CanvasState {
  return {
    expandedDirectories: [],
    nodeStates: Object.fromEntries(Object.entries(layouts).map(([path, manualLayout]) => [
      path,
      { manualLayout }
    ])),
    occlusionOrder
  };
}

function boundProject(
  state: CanvasState,
  generation = 1
): BoundProject {
  return {
    status: 'bound',
    generation,
    bindingId: 'binding-1',
    canonicalRoot: '/project',
    projectRevision: 1,
    snapshot: {
      canonicalRoot: '/project',
      projectTree: [],
      canvasWorkspace: {
        status: 'available',
        workspace: {
          canonicalRoot: '/project',
          ...state
        },
        canvasResources: RESOURCES
      },
      diagnostics: [],
      health: {
        projectName: 'project',
        diagnosticCounts: { errors: 0, warnings: 0 },
        checkedAt: '2026-08-10T00:00:00.000Z'
      }
    },
    workingCopies: { text: {}, feedback: {} }
  };
}

function unavailableProject(): BoundProject {
  const project = boundProject(canvasState({}));
  return {
    ...project,
    snapshot: {
      ...project.snapshot,
      canvasWorkspace: {
        status: 'unavailable',
        code: 'canvas_workspace_unreadable',
        message: 'Canvas state is unreadable.'
      }
    }
  };
}

function stateWithPatch(state: CanvasState, patch: CanvasStatePatch): CanvasState {
  return {
    ...state,
    occlusionOrder: patch.occlusionOrder ?? state.occlusionOrder
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T)
  };
}
