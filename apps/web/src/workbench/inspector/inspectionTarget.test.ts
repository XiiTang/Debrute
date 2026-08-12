import { describe, expect, it, vi } from 'vitest';
import { createInspectionTargetStore } from './inspectionTarget';

describe('Inspection Target', () => {
  it('publishes empty, single, and multiple selections synchronously', () => {
    const store = createInspectionTargetStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.publishPaths(['media/clip.mp4']);
    expect(store.getSnapshot()).toEqual({
      target: { kind: 'single', projectRelativePath: 'media/clip.mp4' },
      version: 1
    });
    expect(listener).toHaveBeenCalledTimes(1);

    store.publishPaths(['notes/b.md', 'notes/a.md', 'notes/a.md']);
    expect(store.getSnapshot()).toEqual({
      target: { kind: 'multiple', count: 2 },
      version: 2
    });

    store.publishPaths([]);
    expect(store.getSnapshot()).toEqual({
      target: { kind: 'empty' },
      version: 3
    });
  });

  it('invalidates only the current single-file target', () => {
    const store = createInspectionTargetStore();
    store.publishPaths(['media/clip.mp4']);

    store.invalidatePath('other.mp4');
    expect(store.getSnapshot().version).toBe(1);

    store.invalidatePath('media/clip.mp4');
    expect(store.getSnapshot()).toEqual({
      target: { kind: 'single', projectRelativePath: 'media/clip.mp4' },
      version: 2
    });
  });
});
