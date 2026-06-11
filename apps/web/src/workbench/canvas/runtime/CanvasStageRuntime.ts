import { buildResizeGeometry } from '../../services/canvasInteraction';
import { CANVAS_PERF_INTERACTION_SESSION_TYPES, type CanvasPerfCounterName, type CanvasPerfMonitor } from '../CanvasPerfMonitor';
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

export interface CanvasStageRuntimeInput {
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
}

export function createCanvasStageRuntime(input: CanvasStageRuntimeInput = {}): CanvasStageRuntime {
  const nodes = new Map<string, RegisteredCanvasNode>();
  let stage: HTMLElement | undefined;
  let camera: CanvasCamera | undefined;
  let lastCameraTransform: string | undefined;
  let lastZoom: string | undefined;
  let lastChromeScale: string | undefined;
  let activePreviewPaths = new Set<string>();

  const recordCounter = (name: CanvasPerfCounterName) => {
    input.perfMonitor?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: canvasStagePerfTimestamp(),
      source: 'CanvasStageRuntime',
      name
    });
  };

  const writeStageCamera = (nextCamera: CanvasCamera) => {
    if (!stage) {
      return;
    }
    const transform = canvasCameraTransform(nextCamera);
    const zoom = String(nextCamera.z);
    const chromeScale = String(canvasChromeScale(nextCamera));
    let wrote = false;
    if (lastZoom !== zoom) {
      stage.style.setProperty('--canvas-zoom', zoom);
      lastZoom = zoom;
      wrote = true;
    }
    if (lastChromeScale !== chromeScale) {
      stage.style.setProperty('--canvas-chrome-scale', chromeScale);
      lastChromeScale = chromeScale;
      wrote = true;
    }
    if (lastCameraTransform !== transform) {
      stage.style.transform = transform;
      lastCameraTransform = transform;
      wrote = true;
    }
    recordCounter(wrote ? 'stage-camera-write' : 'stage-camera-noop');
  };

  const writeNodeLayout = (node: RegisteredCanvasNode, layout: CanvasNodeLayout) => {
    node.layout = layout;
    if (!node.element || node.previewing) {
      return;
    }
    const wrote = [
      writeNodeTransform(node, transformForRect(layout)),
      writeStyleProperty(node, 'width', `${layout.width}px`, 'lastWidth'),
      writeStyleProperty(node, 'height', `${layout.height}px`, 'lastHeight'),
      writeStyleProperty(node, 'z-index', String(layout.z), 'lastZIndex')
    ].some(Boolean);
    recordCounter(wrote ? 'stage-node-layout-write' : 'stage-node-layout-noop');
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
        recordCounter(writeNodeDisplay(record, record.visible) ? 'stage-node-visibility-write' : 'stage-node-visibility-noop');
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
      recordCounter(writeNodeDisplay(node, visible) ? 'stage-node-visibility-write' : 'stage-node-visibility-noop');
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
        for (const path of previousPreviewPaths) {
          clearPreviewPath(path);
        }
        return;
      }
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
        const wrote = [
          writeNodeTransform(node, transformForRect(next)),
          writeStyleProperty(node, 'width', `${next.width}px`, 'lastWidth'),
          writeStyleProperty(node, 'height', `${next.height}px`, 'lastHeight')
        ].some(Boolean);
        if (wrote) {
          recordCounter('stage-drag-preview-write');
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

function writeNodeTransform(node: RegisteredCanvasNode, transform: string): boolean {
  if (!node.element) {
    return false;
  }
  if (node.lastTransform === transform) {
    return false;
  }
  node.lastTransform = transform;
  node.element.style.transform = transform;
  return true;
}

function writeStyleProperty(
  node: RegisteredCanvasNode,
  property: 'width' | 'height' | 'z-index',
  value: string,
  cacheKey: 'lastWidth' | 'lastHeight' | 'lastZIndex'
): boolean {
  if (!node.element) {
    return false;
  }
  if (node[cacheKey] === value) {
    return false;
  }
  node[cacheKey] = value;
  node.element.style.setProperty(property, value);
  return true;
}

function writeNodeDisplay(node: RegisteredCanvasNode, visible: boolean): boolean {
  if (!node.element) {
    return false;
  }
  const display = visible ? 'block' : 'none';
  if (node.lastDisplay === display) {
    return false;
  }
  node.lastDisplay = display;
  node.element.style.setProperty('display', display);
  return true;
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

function canvasStagePerfTimestamp(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
