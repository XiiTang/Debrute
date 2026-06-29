import { describe, expect, it } from 'vitest';
import {
  createCanvasDocument,
  isCanvasDocumentName,
  normalizeCanvasDocumentName
} from './index';

describe('Canvas document names', () => {
  it('creates new Canvas documents with a stable id and default display name', () => {
    expect(createCanvasDocument({ id: 'canvas-1' })).toMatchObject({
      id: 'canvas-1',
      name: 'canvas-1'
    });
  });

  it('normalizes user-submitted Canvas names without restricting Unicode text', () => {
    expect(normalizeCanvasDocumentName('  故事板  ')).toBe('故事板');
    expect(normalizeCanvasDocumentName('Storyboard')).toBe('Storyboard');
  });

  it('rejects empty Canvas names', () => {
    expect(() => normalizeCanvasDocumentName('')).toThrow('Canvas document name must be a non-empty string.');
    expect(() => normalizeCanvasDocumentName('   ')).toThrow('Canvas document name must be a non-empty string.');
  });

  it('recognizes only stored non-empty trimmed Canvas names', () => {
    expect(isCanvasDocumentName('故事板')).toBe(true);
    expect(isCanvasDocumentName(' story ')).toBe(false);
    expect(isCanvasDocumentName('')).toBe(false);
    expect(isCanvasDocumentName(1)).toBe(false);
  });
});
