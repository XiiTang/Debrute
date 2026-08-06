import { describe, expect, it } from 'vitest';
import { canvasPreviewCanonicalSourceIdentity } from '@debrute/canvas-core';
import {
  CANVAS_VIDEO_PREVIEW_PROBE_MAX_TARGETS,
  canvasVideoPreviewProbeWindow,
  canvasVideoPreviewTargetKey,
  reconcileCanvasVideoPreviewTasks,
  retryCanvasVideoPreviewTask,
  updateCanvasVideoPreviewTask,
  type CanvasVideoPreviewTarget,
  type CanvasVideoPreviewTask
} from './CanvasVideoPreviewTaskRegistry';

describe('Canvas Video Preview task registry', { tags: ['canvas-video'] }, () => {
  it('keeps the current target and replaces the same path when its identity changes', () => {
    const current = target('media/a.mp4', 1_000);
    const previous = new Map<string, CanvasVideoPreviewTask>([[
      current.projectRelativePath,
      {
        ...current,
        state: 'needs-source',
        canonicalSourceIdentity: canvasPreviewCanonicalSourceIdentity('source-a')
      }
    ]]);

    expect(reconcileCanvasVideoPreviewTasks({
      previous,
      targets: [current],
      readyTargetKeys: new Set()
    })).toEqual(previous);

    const replacement = target('media/a.mp4', 2_000);
    expect(reconcileCanvasVideoPreviewTasks({
      previous,
      targets: [replacement],
      readyTargetKeys: new Set()
    })).toEqual(new Map([[
      replacement.projectRelativePath,
      { ...replacement, state: 'needs-probe' }
    ]]));
  });

  it('omits targets whose canonical source is already ready', () => {
    const current = target('media/a.mp4', 1_000);
    expect(reconcileCanvasVideoPreviewTasks({
      previous: new Map(),
      targets: [current],
      readyTargetKeys: new Set([canvasVideoPreviewTargetKey(current)])
    })).toEqual(new Map());
  });

  it('selects one bounded rolling Probe window without excluding later targets', () => {
    const tasks = Array.from({ length: CANVAS_VIDEO_PREVIEW_PROBE_MAX_TARGETS + 2 }, (_, index) => ({
      ...target(`media/${index}.mp4`, index),
      state: 'needs-probe' as const
    }));

    expect(canvasVideoPreviewProbeWindow(tasks).map((task) => task.projectRelativePath)).toEqual(
      tasks.slice(0, CANVAS_VIDEO_PREVIEW_PROBE_MAX_TARGETS).map((task) => task.projectRelativePath)
    );
  });

  it('guards state settlement by current target identity and retries only the current failure', () => {
    const current = target('media/a.mp4', 1_000);
    const replacement = target('media/a.mp4', 2_000);
    const failed = new Map<string, CanvasVideoPreviewTask>([[
      current.projectRelativePath,
      { ...current, state: 'failed', failure: { stage: 'ensure', message: 'failed' } }
    ]]);

    expect(updateCanvasVideoPreviewTask(failed, replacement, { state: 'needs-probe' })).toBe(failed);
    expect(retryCanvasVideoPreviewTask(failed, replacement)).toBe(failed);
    expect(retryCanvasVideoPreviewTask(failed, current)).toEqual(new Map([[
      current.projectRelativePath,
      { ...current, state: 'needs-probe' }
    ]]));
  });
});

function target(projectRelativePath: string, frameTimeMs: number): CanvasVideoPreviewTarget {
  return {
    bindingId: 'project-1',
    projectRelativePath,
    sourceRevision: 'revision-1',
    frameTimeMs
  };
}
