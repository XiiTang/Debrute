import { describe, expect, it } from 'vitest';
import {
  CANVAS_POINTER_ACTIVATION_DISTANCE,
  decideCanvasInteraction
} from './CanvasInteractionPolicy.js';
import { canvasNodeSelection } from './runtime/canvasSelection.js';

const selection = canvasNodeSelection(['old.md']);

describe('CanvasInteractionPolicy', () => {
  it('owns the shared completed-click movement threshold', () => {
    expect(CANVAS_POINTER_ACTIVATION_DISTANCE).toBe(4);
  });

  it.each([
    ['text', 'text-caret'],
    ['video', 'video-toggle'],
    ['audio', 'none']
  ] as const)('activates inactive %s content and returns its one-shot handoff', (mediaKind, handoff) => {
    expect(decideCanvasInteraction({
      event: 'completed-click',
      target: { kind: 'node', projectRelativePath: `node.${mediaKind}`, mediaKind, zone: 'content' },
      selection,
      contentActivationProjectRelativePath: 'old.md',
      additive: false
    })).toEqual({
      state: { kind: 'activate-content', projectRelativePath: `node.${mediaKind}` },
      gesture: 'none',
      handoff
    });
  });

  it('lets an already active content region own modifiers and local behavior', () => {
    expect(decideCanvasInteraction({
      event: 'completed-click',
      target: { kind: 'node', projectRelativePath: 'old.md', mediaKind: 'text', zone: 'content' },
      selection,
      contentActivationProjectRelativePath: 'old.md',
      additive: true
    }).state).toEqual({ kind: 'preserve' });
  });

  it('activates an inactive mounted video control without issuing a second Canvas toggle', () => {
    expect(decideCanvasInteraction({
      event: 'completed-click',
      target: {
        kind: 'node',
        projectRelativePath: 'other.mp4',
        mediaKind: 'video',
        zone: 'content',
        contentControl: true
      },
      selection,
      contentActivationProjectRelativePath: 'old.md',
      additive: false
    })).toEqual({
      state: { kind: 'activate-content', projectRelativePath: 'other.mp4' },
      gesture: 'none',
      handoff: 'none'
    });
  });

  it('uses additive inactive content clicks for multi-selection and ends activation', () => {
    expect(decideCanvasInteraction({
      event: 'completed-click',
      target: { kind: 'node', projectRelativePath: 'other.md', mediaKind: 'text', zone: 'content' },
      selection,
      contentActivationProjectRelativePath: 'old.md',
      additive: true
    }).state).toEqual({
      kind: 'set-selection-and-end-content-activation',
      selection: canvasNodeSelection(['old.md', 'other.md'])
    });
  });

  it('selects and ends activation at the manipulation threshold without removing an additively selected node', () => {
    expect(decideCanvasInteraction({
      event: 'manipulation-threshold',
      target: { kind: 'node', projectRelativePath: 'folder', zone: 'manipulation' },
      selection,
      contentActivationProjectRelativePath: 'old.md',
      additive: false
    })).toMatchObject({
      state: {
        kind: 'set-selection-and-end-content-activation',
        selection: canvasNodeSelection(['folder'])
      },
      gesture: 'move'
    });
    expect(decideCanvasInteraction({
      event: 'manipulation-threshold',
      target: { kind: 'node', projectRelativePath: 'old.md', zone: 'manipulation' },
      selection,
      contentActivationProjectRelativePath: 'old.md',
      additive: true
    }).state).toEqual({
      kind: 'set-selection-and-end-content-activation',
      selection
    });
  });

  it('ends activation but preserves selection for a completed Workbench click', () => {
    expect(decideCanvasInteraction({
      event: 'completed-click',
      target: { kind: 'workbench' },
      selection,
      contentActivationProjectRelativePath: 'old.md',
      additive: false
    }).state).toEqual({ kind: 'end-content-activation' });
  });

  it('preserves all state for the active content island', () => {
    expect(decideCanvasInteraction({
      event: 'completed-click',
      target: { kind: 'node', projectRelativePath: 'old.md', zone: 'content-island' },
      selection,
      contentActivationProjectRelativePath: 'old.md',
      additive: false
    }).state).toEqual({ kind: 'preserve' });
    expect(decideCanvasInteraction({
      event: 'completed-click',
      target: { kind: 'node', projectRelativePath: 'other.md', zone: 'content-island' },
      selection,
      contentActivationProjectRelativePath: 'old.md',
      additive: false
    }).state).toEqual({ kind: 'end-content-activation' });
  });

  it('ends activation when a blank-area marquee crosses its threshold', () => {
    expect(decideCanvasInteraction({
      event: 'manipulation-threshold',
      target: { kind: 'blank' },
      selection,
      contentActivationProjectRelativePath: 'old.md',
      additive: false
    })).toEqual({
      state: { kind: 'end-content-activation' },
      gesture: 'marquee',
      handoff: 'none'
    });
  });
});
