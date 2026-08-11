import { describe, expect, it } from 'vitest';
import { resolveCanvasDomInteractionTarget } from './CanvasDomInteractionAdapter';

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

  it('returns one semantic node target for every stable interaction region', () => {
    const surface = document.createElement('div');
    const node = document.createElement('div');
    node.dataset.canvasEntity = 'node';
    node.dataset.canvasNodePath = 'media/clip.mp4';
    node.dataset.canvasNodeKind = 'file';
    node.dataset.canvasMediaKind = 'video';
    surface.append(node);

    const targets = new Set<string>();
    for (const zone of ['content', 'manipulation', 'action', 'content-island', 'resize', 'feedback'] as const) {
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
        zone,
        directManipulation: false,
        contentControl: false
      });
      targets.add(zone);
    }
    expect(targets).toHaveLength(6);
  });

  it('keeps content controls in content, title-bar buttons as actions, and editor islands stable', () => {
    const surface = document.createElement('div');
    const node = document.createElement('div');
    node.dataset.canvasEntity = 'node';
    node.dataset.canvasNodePath = 'notes/readme.md';
    const activationZone = document.createElement('div');
    activationZone.dataset.canvasNodeZone = 'content';
    const button = document.createElement('button');
    activationZone.append(button);
    const actionZone = document.createElement('div');
    actionZone.dataset.canvasNodeZone = 'action';
    const actionButton = document.createElement('button');
    actionZone.append(actionButton);
    const resizeHandle = document.createElement('button');
    resizeHandle.dataset.canvasNodeZone = 'resize';
    const editor = document.createElement('div');
    editor.dataset.canvasNodeZone = 'content-island';
    node.append(activationZone, actionZone, resizeHandle, editor);
    surface.append(node);

    expect(resolveCanvasDomInteractionTarget(surface, button)).toMatchObject({
      kind: 'node',
      projectRelativePath: 'notes/readme.md',
      zone: 'content'
    });
    expect(resolveCanvasDomInteractionTarget(surface, actionButton)).toMatchObject({
      kind: 'node',
      projectRelativePath: 'notes/readme.md',
      zone: 'action'
    });
    expect(resolveCanvasDomInteractionTarget(surface, editor)).toMatchObject({
      kind: 'node',
      projectRelativePath: 'notes/readme.md',
      zone: 'content-island'
    });
    expect(resolveCanvasDomInteractionTarget(surface, resizeHandle)).toMatchObject({
      kind: 'node',
      projectRelativePath: 'notes/readme.md',
      zone: 'resize'
    });
  });

  it('keeps nested media controls in content and identifies range direct manipulation', () => {
    const surface = document.createElement('div');
    const node = document.createElement('div');
    node.dataset.canvasEntity = 'node';
    node.dataset.canvasNodePath = 'media/clip.mp4';
    node.dataset.canvasMediaKind = 'video';
    const content = document.createElement('div');
    content.dataset.canvasNodeZone = 'content';
    const button = document.createElement('media-play-button');
    const range = document.createElement('media-time-range');
    range.dataset.canvasDirectManipulation = 'true';
    content.append(button, range);
    node.append(content);
    surface.append(node);

    expect(resolveCanvasDomInteractionTarget(surface, button)).toMatchObject({
      zone: 'content',
      contentControl: true,
      directManipulation: false
    });
    expect(resolveCanvasDomInteractionTarget(surface, range)).toMatchObject({
      zone: 'content',
      contentControl: false,
      directManipulation: true
    });
  });

  it('lets an already mounted video own its playback click without a second Canvas handoff', () => {
    const surface = document.createElement('div');
    const node = document.createElement('div');
    node.dataset.canvasEntity = 'node';
    node.dataset.canvasNodePath = 'media/clip.mp4';
    node.dataset.canvasMediaKind = 'video';
    const content = document.createElement('div');
    content.dataset.canvasNodeZone = 'content';
    const controller = document.createElement('media-controller');
    const video = document.createElement('video');
    controller.append(video);
    content.append(controller);
    node.append(content);
    surface.append(node);

    expect(resolveCanvasDomInteractionTarget(surface, controller)).toMatchObject({
      zone: 'content',
      contentControl: true
    });
    expect(resolveCanvasDomInteractionTarget(surface, video)).toMatchObject({
      zone: 'content',
      contentControl: true
    });
  });

  it('protects Canvas UI that is not part of a node from blank-area gestures', () => {
    const surface = document.createElement('div');
    const button = document.createElement('button');
    surface.append(button);

    expect(resolveCanvasDomInteractionTarget(surface, button)).toEqual({ kind: 'canvas-ui' });
  });
});
