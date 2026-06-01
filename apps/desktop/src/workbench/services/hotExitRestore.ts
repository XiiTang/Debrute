import type { DesktopHotExitSnapshot, FloatingTextEditorWindowState, TextFileBuffer, WorkbenchState } from '../../types';
import type { ProjectSessionSnapshot } from '@axis/app-protocol';

export function createRendererHotExitSnapshot(input: {
  snapshot: ProjectSessionSnapshot | undefined;
  activeCanvasId: string | undefined;
  selection: WorkbenchState['selection'];
  explorerSelection: string | undefined;
  textFileBuffers: Record<string, TextFileBuffer>;
  textEditorWindows: Record<string, FloatingTextEditorWindowState>;
}): DesktopHotExitSnapshot {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ...(input.snapshot?.projectRoot ? { projectRoot: input.snapshot.projectRoot } : {}),
    ...(input.activeCanvasId ? { activeCanvasId: input.activeCanvasId } : {}),
    ...(input.explorerSelection ? { explorerSelection: input.explorerSelection } : {}),
    ...(input.selection ? { selection: input.selection } : {}),
    textFileBuffers: Object.values(input.textFileBuffers)
      .filter((buffer) => buffer.dirty)
      .map((buffer) => ({
        projectRelativePath: buffer.projectRelativePath,
        content: buffer.content,
        language: buffer.language,
        wordWrap: buffer.wordWrap,
        ...(buffer.diskRevision ? { diskRevision: buffer.diskRevision } : {}),
        ...(buffer.lastSavedRevision ? { lastSavedRevision: buffer.lastSavedRevision } : {})
      })),
    textEditorWindows: Object.values(input.textEditorWindows)
      .filter((windowState) => windowState.open)
      .map((windowState) => ({
        projectRelativePath: windowState.projectRelativePath,
        open: windowState.open,
        x: windowState.x,
        y: windowState.y,
        width: windowState.width,
        height: windowState.height
      }))
  };
}

export function restoreTextBuffersFromHotExitSnapshot(snapshot: DesktopHotExitSnapshot): Record<string, TextFileBuffer> {
  return Object.fromEntries(snapshot.textFileBuffers.map((buffer) => [
    buffer.projectRelativePath,
    {
      projectRelativePath: buffer.projectRelativePath,
      content: buffer.content,
      language: buffer.language,
      wordWrap: buffer.wordWrap,
      dirty: true,
      saving: false,
      ...(buffer.diskRevision ? { diskRevision: buffer.diskRevision } : {}),
      ...(buffer.lastSavedRevision ? { lastSavedRevision: buffer.lastSavedRevision } : {}),
      externalChange: false
    } satisfies TextFileBuffer
  ]));
}

export function restoreTextEditorWindowsFromHotExitSnapshot(snapshot: DesktopHotExitSnapshot): Record<string, FloatingTextEditorWindowState> {
  return Object.fromEntries(snapshot.textEditorWindows.map((windowState) => [
    windowState.projectRelativePath,
    {
      projectRelativePath: windowState.projectRelativePath,
      open: windowState.open,
      x: windowState.x,
      y: windowState.y,
      width: windowState.width,
      height: windowState.height
    } satisfies FloatingTextEditorWindowState
  ]));
}
