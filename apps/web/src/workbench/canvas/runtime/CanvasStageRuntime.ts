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

interface RegisteredCanvasDisplay<TElement extends HTMLElement | SVGPathElement> {
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

interface RegisteredCanvasEdgeGroup extends RegisteredCanvasDisplay<SVGPathElement> {
  path?: string;
  lastPath?: string;
}

export interface CanvasStageRuntime {
  bindStage(stage: HTMLElement): () => void;
  setCamera(camera: CanvasCamera): void;
  registerNodeShell(path: string, element: HTMLElement, initialLayout?: CanvasNodeLayout): () => void;
  setHoveredNode(path: string | undefined): void;
  setSelectedNodePaths(paths: ReadonlySet<string>): void;
  isSingleSelectedNode(path: string): boolean;
  subscribeSingleSelectedNode(path: string, listener: () => void): () => void;
  registerEdgeGroup(id: string, element: SVGPathElement): () => void;
  setEdgeGroupGeometry(id: string, path: string): void;
  setNodeLayout(path: string, layout: CanvasNodeLayout): void;
  setNodeVisible(path: string, visible: boolean): void;
  setEdgeGroupVisible(id: string, visible: boolean): void;
  dispose(): void;
}

export interface CanvasStageRuntimeInput {
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
}

export function createCanvasStageRuntime(input: CanvasStageRuntimeInput = {}): CanvasStageRuntime {
  const nodes = new Map<string, RegisteredCanvasNode>();
  const edgeGroups = new Map<string, RegisteredCanvasEdgeGroup>();
  const singleSelectionListeners = new Map<string, Set<() => void>>();
  let stage: HTMLElement | undefined;
  let camera: CanvasCamera | undefined;
  let lastCameraTransform: string | undefined;
  let lastZoom: string | undefined;
  let lastChromeScale: string | undefined;
  let hoveredNodePath: string | undefined;
  let selectedNodePaths: ReadonlySet<string> = new Set();
  let singleSelectedNodePath: string | undefined;

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
    registerNodeShell: (path, element, initialLayout) => {
      const record = nodes.get(path) ?? {};
      record.element = element;
      nodes.set(path, record);
      if (initialLayout && !record.layout) {
        record.layout = initialLayout;
      }
      if (record.layout) {
        writeNodeLayout(record, record.layout);
      }
      if (record.visible !== undefined) {
        recordCounter(writeDisplay(record, record.visible) ? 'stage-node-visibility-write' : 'stage-node-visibility-noop');
      }
      writeNodeHovered(element, hoveredNodePath === path);
      writeNodeSelected(element, selectedNodePaths.has(path));
      return () => {
        const current = nodes.get(path);
        if (current?.element === element) {
          nodes.delete(path);
        }
      };
    },
    setHoveredNode: (path) => {
      if (hoveredNodePath === path) {
        return;
      }
      if (hoveredNodePath !== undefined) {
        const previous = nodes.get(hoveredNodePath)?.element;
        if (previous) {
          writeNodeHovered(previous, false);
        }
      }
      hoveredNodePath = path;
      if (path !== undefined) {
        const next = nodes.get(path)?.element;
        if (next) {
          writeNodeHovered(next, true);
        }
      }
    },
    setSelectedNodePaths: (paths) => {
      const previousSingle = singleSelectedNodePath;
      for (const path of selectedNodePaths) {
        if (!paths.has(path)) {
          const element = nodes.get(path)?.element;
          if (element) {
            writeNodeSelected(element, false);
          }
        }
      }
      for (const path of paths) {
        if (!selectedNodePaths.has(path)) {
          const element = nodes.get(path)?.element;
          if (element) {
            writeNodeSelected(element, true);
          }
        }
      }
      selectedNodePaths = new Set(paths);
      singleSelectedNodePath = selectedNodePaths.size === 1
        ? selectedNodePaths.values().next().value
        : undefined;
      if (previousSingle !== singleSelectedNodePath) {
        for (const path of new Set([previousSingle, singleSelectedNodePath])) {
          if (path === undefined) {
            continue;
          }
          for (const listener of singleSelectionListeners.get(path) ?? []) {
            listener();
          }
        }
      }
    },
    isSingleSelectedNode: (path) => singleSelectedNodePath === path,
    subscribeSingleSelectedNode: (path, listener) => {
      const listeners = singleSelectionListeners.get(path) ?? new Set<() => void>();
      listeners.add(listener);
      singleSelectionListeners.set(path, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          singleSelectionListeners.delete(path);
        }
      };
    },
    registerEdgeGroup: (id, element) => {
      const record = edgeGroups.get(id) ?? {};
      record.element = element;
      edgeGroups.set(id, record);
      if (record.path !== undefined) {
        writeEdgeGroupPath(record, record.path);
      }
      if (record.visible !== undefined) {
        recordCounter(writeDisplay(record, record.visible) ? 'stage-edge-visibility-write' : 'stage-edge-visibility-noop');
      }
      return () => {
        const current = edgeGroups.get(id);
        if (current?.element === element) {
          edgeGroups.delete(id);
        }
      };
    },
    setEdgeGroupGeometry: (id, path) => {
      const group = edgeGroups.get(id);
      if (!group) {
        edgeGroups.set(id, { path });
        return;
      }
      group.path = path;
      recordCounter(
        writeEdgeGroupPath(group, path)
          ? 'stage-edge-geometry-write'
          : 'stage-edge-geometry-noop'
      );
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
    setEdgeGroupVisible: (id, visible) => {
      const edge = edgeGroups.get(id);
      if (!edge) {
        edgeGroups.set(id, { visible });
        return;
      }
      edge.visible = visible;
      recordCounter(writeDisplay(edge, visible) ? 'stage-edge-visibility-write' : 'stage-edge-visibility-noop');
    },
    dispose: () => {
      nodes.clear();
      edgeGroups.clear();
      singleSelectionListeners.clear();
      stage = undefined;
      camera = undefined;
      hoveredNodePath = undefined;
      selectedNodePaths = new Set();
      singleSelectedNodePath = undefined;
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

function writeNodeHovered(element: HTMLElement, hovered: boolean): void {
  if (hovered) {
    element.setAttribute('data-canvas-hovered', 'true');
  } else {
    element.removeAttribute('data-canvas-hovered');
  }
}

function writeNodeSelected(element: HTMLElement, selected: boolean): void {
  if (selected) {
    element.setAttribute('data-canvas-selected', 'true');
  } else {
    element.removeAttribute('data-canvas-selected');
  }
}

function writeEdgeGroupPath(group: RegisteredCanvasEdgeGroup, path: string): boolean {
  if (!group.element || group.lastPath === path) {
    return false;
  }
  group.lastPath = path;
  group.element.setAttribute('d', path);
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

function writeDisplay<TElement extends HTMLElement | SVGPathElement>(
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
