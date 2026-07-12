import { readFile, stat } from 'node:fs/promises';
import {
  projectContentHash,
  readJsonFile,
  type NormalizedFileWatchEvent
} from '@debrute/project-core';
import type { CanvasDocument, Diagnostic } from '@debrute/canvas-core';
import type { ProjectSessionSnapshot } from '@debrute/app-protocol';
import { projectDiagnosticCounts } from './projectHealth.js';

export type InternalProjectFileWriteReceipt =
  | { kind: 'write'; contentHash: string }
  | { kind: 'delete' };

export function createInternalProjectFileWriteReceipt(content?: string): InternalProjectFileWriteReceipt {
  return content === undefined
    ? { kind: 'delete' }
    : { kind: 'write', contentHash: projectContentHash(content) };
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
}): Promise<boolean> {
  const { current, event } = input;
  if (!current || event.affects.length !== 1 || event.affects[0] !== 'canvas') {
    return false;
  }
  try {
    const watchedCanvas = await readJsonFile<CanvasDocument>(event.absolutePath);
    const currentCanvas = current.canvases.find((canvas) => canvas.id === watchedCanvas.id);
    return currentCanvas ? JSON.stringify(currentCanvas) === JSON.stringify(watchedCanvas) : false;
  } catch {
    return false;
  }
}

export async function consumeInternalProjectFileWatchEvent(input: {
  event: NormalizedFileWatchEvent;
  receipts: Map<string, InternalProjectFileWriteReceipt>;
}): Promise<boolean> {
  const { event, receipts } = input;
  const receipt = receipts.get(event.absolutePath);
  if (!receipt) {
    return false;
  }
  receipts.delete(event.absolutePath);
  try {
    if (receipt.kind === 'delete') {
      await stat(event.absolutePath);
      return false;
    }
    return projectContentHash(await readFile(event.absolutePath)) === receipt.contentHash;
  } catch (error) {
    return receipt.kind === 'delete' && isMissingPathError(error);
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
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
  const diagnostics = [
    diagnostic,
    ...input.current.diagnostics.filter((current) => current.id !== diagnostic.id)
  ];
  return {
    ...input.current,
    diagnostics,
    health: {
      ...input.current.health,
      diagnosticCounts: projectDiagnosticCounts(diagnostics),
      checkedAt: input.checkedAt
    }
  };
}
