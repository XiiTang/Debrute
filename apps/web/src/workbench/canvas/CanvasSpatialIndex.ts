import RBush from 'rbush';
import type { CanvasRect } from './runtime/canvasGeometry';

interface CanvasSpatialElement {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CanvasSpatialIndexEntry {
  id: string;
  bounds: CanvasRect;
}

export interface CanvasSpatialIndex {
  rebuild(entries: readonly CanvasSpatialIndexEntry[]): void;
  upsert(entry: CanvasSpatialIndexEntry): void;
  remove(id: string): void;
  query(rect: CanvasRect): string[];
}

export function createCanvasSpatialIndex(): CanvasSpatialIndex {
  const tree = new RBush<CanvasSpatialElement>();
  const elementsById = new Map<string, CanvasSpatialElement>();

  return {
    rebuild(entries) {
      tree.clear();
      elementsById.clear();
      const elements = entries.map(spatialElementForEntry);
      for (const element of elements) {
        elementsById.set(element.id, element);
      }
      tree.load(elements);
    },
    upsert(entry) {
      const previous = elementsById.get(entry.id);
      if (previous) {
        tree.remove(previous);
      }
      const next = spatialElementForEntry(entry);
      elementsById.set(entry.id, next);
      tree.insert(next);
    },
    remove(id) {
      const previous = elementsById.get(id);
      if (!previous) {
        return;
      }
      elementsById.delete(id);
      tree.remove(previous);
    },
    query(rect) {
      return tree.search(spatialElementForRect(rect))
        .map((entry) => entry.id);
    }
  };
}

function spatialElementForEntry(entry: CanvasSpatialIndexEntry): CanvasSpatialElement {
  return {
    id: entry.id,
    ...spatialElementForRect(entry.bounds)
  };
}

function spatialElementForRect(rect: CanvasRect): Omit<CanvasSpatialElement, 'id'> {
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  return {
    minX: Math.min(rect.x, x2),
    minY: Math.min(rect.y, y2),
    maxX: Math.max(rect.x, x2),
    maxY: Math.max(rect.y, y2)
  };
}
