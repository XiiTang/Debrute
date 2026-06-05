import { describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { cameraForCanvasContent } from './CanvasCameraBounds';

describe('CanvasCameraBounds', () => {
  it('fits visible canvas content that is far from the origin', () => {
    const camera = cameraForCanvasContent({
      nodes: [
        imageNode('flow/cover-a.png', 19_300, 320, 3_840, 2_160),
        imageNode('flow/cover-b.png', 27_140, 3_200, 3_840, 2_160)
      ],
      surfaceSize: { width: 756, height: 469 }
    });

    expect(camera).toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
      z: expect.any(Number)
    });
    expect(camera?.z).toBeGreaterThan(0);
    expect(camera?.z).toBeLessThan(1);
    expect(visibleRect(camera!, { width: 756, height: 469 })).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number)
    });
    expect(rectContains(visibleRect(camera!, { width: 756, height: 469 }), {
      x: 19_300,
      y: 320,
      width: 11_680,
      height: 5_040
    })).toBe(true);
  });

  it('ignores hidden and invalid nodes when fitting content', () => {
    const camera = cameraForCanvasContent({
      nodes: [
        { ...imageNode('flow/hidden.png', 100_000, 100_000, 1_000, 1_000), visible: false },
        imageNode('flow/visible.png', 1_000, 2_000, 400, 200),
        imageNode('flow/invalid.png', 0, 0, 0, 100)
      ],
      surfaceSize: { width: 1_000, height: 600 }
    });

    expect(camera).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      z: expect.any(Number)
    });
    expect(camera?.z).toBeGreaterThan(1);
  });
});

function imageNode(
  projectRelativePath: string,
  x: number,
  y: number,
  width: number,
  height: number
): ProjectedCanvasNode {
  return {
    projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'image',
    x,
    y,
    width,
    height,
    z: 0,
    visible: true,
    locked: false,
    availability: {
      state: 'available',
      size: 1,
      mimeType: 'image/png',
      fileUrl: '',
      revision: 'rev'
    }
  };
}

function visibleRect(
  camera: { x: number; y: number; z: number },
  surfaceSize: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  return {
    x: -camera.x / camera.z,
    y: -camera.y / camera.z,
    width: surfaceSize.width / camera.z,
    height: surfaceSize.height / camera.z
  };
}

function rectContains(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number }
): boolean {
  return outer.x <= inner.x
    && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height;
}
