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

interface RegisteredCanvasDisplay<TElement extends HTMLElement | SVGSVGElement> {
  element?: TElement;
  visible?: boolean;
  lastDisplay?: string;
}

interface RegisteredCanvasNode extends RegisteredCanvasDisplay<HTMLElement> {
  layout?: CanvasNodeLayout;
  lastTransform?: string;
  lastWidth?: string;
  lastHeight?: string;
  lastZIndex?: string;
}

type RegisteredCanvasEdge = RegisteredCanvasDisplay<SVGSVGElement>;

export interface CanvasStageRuntime {
  bindStage(stage: HTMLElement): () => void;
  setCamera(camera: CanvasCamera): void;
  registerNodeShell(path: string, element: HTMLElement): () => void;
  registerEdgeLayer(id: string, element: SVGSVGElement): () => void;
  setNodeLayout(path: string, layout: CanvasNodeLayout): void;
  setNodeVisible(path: string, visible: boolean): void;
  setEdgeVisible(id: string, visible: boolean): void;
  dispose(): void;
}

export interface CanvasStageRuntimeInput {
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
}

export function createCanvasStageRuntime(input: CanvasStageRuntimeInput = {}): CanvasStageRuntime {
  const nodes = new Map<string, RegisteredCanvasNode>();
  const edges = new Map<string, RegisteredCanvasEdge>();
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
        recordCounter(writeDisplay(record, record.visible) ? 'stage-node-visibility-write' : 'stage-node-visibility-noop');
      }
      return () => {
        const current = nodes.get(path);
        if (current?.element === element) {
          nodes.delete(path);
        }
      };
    },
    registerEdgeLayer: (id, element) => {
      const record = edges.get(id) ?? {};
      record.element = element;
      edges.set(id, record);
      if (record.visible !== undefined) {
        recordCounter(writeDisplay(record, record.visible) ? 'stage-edge-visibility-write' : 'stage-edge-visibility-noop');
      }
      return () => {
        const current = edges.get(id);
        if (current?.element === element) {
          edges.delete(id);
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
      recordCounter(writeDisplay(node, visible) ? 'stage-node-visibility-write' : 'stage-node-visibility-noop');
    },
    setEdgeVisible: (id, visible) => {
      const edge = edges.get(id);
      if (!edge) {
        edges.set(id, { visible });
        return;
      }
      edge.visible = visible;
      recordCounter(writeDisplay(edge, visible) ? 'stage-edge-visibility-write' : 'stage-edge-visibility-noop');
    },
    dispose: () => {
      nodes.clear();
      edges.clear();
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

function writeDisplay<TElement extends HTMLElement | SVGSVGElement>(
  record: RegisteredCanvasDisplay<TElement>,
  visible: boolean
): boolean {
  if (!record.element) {
    return false;
  }
  const display = visible ? 'block' : 'none';
  if (record.lastDisplay === display) {
    return false;
  }
  record.lastDisplay = display;
  record.element.style.setProperty('display', display);
  return true;
}

function transformForRect(rect: Pick<CanvasRect, 'x' | 'y'>): string {
  return `translate(${rect.x}px, ${rect.y}px)`;
}

function canvasStagePerfTimestamp(): number {
  return performance.now();
}
