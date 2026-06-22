import { describe, expect, it } from 'vitest';
import type { CanvasFeedbackDocument, UpdateCanvasFeedbackEntryInput } from '@debrute/canvas-core';
import { createCanvasFeedbackEntryUpdater } from './canvasFeedbackUpdates';

describe('canvas feedback updates', () => {
  const input: UpdateCanvasFeedbackEntryInput = {
    operation: 'set-entry',
    projectRelativePath: 'flow/a.png',
    marks: ['like'],
    note: ''
  };

  it('keeps the current feedback state visible when a save fails', async () => {
    const applied: CanvasFeedbackDocument[] = [];
    const notifications: string[] = [];
    const updateCanvasFeedbackEntry = createCanvasFeedbackEntryUpdater({
      requestUpdate: async () => {
        throw new Error('invalid feedback file');
      },
      applyFeedback: (feedback) => applied.push(feedback),
      notifyUnavailable: (message) => notifications.push(message)
    });

    await expect(updateCanvasFeedbackEntry(input)).resolves.toBe(false);

    expect(applied).toEqual([]);
    expect(notifications).toEqual(['Canvas feedback unavailable: invalid feedback file']);
  });

  it('applies only the newest overlapping save response', async () => {
    const first = deferred<CanvasFeedbackDocument>();
    const second = deferred<CanvasFeedbackDocument>();
    const applied: CanvasFeedbackDocument[] = [];
    const updateCanvasFeedbackEntry = createCanvasFeedbackEntryUpdater({
      requestUpdate: (entry) => entry.projectRelativePath === 'flow/a.png' ? first.promise : second.promise,
      applyFeedback: (feedback) => applied.push(feedback),
      notifyUnavailable: () => undefined
    });

    const firstUpdate = updateCanvasFeedbackEntry(input);
    const secondUpdate = updateCanvasFeedbackEntry({
      operation: 'add-region',
      projectRelativePath: 'flow/b.png',
      region: {
        kind: 'pin',
        geometry: { type: 'point', x: 0.2, y: 0.3 },
        comment: 'fix face'
      }
    });

    first.resolve(feedbackDocument('flow/a.png'));
    await expect(firstUpdate).resolves.toBe(false);
    expect(applied).toEqual([]);

    second.resolve(feedbackDocument('flow/b.png'));
    await expect(secondUpdate).resolves.toBe(true);
    expect(applied).toEqual([feedbackDocument('flow/b.png')]);
  });
});

function feedbackDocument(projectRelativePath: string): CanvasFeedbackDocument {
  return {
    schemaVersion: 2,
    updatedAt: '2026-05-26T12:00:00.000Z',
    entries: {
      [projectRelativePath]: {
        projectRelativePath,
        marks: ['like'],
        note: '',
        nextRegionLabel: 1,
        regions: [],
        updatedAt: '2026-05-26T12:00:00.000Z'
      }
    }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((nextResolve) => {
      resolve = nextResolve;
    }),
    resolve
  };
}
