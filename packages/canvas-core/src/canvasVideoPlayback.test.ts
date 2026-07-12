import { describe, expect, it } from 'vitest';
import {
  createCanvasDocument,
  projectCanvas,
  updateCanvasVideoPlaybackState,
  type CanvasDocument
} from './index';

describe('Canvas video playback state', { tags: ['canvas-video'] }, () => {
  it('stores playback time only on matching video nodes', () => {
    const canvas = canvasWithNodes();

    const next = updateCanvasVideoPlaybackState(canvas, {
      updates: [
        { projectRelativePath: 'media/clip.mp4', currentTimeSeconds: 12.345 },
        { projectRelativePath: 'media/image.png', currentTimeSeconds: 8 }
      ]
    });

    expect(next.nodeElements.find((node) => node.projectRelativePath === 'media/clip.mp4')).toMatchObject({
      videoPlayback: { currentTimeSeconds: 12.345 }
    });
    expect(next.nodeElements.find((node) => node.projectRelativePath === 'media/image.png')).not.toHaveProperty('videoPlayback');
  });

  it('removes playback state when the timestamp is zero', () => {
    const canvas = updateCanvasVideoPlaybackState(canvasWithNodes(), {
      updates: [{ projectRelativePath: 'media/clip.mp4', currentTimeSeconds: 5 }]
    });

    const next = updateCanvasVideoPlaybackState(canvas, {
      updates: [{ projectRelativePath: 'media/clip.mp4', currentTimeSeconds: 0 }]
    });

    expect(next.nodeElements.find((node) => node.projectRelativePath === 'media/clip.mp4')).not.toHaveProperty('videoPlayback');
  });

  it('normalizes positive playback timestamps to millisecond precision', () => {
    const next = updateCanvasVideoPlaybackState(canvasWithNodes(), {
      updates: [{ projectRelativePath: 'media/clip.mp4', currentTimeSeconds: 12.34567 }]
    });

    expect(next.nodeElements.find((node) => node.projectRelativePath === 'media/clip.mp4')).toMatchObject({
      videoPlayback: { currentTimeSeconds: 12.346 }
    });
  });

  it('rejects invalid playback timestamps', () => {
    const canvas = canvasWithNodes();

    expect(() => updateCanvasVideoPlaybackState(canvas, {
      updates: [{ projectRelativePath: 'media/clip.mp4', currentTimeSeconds: Number.NaN }]
    })).toThrow('Canvas video playback time must be a non-negative finite number.');

    expect(() => updateCanvasVideoPlaybackState(canvas, {
      updates: [{ projectRelativePath: 'media/clip.mp4', currentTimeSeconds: -1 }]
    })).toThrow('Canvas video playback time must be a non-negative finite number.');
  });

  it('projects videoPlayback as Canvas document state', () => {
    const canvas = updateCanvasVideoPlaybackState(canvasWithNodes(), {
      updates: [{ projectRelativePath: 'media/clip.mp4', currentTimeSeconds: 4.5 }]
    });

    const projection = projectCanvas({
      canvas,
      nodeAvailability: () => ({
        state: 'available',
        size: 100,
        mimeType: 'video/mp4',
        fileUrl: '',
        revision: 'rev'
      })
    });

    expect(projection.nodes.find((node) => node.projectRelativePath === 'media/clip.mp4')).toMatchObject({
      videoPlayback: { currentTimeSeconds: 4.5 }
    });
  });
});

function canvasWithNodes(): CanvasDocument {
  return {
    ...createCanvasDocument({ id: 'canvas-1' }),
    nodeElements: [
      {
        projectRelativePath: 'media/clip.mp4',
        nodeKind: 'file',
        mediaKind: 'video',
        x: 0,
        y: 0,
        width: 640,
        height: 360,
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
