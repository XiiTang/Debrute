import type { CanvasVideoPlayerHandle } from './CanvasVideoPlayerAdapter';

export interface CanvasVideoHotkeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
  selectedVideoPath: string | undefined;
  activeElement: Element | null;
}

export interface CanvasVideoHotkeyController {
  register(projectRelativePath: string, target: CanvasVideoPlayerHandle | undefined): void;
  handleKeyDown(event: CanvasVideoHotkeyEvent): boolean;
}

export function createCanvasVideoHotkeyController(options: {
  requestTargetMount: (projectRelativePath: string) => void;
}): CanvasVideoHotkeyController {
  const targets = new Map<string, CanvasVideoPlayerHandle>();
  return {
    register(projectRelativePath, target) {
      if (target) {
        targets.set(projectRelativePath, target);
      } else {
        targets.delete(projectRelativePath);
      }
    },
    handleKeyDown(event) {
      if (shouldLetFocusedElementHandleKey(event.activeElement)) {
        return false;
      }
      if (!event.selectedVideoPath) {
        return false;
      }
      const target = targets.get(event.selectedVideoPath);
      if (!target) {
        if (!isVideoShortcutKey(event.key)) {
          return false;
        }
        options.requestTargetMount(event.selectedVideoPath);
        event.preventDefault();
        return true;
      }
      const handled = dispatchVideoShortcut(target, event);
      if (handled) {
        event.preventDefault();
      }
      return handled;
    }
  };
}

function isVideoShortcutKey(key: string): boolean {
  switch (key) {
    case ' ':
    case 'k':
    case 'K':
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'm':
    case 'M':
    case 'c':
    case 'C':
    case '[':
    case '<':
    case ']':
    case '>':
    case 'f':
    case 'F':
    case 'p':
    case 'P':
      return true;
    default:
      return false;
  }
}

function shouldLetFocusedElementHandleKey(element: Element | null): boolean {
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  return tagName === 'input'
    || tagName === 'textarea'
    || tagName === 'select'
    || tagName === 'button'
    || element.getAttribute('role') === 'button'
    || element.getAttribute('role') === 'menu'
    || element.getAttribute('role') === 'menuitem'
    || element.closest('[role="button"]') !== null
    || element.closest('[role="menu"]') !== null
    || element.closest('[role="menuitem"]') !== null
    || element.closest('button,input,textarea,select,media-control-bar,media-play-button,media-mute-button,media-captions-button,media-pip-button,media-fullscreen-button,media-playback-rate-button,media-time-range,media-volume-range') !== null
    || element.closest('[contenteditable="true"]') !== null;
}

function dispatchVideoShortcut(target: CanvasVideoPlayerHandle, event: Pick<CanvasVideoHotkeyEvent, 'key' | 'shiftKey'>): boolean {
  switch (event.key) {
    case ' ':
    case 'k':
    case 'K':
      target.togglePlayback();
      return true;
    case 'ArrowLeft':
      target.seekBy(event.shiftKey ? -10 : -5);
      return true;
    case 'ArrowRight':
      target.seekBy(event.shiftKey ? 10 : 5);
      return true;
    case 'm':
    case 'M':
      target.toggleMuted();
      return true;
    case 'c':
    case 'C':
      target.toggleCaptions();
      return true;
    case '[':
    case '<':
      target.adjustPlaybackRate(-0.25);
      return true;
    case ']':
    case '>':
      target.adjustPlaybackRate(0.25);
      return true;
    case 'f':
    case 'F':
      target.enterFullscreen();
      return true;
    case 'p':
    case 'P':
      target.togglePictureInPicture();
      return true;
    default:
      return false;
  }
}
