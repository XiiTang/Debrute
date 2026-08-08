import { CANVAS_NODE_PRESENTATION_SCALE } from './CanvasNodePresentationGeometry.js';

export const CANVAS_GENERIC_NODE_PRESENTATION_HEIGHT = 48;
export const CANVAS_GENERIC_NODE_AUTOMATIC_MIN_WIDTH = 120;
export const CANVAS_GENERIC_NODE_AUTOMATIC_MAX_WIDTH = 360;

export interface CanvasGenericNodeSceneSize {
  readonly width: number;
  readonly height: number;
}

export type CanvasGenericIdentityRowMeasurer = (
  labels: readonly string[]
) => ReadonlyMap<string, number>;

const measuredIdentityRowWidths = new Map<string, number>();

export function canvasGenericNodeSceneSizes(
  labels: readonly string[],
  measureIdentityRows: CanvasGenericIdentityRowMeasurer = measureCanvasGenericIdentityRows
): ReadonlyMap<string, CanvasGenericNodeSceneSize> {
  const uniqueLabels = [...new Set(labels)];
  if (uniqueLabels.length === 0) {
    return new Map();
  }
  const measuredWidths = measureIdentityRows(uniqueLabels);
  return new Map(uniqueLabels.map((label) => {
    const intrinsicWidth = measuredWidths.get(label);
    if (intrinsicWidth === undefined || !Number.isFinite(intrinsicWidth) || intrinsicWidth <= 0) {
      throw new Error(`Canvas generic identity-row measurement is missing for ${JSON.stringify(label)}.`);
    }
    const presentationWidth = Math.min(
      CANVAS_GENERIC_NODE_AUTOMATIC_MAX_WIDTH,
      Math.max(CANVAS_GENERIC_NODE_AUTOMATIC_MIN_WIDTH, Math.ceil(intrinsicWidth))
    );
    return [label, {
      width: presentationWidth * CANVAS_NODE_PRESENTATION_SCALE,
      height: CANVAS_GENERIC_NODE_PRESENTATION_HEIGHT * CANVAS_NODE_PRESENTATION_SCALE
    }];
  }));
}

export function measureCanvasGenericIdentityRows(
  labels: readonly string[],
  measurementDocument: Document = document
): ReadonlyMap<string, number> {
  if (!measurementDocument.fonts || measurementDocument.fonts.status !== 'loaded') {
    throw new Error('Canvas generic identity rows require ready Workbench shell fonts.');
  }

  const uniqueLabels = [...new Set(labels)];
  const missingLabels = uniqueLabels.filter((label) => !measuredIdentityRowWidths.has(label));
  if (missingLabels.length > 0) {
    const container = measurementDocument.createElement('div');
    container.dataset.canvasGenericMeasurementBatch = 'true';
    Object.assign(container.style, {
      position: 'fixed',
      left: '-100000px',
      top: '0',
      width: 'max-content',
      height: '0',
      overflow: 'visible',
      visibility: 'hidden',
      pointerEvents: 'none'
    });

    const rows = missingLabels.map((label) => {
      const row = measurementDocument.createElement('div');
      row.className = 'db-canvas-node-generic canvas-generic-node-measurement-row';
      row.style.width = 'max-content';
      row.style.height = `${CANVAS_GENERIC_NODE_PRESENTATION_HEIGHT}px`;
      const icon = measurementDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('aria-hidden', 'true');
      const identity = measurementDocument.createElement('strong');
      identity.className = 'db-canvas-node-generic__label';
      identity.textContent = label;
      row.append(icon, identity);
      container.append(row);
      return { label, row };
    });

    const body = measurementDocument.body;
    if (!body) {
      throw new Error('Canvas generic identity-row measurement requires document.body.');
    }
    body.append(container);
    try {
      const completedMeasurements = rows.map(({ label, row }) => {
        const width = row.getBoundingClientRect().width;
        if (!Number.isFinite(width) || width <= 0) {
          throw new Error(`Canvas generic identity-row measurement failed for ${JSON.stringify(label)}.`);
        }
        return [label, width] as const;
      });
      for (const [label, width] of completedMeasurements) {
        measuredIdentityRowWidths.set(label, width);
      }
    } finally {
      container.remove();
    }
  }

  return new Map(uniqueLabels.map((label) => {
    const width = measuredIdentityRowWidths.get(label);
    if (width === undefined) {
      throw new Error(`Canvas generic identity-row measurement is incomplete for ${JSON.stringify(label)}.`);
    }
    return [label, width];
  }));
}
