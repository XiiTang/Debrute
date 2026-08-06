import { describe, expect, it } from 'vitest';
import { canvasPreviewTargetIdentityFromDigest } from '@debrute/canvas-core';
import { canvasTextPreviewTargetKey } from './CanvasTextPreviewCapture.js';
import {
  CANVAS_TEXT_PREVIEW_CONTENT_MAX_BYTES,
  CANVAS_TEXT_PREVIEW_CONTENT_MAX_TARGETS,
  canvasTextPreviewContentWindow,
  reconcileCanvasTextPreviewTasks,
  type CanvasTextPreviewTask
} from './CanvasTextPreviewTaskRegistry.js';

describe('CanvasTextPreviewTaskRegistry', { tags: ['canvas-text'] }, () => {
  it('keeps one latest task per path and drops completed or removed targets', () => {
    const previous = new Map<string, CanvasTextPreviewTask>([
      ['a.md', task('a.md', 'old', 'ready')],
      ['gone.md', task('gone.md', 'gone', 'needs-content')]
    ]);
    const next = reconcileCanvasTextPreviewTasks({
      previous,
      targets: [target('a.md', 'new'), target('b.md', 'b')],
      sourceAvailability: {
        'a.md': { targetKey: canvasTextPreviewTargetKey(target('a.md', 'new')), available: false },
        'b.md': { targetKey: canvasTextPreviewTargetKey(target('b.md', 'b')), available: true }
      }
    });

    expect([...next.keys()]).toEqual(['a.md']);
    expect(next.get('a.md')).toMatchObject({ targetIdentity: 'new', state: 'needs-content' });
  });

  it('retains current work for an unchanged target identity', () => {
    const current = task('a.md', 'same', 'ready');
    const next = reconcileCanvasTextPreviewTasks({
      previous: new Map([['a.md', current]]),
      targets: [target('a.md', 'same')],
      sourceAvailability: {
        'a.md': { targetKey: canvasTextPreviewTargetKey(target('a.md', 'same')), available: false }
      }
    });

    expect(next.get('a.md')).toBe(current);
  });

  it('retains only the executing task after its target leaves active maintenance', () => {
    const capturing = task('a.md', 'capture', 'capturing');
    const next = reconcileCanvasTextPreviewTasks({
      previous: new Map([
        ['a.md', capturing],
        ['b.md', task('b.md', 'queued', 'waiting-font')]
      ]),
      targets: [],
      sourceAvailability: {}
    });

    expect([...next.values()]).toEqual([capturing]);
  });

  it('lets an old executing identity finish before admitting a replacement at the same path', () => {
    const uploading = task('a.md', 'old', 'uploading');
    const next = reconcileCanvasTextPreviewTasks({
      previous: new Map([['a.md', uploading]]),
      targets: [target('a.md', 'new')],
      sourceAvailability: {}
    });

    expect(next.get('a.md')).toBe(uploading);
  });

  it('does not reuse work or source availability from another Project binding', () => {
    const current = task('a.md', 'same', 'ready');
    const rebound = { ...target('a.md', 'same'), bindingId: 'project-2' };
    const next = reconcileCanvasTextPreviewTasks({
      previous: new Map([['a.md', current]]),
      targets: [rebound],
      sourceAvailability: {
        'a.md': {
          targetKey: canvasTextPreviewTargetKey(current),
          available: true
        }
      }
    });

    expect(next.get('a.md')).toMatchObject({ bindingId: 'project-2', state: 'checking' });
  });

  it('admits every unknown target without a viewport filter', () => {
    const next = reconcileCanvasTextPreviewTasks({
      previous: new Map(),
      targets: Array.from({ length: 200 }, (_, index) => target(`${index}.md`, `${index}`)),
      sourceAvailability: {}
    });

    expect(next).toHaveLength(200);
    expect([...next.values()].every((item) => item.state === 'checking')).toBe(true);
  });

  it('bounds the materialized content view by target count and UTF-8 bytes', () => {
    const ordered = Array.from({ length: 20 }, (_, index) => ({
      ...task(`${index}.md`, `${index}`, 'needs-content'),
      estimatedBytes: index === 0 ? CANVAS_TEXT_PREVIEW_CONTENT_MAX_BYTES - 9 : 1
    }));

    expect(canvasTextPreviewContentWindow({ orderedTasks: ordered, allocatedTasks: [] }).map((item) => item.projectRelativePath)).toEqual([
      '0.md', '1.md', '2.md', '3.md', '4.md', '5.md', '6.md', '7.md', '8.md', '9.md'
    ]);
    expect(CANVAS_TEXT_PREVIEW_CONTENT_MAX_TARGETS).toBe(10);
  });

  it('counts existing reads and capture content against the same byte window', () => {
    const allocated = [{ ...task('capture.md', 'capture', 'capturing'), estimatedBytes: 7 * 1024 * 1024 }];
    const ordered = [
      { ...task('too-large.md', 'large', 'needs-content'), estimatedBytes: 2 * 1024 * 1024 },
      { ...task('fits.md', 'fits', 'needs-content'), estimatedBytes: 1024 * 1024 }
    ];

    expect(canvasTextPreviewContentWindow({ orderedTasks: ordered, allocatedTasks: allocated }).map((item) => item.projectRelativePath)).toEqual([
      'fits.md'
    ]);
  });

  it('runs the first oversized content task alone instead of starving it', () => {
    const oversized = {
      ...task('large.md', 'large', 'needs-content'),
      estimatedBytes: CANVAS_TEXT_PREVIEW_CONTENT_MAX_BYTES + 1
    };
    const small = task('small.md', 'small', 'needs-content');

    expect(canvasTextPreviewContentWindow({ orderedTasks: [oversized, small], allocatedTasks: [] }))
      .toEqual([oversized]);
    expect(canvasTextPreviewContentWindow({
      orderedTasks: [oversized],
      allocatedTasks: [task('allocated.md', 'allocated', 'reading')]
    })).toEqual([]);
  });
});

function target(projectRelativePath: string, targetIdentity: string) {
  return {
    bindingId: 'project-1',
    canvasId: 'canvas-1',
    projectRelativePath,
    targetIdentity: canvasPreviewTargetIdentityFromDigest(targetIdentity),
    contentDigest: `sha256:${targetIdentity}`,
    estimatedBytes: 1,
    language: 'markdown' as const,
    wordWrap: false,
    contentCssWidth: 420,
    contentCssHeight: 248,
    scrollTop: 0,
    scrollLeft: 0,
    styleKey: 'style',
    sourcePixelWidth: 1680,
    sourcePixelHeight: 992,
    sourceScale: 4
  };
}

function task(
  projectRelativePath: string,
  targetIdentity: string,
  state: CanvasTextPreviewTask['state']
): CanvasTextPreviewTask {
  return { ...target(projectRelativePath, targetIdentity), attempt: {}, state };
}
