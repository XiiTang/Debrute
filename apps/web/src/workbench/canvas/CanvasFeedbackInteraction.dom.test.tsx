import { useEffect, type ReactElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type {
  WorkbenchApiClient,
  WorkbenchCanvasFeedbackMutationResult,
  WorkbenchEvent
} from '@debrute/app-protocol';
import type { CanvasFeedbackDocument, CanvasFeedbackGeometry } from '@debrute/canvas-core';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';
import {
  CanvasFeedbackInteractionBar,
  useCanvasFeedbackInteraction,
  type CanvasFeedbackInteraction
} from './CanvasFeedbackInteraction';
import { CanvasMediaFeedbackLayer } from './CanvasMediaFeedbackLayer';
import { I18nProvider } from '../i18n';

describe('CanvasFeedbackInteraction', () => {
  it('keeps Feedback Item values independent and saves only the capsule that loses focus', async () => {
    const putFeedbackWorkingCopy = vi.fn<WorkbenchApiClient['putFeedbackWorkingCopy']>(async (_projectId, value) => value);
    const clearFeedbackWorkingCopy = vi.fn<WorkbenchApiClient['clearFeedbackWorkingCopy']>(async () => undefined);
    const updateCanvasFeedbackEntry = vi.fn<WorkbenchApiClient['updateCanvasFeedbackEntry']>(async (input) => {
      const itemId = input.operation === 'update-item' ? input.itemId : 'unexpected';
      return mutationResult(feedbackFixture(itemId === 'feedback-a' ? 'Updated A' : 'Original A'));
    });
    const probe = await renderInteraction(apiFixture({
      putFeedbackWorkingCopy,
      clearFeedbackWorkingCopy,
      updateCanvasFeedbackEntry
    }));

    await act(async () => {
      await probe.current.load();
      probe.current.focusCapsule('feedback-a');
      probe.current.changeCapsule('feedback-a', 'Updated A');
    });

    expect(probe.current.capsulesForPath('image.png').map((capsule) => capsule.comment)).toEqual([
      'Updated A',
      'Original B'
    ]);
    expect(putFeedbackWorkingCopy).toHaveBeenLastCalledWith('project-1', expect.objectContaining({
      itemId: 'feedback-a',
      comment: 'Updated A'
    }));

    await act(async () => {
      await probe.current.blurCapsule('feedback-a');
    });

    expect(updateCanvasFeedbackEntry).toHaveBeenCalledWith({
      operation: 'update-item',
      projectRelativePath: 'image.png',
      itemId: 'feedback-a',
      comment: 'Updated A'
    });
    expect(clearFeedbackWorkingCopy).toHaveBeenCalledWith('project-1', 'feedback-a');
    expect(putFeedbackWorkingCopy).not.toHaveBeenCalledWith('project-1', expect.objectContaining({
      itemId: 'feedback-b'
    }));
    await probe.unmount();
  });

  it('keeps the Feedback Bar target locked while a capsule has real focus', async () => {
    const probe = await renderInteraction(apiFixture());
    const first = feedbackTarget('first.png');
    const second = feedbackTarget('second.png');

    await act(async () => {
      probe.current.handleTargetChange(first);
      probe.current.focusCapsule('feedback-a');
      probe.current.handleTargetChange(second);
    });
    expect(probe.current.currentTarget?.projectRelativePath).toBe('first.png');

    await act(async () => {
      await probe.current.blurCapsule('feedback-a');
      probe.current.handleTargetChange(second);
    });
    expect(probe.current.currentTarget?.projectRelativePath).toBe('second.png');
    await probe.unmount();
  });

  it('forces a focused Feedback Bar target closed when its Project file disappears', async () => {
    const probe = await renderInteraction(apiFixture());

    await act(async () => {
      await probe.current.load();
      probe.current.handleTargetChange(feedbackTarget('image.png'));
      probe.current.focusCapsule('feedback-a');
      probe.current.changeCapsule('feedback-a', 'Protected draft');
      probe.current.invalidateTarget('image.png');
    });

    expect(probe.current.currentTarget).toBeUndefined();
    expect(probe.current.focusedCapsuleId).toBeUndefined();
    expect(probe.current.capsulesForPath('image.png').find((capsule) => capsule.itemId === 'feedback-a')?.comment)
      .toBe('Protected draft');
    await probe.unmount();
  });

  it('does not carry Bar hover ownership across forced target invalidation', async () => {
    vi.useFakeTimers();
    const probe = await renderInteraction(apiFixture());
    try {
      await act(async () => {
        probe.current.handleTargetChange(feedbackTarget('first.png'));
        probe.current.handlePointerEnter();
        probe.current.focusCapsule('feedback-a');
        probe.current.invalidateTarget('first.png');
        probe.current.handleTargetChange(feedbackTarget('second.png'));
        probe.current.handleTargetChange(undefined);
      });

      await act(async () => vi.advanceTimersByTime(120));
      expect(probe.current.currentTarget).toBeUndefined();
    } finally {
      await probe.unmount();
      vi.useRealTimers();
    }
  });

  it('shows only the newly hovered file feedback after the previous file capsule loses focus', async () => {
    const probe = await renderInteraction(apiFixture({
      readCanvasFeedback: vi.fn(async () => multiFileFeedbackFixture())
    }));
    const first = feedbackTarget('image.png');
    const second = feedbackTarget('second.png');

    await act(async () => {
      await probe.current.load();
      probe.current.handleTargetChange(first);
      probe.current.focusCapsule('feedback-a');
      probe.current.handleTargetChange(second);
    });
    expect(probe.current.currentTarget?.projectRelativePath).toBe('image.png');

    await act(async () => {
      await probe.current.blurCapsule('feedback-a');
    });

    expect(probe.current.currentTarget?.projectRelativePath).toBe('second.png');
    expect(probe.current.capsulesForPath('second.png').map((capsule) => capsule.comment)).toEqual([
      'Only on second'
    ]);
    expect(probe.current.capsulesForPath('image.png').map((capsule) => capsule.comment)).toEqual([
      'Original A',
      'Original B'
    ]);
    await probe.unmount();
  });

  it('keeps the current file feedback when focus moves from its Capsule to a tool in the same Bar', async () => {
    const probe = await renderInteraction(apiFixture());
    const target = feedbackTarget('image.png');

    await act(async () => {
      await probe.current.load();
      probe.current.handleTargetChange(target);
      probe.current.focusCapsule('feedback-a');
      probe.current.handlePointerEnter();
      probe.current.handleTargetChange(undefined);
      await probe.current.blurCapsule('feedback-a');
    });

    expect(probe.current.currentTarget?.projectRelativePath).toBe('image.png');
    expect(probe.current.capsulesForPath('image.png').map((capsule) => capsule.comment)).toEqual([
      'Original A',
      'Original B'
    ]);
    await probe.unmount();
  });

  it('delays Feedback Bar dismissal after pointer leave and cancels it when the pointer returns', async () => {
    vi.useFakeTimers();
    const probe = await renderInteraction(apiFixture());
    try {
      await act(async () => {
        probe.current.handleTargetChange(feedbackTarget('image.png'));
        probe.current.handlePointerEnter();
        probe.current.handlePointerLeave();
      });
      expect(probe.current.currentTarget?.projectRelativePath).toBe('image.png');

      await act(async () => vi.advanceTimersByTime(60));
      await act(async () => probe.current.handlePointerEnter());
      await act(async () => vi.advanceTimersByTime(120));
      expect(probe.current.currentTarget?.projectRelativePath).toBe('image.png');

      await act(async () => probe.current.handlePointerLeave());
      await act(async () => vi.advanceTimersByTime(119));
      expect(probe.current.currentTarget?.projectRelativePath).toBe('image.png');

      await act(async () => vi.advanceTimersByTime(1));
      expect(probe.current.currentTarget).toBeUndefined();
    } finally {
      await probe.unmount();
      vi.useRealTimers();
    }
  });

  it('preserves the remaining dismissal buffer when a focused Capsule blurs after pointer leave', async () => {
    vi.useFakeTimers();
    const probe = await renderInteraction(apiFixture());
    try {
      await act(async () => {
        probe.current.handleTargetChange(feedbackTarget('image.png'));
        probe.current.handlePointerEnter();
        probe.current.focusCapsule('feedback-a');
        probe.current.handlePointerLeave();
      });
      await act(async () => vi.advanceTimersByTime(60));
      await act(async () => probe.current.blurCapsule('feedback-a'));
      await act(async () => vi.advanceTimersByTime(59));

      expect(probe.current.currentTarget?.projectRelativePath).toBe('image.png');

      await act(async () => vi.advanceTimersByTime(1));
      expect(probe.current.currentTarget).toBeUndefined();
    } finally {
      await probe.unmount();
      vi.useRealTimers();
    }
  });

  it('discards a never-written empty capsule locally on blur', async () => {
    const updateCanvasFeedbackEntry = vi.fn<WorkbenchApiClient['updateCanvasFeedbackEntry']>();
    const putFeedbackWorkingCopy = vi.fn<WorkbenchApiClient['putFeedbackWorkingCopy']>();
    const clearFeedbackWorkingCopy = vi.fn<WorkbenchApiClient['clearFeedbackWorkingCopy']>(async () => undefined);
    const probe = await renderInteraction(apiFixture({
      updateCanvasFeedbackEntry,
      putFeedbackWorkingCopy,
      clearFeedbackWorkingCopy
    }));

    let itemId = '';
    await act(async () => {
      itemId = probe.current.createFileCapsule('image.png');
      await probe.current.blurCapsule(itemId);
    });

    expect(probe.current.capsulesForPath('image.png')).toEqual([]);
    expect(updateCanvasFeedbackEntry).not.toHaveBeenCalled();
    expect(putFeedbackWorkingCopy).not.toHaveBeenCalled();
    expect(clearFeedbackWorkingCopy).not.toHaveBeenCalled();
    await probe.unmount();
  });

  it('keeps an accepted Capsule unchanged when close deletion fails', async () => {
    const updateCanvasFeedbackEntry = vi.fn<WorkbenchApiClient['updateCanvasFeedbackEntry']>(async () => {
      throw new Error('delete failed');
    });
    const clearFeedbackWorkingCopy = vi.fn<WorkbenchApiClient['clearFeedbackWorkingCopy']>(async () => undefined);
    const probe = await renderInteraction(apiFixture({
      updateCanvasFeedbackEntry,
      clearFeedbackWorkingCopy
    }));

    await act(async () => {
      await probe.current.load();
      probe.current.focusCapsule('feedback-a');
      await probe.current.deleteCapsule('feedback-a');
    });

    expect(probe.current.capsulesForPath('image.png').find((capsule) => capsule.itemId === 'feedback-a'))
      .toMatchObject({ comment: 'Original A', unsynchronized: false });
    expect(probe.current.focusedCapsuleId).toBe('feedback-a');
    expect(clearFeedbackWorkingCopy).not.toHaveBeenCalled();
    await probe.unmount();
  });

  it('keeps an empty accepted Capsule while failed blur deletion suppresses only its geometry', async () => {
    const updateCanvasFeedbackEntry = vi.fn<WorkbenchApiClient['updateCanvasFeedbackEntry']>(async () => {
      throw new Error('delete failed');
    });
    const clearFeedbackWorkingCopy = vi.fn<WorkbenchApiClient['clearFeedbackWorkingCopy']>(async () => undefined);
    const probe = await renderInteraction(apiFixture({
      readCanvasFeedback: vi.fn(async () => spatialFeedbackFixture()),
      updateCanvasFeedbackEntry,
      clearFeedbackWorkingCopy
    }));

    await act(async () => {
      await probe.current.load();
      probe.current.changeCapsule('feedback-spatial', '');
      await probe.current.blurCapsule('feedback-spatial');
    });

    expect(probe.current.capsulesForPath('image.png')).toContainEqual(expect.objectContaining({
      itemId: 'feedback-spatial',
      comment: '',
      unsynchronized: true
    }));
    expect(probe.current.canvas.suppressedSpatialItemIds.has('feedback-spatial')).toBe(true);
    expect(clearFeedbackWorkingCopy).not.toHaveBeenCalled();
    await probe.unmount();
  });

  it('allows only one accepted-item deletion request at a time', async () => {
    const pendingMutation = deferred<WorkbenchCanvasFeedbackMutationResult>();
    const updateCanvasFeedbackEntry = vi.fn<WorkbenchApiClient['updateCanvasFeedbackEntry']>(() => pendingMutation.promise);
    const probe = await renderInteraction(apiFixture({ updateCanvasFeedbackEntry }));
    await act(async () => probe.current.load());

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = probe.current.deleteCapsule('feedback-a');
      second = probe.current.deleteCapsule('feedback-a');
      await Promise.resolve();
    });
    expect(updateCanvasFeedbackEntry).toHaveBeenCalledTimes(1);

    await act(async () => {
      probe.current.applyEvent({
        type: 'canvas.feedback.changed',
        projectId: 'project-1',
        projectRevision: 2,
        feedback: feedbackFixtureWithout('feedback-a')
      });
      pendingMutation.resolve(mutationResult(feedbackFixtureWithout('feedback-a')));
      await Promise.all([first, second]);
    });
    expect(probe.current.capsulesForPath('image.png').some((capsule) => capsule.itemId === 'feedback-a')).toBe(false);
    await probe.unmount();
  });

  it('does not let an older mutation response overwrite a newer Runtime event', async () => {
    const pendingMutation = deferred<WorkbenchCanvasFeedbackMutationResult>();
    const probe = await renderInteraction(apiFixture({
      updateCanvasFeedbackEntry: vi.fn(() => pendingMutation.promise)
    }));
    await act(async () => probe.current.load());

    let mutation!: Promise<void>;
    await act(async () => {
      mutation = probe.current.setMarks('image.png', ['important']);
      probe.current.applyEvent({
        type: 'canvas.feedback.changed',
        projectId: 'project-1',
        projectRevision: 3,
        feedback: feedbackFixture('Event value')
      } as WorkbenchEvent);
      pendingMutation.resolve({
        ...mutationResult(feedbackFixture('Response value')),
        projectRevision: 2
      });
      await mutation;
    });

    expect(probe.current.capsulesForPath('image.png')[0]?.comment).toBe('Event value');
    await probe.unmount();
  });

  it('allows only one Marks mutation per file at a time', async () => {
    const pendingMutation = deferred<WorkbenchCanvasFeedbackMutationResult>();
    const updateCanvasFeedbackEntry = vi.fn<WorkbenchApiClient['updateCanvasFeedbackEntry']>(() => pendingMutation.promise);
    const probe = await renderInteraction(apiFixture({ updateCanvasFeedbackEntry }));
    await act(async () => probe.current.load());

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = probe.current.setMarks('image.png', ['important']);
      second = probe.current.setMarks('image.png', ['like']);
      await Promise.resolve();
    });

    expect(updateCanvasFeedbackEntry).toHaveBeenCalledTimes(1);
    expect(updateCanvasFeedbackEntry).toHaveBeenCalledWith({
      operation: 'set-marks',
      projectRelativePath: 'image.png',
      marks: ['important']
    });

    await act(async () => {
      pendingMutation.resolve(mutationResult(feedbackFixture()));
      await Promise.all([first, second]);
    });
    await probe.unmount();
  });

  it('keeps user creation order while accepted and local values synchronize independently', async () => {
    const probe = await renderInteraction(apiFixture());
    await act(async () => {
      await probe.current.load();
      probe.current.restoreWorkingCopies({
        'feedback-local-first': {
          itemId: 'feedback-local-first',
          createdAt: '2026-07-22T23:59:59.000Z',
          projectRelativePath: 'image.png',
          kind: 'comment',
          scope: 'file',
          comment: 'Local first'
        }
      });
    });

    expect(probe.current.capsulesForPath('image.png').map((capsule) => capsule.itemId)).toEqual([
      'feedback-local-first',
      'feedback-a',
      'feedback-b'
    ]);
    await probe.unmount();
  });

  it('clears a previously persisted new value when the user empties it before first blur', async () => {
    const clearFeedbackWorkingCopy = vi.fn<WorkbenchApiClient['clearFeedbackWorkingCopy']>(async () => undefined);
    const probe = await renderInteraction(apiFixture({ clearFeedbackWorkingCopy }));
    let itemId = '';

    await act(async () => {
      itemId = probe.current.createFileCapsule('image.png');
      probe.current.changeCapsule(itemId, 'Temporary');
      probe.current.changeCapsule(itemId, '');
      await probe.current.blurCapsule(itemId);
    });

    expect(clearFeedbackWorkingCopy).toHaveBeenCalledWith('project-1', itemId);
    expect(probe.current.capsulesForPath('image.png').some((capsule) => capsule.itemId === itemId)).toBe(false);
    await probe.unmount();
  });

  it('does not let an older blur completion clear a newer tool composition', async () => {
    const mutation = deferred<WorkbenchCanvasFeedbackMutationResult>();
    const updateCanvasFeedbackEntry = vi.fn<WorkbenchApiClient['updateCanvasFeedbackEntry']>(() => mutation.promise);
    const probe = await renderInteraction(apiFixture({ updateCanvasFeedbackEntry }));
    const firstTarget = feedbackTarget('first.png');
    const secondTarget = feedbackTarget('second.mp4');
    let firstItemId = '';
    let firstBlur!: Promise<void>;

    await act(async () => {
      probe.current.handleDraft({
        projectRelativePath: 'first.png',
        kind: 'pin',
        scope: 'file',
        geometry: { type: 'point', x: 0.25, y: 0.5 },
        feedbackBarTarget: firstTarget
      });
    });
    firstItemId = probe.current.composition!.itemId;
    await act(async () => {
      probe.current.changeCapsule(firstItemId, 'First');
      firstBlur = probe.current.blurCapsule(firstItemId);
      await Promise.resolve();
    });
    expect(updateCanvasFeedbackEntry).toHaveBeenCalledTimes(1);

    await act(async () => {
      probe.current.handleDraft({
        projectRelativePath: 'second.mp4',
        kind: 'region',
        scope: 'moment',
        momentTimeSeconds: 3.5,
        feedbackBarTarget: secondTarget
      });
    });
    const secondItemId = probe.current.composition!.itemId;

    await act(async () => {
      mutation.resolve(mutationResult(feedbackFixture()));
      await firstBlur;
    });

    expect(probe.current.composition?.itemId).toBe(secondItemId);
    expect(probe.current.localMode).toBe('rect');
    await probe.unmount();
  });

  it('preserves a newer edit made while an older blur clears its Working Copy', async () => {
    const cleared = deferred<void>();
    const clearFeedbackWorkingCopy = vi.fn<WorkbenchApiClient['clearFeedbackWorkingCopy']>(() => cleared.promise);
    const probe = await renderInteraction(apiFixture({ clearFeedbackWorkingCopy }));
    await act(async () => probe.current.load());
    let blur!: Promise<void>;

    await act(async () => {
      probe.current.focusCapsule('feedback-a');
      probe.current.changeCapsule('feedback-a', 'First save');
      blur = probe.current.blurCapsule('feedback-a');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clearFeedbackWorkingCopy).toHaveBeenCalledWith('project-1', 'feedback-a');

    await act(async () => {
      probe.current.focusCapsule('feedback-a');
      probe.current.changeCapsule('feedback-a', 'Newer edit');
      cleared.resolve();
      await blur;
    });

    expect(probe.current.capsulesForPath('image.png')[0]?.comment).toBe('Newer edit');
    await probe.unmount();
  });

  it('keeps incomplete spatial tool composition out of editable Capsules', async () => {
    const probe = await renderInteraction(apiFixture());

    await act(async () => {
      probe.current.handleDraft({
        projectRelativePath: 'video.mp4',
        kind: 'pin',
        scope: 'moment',
        momentTimeSeconds: 6.25,
        feedbackBarTarget: feedbackTarget('video.mp4')
      });
    });

    expect(probe.current.composition).toMatchObject({
      projectRelativePath: 'video.mp4',
      kind: 'pin',
      momentTimeSeconds: 6.25
    });
    expect(probe.current.capsulesForPath('video.mp4')).toEqual([]);
    expect(probe.current.localMode).toBe('pin');
    await probe.unmount();
  });

  it('creates a point Capsule on pointer release and keeps its textarea ready for input', async () => {
    const probe = await renderPointInteraction(apiFixture());
    await act(async () => {
      probe.current.handleTargetChange(feedbackTarget('image.png'));
    });

    expect(probe.current.currentTarget?.projectRelativePath).toBe('image.png');
    expect(probe.container.querySelector('[data-canvas-feedback-bar="true"]')).not.toBeNull();
    const addPin = probe.container.querySelector('[aria-label="Add feedback pin"]') as HTMLButtonElement;
    await act(async () => addPin.click());
    const layer = probe.container.querySelector('[data-canvas-media-feedback-layer="true"]') as HTMLDivElement;
    layer.setPointerCapture = vi.fn();
    layer.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({})
    });

    await act(async () => {
      layer.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 25,
        clientY: 40,
        pointerId: 1
      }));
    });
    expect(probe.container.querySelector('textarea')).toBeNull();

    await act(async () => {
      layer.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        clientX: 25,
        clientY: 40,
        pointerId: 1
      }));
    });
    const textarea = probe.container.querySelector('textarea') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);
    await act(async () => {
      textarea.value = 'Point note';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(probe.current.capsulesForPath('image.png')).toEqual([
      expect.objectContaining({
        kind: 'pin',
        geometry: { type: 'point', x: 0.25, y: 0.4 },
        comment: 'Point note'
      })
    ]);
    await probe.unmount();
  });

  it('keeps Comment visible until rectangle geometry is actually placed', async () => {
    const probe = await renderPointInteraction(apiFixture());
    await act(async () => {
      probe.current.handleTargetChange(feedbackTarget('image.png'));
    });

    const addRectangle = probe.container.querySelector('[aria-label="Add feedback rectangle"]') as HTMLButtonElement;
    await act(async () => addRectangle.click());

    expect(probe.current.localMode).toBe('rect');
    expect(probe.container.querySelector('[data-canvas-feedback-add-comment="true"]')).not.toBeNull();
    expect(probe.container.querySelector('textarea')).toBeNull();

    await act(async () => {
      probe.current.handleDraft({
        projectRelativePath: 'image.png',
        kind: 'region',
        scope: 'file',
        geometry: { type: 'rect', x: 0.2, y: 0.3, width: 0.4, height: 0.25 },
        feedbackBarTarget: feedbackTarget('image.png')
      });
    });

    expect(probe.container.querySelector('[data-canvas-feedback-add-comment="true"]')).toBeNull();
    expect(document.activeElement).toBe(probe.container.querySelector('textarea'));
    await probe.unmount();
  });

  it('projects restored spatial Working Copies independently across files', async () => {
    const probe = await renderInteraction(apiFixture());

    await act(async () => {
      probe.current.restoreWorkingCopies({
        'local-a': {
          itemId: 'local-a',
          createdAt: '2026-07-23T00:00:00.000Z',
          projectRelativePath: 'a.png',
          kind: 'pin',
          scope: 'file',
          geometry: { type: 'point', x: 0.2, y: 0.3 },
          comment: 'A'
        },
        'local-b': {
          itemId: 'local-b',
          createdAt: '2026-07-23T00:00:01.000Z',
          projectRelativePath: 'b.png',
          kind: 'region',
          scope: 'file',
          geometry: { type: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          comment: 'B'
        }
      });
    });

    expect(probe.current.canvas.localSpatialItems.map((item) => item.projectRelativePath)).toEqual([
      'a.png',
      'b.png'
    ]);
    await probe.unmount();
  });

  it('sends the exact non-empty textarea value and releases the creation affordance after blur', async () => {
    const updateCanvasFeedbackEntry = vi.fn<WorkbenchApiClient['updateCanvasFeedbackEntry']>(async () => {
      throw new Error('save failed');
    });
    const probe = await renderInteraction(apiFixture({ updateCanvasFeedbackEntry }));
    let itemId = '';

    await act(async () => {
      itemId = probe.current.createFileCapsule('image.png');
      probe.current.changeCapsule(itemId, '  First line\nSecond line  ');
      await probe.current.blurCapsule(itemId);
    });

    expect(updateCanvasFeedbackEntry).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'add-item',
      item: expect.objectContaining({ comment: '  First line\nSecond line  ' })
    }));
    expect(probe.current.authoringItemId).toBeUndefined();
    expect(probe.current.capsulesForPath('image.png').find((capsule) => capsule.itemId === itemId)?.comment)
      .toBe('  First line\nSecond line  ');
    await probe.unmount();
  });
});

