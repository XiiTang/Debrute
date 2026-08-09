import type {
  CanvasResourceView,
  CanvasState,
  WorkbenchApiClient
} from '@debrute/app-protocol';
import type { WorkbenchProjectProjectionState } from '../services/WorkbenchProjectProjection.js';
import type { CanvasLayoutOverride } from './canvasManualLayoutDraft.js';
import { canvasNodesWithLayoutOverrides } from './canvasManualLayoutDraft.js';
import {
  projectCanvasNodeScene,
  projectCanvasSceneNodes,
  raiseCanvasSelection,
  reconcileCanvasOcclusionOrder,
  type CanvasProjectedRect
} from './CanvasScene.js';

type CanvasStatePatch = Parameters<WorkbenchApiClient['patchCanvasState']>[0];

interface CanvasOcclusionWriteContext {
  canonicalRoot: string;
  resources: CanvasResourceView;
  state: CanvasState;
}

export interface CanvasOcclusionOrderWrites {
  raiseSelection(projectRelativePaths: readonly string[]): Promise<void>;
  commitManualLayouts(input: {
    selectedProjectRelativePaths: readonly string[];
    nodeLayouts: readonly CanvasLayoutOverride[];
  }): Promise<void>;
  resetManualLayouts(input:
    | { all: true }
    | { nodePaths: readonly string[] }
  ): Promise<void>;
  reconcileVisibility(newlyVisibleProjectRelativePaths: readonly string[]): Promise<void>;
}

export function createCanvasOcclusionOrderWrites(input: {
  generation: number;
  readProjectProjection(): WorkbenchProjectProjectionState;
  patchCanvasState(patch: CanvasStatePatch): Promise<unknown>;
}): CanvasOcclusionOrderWrites {
  let tail = Promise.resolve();

  const transact = (
    derivePatch: (context: CanvasOcclusionWriteContext) => CanvasStatePatch | undefined
  ): Promise<void> => {
    const result = tail.then(async () => {
      const project = input.readProjectProjection();
      if (project.status !== 'bound' || project.generation !== input.generation) {
        throw new Error('Canvas mutation belongs to an inactive Project.');
      }
      const workspace = project.snapshot.canvasWorkspace;
      if (workspace.status !== 'available') {
        throw new Error(workspace.message);
      }
      const patch = derivePatch({
        canonicalRoot: project.canonicalRoot,
        resources: workspace.canvasResources,
        state: workspace.workspace
      });
      if (patch) {
        await input.patchCanvasState(patch);
      }
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    raiseSelection(projectRelativePaths) {
      const selectedProjectRelativePaths = [...projectRelativePaths];
      return transact((context) => {
        const occlusionOrder = raiseCanvasSelection(
          context.state.occlusionOrder,
          selectedProjectRelativePaths
        );
        return sameOrder(context.state.occlusionOrder, occlusionOrder)
          ? undefined
          : { occlusionOrder };
      });
    },
    commitManualLayouts(command) {
      const selectedProjectRelativePaths = [...command.selectedProjectRelativePaths];
      const nodeLayouts = command.nodeLayouts.map((layout) => ({ ...layout }));
      return transact((context) => {
        const currentNodes = projectCanvasSceneNodes({
          canonicalRoot: context.canonicalRoot,
          resources: context.resources,
          state: context.state
        });
        const currentByPath = new Map(
          currentNodes.map((node) => [node.projectRelativePath, node])
        );
        const changedLayouts = nodeLayouts.filter((layout) => {
          const current = currentByPath.get(layout.projectRelativePath);
          return current !== undefined && !sameGeometry(current, layout);
        });
        const finalNodes = canvasNodesWithLayoutOverrides({
          nodes: currentNodes,
          layoutOverrides: nodeLayouts
        });
        const reconciledOrder = reconcileCanvasOcclusionOrder(
          context.state.occlusionOrder,
          finalNodes
        );
        const occlusionOrder = raiseCanvasSelection(
          reconciledOrder,
          selectedProjectRelativePaths
        );
        const occlusionChanged = !sameOrder(
          context.state.occlusionOrder,
          occlusionOrder
        );
        if (changedLayouts.length === 0 && !occlusionChanged) {
          return undefined;
        }
        return {
          ...(changedLayouts.length > 0 ? {
            nodeStateUpdates: changedLayouts.map((layout) => ({
              projectRelativePath: layout.projectRelativePath,
              manualLayout: {
                x: layout.x,
                y: layout.y,
                width: layout.width,
                height: layout.height
              }
            }))
          } : {}),
          ...(occlusionChanged ? { occlusionOrder } : {})
        };
      });
    },
    resetManualLayouts(command) {
      const reset = 'all' in command
        ? { all: true as const }
        : { nodePaths: [...command.nodePaths] };
      return transact((context) => {
        const currentState = context.state;
        const requestedPaths = 'all' in reset
          ? Object.keys(currentState.nodeStates)
          : reset.nodePaths;
        const nodePaths = requestedPaths.filter((path) => (
          currentState.nodeStates[path]?.manualLayout !== undefined
        ));
        const nextState = {
          ...currentState,
          nodeStates: { ...currentState.nodeStates }
        };
        for (const path of nodePaths) {
          const current = nextState.nodeStates[path]!;
          const { manualLayout: _manualLayout, ...remaining } = current;
          if (Object.keys(remaining).length === 0) {
            delete nextState.nodeStates[path];
          } else {
            nextState.nodeStates[path] = remaining;
          }
        }
        const scene = projectCanvasNodeScene({
          canonicalRoot: context.canonicalRoot,
          resources: context.resources,
          state: nextState
        });
        const occlusionChanged = !sameOrder(
          currentState.occlusionOrder,
          scene.occlusionOrder
        );
        if (nodePaths.length === 0 && !occlusionChanged) {
          return undefined;
        }
        return {
          ...(nodePaths.length > 0 ? {
            nodeStateUpdates: nodePaths.map((projectRelativePath) => ({
              projectRelativePath,
              manualLayout: null
            }))
          } : {}),
          ...(occlusionChanged ? { occlusionOrder: scene.occlusionOrder } : {})
        };
      });
    },
    reconcileVisibility(newlyVisibleProjectRelativePaths) {
      const newlyVisible = [...newlyVisibleProjectRelativePaths];
      return transact((context) => {
        const scene = projectCanvasNodeScene({
          canonicalRoot: context.canonicalRoot,
          resources: context.resources,
          state: context.state
        });
        const visiblePaths = new Set(
          scene.nodes.map((node) => node.projectRelativePath)
        );
        const stillNewlyVisible = newlyVisible.filter((path) => visiblePaths.has(path));
        const occlusionOrder = raiseCanvasSelection(
          scene.occlusionOrder,
          stillNewlyVisible
        );
        return sameOrder(context.state.occlusionOrder, occlusionOrder)
          ? undefined
          : { occlusionOrder };
      });
    }
  };
}

function sameGeometry(left: CanvasProjectedRect, right: CanvasProjectedRect): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
