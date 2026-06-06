import { buildResizeGeometry } from '../../services/canvasInteraction';
import { canvasCameraTransform, canvasChromeScale, type CanvasCamera } from './canvasCamera';
import type { CanvasRect } from './canvasGeometry';
import type { CanvasRuntimeDragState } from './CanvasEditorRuntime';

export interface CanvasNodeLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

interface RegisteredCanvasNode {
  element?: HTMLElement;
  layout?: CanvasNodeLayout;
  visible?: boolean;
  previewing?: boolean;
  lastTransform?: string;
  lastWidth?: string;
  lastHeight?: string;
  lastZIndex?: string;
  lastDisplay?: string;
}

export interface CanvasStageRuntime {
  bindStage(stage: HTMLElement): () => void;
  setCamera(camera: CanvasCamera): void;
  registerNodeShell(path: string, element: HTMLElement): () => void;
  setNodeLayout(path: string, layout: CanvasNodeLayout): void;
  setNodeVisible(path: string, visible: boolean): void;
  applyDragPreview(state: CanvasRuntimeDragState | undefined): void;
  clearDragPreview(): void;
  dispose(): void;
}

export function createCanvasStageRuntime(): CanvasStageRuntime {
  const nodes = new Map<string, RegisteredCanvasNode>();
  let stage: HTMLElement | undefined;
  let camera: CanvasCamera | undefined;
  let lastCameraTransform: string | undefined;
  let lastZoom: string | undefined;
  let lastChromeScale: string | undefined;
  let activePreviewPaths = new Set<string>();

  const writeStageCamera = (nextCamera: CanvasCamera) => {
    if (!stage) {
      return;
    }
    const transform = canvasCameraTransform(nextCamera);
    const zoom = String(nextCamera.z);
    const chromeScale = String(canvasChromeScale(nextCamera));
    if (lastZoom !== zoom) {
      stage.style.setProperty('--canvas-zoom', zoom);
      lastZoom = zoom;
    }
    if (lastChromeScale !== chromeScale) {
      stage.style.setProperty('--canvas-chrome-scale', chromeScale);
      lastChromeScale = chromeScale;
    }
    if (lastCameraTransform !== transform) {
      stage.style.transform = transform;
      lastCameraTransform = transform;
    }
  };

  const writeNodeLayout = (node: RegisteredCanvasNode, layout: CanvasNodeLayout) => {
    node.layout = layout;
    if (!node.element || node.previewing) {
      return;
    }
    writeNodeTransform(node, transformForRect(layout));
    writeStyleProperty(node, 'width', `${layout.width}px`, 'lastWidth');
    writeStyleProperty(node, 'height', `${layout.height}px`, 'lastHeight');
    writeStyleProperty(node, 'z-index', String(layout.z), 'lastZIndex');
  };

  const clearPreviewPath = (path: string) => {
    const node = nodes.get(path);
    if (!node) {
      return;
    }
    node.previewing = false;
    if (node.layout) {
      writeNodeLayout(node, node.layout);
    }
  };

  return {
    bindStage: (nextStage) => {
      stage = nextStage;
      lastCameraTransform = undefined;
      lastZoom = undefined;
      lastChromeScale = undefined;
      if (camera) {
        writeStageCamera(camera);
      }
      return () => {
        if (stage === nextStage) {
          stage = undefined;
        }
      };
    },
    setCamera: (nextCamera) => {
      camera = nextCamera;
      writeStageCamera(nextCamera);
    },
    registerNodeShell: (path, element) => {
      const record = nodes.get(path) ?? {};
      record.element = element;
      nodes.set(path, record);
      if (record.layout) {
        writeNodeLayout(record, record.layout);
      }
      if (record.visible !== undefined) {
        writeNodeDisplay(record, record.visible);
      }
      return () => {
        const current = nodes.get(path);
        if (current?.element === element) {
          nodes.delete(path);
        }
      };
    },
    setNodeLayout: (path, layout) => {
      const node = nodes.get(path);
      if (!node) {
        nodes.set(path, { layout });
        return;
      }
      writeNodeLayout(node, layout);
    },
    setNodeVisible: (path, visible) => {
      const node = nodes.get(path);
      if (!node) {
        nodes.set(path, { visible });
        return;
      }
      node.visible = visible;
      writeNodeDisplay(node, visible);
    },
    applyDragPreview: (state) => {
      const previousPreviewPaths = activePreviewPaths;
      activePreviewPaths = new Set();
      if (!state) {
        for (const path of previousPreviewPaths) {
          clearPreviewPath(path);
        }
        return;
      }
      if (state.kind === 'move-node') {
        const delta = dragStateDelta(state);
        for (const origin of state.origins) {
          const node = nodes.get(origin.projectRelativePath);
          if (!node) {
            continue;
          }
          activePreviewPaths.add(origin.projectRelativePath);
          node.previewing = true;
          writeNodeTransform(node, `translate(${origin.x + delta.dx}px, ${origin.y + delta.dy}px)`);
        }
      } else {
        const node = nodes.get(state.node.projectRelativePath);
        if (node) {
          const delta = dragStateDelta(state);
          const next = buildResizeGeometry(
            state.handle,
            state.origin,
            { x: delta.dx, y: delta.dy },
            state.preserveAspect
          );
          activePreviewPaths.add(state.node.projectRelativePath);
          node.previewing = true;
          writeNodeTransform(node, transformForRect(next));
          writeStyleProperty(node, 'width', `${next.width}px`, 'lastWidth');
          writeStyleProperty(node, 'height', `${next.height}px`, 'lastHeight');
        }
      }
      for (const path of previousPreviewPaths) {
        if (!activePreviewPaths.has(path)) {
          clearPreviewPath(path);
        }
      }
    },
    clearDragPreview: () => {
      for (const path of activePreviewPaths) {
        clearPreviewPath(path);
      }
      activePreviewPaths = new Set();
    },
    dispose: () => {
      nodes.clear();
      stage = undefined;
      camera = undefined;
      activePreviewPaths = new Set();
    }
  };
}

function writeNodeTransform(node: RegisteredCanvasNode, transform: string): void {
  if (!node.element) {
    return;
  }
  if (node.lastTransform === transform) {
    return;
  }
  node.lastTransform = transform;
  node.element.style.transform = transform;
}

function writeStyleProperty(
  node: RegisteredCanvasNode,
  property: 'width' | 'height' | 'z-index',
  value: string,
  cacheKey: 'lastWidth' | 'lastHeight' | 'lastZIndex'
): void {
  if (!node.element) {
    return;
  }
  if (node[cacheKey] === value) {
    return;
  }
  node[cacheKey] = value;
  node.element.style.setProperty(property, value);
}

function writeNodeDisplay(node: RegisteredCanvasNode, visible: boolean): void {
  if (!node.element) {
    return;
  }
  const display = visible ? 'block' : 'none';
  if (node.lastDisplay === display) {
    return;
  }
  node.lastDisplay = display;
  node.element.style.setProperty('display', display);
}

function transformForRect(rect: Pick<CanvasRect, 'x' | 'y'>): string {
  return `translate(${rect.x}px, ${rect.y}px)`;
}

function dragStateDelta(state: CanvasRuntimeDragState): { dx: number; dy: number } {
  const current = state.current ?? state.start;
  return {
    dx: current.x - state.start.x,
    dy: current.y - state.start.y
  };
}
