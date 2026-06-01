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

export function textBufferStatus(buffer: TextFileBuffer | undefined): { label: string; className: string } {
  if (!buffer) {
    return { label: 'Loading', className: 'loading' };
  }
  if (buffer.error) {
    return { label: 'Error', className: 'error' };
  }
  if (buffer.externalChange) {
    return { label: 'External change', className: 'external' };
  }
  if (buffer.saving) {
    return { label: 'Saving', className: 'saving' };
  }
  if (buffer.dirty) {
    return { label: 'Unsaved', className: 'dirty' };
  }
  return { label: 'Saved', className: 'saved' };
}

export function clearTextBufferError(buffer: TextFileBuffer): TextFileBuffer {
  const { error: _error, ...rest } = buffer;
  return rest;
}

export function basenameFromProjectPath(path: string): string {
  return path.split('/').pop() || path;
}
