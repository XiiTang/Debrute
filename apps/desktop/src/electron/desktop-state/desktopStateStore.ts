import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesktopState } from '@axis/app-protocol';

export interface DesktopStateStore {
  readDesktopState(): Promise<DesktopState>;
  setSetupCompleted(completed: boolean): Promise<DesktopState>;
  rememberProjectRoot(projectRoot: string): Promise<DesktopState>;
  clearRecentProjectRoots(): Promise<DesktopState>;
}

const DESKTOP_STATE_FILE = 'desktop-state.json';

export function createDesktopStateStore(userDataPath: string): DesktopStateStore {
  const path = join(userDataPath, DESKTOP_STATE_FILE);

  async function readDesktopState(): Promise<DesktopState> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as DesktopState;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { recentProjectRoots: [], setupCompleted: false };
      }
      throw error;
    }
  }

  async function writeDesktopState(state: DesktopState): Promise<void> {
    await mkdir(userDataPath, { recursive: true });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  return {
    readDesktopState,
    async setSetupCompleted(completed: boolean): Promise<DesktopState> {
      const state = await readDesktopState();
      const next = {
        ...state,
        setupCompleted: completed
      };
      await writeDesktopState(next);
      return next;
    },
    async rememberProjectRoot(projectRoot: string): Promise<DesktopState> {
      const state = await readDesktopState();
      const recentProjectRoots = [projectRoot, ...state.recentProjectRoots.filter((item) => item !== projectRoot)].slice(0, 12);
      const next = {
        recentProjectRoots,
        lastProjectRoot: projectRoot,
        setupCompleted: state.setupCompleted
      };
      await writeDesktopState(next);
      return next;
    },
    async clearRecentProjectRoots(): Promise<DesktopState> {
      const state = await readDesktopState();
      const next = {
        recentProjectRoots: [],
        ...(state.lastProjectRoot ? { lastProjectRoot: state.lastProjectRoot } : {}),
        setupCompleted: state.setupCompleted
      };
      await writeDesktopState(next);
      return next;
    }
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
