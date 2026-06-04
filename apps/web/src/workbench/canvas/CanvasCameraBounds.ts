import type { ProjectedCanvasNode } from '@axis/canvas-core';
import { MAX_CANVAS_CAMERA_Z, MIN_CANVAS_CAMERA_Z, type CanvasCamera } from './runtime/canvasCamera';
import type { CanvasRect, CanvasSize } from './runtime/canvasGeometry';
import { clamp, rectCenter } from './runtime/canvasGeometry';

const CANVAS_FIT_PADDING_PX = 96;

export function cameraForCanvasContent(input: {
  nodes: ProjectedCanvasNode[];
  surfaceSize: CanvasSize;
}): CanvasCamera | undefined {
  const bounds = canvasContentBounds(input.nodes);
  return bounds ? cameraForCanvasBounds({ bounds, surfaceSize: input.surfaceSize }) : undefined;
}

export function canvasContentBounds(nodes: ProjectedCanvasNode[]): CanvasRect | undefined {
  const visibleNodes = nodes.filter((node) => (
    node.visible !== false
    && Number.isFinite(node.x)
    && Number.isFinite(node.y)
    && Number.isFinite(node.width)
    && Number.isFinite(node.height)
    && node.width > 0
    && node.height > 0
  ));
  const first = visibleNodes[0];
  if (!first) {
    return undefined;
  }
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x + first.width;
  let maxY = first.y + first.height;
  for (const node of visibleNodes.slice(1)) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function cameraForCanvasBounds(input: { bounds: CanvasRect; surfaceSize: CanvasSize }): CanvasCamera {
  const availableWidth = Math.max(1, input.surfaceSize.width - CANVAS_FIT_PADDING_PX * 2);
  const availableHeight = Math.max(1, input.surfaceSize.height - CANVAS_FIT_PADDING_PX * 2);
  const z = clamp(
    Math.min(availableWidth / input.bounds.width, availableHeight / input.bounds.height),
    MIN_CANVAS_CAMERA_Z,
    MAX_CANVAS_CAMERA_Z
  );
  const center = rectCenter(input.bounds);
  return {
    x: input.surfaceSize.width / 2 - center.x * z,
    y: input.surfaceSize.height / 2 - center.y * z,
    z
  };
}
