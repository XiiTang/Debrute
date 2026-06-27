import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveWorkbenchRuntimePaths, type WorkbenchRuntimeOwner } from '@debrute/workbench-runtime';

interface CliOwnerState {
  ownerId: string;
}

export async function resolveCliRuntimeOwner(runtimeDir = resolveWorkbenchRuntimePaths().runtimeDir): Promise<WorkbenchRuntimeOwner> {
  const ownerId = await readOrCreateCliOwnerId(runtimeDir);
  return {
    kind: 'cli',
    ownerId,
    pid: process.pid
  };
}

async function readOrCreateCliOwnerId(runtimeDir: string): Promise<string> {
  const path = join(runtimeDir, 'cli-owner.json');
  const existing = await readCliOwnerState(path);
  if (existing) {
    return existing.ownerId;
  }
  const next: CliOwnerState = { ownerId: randomUUID() };
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return next.ownerId;
}

async function readCliOwnerState(path: string): Promise<CliOwnerState | undefined> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw invalidCliOwnerState(error instanceof Error ? error.message : String(error));
  }
  return assertCliOwnerState(parsed);
}

function assertCliOwnerState(value: unknown): CliOwnerState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidCliOwnerState('expected object');
  }
  const state = value as Record<string, unknown>;
  if (typeof state.ownerId !== 'string' || state.ownerId.length === 0) {
    throw invalidCliOwnerState('ownerId must be a non-empty string');
  }
  return {
    ownerId: state.ownerId
  };
}

function invalidCliOwnerState(message: string): Error {
  return new Error(`Invalid Debrute CLI runtime owner state: ${message}.`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
