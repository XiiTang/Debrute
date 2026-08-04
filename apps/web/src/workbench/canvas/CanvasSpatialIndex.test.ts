import { describe, expect, it } from 'vitest';
import { createCanvasSpatialIndex } from './CanvasSpatialIndex.js';

describe('CanvasSpatialIndex', () => {
  it('bulk loads bounds and returns only entries intersecting the query rectangle', () => {
    const index = createCanvasSpatialIndex();
    index.rebuild([
      { id: 'near', bounds: { x: 0, y: 0, width: 100, height: 80 } },
      { id: 'far', bounds: { x: 1000, y: 1000, width: 100, height: 80 } }
    ]);

    expect(index.query({ x: 50, y: 40, width: 100, height: 100 })).toEqual(['near']);
  });

  it('updates one dirty entry without rebuilding unrelated bounds', () => {
    const index = createCanvasSpatialIndex();
    index.rebuild([
      { id: 'moving', bounds: { x: 0, y: 0, width: 100, height: 80 } },
      { id: 'stable', bounds: { x: 300, y: 0, width: 100, height: 80 } }
    ]);

    index.upsert({ id: 'moving', bounds: { x: 600, y: 0, width: 100, height: 80 } });

    expect(index.query({ x: 0, y: 0, width: 450, height: 100 })).toEqual(['stable']);
    expect(index.query({ x: 550, y: 0, width: 200, height: 100 })).toEqual(['moving']);
  });

  it('removes entries by stable identity', () => {
    const index = createCanvasSpatialIndex();
    index.rebuild([{ id: 'removed', bounds: { x: 0, y: 0, width: 100, height: 80 } }]);

    index.remove('removed');

    expect(index.query({ x: 0, y: 0, width: 100, height: 80 })).toEqual([]);
  });

  it('returns a large hit set without promising sort order', () => {
    const index = createCanvasSpatialIndex();
    const entries = Array.from({ length: 2_000 }, (_value, index) => ({
      id: `node-${String(2_000 - index).padStart(4, '0')}`,
      bounds: { x: index, y: index, width: 10, height: 10 }
    }));
    index.rebuild(entries);

    expect(new Set(index.query({ x: -1, y: -1, width: 3_000, height: 3_000 })))
      .toEqual(new Set(entries.map((entry) => entry.id)));
  });
});
