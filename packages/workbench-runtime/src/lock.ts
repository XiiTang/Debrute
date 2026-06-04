import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { registryError } from './errors.js';
import type { WorkbenchRuntimePaths } from './paths.js';

export interface WorkbenchRuntimeStartupLock {
  release(): Promise<void>;
}

export interface WorkbenchRuntimeStartupLockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

interface LockFile {
  pid: number;
  acquiredAt: string;
}

export async function acquireWorkbenchRuntimeStartupLock(
  paths: WorkbenchRuntimePaths,
  options: WorkbenchRuntimeStartupLockOptions = {}
): Promise<WorkbenchRuntimeStartupLock> {
  await mkdir(dirname(paths.lockPath), { recursive: true, mode: 0o700 });
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const lock = await tryAcquire(paths.lockPath);
    if (lock) {
      return lock;
    }
    await removeDeadOwnerLock(paths.lockPath);
    await sleep(pollMs);
  }
  throw registryError('runtime_lock_timeout', 'AXIS workbench runtime startup lock timed out.');
}

export async function withWorkbenchRuntimeStartupLock<T>(
  paths: WorkbenchRuntimePaths,
  callback: () => Promise<T>,
  options: WorkbenchRuntimeStartupLockOptions = {}
): Promise<T> {
  const lock = await acquireWorkbenchRuntimeStartupLock(paths, options);
  try {
    return await callback();
  } finally {
    await lock.release();
  }
}

async function tryAcquire(lockPath: string): Promise<WorkbenchRuntimeStartupLock | undefined> {
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    return {
      release: async () => {
        await rm(lockPath, { force: true });
      }
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      return undefined;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function removeDeadOwnerLock(lockPath: string): Promise<void> {
  const lock = await readLock(lockPath);
  if (!lock || isProcessAlive(lock.pid)) {
    return;
  }
  await rm(lockPath, { force: true });
}

async function readLock(lockPath: string): Promise<LockFile | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as unknown;
    if (!isRecord(value) || typeof value.pid !== 'number' || !Number.isInteger(value.pid) || typeof value.acquiredAt !== 'string') {
      return undefined;
    }
    return { pid: value.pid, acquiredAt: value.acquiredAt };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== 'ESRCH';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
