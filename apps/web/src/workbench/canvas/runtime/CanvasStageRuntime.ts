import { CANVAS_PERF_INTERACTION_SESSION_TYPES, type CanvasPerfCounterName, type CanvasPerfMonitor } from '../CanvasPerfMonitor';
import { canvasCameraTransform, canvasChromeScale, type CanvasCamera } from './canvasCamera';
import type { CanvasRect } from './canvasGeometry';

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
    if (!node.element) {
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
    dispose: () => {
      nodes.clear();
      stage = undefined;
      camera = undefined;
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

function canvasStagePerfTimestamp(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
