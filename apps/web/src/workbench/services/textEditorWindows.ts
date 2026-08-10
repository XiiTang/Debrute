import type { FloatingTextEditorWindowState, TextFileBuffer } from '../../types';
import {
  anchorResizedFloatingWindowRect,
  type FloatingWindowGesture
} from '../shell/floatingWindowGesture.js';
import {
  constrainContainedRect,
  sameWindowRect,
  type WorkbenchWindowRect
} from '../shell/windowBounds';

const DEFAULT_TEXT_EDITOR_WINDOW_RECT = {
  x: 420,
  y: 110,
  width: 820,
  height: 620
};
const TEXT_EDITOR_WINDOW_MIN_WIDTH = 420;
const TEXT_EDITOR_WINDOW_MIN_HEIGHT = 260;

export function openTextEditorWindowState(
  windows: Record<string, FloatingTextEditorWindowState>,
  projectRelativePath: string,
  viewport: WorkbenchWindowRect
): Record<string, FloatingTextEditorWindowState> {
  const existing = windows[projectRelativePath];
  const next = constrainTextEditorWindowState(existing
    ? { ...existing, open: true }
    : {
        projectRelativePath,
        open: true,
        ...DEFAULT_TEXT_EDITOR_WINDOW_RECT
      }, viewport);
  return {
    ...windows,
    [projectRelativePath]: next
  };
}

export function closeTextEditorWindowState(
  windows: Record<string, FloatingTextEditorWindowState>,
  projectRelativePath: string
): Record<string, FloatingTextEditorWindowState> {
  const existing = windows[projectRelativePath];
  if (!existing) {
    return windows;
  }
  return {
    ...windows,
    [projectRelativePath]: {
      ...existing,
      open: false
    }
  };
}

export function resolveTextEditorWindowGestureRect(
  candidate: WorkbenchWindowRect,
  gesture: FloatingWindowGesture,
  viewport: WorkbenchWindowRect
): WorkbenchWindowRect {
  if (gesture.kind === 'move') {
    return constrainContainedRect(candidate, viewport);
  }
  const width = Math.max(TEXT_EDITOR_WINDOW_MIN_WIDTH, Math.round(candidate.width));
  const height = Math.max(TEXT_EDITOR_WINDOW_MIN_HEIGHT, Math.round(candidate.height));
  return constrainContainedRect(
    anchorResizedFloatingWindowRect(candidate, gesture.direction, { width, height }),
    viewport
  );
}

export function commitTextEditorWindowRect(
  windows: Record<string, FloatingTextEditorWindowState>,
  projectRelativePath: string,
  rect: WorkbenchWindowRect
): Record<string, FloatingTextEditorWindowState> {
  const existing = windows[projectRelativePath];
  if (!existing || sameWindowRect(existing, rect)) {
    return windows;
  }
  return {
    ...windows,
    [projectRelativePath]: { ...existing, ...rect }
  };
}

export function constrainOpenTextEditorWindowsToViewport(
  windows: Record<string, FloatingTextEditorWindowState>,
  viewport: WorkbenchWindowRect
): Record<string, FloatingTextEditorWindowState> {
  let changed = false;
  const nextWindows = { ...windows };
  for (const [projectRelativePath, windowState] of Object.entries(windows)) {
    if (!windowState.open) {
      continue;
    }
    const nextWindow = constrainTextEditorWindowState(windowState, viewport);
    if (!sameTextEditorWindowState(windowState, nextWindow)) {
      nextWindows[projectRelativePath] = nextWindow;
      changed = true;
    }
  }
  return changed ? nextWindows : windows;
}

function constrainTextEditorWindowState(
  windowState: FloatingTextEditorWindowState,
  viewport: WorkbenchWindowRect
): FloatingTextEditorWindowState {
  return {
    ...windowState,
    ...constrainContainedRect(windowState, viewport)
  };
}

function sameTextEditorWindowState(
  left: FloatingTextEditorWindowState,
  right: FloatingTextEditorWindowState
): boolean {
  return left.projectRelativePath === right.projectRelativePath
    && left.open === right.open
    && sameWindowRect(left, right);
}

export type TextBufferStatusTone = 'danger' | 'info' | 'loading';

export interface TextBufferStatusLabels {
  loading: string;
  error: string;
  externalChange: string;
  saving: string;
}

export function textBufferStatus(
  buffer: TextFileBuffer | undefined,
  labels: TextBufferStatusLabels
): { label: string; tone: TextBufferStatusTone } | undefined {
  if (!buffer) {
    return { label: labels.loading, tone: 'loading' };
  }
  if (buffer.error) {
    return { label: labels.error, tone: 'danger' };
  }
  if (buffer.externalChange) {
    return { label: labels.externalChange, tone: 'info' };
  }
  if (buffer.saving) {
    return { label: labels.saving, tone: 'loading' };
  }
  return undefined;
}

export function clearTextBufferError(buffer: TextFileBuffer): TextFileBuffer {
  const { error: _error, ...rest } = buffer;
  return rest;
}

export function basenameFromProjectPath(path: string): string {
  return path.split('/').pop() || path;
}
