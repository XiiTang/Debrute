import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface WaitForConditionOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function createIsolatedDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function waitForCondition(
  conditionName: string,
  condition: () => boolean | Promise<boolean>,
  options: WaitForConditionOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const deadline = performance.now() + timeoutMs;

  while (!await condition()) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out waiting for ${conditionName} after ${timeoutMs}ms.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

export async function assertPortCanRebind(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const rejectListen = (error: Error) => {
      server.off('listening', resolve);
      reject(error);
    };
    server.once('error', rejectListen);
    server.once('listening', () => {
      server.off('error', rejectListen);
      resolve();
    });
    server.listen(port, '127.0.0.1');
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