function InteractionProbe({
  api,
  overlayRuntime,
  onValue
}: {
  api: WorkbenchApiClient;
  overlayRuntime: ReturnType<typeof createCanvasOverlayRuntime>;
  onValue(value: CanvasFeedbackInteraction): void;
}): null {
  const interaction = useCanvasFeedbackInteraction({
    api,
    projectId: 'project-1',
    overlayRuntime,
    notifyUnavailable: vi.fn()
  });
  useEffect(() => onValue(interaction), [interaction, onValue]);
  return null;
}

async function renderInteraction(api: WorkbenchApiClient): Promise<{
  readonly current: CanvasFeedbackInteraction;
  unmount(): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const overlayRuntime = createCanvasOverlayRuntime();
  let current!: CanvasFeedbackInteraction;
  await act(async () => {
    root.render(
      <InteractionProbe
        api={api}
        overlayRuntime={overlayRuntime}
        onValue={(value) => { current = value; }}
      />
    );
  });
  return {
    get current() { return current; },
    async unmount() {
      await act(async () => root.unmount());
      overlayRuntime.dispose();
      container.remove();
    }
  };
}

function PointInteractionProbe({
  api,
  overlayRuntime,
  onValue
}: {
  api: WorkbenchApiClient;
  overlayRuntime: ReturnType<typeof createCanvasOverlayRuntime>;
  onValue(value: CanvasFeedbackInteraction): void;
}): ReactElement {
  const interaction = useCanvasFeedbackInteraction({
    api,
    projectId: 'project-1',
    overlayRuntime,
    notifyUnavailable: vi.fn()
  });
  useEffect(() => onValue(interaction), [interaction, onValue]);
  const draftRegions = interaction.canvas.localSpatialItems
    .filter((item): item is typeof item & { geometry: CanvasFeedbackGeometry } => (
      item.projectRelativePath === 'image.png' && item.geometry !== undefined
    ))
    .map((item) => ({ itemId: item.itemId, geometry: item.geometry }));
  return (
    <I18nProvider locale="en">
      <CanvasFeedbackInteractionBar interaction={interaction} overlayRuntime={overlayRuntime} />
      <CanvasMediaFeedbackLayer
        items={[]}
        mode={interaction.localMode}
        draftRegions={draftRegions}
        activeItemId={interaction.focusedCapsuleId}
        onRegionDraft={(geometry) => interaction.handleDraft({
          projectRelativePath: 'image.png',
          kind: 'pin',
          scope: 'file',
          geometry,
          feedbackBarTarget: feedbackTarget('image.png')
        })}
      />
    </I18nProvider>
  );
}

