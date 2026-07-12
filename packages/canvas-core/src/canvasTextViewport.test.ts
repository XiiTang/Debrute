import { describe, expect, it } from 'vitest';
import {
  createCanvasDocument,
  projectCanvas,
  reconcileCanvasNodeElements,
  updateCanvasTextViewportState,
  type CanvasDocument
} from './index';

describe('Canvas text viewport state', { tags: ['canvas-text'] }, () => {
  it('stores text viewport only on matching text nodes', () => {
    const canvas = canvasWithNodes();

    const next = updateCanvasTextViewportState(canvas, {
      updates: [
        { projectRelativePath: 'notes/readme.md', scrollTop: 72.5, scrollLeft: 9 },
        { projectRelativePath: 'media/image.png', scrollTop: 18, scrollLeft: 3 }
      ]
    });

    expect(next.nodeElements.find((node) => node.projectRelativePath === 'notes/readme.md')).toMatchObject({
      textViewport: { scrollTop: 72.5, scrollLeft: 9 }
    });
    expect(next.nodeElements.find((node) => node.projectRelativePath === 'media/image.png')).not.toHaveProperty('textViewport');
  });

  it('removes text viewport state when the scroll pair is top-left', () => {
    const canvas = updateCanvasTextViewportState(canvasWithNodes(), {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });

    const next = updateCanvasTextViewportState(canvas, {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 0, scrollLeft: 0 }]
    });

    expect(next.nodeElements.find((node) => node.projectRelativePath === 'notes/readme.md')).not.toHaveProperty('textViewport');
  });

  it('keeps the same Canvas document when the text viewport is unchanged', () => {
    const canvas = updateCanvasTextViewportState(canvasWithNodes(), {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });

    expect(updateCanvasTextViewportState(canvas, {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    })).toBe(canvas);
  });

  it('rejects invalid text viewport scroll values', () => {
    const canvas = canvasWithNodes();

    expect(() => updateCanvasTextViewportState(canvas, {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: Number.NaN, scrollLeft: 0 }]
    })).toThrow('Canvas text viewport scroll values must be non-negative finite numbers.');

    expect(() => updateCanvasTextViewportState(canvas, {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 0, scrollLeft: -1 }]
    })).toThrow('Canvas text viewport scroll values must be non-negative finite numbers.');
  });

  it('projects textViewport as Canvas document state', () => {
    const canvas = updateCanvasTextViewportState(canvasWithNodes(), {
      updates: [{ projectRelativePath: 'notes/readme.md', scrollTop: 72, scrollLeft: 9 }]
    });

    const projection = projectCanvas({
      canvas,
      nodeAvailability: () => ({
        state: 'available',
        size: 100,
        mimeType: 'text/markdown',
        fileUrl: '',
        revision: 'rev'
      })
    });

    expect(projection.nodes.find((node) => node.projectRelativePath === 'notes/readme.md')).toMatchObject({
      textViewport: { scrollTop: 72, scrollLeft: 9 }
    });
  });

  it('preserves textViewport when reconciling existing text nodes', () => {
    const [textNode] = reconcileCanvasNodeElements({
      existing: [
        {
          projectRelativePath: 'notes/readme.md',
          nodeKind: 'file',
          mediaKind: 'text',
          x: 0,
          y: 0,
          width: 420,
          height: 260,
          z: 0,
          textViewport: { scrollTop: 72, scrollLeft: 9 }
        }
      ],
      desired: [{ projectRelativePath: 'notes/readme.md', nodeKind: 'file', mediaKind: 'text' }],
      layoutSizeForNode: () => ({ width: 420, height: 260 })
    });

    expect(textNode).toMatchObject({
      textViewport: { scrollTop: 72, scrollLeft: 9 }
    });
  });
});

function canvasWithNodes(): CanvasDocument {
  return {
    ...createCanvasDocument({ id: 'canvas-1' }),
    nodeElements: [
      {
        projectRelativePath: 'notes/readme.md',
        nodeKind: 'file',
        mediaKind: 'text',
        x: 0,
        y: 0,
        width: 420,
        height: 260,
        z: 0
      },
      {
        projectRelativePath: 'media/image.png',
        nodeKind: 'file',
        mediaKind: 'image',
        x: 700,
        y: 0,
        width: 320,
        height: 180,
        z: 1
      }
    ]
  };
}
