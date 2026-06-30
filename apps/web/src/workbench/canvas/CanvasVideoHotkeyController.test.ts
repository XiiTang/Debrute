// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createCanvasVideoHotkeyController } from './CanvasVideoHotkeyController';
import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';

describe('CanvasVideoHotkeyController', () => {
  it('dispatches shortcuts only to the selected video target', () => {
    const selected = videoHandle();
    const unselected = videoHandle();
    const controller = createCanvasVideoHotkeyController();
    controller.register('media/selected.mp4', selected);
    controller.register('media/unselected.mp4', unselected);

    const event = keyboardEvent(' ', {
      selectedVideoPath: 'media/selected.mp4',
      activeElement: document.body
    });
    const handled = controller.handleKeyDown(event);

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(selected.togglePlayback).toHaveBeenCalledTimes(1);
    expect(unselected.togglePlayback).not.toHaveBeenCalled();
  });

  it('ignores shortcuts when focus is inside text input controls', () => {
    const target = videoHandle();
    const controller = createCanvasVideoHotkeyController();
    controller.register('media/selected.mp4', target);
    const input = document.createElement('input');
    document.body.append(input);

    try {
      const handled = controller.handleKeyDown(keyboardEvent(' ', {
        selectedVideoPath: 'media/selected.mp4',
        activeElement: input
      }));

      expect(handled).toBe(false);
      expect(target.togglePlayback).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it('ignores shortcuts when focus is inside media control widgets', () => {
    const target = videoHandle();
    const controller = createCanvasVideoHotkeyController();
    controller.register('media/selected.mp4', target);
    const control = document.createElement('button');
    document.body.append(control);

    try {
      const handled = controller.handleKeyDown(keyboardEvent(' ', {
        selectedVideoPath: 'media/selected.mp4',
        activeElement: control
      }));

      expect(handled).toBe(false);
      expect(target.togglePlayback).not.toHaveBeenCalled();
    } finally {
      control.remove();
    }
  });

  it('lets focused media-chrome role button controls handle their own shortcuts', () => {
    const target = videoHandle();
    const controller = createCanvasVideoHotkeyController();
    controller.register('media/selected.mp4', target);
    const control = document.createElement('media-play-button');
    control.setAttribute('role', 'button');
    document.body.append(control);

    try {
      const handled = controller.handleKeyDown(keyboardEvent(' ', {
        selectedVideoPath: 'media/selected.mp4',
        activeElement: control
      }));

      expect(handled).toBe(false);
      expect(target.togglePlayback).not.toHaveBeenCalled();
    } finally {
      control.remove();
    }
  });

  it('lets focused descendants of media control buttons handle their own shortcuts', () => {
    const target = videoHandle();
    const controller = createCanvasVideoHotkeyController();
    controller.register('media/selected.mp4', target);
    const control = document.createElement('media-play-button');
    control.setAttribute('role', 'button');
    const icon = document.createElement('span');
    control.append(icon);
    document.body.append(control);

    try {
      const handled = controller.handleKeyDown(keyboardEvent(' ', {
        selectedVideoPath: 'media/selected.mp4',
        activeElement: icon
      }));

      expect(handled).toBe(false);
      expect(target.togglePlayback).not.toHaveBeenCalled();
    } finally {
      control.remove();
    }
  });

  it('ignores shortcuts without exactly one selected video target', () => {
    const target = videoHandle();
    const controller = createCanvasVideoHotkeyController();
    controller.register('media/selected.mp4', target);

    expect(controller.handleKeyDown(keyboardEvent(' ', { selectedVideoPath: undefined, activeElement: document.body }))).toBe(false);
    expect(target.togglePlayback).not.toHaveBeenCalled();
  });
});

function videoHandle(): CanvasVideoPlayerHandle {
  return {
    togglePlayback: vi.fn(),
    seekBy: vi.fn(),
    toggleMuted: vi.fn(),
    adjustPlaybackRate: vi.fn(),
    toggleCaptions: vi.fn(),
    enterFullscreen: vi.fn(),
    togglePictureInPicture: vi.fn()
  };
}

function keyboardEvent(
  key: string,
  input: { selectedVideoPath: string | undefined; activeElement: Element | null }
) {
  return {
    key,
    shiftKey: false,
    preventDefault: vi.fn(),
    selectedVideoPath: input.selectedVideoPath,
    activeElement: input.activeElement
  };
}
