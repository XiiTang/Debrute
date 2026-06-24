import type { ProjectedCanvasNode } from '@debrute/canvas-core';

export interface CanvasVisibilityControllerStageRuntime {
  setNodeVisible(path: string, visible: boolean): void;
}

export interface CanvasVisibilityController {
  sync(input: CanvasVisibilityControllerSyncInput): void;
}

export interface CanvasVisibilityControllerSyncInput {
  nodesByPath: ReadonlyMap<string, Pick<ProjectedCanvasNode, 'projectRelativePath'>>;
  culledNodePaths: ReadonlySet<string>;
  selectedNodePaths: ReadonlySet<string>;
  activeNodePaths: ReadonlySet<string>;
}

export function createCanvasVisibilityController(input: {
  stageRuntime: CanvasVisibilityControllerStageRuntime;
}): CanvasVisibilityController {
  const lastVisibilityByPath = new Map<string, boolean>();

  return {
    sync: (syncInput) => {
      for (const path of [...lastVisibilityByPath.keys()]) {
        if (!syncInput.nodesByPath.has(path)) {
          lastVisibilityByPath.delete(path);
        }
      }

      for (const path of syncInput.nodesByPath.keys()) {
        const visible = !syncInput.culledNodePaths.has(path)
          || syncInput.selectedNodePaths.has(path)
          || syncInput.activeNodePaths.has(path);
        if (lastVisibilityByPath.get(path) === visible) {
          continue;
        }
        lastVisibilityByPath.set(path, visible);
        input.stageRuntime.setNodeVisible(path, visible);
      }
    }
  };
}
