import { describe, expect, it } from 'vitest';
import { resolveCanvasDomInteractionTarget } from './CanvasDomInteractionAdapter.js';

describe('resolveCanvasDomInteractionTarget', () => {
  it('classifies blank Canvas, blocked camera movement, and targets outside the surface', () => {
    const surface = document.createElement('div');
    const blank = document.createElement('div');
    const blocker = document.createElement('div');
    const outside = document.createElement('div');
    blocker.dataset.canvasHitTestBlocker = 'true';
    surface.append(blank, blocker);

    expect(resolveCanvasDomInteractionTarget(surface, blank)).toEqual({ kind: 'blank' });
    expect(resolveCanvasDomInteractionTarget(surface, blocker)).toEqual({ kind: 'blocked' });
    expect(resolveCanvasDomInteractionTarget(surface, outside)).toEqual({ kind: 'outside' });
  });

  it('returns one semantic node target for passive presentation and every interaction zone', () => {
    const surface = document.createElement('div');
    const node = document.createElement('div');
    node.dataset.canvasEntity = 'node';
    node.dataset.canvasNodePath = 'media/clip.mp4';
    node.dataset.canvasNodeKind = 'file';
    node.dataset.canvasMediaKind = 'video';
    surface.append(node);

    const targets = new Set<string>();
    for (const zone of ['passive', 'move', 'activate', 'action', 'interaction-island', 'resize', 'feedback'] as const) {
      const wrapper = document.createElement('div');
      const child = document.createElement('span');
      wrapper.dataset.canvasNodeZone = zone;
      wrapper.append(child);
      node.append(wrapper);
      const target = resolveCanvasDomInteractionTarget(surface, child);
      expect(target).toEqual({
        kind: 'node',
        projectRelativePath: 'media/clip.mp4',
        mediaKind: 'video',
        zone
      });
      targets.add(zone);
    }
    expect(targets).toHaveLength(7);
  });

  it('keeps a real button as a node action and an active editor as a node interaction island', () => {
    const surface = document.createElement('div');
    const node = document.createElement('div');
    node.dataset.canvasEntity = 'node';
    node.dataset.canvasNodePath = 'notes/readme.md';
    const activationZone = document.createElement('div');
    activationZone.dataset.canvasNodeZone = 'activate';
    const button = document.createElement('button');
    activationZone.append(button);
    const resizeHandle = document.createElement('button');
    resizeHandle.dataset.canvasNodeZone = 'resize';
    const editor = document.createElement('div');
    editor.dataset.canvasInteractionIsland = 'true';
    node.append(activationZone, resizeHandle, editor);
    surface.append(node);

    expect(resolveCanvasDomInteractionTarget(surface, button)).toMatchObject({
      kind: 'node',
      projectRelativePath: 'notes/readme.md',
      zone: 'action'
    });
    expect(resolveCanvasDomInteractionTarget(surface, editor)).toMatchObject({
      kind: 'node',
      projectRelativePath: 'notes/readme.md',
      zone: 'interaction-island'
    });
    expect(resolveCanvasDomInteractionTarget(surface, resizeHandle)).toMatchObject({
      kind: 'node',
      projectRelativePath: 'notes/readme.md',
      zone: 'resize'
    });
  });

  it('protects Canvas UI that is not part of a node from blank-area gestures', () => {
    const surface = document.createElement('div');
    const button = document.createElement('button');
    surface.append(button);

    expect(resolveCanvasDomInteractionTarget(surface, button)).toEqual({ kind: 'canvas-ui' });
  });
});
