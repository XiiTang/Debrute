import { describe, expect, it } from 'vitest';
import {
  CANVAS_FEEDBACK_SCHEMA_VERSION,
  canvasFeedbackRenderedProjectPath,
  createEmptyCanvasFeedbackDocument,
  normalizeCanvasFeedbackDocument,
  updateCanvasFeedbackEntry,
  type CanvasFeedbackDocument
} from './index';

const NOW = '2026-06-21T12:00:00.000Z';
const LATER = '2026-06-21T12:00:01.000Z';

describe('Canvas feedback v2', () => {
  it('creates an empty v2 feedback document', () => {
    expect(CANVAS_FEEDBACK_SCHEMA_VERSION).toBe(2);
    expect(createEmptyCanvasFeedbackDocument(NOW)).toEqual({
      schemaVersion: 2,
      updatedAt: NOW,
      entries: {}
    });
  });

  it('rejects invalid schema versions', () => {
    expect(() => normalizeCanvasFeedbackDocument({
      schemaVersion: 1,
      updatedAt: NOW,
      entries: {}
    })).toThrow('Invalid Canvas feedback document.');
  });

  it('updates marks independently from file-level comments and local regions', () => {
    const withComment = updateCanvasFeedbackEntry(createEmptyCanvasFeedbackDocument(NOW), {
      operation: 'add-comment',
      projectRelativePath: 'assets/page.png',
      comment: 'overall direction works'
    }, NOW);
    const withRegion = updateCanvasFeedbackEntry(withComment, {
      operation: 'add-region',
      projectRelativePath: 'assets/page.png',
      region: {
        kind: 'pin',
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
      comments: [{
        comment: 'overall direction works',
        createdAt: NOW,
        updatedAt: NOW
      }],
      nextRegionLabel: 2,
      regions: [{
        label: 1,
        kind: 'pin',
        geometry: { type: 'point', x: 0.42, y: 0.31 },
        comment: 'face is blurry'
      }]
    });
  });

  it('adds updates and deletes file-level comments', () => {
    const first = updateCanvasFeedbackEntry(createEmptyCanvasFeedbackDocument(NOW), {
      operation: 'add-comment',
      projectRelativePath: 'assets/page.png',
      comment: ' first comment '
    }, NOW);
    const commentId = first.entries['assets/page.png']!.comments[0]!.id;
    const second = updateCanvasFeedbackEntry(first, {
      operation: 'add-comment',
      projectRelativePath: 'assets/page.png',
      comment: 'second comment'
    }, LATER);
    const updated = updateCanvasFeedbackEntry(second, {
      operation: 'update-comment',
      projectRelativePath: 'assets/page.png',
      commentId,
      comment: 'updated comment'
    }, LATER);
    const deleted = updateCanvasFeedbackEntry(updated, {
      operation: 'delete-comment',
      projectRelativePath: 'assets/page.png',
      commentId
    }, LATER);

    expect(first.entries['assets/page.png']!.comments).toMatchObject([{
      id: commentId,
      comment: 'first comment',
      createdAt: NOW,
      updatedAt: NOW
    }]);
    expect(second.entries['assets/page.png']!.comments).toHaveLength(2);
    expect(updated.entries['assets/page.png']!.comments[0]).toMatchObject({
      id: commentId,
      comment: 'updated comment',
      createdAt: NOW,
      updatedAt: LATER
    });
    expect(deleted.entries['assets/page.png']!.comments.map((item) => item.comment)).toEqual(['second comment']);
  });

  it('allocates non-conflicting comment ids for one timestamp', () => {
    const first = updateCanvasFeedbackEntry(createEmptyCanvasFeedbackDocument(NOW), {
      operation: 'add-comment',
      projectRelativePath: 'assets/page.png',
      comment: 'first'
    }, NOW);
    const firstId = first.entries['assets/page.png']!.comments[0]!.id;
    const second = updateCanvasFeedbackEntry(first, {
      operation: 'add-comment',
      projectRelativePath: 'assets/page.png',
      comment: 'second'
    }, NOW);
    const deleted = updateCanvasFeedbackEntry(second, {
      operation: 'delete-comment',
      projectRelativePath: 'assets/page.png',
      commentId: firstId
    }, NOW);
    const third = updateCanvasFeedbackEntry(deleted, {
      operation: 'add-comment',
      projectRelativePath: 'assets/page.png',
      comment: 'third'
    }, NOW);

    expect(third.entries['assets/page.png']!.comments.map((comment) => comment.id)).toEqual([
      `comment-${NOW.replace(/[^0-9]/g, '')}-2`,
      `comment-${NOW.replace(/[^0-9]/g, '')}-3`
    ]);
  });

  it('removes an entry when the last mark comment and region are removed', () => {
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

  it('allocates stable non-reused labels for pins and rectangles', () => {
    const first = updateCanvasFeedbackEntry(createEmptyCanvasFeedbackDocument(NOW), {
      operation: 'add-region',
      projectRelativePath: 'assets/page.png',
      region: {
        kind: 'pin',
        geometry: { type: 'point', x: 0.1, y: 0.2 },
        comment: 'pin comment'
      }
    }, NOW);
    const firstRegionId = first.entries['assets/page.png']!.regions[0]!.id;
    const second = updateCanvasFeedbackEntry(first, {
      operation: 'add-region',
      projectRelativePath: 'assets/page.png',
      region: {
        kind: 'region',
        geometry: { type: 'rect', x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
        comment: 'rect comment'
      }
    }, NOW);
    const third = updateCanvasFeedbackEntry(second, {
      operation: 'delete-region',
      projectRelativePath: 'assets/page.png',
      regionId: firstRegionId
    }, LATER);
    const fourth = updateCanvasFeedbackEntry(third, {
      operation: 'add-region',
      projectRelativePath: 'assets/page.png',
      region: {
        kind: 'region',
        geometry: { type: 'rect', x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
        comment: 'second rect comment'
      }
    }, LATER);

    expect(fourth.entries['assets/page.png']!.regions.map((region) => region.label)).toEqual([2, 3]);
    expect(fourth.entries['assets/page.png']!.nextRegionLabel).toBe(4);
  });

  it('rejects invalid geometry and empty durable comments', () => {
    const document = createEmptyCanvasFeedbackDocument(NOW);
    expect(() => updateCanvasFeedbackEntry(document, {
      operation: 'add-region',
      projectRelativePath: 'assets/page.png',
      region: {
        kind: 'pin',
        geometry: { type: 'point', x: 1.2, y: 0.2 },
        comment: 'outside'
      }
    }, NOW)).toThrow('Canvas feedback point x must be between 0 and 1.');

    expect(() => updateCanvasFeedbackEntry(document, {
      operation: 'add-region',
      projectRelativePath: 'assets/page.png',
      region: {
        kind: 'region',
        geometry: { type: 'rect', x: 0.2, y: 0.2, width: 0, height: 0.1 },
        comment: 'bad size'
      }
    }, NOW)).toThrow('Canvas feedback region width must be greater than 0.');

    expect(() => updateCanvasFeedbackEntry(document, {
      operation: 'add-region',
      projectRelativePath: 'assets/page.png',
      region: {
        kind: 'pin',
        geometry: { type: 'point', x: 0.2, y: 0.2 },
        comment: '   '
      }
    }, NOW)).toThrow('Canvas feedback region comment must be non-empty.');

    expect(() => updateCanvasFeedbackEntry(document, {
      operation: 'add-comment',
      projectRelativePath: 'assets/page.png',
      comment: '   '
    }, NOW)).toThrow('Canvas feedback comment must be non-empty.');
  });

  it('derives rendered feedback paths without storing them in the feedback document', () => {
    expect(canvasFeedbackRenderedProjectPath('拼接图/韩语翻译-liked-page1-8-右到左.png')).toBe(
      '.debrute/reviews/rendered-feedback/拼接图/韩语翻译-liked-page1-8-右到左.png.annotated.png'
    );
    expect(canvasFeedbackRenderedProjectPath('assets/page.01.jpg')).toBe(
      '.debrute/reviews/rendered-feedback/assets/page.01.jpg.annotated.png'
    );
    expect(() => canvasFeedbackRenderedProjectPath('.debrute/reviews/rendered-feedback/assets/page.png.annotated.png')).toThrow(
      'Canvas feedback cannot target rendered feedback artifacts.'
    );
  });

  it('normalizes a complete v2 document and rejects mismatched entry keys', () => {
    const document: CanvasFeedbackDocument = {
      schemaVersion: 2,
      updatedAt: NOW,
      entries: {
        'assets/page.png': {
          projectRelativePath: 'assets/page.png',
          marks: ['like'],
          comments: [{
            id: 'comment-1',
            comment: 'overall',
            createdAt: NOW,
            updatedAt: NOW
          }],
          nextRegionLabel: 2,
          regions: [{
            id: 'region-1',
            label: 1,
            kind: 'pin',
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
      schemaVersion: 2,
      updatedAt: NOW,
      entries: {
        'assets/page.png': {
          projectRelativePath: 'assets/page.png',
          marks: [],
          comments: [],
          nextRegionLabel: 1,
          regions: [],
          updatedAt: NOW,
          extra: 'unexpected'
        }
      }
    })).toThrow('Invalid Canvas feedback entry.');
  });

  it('rejects duplicate local feedback ids labels and comment ids', () => {
    const duplicateLabel: CanvasFeedbackDocument = {
      schemaVersion: 2,
      updatedAt: NOW,
      entries: {
        'assets/page.png': {
          projectRelativePath: 'assets/page.png',
          marks: [],
          comments: [],
          nextRegionLabel: 3,
          regions: [{
            id: 'region-1',
            label: 1,
            kind: 'pin',
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'first',
            createdAt: NOW,
            updatedAt: NOW
          }, {
            id: 'region-2',
            label: 1,
            kind: 'pin',
            geometry: { type: 'point', x: 0.4, y: 0.5 },
            comment: 'second',
            createdAt: NOW,
            updatedAt: NOW
          }],
          updatedAt: NOW
        }
      }
    };
    const duplicateCommentId: CanvasFeedbackDocument = {
      schemaVersion: 2,
      updatedAt: NOW,
      entries: {
        'assets/page.png': {
          projectRelativePath: 'assets/page.png',
          marks: [],
          comments: [{
            id: 'comment-1',
            comment: 'first',
            createdAt: NOW,
            updatedAt: NOW
          }, {
            id: 'comment-1',
            comment: 'second',
            createdAt: NOW,
            updatedAt: NOW
          }],
          nextRegionLabel: 1,
          regions: [],
          updatedAt: NOW
        }
      }
    };

    expect(() => normalizeCanvasFeedbackDocument(duplicateLabel)).toThrow(
      'Canvas feedback region labels must be unique.'
    );
    expect(() => normalizeCanvasFeedbackDocument({
      ...duplicateLabel,
      entries: {
        'assets/page.png': {
          ...duplicateLabel.entries['assets/page.png']!,
          regions: duplicateLabel.entries['assets/page.png']!.regions.map((region, index) => ({
            ...region,
            id: 'region-1',
            label: index + 1
          }))
        }
      }
    })).toThrow('Canvas feedback region ids must be unique.');
    expect(() => normalizeCanvasFeedbackDocument(duplicateCommentId)).toThrow(
      'Canvas feedback comment ids must be unique.'
    );
  });
});
