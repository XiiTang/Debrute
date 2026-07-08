import type { FloatingTextEditorWindowState, TextFileBuffer } from '../../types';
import type { FloatingPanelResizeInput } from '../shell/floatingPanels';
import {
  constrainContainedRect,
  sameWindowRect,
  type WorkbenchViewportRect
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
  viewport: WorkbenchViewportRect
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

export function dragTextEditorWindowState(
  windows: Record<string, FloatingTextEditorWindowState>,
  projectRelativePath: string,
  delta: { dx: number; dy: number },
  viewport: WorkbenchViewportRect
): Record<string, FloatingTextEditorWindowState> {
  const existing = windows[projectRelativePath];
  if (!existing) {
    return windows;
  }
  return {
    ...windows,
    [projectRelativePath]: constrainTextEditorWindowState({
      ...existing,
      x: existing.x + delta.dx,
      y: existing.y + delta.dy
    }, viewport)
  };
}

export function resizeTextEditorWindowState(
  windows: Record<string, FloatingTextEditorWindowState>,
  projectRelativePath: string,
  input: FloatingPanelResizeInput,
  viewport: WorkbenchViewportRect
): Record<string, FloatingTextEditorWindowState> {
  const existing = windows[projectRelativePath];
  if (!existing) {
    return windows;
  }
  const width = Math.max(TEXT_EDITOR_WINDOW_MIN_WIDTH, Math.round(input.width));
  const height = Math.max(TEXT_EDITOR_WINDOW_MIN_HEIGHT, Math.round(input.height));
  return {
    ...windows,
    [projectRelativePath]: constrainTextEditorWindowState({
      ...existing,
      x: input.direction.includes('w') ? input.x + input.width - width : input.x,
      y: input.direction.includes('n') ? input.y + input.height - height : input.y,
      width,
      height
    }, viewport)
  };
}

export function constrainOpenTextEditorWindowsToViewport(
  windows: Record<string, FloatingTextEditorWindowState>,
  viewport: WorkbenchViewportRect
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
  viewport: WorkbenchViewportRect
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
