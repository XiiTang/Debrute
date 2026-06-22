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

  it('rejects old v1 feedback documents instead of migrating them', () => {
    expect(() => normalizeCanvasFeedbackDocument({
      schemaVersion: 1,
      updatedAt: NOW,
      entries: {}
    })).toThrow('Invalid Canvas feedback document.');
  });

  it('preserves local regions when updating image-level marks and note', () => {
    const withRegion = updateCanvasFeedbackEntry(createEmptyCanvasFeedbackDocument(NOW), {
      operation: 'add-region',
      projectRelativePath: '拼接图/page.png',
      region: {
        kind: 'pin',
        geometry: { type: 'point', x: 0.42, y: 0.31 },
        comment: 'face is blurry'
      }
    }, NOW);

    const next = updateCanvasFeedbackEntry(withRegion, {
      operation: 'set-entry',
      projectRelativePath: '拼接图/page.png',
      marks: ['like', 'needs_revision'],
      note: 'overall direction works'
    }, LATER);

    expect(next.entries['拼接图/page.png']).toMatchObject({
      projectRelativePath: '拼接图/page.png',
      marks: ['like', 'needs_revision'],
      note: 'overall direction works',
      nextRegionLabel: 2,
      regions: [{
        label: 1,
        kind: 'pin',
        geometry: { type: 'point', x: 0.42, y: 0.31 },
        comment: 'face is blurry'
      }]
    });
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
          note: 'note',
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

  it('rejects duplicate local feedback ids and labels', () => {
    const duplicateLabel: CanvasFeedbackDocument = {
      schemaVersion: 2,
      updatedAt: NOW,
      entries: {
        'assets/page.png': {
          projectRelativePath: 'assets/page.png',
          marks: [],
          note: '',
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
  });
});