async function renderPointInteraction(api: WorkbenchApiClient): Promise<{
  container: HTMLDivElement;
  readonly current: CanvasFeedbackInteraction;
  unmount(): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const overlayRuntime = createCanvasOverlayRuntime();
  let current!: CanvasFeedbackInteraction;
  await act(async () => {
    root.render(
      <PointInteractionProbe
        api={api}
        overlayRuntime={overlayRuntime}
        onValue={(value) => { current = value; }}
      />
    );
  });
  return {
    container,
    get current() { return current; },
    async unmount() {
      await act(async () => root.unmount());
      overlayRuntime.dispose();
      container.remove();
    }
  };
}

function apiFixture(overrides: Partial<WorkbenchApiClient> = {}): WorkbenchApiClient {
  return {
    readCanvasFeedback: vi.fn(async () => feedbackFixture()),
    updateCanvasFeedbackEntry: vi.fn(async () => mutationResult(feedbackFixture())),
    putFeedbackWorkingCopy: vi.fn(async (_projectId, value) => value),
    clearFeedbackWorkingCopy: vi.fn(async () => undefined),
    ...overrides
  } as unknown as WorkbenchApiClient;
}

function feedbackFixture(firstComment = 'Original A'): CanvasFeedbackDocument {
  return {
    updatedAt: '2026-07-23T00:00:00.000Z',
    entries: {
      'image.png': {
        projectRelativePath: 'image.png',
        marks: [],
        nextMomentLabel: 1,
        nextSpatialLabel: 1,
        items: [
          {
            id: 'feedback-a',
            kind: 'comment',
            scope: 'file',
            comment: firstComment,
            createdAt: '2026-07-23T00:00:00.000Z',
            updatedAt: '2026-07-23T00:00:00.000Z'
          },
          {
            id: 'feedback-b',
            kind: 'comment',
            scope: 'file',
            comment: 'Original B',
            createdAt: '2026-07-23T00:00:01.000Z',
            updatedAt: '2026-07-23T00:00:01.000Z'
          }
        ],
        updatedAt: '2026-07-23T00:00:01.000Z'
      }
    }
  };
}

