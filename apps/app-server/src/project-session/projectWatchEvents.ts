import { stat } from 'node:fs/promises';
import {
  readJsonFile,
  readTextFile,
  type NormalizedFileWatchEvent
} from '@debrute/project-core';
import type { CanvasDocument, Diagnostic } from '@debrute/canvas-core';
import type { ProjectSessionSnapshot } from '@debrute/app-protocol';

export interface InternalProjectFileWrite {
  content?: string;
  expiresAt: number;
}

export async function shouldIgnoreStaleWatchedEvent(input: {
  snapshotLoadedAt: number;
  event: NormalizedFileWatchEvent;
}): Promise<boolean> {
  if (input.snapshotLoadedAt <= 0) {
    return false;
  }
  if (input.event.observedAt !== undefined && input.event.observedAt <= input.snapshotLoadedAt) {
    return true;
  }
  try {
    const fileStat = await stat(input.event.absolutePath);
    return fileStat.mtimeMs <= input.snapshotLoadedAt;
  } catch {
    return false;
  }
}

export async function shouldIgnoreWatchedCanvasEvent(input: {
  current: ProjectSessionSnapshot | undefined;
  event: NormalizedFileWatchEvent;
  internalProjectFileWrites: Map<string, InternalProjectFileWrite>;
}): Promise<boolean> {
  const { current, event, internalProjectFileWrites } = input;
  if (!current || event.affects.length !== 1 || event.affects[0] !== 'canvas') {
    return false;
  }
  const internalWrite = internalProjectFileWrites.get(event.absolutePath);
  if (internalWrite) {
    if (internalWrite.expiresAt <= Date.now()) {
      internalProjectFileWrites.delete(event.absolutePath);
    } else {
      try {
        if (await readTextFile(event.absolutePath) === internalWrite.content) {
          return true;
        }
      } catch {
        return false;
      }
    }
  }
  try {
    const watchedCanvas = await readJsonFile<CanvasDocument>(event.absolutePath);
    const currentCanvas = current.canvases.find((canvas) => canvas.id === watchedCanvas.id);
    return currentCanvas ? JSON.stringify(currentCanvas) === JSON.stringify(watchedCanvas) : false;
  } catch {
    return false;
  }
}

export async function shouldIgnoreInternalProjectFileEvent(input: {
  event: NormalizedFileWatchEvent;
  internalProjectFileWrites: Map<string, InternalProjectFileWrite>;
}): Promise<boolean> {
  const { event, internalProjectFileWrites } = input;
  const internalWrite = internalProjectFileWrites.get(event.absolutePath);
  if (!internalWrite) {
    return false;
  }
  if (internalWrite.expiresAt <= Date.now()) {
    internalProjectFileWrites.delete(event.absolutePath);
    return false;
  }
  try {
    if (internalWrite.content === undefined) {
      return true;
    }
    return await readTextFile(event.absolutePath) === internalWrite.content;
  } catch {
    return false;
  }
}

export function projectWatchRefreshFailedSnapshot(input: {
  current: ProjectSessionSnapshot;
  event: NormalizedFileWatchEvent;
  errorMessage: string;
  checkedAt: string;
}): ProjectSessionSnapshot {
  const diagnostic: Diagnostic = {
    id: `project.watch.refresh_failed:${input.event.projectRelativePath}`,
    source: 'project',
    severity: 'error',
    code: 'project.watch.refresh_failed',
    message: input.errorMessage,
    filePath: input.event.absolutePath
  };
  return {
    ...input.current,
    diagnostics: [diagnostic, ...input.current.diagnostics],
    health: {
      ...input.current.health,
      diagnosticCounts: {
        ...input.current.health.diagnosticCounts,
        errors: input.current.health.diagnosticCounts.errors + 1
      },
      checkedAt: input.checkedAt
    }
  };
}
