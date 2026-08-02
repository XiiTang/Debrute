import { describe, expect, it, vi } from 'vitest';
import {
  canvasChangedRecordPaths,
  createCanvasPathSnapshotStore
} from './CanvasPathSnapshotStore.js';

describe('CanvasPathSnapshotStore', () => {
  it('derives and notifies only explicitly changed paths', () => {
    const values = new Map([['a', 1], ['b', 1]]);
    const deriveSnapshot = vi.fn((node: { projectRelativePath: string }) => (
      values.get(node.projectRelativePath) ?? 0
    ));
    const store = createCanvasPathSnapshotStore({
      deriveSnapshot,
      snapshotsEqual: Object.is
    });
    const notifyA = vi.fn();
    const notifyB = vi.fn();
    const nodeA = { projectRelativePath: 'a' };
    const nodeB = { projectRelativePath: 'b' };

    expect(store.getSnapshot(nodeA)).toBe(1);
    expect(store.getSnapshot(nodeB)).toBe(1);
    store.subscribe(nodeA, notifyA);
    store.subscribe(nodeB, notifyB);
    deriveSnapshot.mockClear();

    values.set('a', 2);
    store.flush(new Set(['a']));

    expect(deriveSnapshot).toHaveBeenCalledTimes(1);
    expect(notifyA).toHaveBeenCalledTimes(1);
    expect(notifyB).not.toHaveBeenCalled();
    expect(store.getSnapshot(nodeA)).toBe(2);
  });

  it('reports only record entries whose identity changed', () => {
    const retained = { value: 1 };
    expect(canvasChangedRecordPaths(
      { retained, removed: { value: 2 }, changed: { value: 3 } },
      { retained, added: { value: 4 }, changed: { value: 5 } }
    ).sort()).toEqual(['added', 'changed', 'removed']);
  });

  it('retains falsy snapshots while another listener still observes the same node', () => {
    let value = false;
    const node = { projectRelativePath: 'shared' };
    const store = createCanvasPathSnapshotStore({
      deriveSnapshot: () => value,
      snapshotsEqual: Object.is
    });
    const removedListener = vi.fn();
    const retainedListener = vi.fn();

    expect(store.getSnapshot(node)).toBe(false);
    const unsubscribe = store.subscribe(node, removedListener);
    store.subscribe(node, retainedListener);
    value = true;
    store.flush(new Set(['shared']));

    expect(removedListener).toHaveBeenCalledTimes(1);
    expect(retainedListener).toHaveBeenCalledTimes(1);

    removedListener.mockClear();
    retainedListener.mockClear();
    unsubscribe();
    value = false;
    store.flush(new Set(['shared']));

    expect(removedListener).not.toHaveBeenCalled();
    expect(retainedListener).toHaveBeenCalledTimes(1);
  });
});