function multiFileFeedbackFixture(): CanvasFeedbackDocument {
  const first = feedbackFixture();
  return {
    ...first,
    entries: {
      ...first.entries,
      'second.png': {
        projectRelativePath: 'second.png',
        marks: [],
        nextMomentLabel: 1,
        nextSpatialLabel: 1,
        items: [{
          id: 'feedback-second',
          kind: 'comment',
          scope: 'file',
          comment: 'Only on second',
          createdAt: '2026-07-23T00:00:02.000Z',
          updatedAt: '2026-07-23T00:00:02.000Z'
        }],
        updatedAt: '2026-07-23T00:00:02.000Z'
      }
    }
  };
}

function spatialFeedbackFixture(): CanvasFeedbackDocument {
  return {
    updatedAt: '2026-07-23T00:00:00.000Z',
    entries: {
      'image.png': {
        projectRelativePath: 'image.png',
        marks: [],
        nextMomentLabel: 1,
        nextSpatialLabel: 2,
        items: [{
          id: 'feedback-spatial',
          label: 1,
          kind: 'pin',
          scope: 'file',
          geometry: { type: 'point', x: 0.25, y: 0.5 },
          comment: 'Pin note',
          createdAt: '2026-07-23T00:00:00.000Z',
          updatedAt: '2026-07-23T00:00:00.000Z'
        }],
        updatedAt: '2026-07-23T00:00:00.000Z'
      }
    }
  };
}

function feedbackFixtureWithout(itemId: string): CanvasFeedbackDocument {
  const feedback = feedbackFixture();
  const entry = feedback.entries['image.png']!;
  return {
    ...feedback,
    entries: {
      ...feedback.entries,
      'image.png': {
        ...entry,
        items: entry.items.filter((item) => item.id !== itemId)
      }
    }
  };
}

function mutationResult(_feedback: CanvasFeedbackDocument): WorkbenchCanvasFeedbackMutationResult {
  return {
    projectId: 'project-1',
    projectRevision: 2
  };
}

function feedbackTarget(projectRelativePath: string) {
  return {
    projectRelativePath,
    nodeRect: { x: 10, y: 20, width: 300, height: 180 },
    surfaceRect: { x: 0, y: 0, width: 1280, height: 720 },
    camera: { x: 12, y: 24, z: 1 },
    localToolset: 'image' as const,
    canStartVideoMomentFeedback: false,
    entry: undefined
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
