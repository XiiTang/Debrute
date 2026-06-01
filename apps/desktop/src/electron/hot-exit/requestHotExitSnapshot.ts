import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron';
import type { DesktopHotExitSnapshot } from '@axis/app-protocol';

export interface BrowserWindowSource {
  getFocusedWindow(): BrowserWindow | null;
  getAllWindows(): BrowserWindow[];
}

export interface RequestHotExitSnapshotInput {
  browserWindows: BrowserWindowSource;
  ipcMain: IpcMain;
  now?: () => string;
  timeoutMs?: number;
}

export function requestHotExitSnapshot(input: RequestHotExitSnapshotInput): Promise<DesktopHotExitSnapshot> {
  const window = input.browserWindows.getFocusedWindow() ?? input.browserWindows.getAllWindows()[0];
  if (!window) {
    return Promise.resolve({
      schemaVersion: 1,
      createdAt: input.now?.() ?? new Date().toISOString(),
      textFileBuffers: [],
      textEditorWindows: []
    });
  }

  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out while collecting Hot Exit state.'));
    }, input.timeoutMs ?? 5000);
    const onResponse = (_event: IpcMainEvent, payload: unknown) => {
      if (!isRecord(payload) || payload.requestId !== requestId) {
        return;
      }
      cleanup();
      if (typeof payload.error === 'string') {
        reject(new Error(payload.error));
        return;
      }
      resolve(payload.snapshot as DesktopHotExitSnapshot);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      input.ipcMain.off('axis:hotExitSnapshotResponse', onResponse);
    };
    input.ipcMain.on('axis:hotExitSnapshotResponse', onResponse);
    window.webContents.send('axis:requestHotExitSnapshot', requestId);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
