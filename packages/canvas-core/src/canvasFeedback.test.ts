import { describe, expect, it } from 'vitest';
import {
  CANVAS_FEEDBACK_MARKS,
  canvasFeedbackEntryHasFileSpatialItems,
  canvasFeedbackItemsForMoment,
  canvasFeedbackMomentRefs,
  canvasFeedbackRenderedMomentProjectPath,
  canvasFeedbackRenderedProjectPath,
  createEmptyCanvasFeedbackDocument,
  normalizeCanvasFeedbackDocument,
  updateCanvasFeedbackEntry,
  type CanvasFeedbackDocument,
  type CanvasFeedbackEntry
} from './index';

const NOW = '2026-06-21T12:00:00.000Z';
const LATER = '2026-06-21T12:00:01.000Z';

describe('Canvas feedback', () => {
  it('normalizes Canvas feedback marks as selected-only fixed-order values', () => {
    const normalized = normalizeCanvasFeedbackDocument({
      updatedAt: '2026-05-26T12:00:00.000Z',
      entries: {
        'flow/a.png': {
          projectRelativePath: 'flow/a.png',
          marks: ['needs_revision', 'like', 'like', 'check'],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      }
    });

    expect(CANVAS_FEEDBACK_MARKS).toEqual([
      'like', 'dislike', 'check', 'cross', 'pending', 'important', 'needs_revision'
    ]);
    expect(normalized.entries['flow/a.png']).toEqual({
      projectRelativePath: 'flow/a.png',
      marks: ['like', 'check', 'needs_revision'],
      nextMomentLabel: 1,
      nextSpatialLabel: 1,
      items: [],
      updatedAt: '2026-05-26T12:00:00.000Z'
    });
  });

  it('updates and deletes Canvas feedback entries as current state', () => {
    const empty = createEmptyCanvasFeedbackDocument('2026-05-26T12:00:00.000Z');
    const added = updateCanvasFeedbackEntry(empty, {
      operation: 'set-marks',
      projectRelativePath: 'flow/a.png',
      marks: ['cross', 'like']
    }, '2026-05-26T12:01:00.000Z');

    expect(added).toEqual({
      updatedAt: '2026-05-26T12:01:00.000Z',
      entries: {
        'flow/a.png': {
          projectRelativePath: 'flow/a.png',
          marks: ['like', 'cross'],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [],
          updatedAt: '2026-05-26T12:01:00.000Z'
        }
      }
    });

    const cleared = updateCanvasFeedbackEntry(added, {
      operation: 'set-marks',
      projectRelativePath: 'flow/a.png',
      marks: []
    }, '2026-05-26T12:02:00.000Z');

    expect(cleared).toEqual({
      updatedAt: '2026-05-26T12:02:00.000Z',
      entries: {}
    });
  });

  it('rejects invalid Canvas feedback documents', () => {
    expect(() => normalizeCanvasFeedbackDocument({
      updatedAt: '2026-05-26T12:00:00.000Z',
      entries: {
        'flow/a.png': {
          projectRelativePath: 'flow/a.png',
          marks: ['unknown'],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      }
    })).toThrow('Invalid Canvas feedback mark: unknown');

    expect(() => normalizeCanvasFeedbackDocument({
      updatedAt: '2026-05-26T12:00:00.000Z',
      entries: {
        'flow/a.png': {
          projectRelativePath: 'flow/b.png',
          marks: ['like'],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      }
    })).toThrow('Canvas feedback entry key must match projectRelativePath: flow/a.png');

    expect(() => updateCanvasFeedbackEntry(
      createEmptyCanvasFeedbackDocument('2026-05-26T12:00:00.000Z'),
      { operation: 'set-marks', projectRelativePath: '../outside.png', marks: ['like'] },
      '2026-05-26T12:01:00.000Z'
    )).toThrow('Invalid Canvas feedback project-relative path: ../outside.png');
  });

  it('creates an empty feedback document', () => {
    expect(createEmptyCanvasFeedbackDocument(NOW)).toEqual({
      updatedAt: NOW,
      entries: {}
    });
  });

  it('rejects invalid document structure', () => {
    expect(() => normalizeCanvasFeedbackDocument({
      updatedAt: 1,
      entries: {}
    })).toThrow('Invalid Canvas feedback document.');
  });

  it('normalizes the final unified feedback item document shape', () => {
    const document: CanvasFeedbackDocument = {
      updatedAt: NOW,
      entries: {
        'assets/page.png': {
          projectRelativePath: 'assets/page.png',
          marks: ['like'],
          nextMomentLabel: 1,
          nextSpatialLabel: 2,
          items: [{
            id: 'item-1',
            kind: 'pin',
            scope: 'file',
            label: 1,
            geometry: { type: 'point', x: 0.5, y: 0.5 },
            comment: 'center',
            createdAt: NOW,
            updatedAt: NOW
          }],
          updatedAt: NOW
        }
      }
    };

    expect(normalizeCanvasFeedbackDocument(document)).toEqual(document);
  });

  it('updates marks independently from file and local items', () => {
    const withFileComment = updateCanvasFeedbackEntry(createEmptyCanvasFeedbackDocument(NOW), {
      operation: 'add-item',
      projectRelativePath: 'assets/page.png',
      item: {
        kind: 'comment',
        scope: 'file',
        comment: 'overall direction works'
      }
    }, NOW);
    const withRegion = updateCanvasFeedbackEntry(withFileComment, {
      operation: 'add-item',
      projectRelativePath: 'assets/page.png',
      item: {
        kind: 'pin',
        scope: 'file',
        geometry: { type: 'point', x: 0.42, y: 0.31 },
        comment: 'face is blurry'
      }
    }, NOW);

    const next = updateCanvasFeedbackEntry(withRegion, {
      operation: 'set-marks',
      projectRelativePath: 'assets/page.png',
      marks: ['like', 'needs_revision']
    }, LATER);

    expect(next.entries['assets/page.png']).toMatchObject({
      projectRelativePath: 'assets/page.png',
      marks: ['like', 'needs_revision'],
      nextMomentLabel: 1,
      nextSpatialLabel: 2,
      items: [{
        kind: 'comment',
        scope: 'file',
        comment: 'overall direction works',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        label: 1,
        kind: 'pin',
        scope: 'file',
        geometry: { type: 'point', x: 0.42, y: 0.31 },
        comment: 'face is blurry'
      }]
    });
  });

  it('adds updates and deletes file-level comments through unified item mutations', () => {
    const first = updateCanvasFeedbackEntry(createEmptyCanvasFeedbackDocument(NOW), {
      operation: 'add-item',
      projectRelativePath: 'assets/page.png',
      item: { kind: 'comment', scope: 'file', comment: ' first comment ' }
    }, NOW);
    const commentId = first.entries['assets/page.png']!.items[0]!.id;
    const second = updateCanvasFeedbackEntry(first, {
      operation: 'add-item',
      projectRelativePath: 'assets/page.png',
      item: { kind: 'comment', scope: 'file', comment: 'second comment' }
    }, LATER);
    const updated = updateCanvasFeedbackEntry(second, {
      operation: 'update-item',
      projectRelativePath: 'assets/page.png',
      itemId: commentId,
      comment: 'updated comment'
    }, LATER);
    const deleted = updateCanvasFeedbackEntry(updated, {
      operation: 'delete-item',
      projectRelativePath: 'assets/page.png',
      itemId: commentId
    }, LATER);

    expect(first.entries['assets/page.png']!.items).toMatchObject([{
      id: commentId,
      kind: 'comment',
      scope: 'file',
      comment: 'first comment',
      createdAt: NOW,
      updatedAt: NOW
    }]);
    expect(second.entries['assets/page.png']!.items).toHaveLength(2);
    expect(updated.entries['assets/page.png']!.items[0]).toMatchObject({
      id: commentId,
      kind: 'comment',
      scope: 'file',
      comment: 'updated comment',
      createdAt: NOW,
      updatedAt: LATER
    });
    expect(deleted.entries['assets/page.png']!.items.map((item) => item.comment)).toEqual(['second comment']);
  });

  it('adds file comments, moment comments, and spatial items through unified item mutations', () => {
    const withFileComment = updateCanvasFeedbackEntry(createEmptyCanvasFeedbackDocument(NOW), {
      operation: 'add-item',
      projectRelativePath: 'assets/clip.mp4',
      item: {
        kind: 'comment',
        scope: 'file',
        comment: 'overall direction works'
      }
    }, NOW);
    const withMomentComment = updateCanvasFeedbackEntry(withFileComment, {
      operation: 'add-item',
      projectRelativePath: 'assets/clip.mp4',
      item: {
        kind: 'comment',
        scope: 'moment',
        momentTimeSeconds: 12.345,
        comment: 'cut here'
      }
    }, NOW);
    const withMomentPin = updateCanvasFeedbackEntry(withMomentComment, {
      operation: 'add-item',
      projectRelativePath: 'assets/clip.mp4',
      item: {
        kind: 'pin',
        scope: 'moment',
        momentTimeSeconds: 12.345,
        geometry: { type: 'point', x: 0.42, y: 0.31 },
        comment: 'face is blurry'
      }
    }, LATER);

    expect(withMomentPin.entries['assets/clip.mp4']).toMatchObject({
      nextMomentLabel: 2,
      nextSpatialLabel: 2,
      items: [{
        kind: 'comment',
        scope: 'file',
        comment: 'overall direction works'
      }, {
        kind: 'comment',
        scope: 'moment',
        moment: { label: 'M1', currentTimeSeconds: 12.345 },
        comment: 'cut here'
      }, {
        kind: 'pin',
        scope: 'moment',
        label: 1,
        moment: { label: 'M1', currentTimeSeconds: 12.345 },
        geometry: { type: 'point', x: 0.42, y: 0.31 },
        comment: 'face is blurry'
      }]
    });
  });

  it('allocates non-conflicting item ids for one timestamp', () => {
    const first = updateCanvasFeedbackEntry(createEmptyCanvasFeedbackDocument(NOW), {
      operation: 'add-item',
      projectRelativePath: 'assets/page.png',
      item: { kind: 'comment', scope: 'file', comment: 'first' }
    }, NOW);
    const firstId = first.entries['assets/page.png']!.items[0]!.id;
    const second = updateCanvasFeedbackEntry(first, {
      operation: 'add-item',
      projectRelativePath: 'assets/page.png',
      item: { kind: 'comment', scope: 'file', comment: 'second' }
    }, NOW);
    const deleted = updateCanvasFeedbackEntry(second, {
      operation: 'delete-item',
      projectRelativePath: 'assets/page.png',
      itemId: firstId
    }, NOW);
    const third = updateCanvasFeedbackEntry(deleted, {
      operation: 'add-item',
      projectRelativePath: 'assets/page.png',
      item: { kind: 'comment', scope: 'file', comment: 'third' }
    }, NOW);

    expect(third.entries['assets/page.png']!.items.map((item) => item.id)).toEqual([
      `item-${NOW.replace(/[^0-9]/g, '')}-2`,
      `item-${NOW.replace(/[^0-9]/g, '')}-3`
    ]);
  });

  it('allocates exact-time moments and entry-local spatial labels without reuse', () => {
    const first = updateCanvasFeedbackEntry(createEmptyCanvasFeedbackDocument(NOW), {
      operation: 'add-item',
      projectRelativePath: 'assets/clip.mp4',
      item: { kind: 'comment', scope: 'moment', momentTimeSeconds: 1.111, comment: 'first moment' }
    }, NOW);
    const sameMoment = updateCanvasFeedbackEntry(first, {
      operation: 'add-item',
      projectRelativePath: 'assets/clip.mp4',
      item: {
        kind: 'region',
        scope: 'moment',
        momentTimeSeconds: 1.111,
        geometry: { type: 'rect', x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        comment: 'same moment'
      }
    }, NOW);
    const newMoment = updateCanvasFeedbackEntry(sameMoment, {
      operation: 'add-item',
      projectRelativePath: 'assets/clip.mp4',
      item: {
        kind: 'pin',
        scope: 'moment',
        momentTimeSeconds: 1.112,
        geometry: { type: 'point', x: 0.4, y: 0.5 },
        comment: 'new moment'
      }
    }, LATER);
    const firstSpatialId = newMoment.entries['assets/clip.mp4']!.items.find((item) => item.kind === 'region')!.id;
    const afterDelete = updateCanvasFeedbackEntry(newMoment, {
      operation: 'delete-item',
      projectRelativePath: 'assets/clip.mp4',
      itemId: firstSpatialId
    }, LATER);
    const afterAdd = updateCanvasFeedbackEntry(afterDelete, {
      operation: 'add-item',
      projectRelativePath: 'assets/clip.mp4',
      item: {
        kind: 'region',
        scope: 'moment',
        momentTimeSeconds: 1.111,
        geometry: { type: 'rect', x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
        comment: 'new region label'
      }
    }, LATER);

    expect(afterAdd.entries['assets/clip.mp4']!.items.map((item) => item.scope === 'moment' ? item.moment.label : '')).toEqual(['M1', 'M2', 'M1']);
    expect(afterAdd.entries['assets/clip.mp4']!.items.filter((item) => item.kind !== 'comment').map((item) => item.label)).toEqual([2, 3]);
    expect(afterAdd.entries['assets/clip.mp4']!.nextMomentLabel).toBe(3);
    expect(afterAdd.entries['assets/clip.mp4']!.nextSpatialLabel).toBe(4);
  });

  it('removes an entry when the last mark or item is removed', () => {
    const withMark = updateCanvasFeedbackEntry(createEmptyCanvasFeedbackDocument(NOW), {
      operation: 'set-marks',
      projectRelativePath: 'assets/page.png',
      marks: ['check']
    }, NOW);
    const withoutMark = updateCanvasFeedbackEntry(withMark, {
      operation: 'set-marks',
      projectRelativePath: 'assets/page.png',
      marks: []
    }, LATER);

    expect(withMark.entries['assets/page.png']).toBeDefined();
    expect(withoutMark.entries['assets/page.png']).toBeUndefined();
  });

  it('rejects invalid geometry, empty durable comments, and invalid moment times', () => {
    const document = createEmptyCanvasFeedbackDocument(NOW);
    expect(() => updateCanvasFeedbackEntry(document, {
      operation: 'add-item',
      projectRelativePath: 'assets/page.png',
      item: {
        kind: 'pin',
        scope: 'file',
        geometry: { type: 'point', x: 1.2, y: 0.2 },
        comment: 'outside'
      }
    }, NOW)).toThrow('Canvas feedback point x must be between 0 and 1.');

    expect(() => updateCanvasFeedbackEntry(document, {
      operation: 'add-item',
      projectRelativePath: 'assets/page.png',
      item: {
        kind: 'region',
        scope: 'file',
        geometry: { type: 'rect', x: 0.2, y: 0.2, width: 0, height: 0.1 },
        comment: 'bad size'
      }
    }, NOW)).toThrow('Canvas feedback region width must be greater than 0.');

    expect(() => updateCanvasFeedbackEntry(document, {
      operation: 'add-item',
      projectRelativePath: 'assets/page.png',
      item: {
        kind: 'pin',
        scope: 'file',
        geometry: { type: 'point', x: 0.2, y: 0.2 },
        comment: '   '
      }
    }, NOW)).toThrow('Canvas feedback comment must be non-empty.');

    expect(() => updateCanvasFeedbackEntry(document, {
      operation: 'add-item',
      projectRelativePath: 'assets/page.png',
      item: { kind: 'comment', scope: 'file', comment: '   ' }
    }, NOW)).toThrow('Canvas feedback comment must be non-empty.');

    expect(() => updateCanvasFeedbackEntry(document, {
      operation: 'add-item',
      projectRelativePath: 'assets/clip.mp4',
      item: { kind: 'comment', scope: 'moment', momentTimeSeconds: -1, comment: 'bad time' }
    }, NOW)).toThrow('Canvas video playback time must be a non-negative finite number.');
  });

  it('derives image and video moment feedback artifact paths without storing them in the document', () => {
    expect(canvasFeedbackRenderedProjectPath('拼接图/韩语翻译-liked-page1-8-右到左.png')).toBe(
      '.debrute/reviews/rendered-feedback/拼接图/韩语翻译-liked-page1-8-右到左.png.annotated.png'
    );
    expect(canvasFeedbackRenderedProjectPath('assets/page.01.jpg')).toBe(
      '.debrute/reviews/rendered-feedback/assets/page.01.jpg.annotated.png'
    );
    expect(canvasFeedbackRenderedMomentProjectPath('assets/clip.mp4', 'M12')).toBe(
      '.debrute/reviews/rendered-feedback/assets/clip.mp4.moment-M12.annotated.png'
    );
    expect(() => canvasFeedbackRenderedProjectPath('.debrute/reviews/rendered-feedback/assets/page.png.annotated.png')).toThrow(
      'Canvas feedback cannot target rendered feedback artifacts.'
    );
  });

  it('normalizes a complete document and rejects mismatched entry keys', () => {
    const document: CanvasFeedbackDocument = {
      updatedAt: NOW,
      entries: {
        'assets/page.png': {
          projectRelativePath: 'assets/page.png',
          marks: ['like'],
          nextMomentLabel: 1,
          nextSpatialLabel: 2,
          items: [{
            id: 'item-1',
            kind: 'pin',
            scope: 'file',
            label: 1,
            geometry: { type: 'point', x: 0.5, y: 0.5 },
            comment: 'center',
            createdAt: NOW,
            updatedAt: NOW
          }],
          updatedAt: NOW
        }
      }
    };
    expect(normalizeCanvasFeedbackDocument(document)).toEqual(document);
    expect(() => normalizeCanvasFeedbackDocument({
      ...document,
      entries: {
        'assets/other.png': document.entries['assets/page.png']
      }
    })).toThrow('Canvas feedback entry key must match projectRelativePath: assets/other.png');
  });

  it('rejects unknown feedback entry fields', () => {
    expect(() => normalizeCanvasFeedbackDocument({
      updatedAt: NOW,
      entries: {
        'assets/page.png': {
          ...feedbackEntry('assets/page.png'),
          extra: 'unexpected'
        }
      }
    })).toThrow('Invalid Canvas feedback entry.');
  });

  it('rejects duplicate item ids and duplicate spatial labels', () => {
    const duplicateLabel: CanvasFeedbackDocument = {
      updatedAt: NOW,
      entries: {
        'assets/page.png': {
          projectRelativePath: 'assets/page.png',
          marks: [],
          nextMomentLabel: 1,
          nextSpatialLabel: 3,
          items: [{
            id: 'item-1',
            kind: 'pin',
            scope: 'file',
            label: 1,
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'first',
            createdAt: NOW,
            updatedAt: NOW
          }, {
            id: 'item-2',
            kind: 'pin',
            scope: 'file',
            label: 1,
            geometry: { type: 'point', x: 0.4, y: 0.5 },
            comment: 'second',
            createdAt: NOW,
            updatedAt: NOW
          }],
          updatedAt: NOW
        }
      }
    };
    const duplicateItemId: CanvasFeedbackDocument = {
      updatedAt: NOW,
      entries: {
        'assets/page.png': {
          projectRelativePath: 'assets/page.png',
          marks: [],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [{
            id: 'item-1',
            kind: 'comment',
            scope: 'file',
            comment: 'first',
            createdAt: NOW,
            updatedAt: NOW
          }, {
            id: 'item-1',
            kind: 'comment',
            scope: 'file',
            comment: 'second',
            createdAt: NOW,
            updatedAt: NOW
          }],
          updatedAt: NOW
        }
      }
    };

    expect(() => normalizeCanvasFeedbackDocument(duplicateLabel)).toThrow(
      'Canvas feedback spatial labels must be unique.'
    );
    expect(() => normalizeCanvasFeedbackDocument(duplicateItemId)).toThrow(
      'Canvas feedback item ids must be unique.'
    );
  });

  it('requires next labels to exceed existing labels', () => {
    expect(() => normalizeCanvasFeedbackDocument({
      updatedAt: NOW,
      entries: {
        'assets/clip.mp4': {
          projectRelativePath: 'assets/clip.mp4',
          marks: [],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [{
            id: 'item-1',
            kind: 'comment',
            scope: 'moment',
            moment: { label: 'M1', currentTimeSeconds: 2 },
            comment: 'cut here',
            createdAt: NOW,
            updatedAt: NOW
          }],
          updatedAt: NOW
        }
      }
    })).toThrow('Canvas feedback nextMomentLabel must exceed existing moment labels.');

    expect(() => normalizeCanvasFeedbackDocument({
      updatedAt: NOW,
      entries: {
        'assets/page.png': {
          projectRelativePath: 'assets/page.png',
          marks: [],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [{
            id: 'item-1',
            kind: 'pin',
            scope: 'file',
            label: 1,
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'pin',
            createdAt: NOW,
            updatedAt: NOW
          }],
          updatedAt: NOW
        }
      }
    })).toThrow('Canvas feedback nextSpatialLabel must exceed existing spatial labels.');
  });

  it('exposes helpers for file spatial items and moment item groups', () => {
    const entry: CanvasFeedbackEntry = {
      projectRelativePath: 'assets/clip.mp4',
      marks: [],
      nextMomentLabel: 3,
      nextSpatialLabel: 3,
      items: [{
        id: 'item-file',
        kind: 'comment',
        scope: 'file',
        comment: 'overall',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'item-moment',
        kind: 'comment',
        scope: 'moment',
        moment: { label: 'M1', currentTimeSeconds: 4.25 },
        comment: 'moment',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'item-pin',
        kind: 'pin',
        scope: 'moment',
        label: 1,
        moment: { label: 'M1', currentTimeSeconds: 4.25 },
        geometry: { type: 'point', x: 0.2, y: 0.3 },
        comment: 'pin',
        createdAt: NOW,
        updatedAt: NOW
      }, {
        id: 'item-region',
        kind: 'region',
        scope: 'moment',
        label: 2,
        moment: { label: 'M2', currentTimeSeconds: 8 },
        geometry: { type: 'rect', x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
        comment: 'region',
        createdAt: NOW,
        updatedAt: NOW
      }],
      updatedAt: NOW
    };

    expect(canvasFeedbackEntryHasFileSpatialItems(entry)).toBe(false);
    expect(canvasFeedbackMomentRefs(entry)).toEqual([
      { label: 'M1', currentTimeSeconds: 4.25 },
      { label: 'M2', currentTimeSeconds: 8 }
    ]);
    expect(canvasFeedbackItemsForMoment(entry, { label: 'M1', currentTimeSeconds: 4.25 }).map((item) => item.id)).toEqual([
      'item-moment',
      'item-pin'
    ]);
  });
});

function feedbackEntry(projectRelativePath = 'assets/page.png'): CanvasFeedbackEntry {
  return {
    projectRelativePath,
    marks: [],
    nextMomentLabel: 1,
    nextSpatialLabel: 1,
    items: [],
    updatedAt: NOW
  };
}
