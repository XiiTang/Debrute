import { describe, expect, it } from 'vitest';
import { createCanvasDocument } from '@debrute/canvas-core';
import { assertCurrentCanvasDocument } from './CanvasProjectionService';

describe('CanvasProjectionService Canvas document validation', () => {
  it('accepts current Canvas documents with a stored display name', () => {
    const canvas = createCanvasDocument({ id: 'canvas-1' });

    expect(assertCurrentCanvasDocument({
      ...canvas,
      name: '故事板'
    }, '/project/.debrute/canvases/canvas-1.json')).toMatchObject({
      id: 'canvas-1',
      name: '故事板'
    });
  });

  it('rejects Canvas documents without a current-schema display name', () => {
    const canvas = createCanvasDocument({ id: 'canvas-1' });
    const { name: _name, ...missingName } = canvas;

    expect(() => assertCurrentCanvasDocument(
      missingName,
      '/project/.debrute/canvases/canvas-1.json'
    )).toThrow('Invalid canvas document: /project/.debrute/canvases/canvas-1.json');

    expect(() => assertCurrentCanvasDocument({
      ...canvas,
      name: '  story  '
    }, '/project/.debrute/canvases/canvas-1.json')).toThrow('Invalid canvas document: /project/.debrute/canvases/canvas-1.json');

    expect(() => assertCurrentCanvasDocument({
      ...canvas,
      name: ''
    }, '/project/.debrute/canvases/canvas-1.json')).toThrow('Invalid canvas document: /project/.debrute/canvases/canvas-1.json');
  });
});
