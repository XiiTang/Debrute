import type { FloatingTextEditorWindowState, TextFileBuffer } from '../../types';

const DEFAULT_TEXT_EDITOR_WINDOW_RECT = {
  x: 420,
  y: 110,
  width: 820,
  height: 620
};

export function openTextEditorWindowState(
  windows: Record<string, FloatingTextEditorWindowState>,
  projectRelativePath: string
): Record<string, FloatingTextEditorWindowState> {
  const existing = windows[projectRelativePath];
  return {
    ...windows,
    [projectRelativePath]: existing
      ? { ...existing, open: true }
      : {
          projectRelativePath,
          open: true,
          ...DEFAULT_TEXT_EDITOR_WINDOW_RECT
        }
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
  delta: { dx: number; dy: number }
): Record<string, FloatingTextEditorWindowState> {
  const existing = windows[projectRelativePath];
  if (!existing) {
    return windows;
  }
  return {
    ...windows,
    [projectRelativePath]: {
      ...existing,
      x: Math.max(8, existing.x + delta.dx),
      y: Math.max(8, existing.y + delta.dy)
    }
  };
}

export type TextBufferStatusTone = 'warning' | 'danger' | 'info' | 'loading';

export function textBufferStatus(buffer: TextFileBuffer | undefined): { label: string; tone: TextBufferStatusTone } | undefined {
  if (!buffer) {
    return { label: 'Loading', tone: 'loading' };
  }
  if (buffer.error) {
    return { label: 'Error', tone: 'danger' };
  }
  if (buffer.externalChange) {
    return { label: 'External change', tone: 'info' };
  }
  if (buffer.saving) {
    return { label: 'Saving', tone: 'loading' };
  }
  if (buffer.dirty) {
    return { label: 'Unsaved', tone: 'warning' };
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
