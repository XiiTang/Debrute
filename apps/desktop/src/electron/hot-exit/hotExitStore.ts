import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanvasSelectionItem } from '@axis/canvas-core';
import type { DesktopHotExitSnapshot, DesktopHotExitTextBuffer, DesktopHotExitTextEditorWindow } from '@axis/app-protocol';

export type { DesktopHotExitSnapshot } from '@axis/app-protocol';

export interface HotExitStore {
  readHotExitSnapshot(): Promise<DesktopHotExitSnapshot | undefined>;
  writeHotExitSnapshot(snapshot: DesktopHotExitSnapshot): Promise<void>;
  clearHotExitSnapshot(): Promise<void>;
}

const HOT_EXIT_FILE = 'hot-exit.json';

export function createHotExitStore(userDataPath: string): HotExitStore {
  const path = join(userDataPath, HOT_EXIT_FILE);
  return {
    async readHotExitSnapshot(): Promise<DesktopHotExitSnapshot | undefined> {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
        return assertHotExitSnapshot(parsed);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    },
    async writeHotExitSnapshot(snapshot: DesktopHotExitSnapshot): Promise<void> {
      await mkdir(userDataPath, { recursive: true });
      await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    },
    async clearHotExitSnapshot(): Promise<void> {
      await rm(path, { force: true });
    }
  };
}

function assertHotExitSnapshot(value: unknown): DesktopHotExitSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.createdAt !== 'string') {
    throw new Error('Invalid AXIS Hot Exit snapshot.');
  }
  if (!hasOnlyKeys(value, [
    'schemaVersion',
    'createdAt',
    'projectRoot',
    'activeCanvasId',
    'explorerSelection',
    'selection',
    'textFileBuffers',
    'textEditorWindows'
  ])) {
    throw new Error('Invalid AXIS Hot Exit snapshot.');
  }
  if (!optionalString(value.projectRoot) || !optionalString(value.activeCanvasId) || !optionalString(value.explorerSelection)) {
    throw new Error('Invalid AXIS Hot Exit snapshot.');
  }
  const selection = value.selection;
  if (selection !== undefined && !isHotExitSelection(selection)) {
    throw new Error('Invalid AXIS Hot Exit snapshot.');
  }
  const textFileBuffers = value.textFileBuffers;
  if (!Array.isArray(textFileBuffers) || !textFileBuffers.every(isHotExitTextBuffer)) {
    throw new Error('Invalid AXIS Hot Exit snapshot.');
  }
  const textEditorWindows = value.textEditorWindows;
  if (!Array.isArray(textEditorWindows) || !textEditorWindows.every(isHotExitTextEditorWindow)) {
    throw new Error('Invalid AXIS Hot Exit snapshot.');
  }
  const snapshot: DesktopHotExitSnapshot = {
    schemaVersion: 1,
    createdAt: value.createdAt,
    textFileBuffers,
    textEditorWindows
  };
  if (typeof value.projectRoot === 'string') {
    snapshot.projectRoot = value.projectRoot;
  }
  if (typeof value.activeCanvasId === 'string') {
    snapshot.activeCanvasId = value.activeCanvasId;
  }
  if (typeof value.explorerSelection === 'string') {
    snapshot.explorerSelection = value.explorerSelection;
  }
  if (selection !== undefined) {
    snapshot.selection = selection;
  }
  return snapshot;
}

function isHotExitTextBuffer(value: unknown): value is DesktopHotExitTextBuffer {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'projectRelativePath',
      'content',
      'language',
      'wordWrap',
      'diskRevision',
      'lastSavedRevision'
    ])
    && typeof value.projectRelativePath === 'string'
    && typeof value.content === 'string'
    && typeof value.language === 'string'
    && typeof value.wordWrap === 'boolean'
    && optionalString(value.diskRevision)
    && optionalString(value.lastSavedRevision);
}

function isHotExitTextEditorWindow(value: unknown): value is DesktopHotExitTextEditorWindow {
  return isRecord(value)
    && hasOnlyKeys(value, ['projectRelativePath', 'open', 'x', 'y', 'width', 'height'])
    && typeof value.projectRelativePath === 'string'
    && typeof value.open === 'boolean'
    && finiteNumber(value.x)
    && finiteNumber(value.y)
    && finiteNumber(value.width)
    && finiteNumber(value.height);
}

function isHotExitSelection(value: unknown): value is NonNullable<DesktopHotExitSnapshot['selection']> {
  return isHotExitSelectionItem(value)
    || (isRecord(value)
      && hasOnlyKeys(value, ['kind', 'items'])
      && value.kind === 'multi'
      && Array.isArray(value.items)
      && value.items.every(isHotExitSelectionItem));
}

function isHotExitSelectionItem(value: unknown): value is CanvasSelectionItem {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === 'node') {
    return hasOnlyKeys(value, ['kind', 'projectRelativePath'])
      && typeof value.projectRelativePath === 'string';
  }
  return value.kind === 'diagnostic'
    && hasOnlyKeys(value, ['kind', 'id'])
    && typeof value.id === 'string';
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
