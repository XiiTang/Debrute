import { describe, expect, it } from 'vitest';
import { canvasPreviewTargetIdentity } from '@debrute/canvas-core';
import {
  canvasVideoPreviewReadWindow,
  canvasVideoPreviewTargetIdentity,
  canvasVideoPreviewTargetKey,
  reconcileCanvasVideoPreviewTasks,
  retryCanvasVideoPreviewTask,
  type CanvasVideoPreviewTarget
} from './CanvasVideoPreviewTaskRegistry';

describe('CanvasVideoPreviewTaskRegistry', { tags: ['canvas-video'] }, () => {
  it('keeps multiple frame times for one video as independent tasks', () => {
    const first = target(0);
    const second = target(2_500);
    const tasks = reconcileCanvasVideoPreviewTasks({
      previous: new Map(),
      targets: [first, second],
      readyTargetKeys: new Set()
    });
    expect(tasks.size).toBe(2);
    expect(canvasVideoPreviewReadWindow([...tasks.values()])).toHaveLength(2);
    expect(canvasVideoPreviewTargetIdentity(first)).toBe(
      canvasPreviewTargetIdentity(['rev-a', 0])
    );
    expect(canvasVideoPreviewTargetKey(first)).not.toBe(canvasVideoPreviewTargetKey(second));
  });

  it('retries only the current failed target', () => {
    const current = target(0);
    const key = canvasVideoPreviewTargetKey(current);
    const failed = new Map([[key, {
      ...current,
      state: 'failed' as const,
      failure: { stage: 'decode' as const, message: 'unsupported' }
    }]]);
    expect(retryCanvasVideoPreviewTask(failed, current).get(key)?.state).toBe('needs-read');
    expect(retryCanvasVideoPreviewTask(failed, target(1_000))).toBe(failed);
  });

  it('reads at most ten pending targets and leaves non-read states alone', () => {
    const targets = Array.from({ length: 12 }, (_, index) => target(index * 1_000));
    const tasks = reconcileCanvasVideoPreviewTasks({
      previous: new Map(),
      targets,
      readyTargetKeys: new Set()
    });
    const firstKey = canvasVideoPreviewTargetKey(targets[0]!);
    tasks.set(firstKey, { ...targets[0]!, state: 'needs-capture' });

    expect(canvasVideoPreviewReadWindow([...tasks.values()])).toEqual(
      targets.slice(1, 11).map((candidate) => ({ ...candidate, state: 'needs-read' }))
    );
  });

  it('preserves matching work while dropping ready and stale target identities', () => {
    const current = target(0);
    const ready = target(1_000);
    const stale = target(2_000);
    const previous = reconcileCanvasVideoPreviewTasks({
      previous: new Map(),
      targets: [current, ready, stale],
      readyTargetKeys: new Set()
    });
    previous.set(canvasVideoPreviewTargetKey(current), { ...current, state: 'capturing' });

    const reconciled = reconcileCanvasVideoPreviewTasks({
      previous,
      targets: [current, ready],
      readyTargetKeys: new Set([canvasVideoPreviewTargetKey(ready)])
    });

    expect([...reconciled.values()]).toEqual([{ ...current, state: 'capturing' }]);
  });
});

function target(frameTimeMs: number): CanvasVideoPreviewTarget {
  return {
    bindingId: 'project-1',
    projectRelativePath: 'media/a.mkv',
    sourceRevision: 'rev-a',
    sourceUrl: '/api/video',
    frameTimeMs
  };
}
