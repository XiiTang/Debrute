import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveWorkbenchRuntimePaths, type WorkbenchRuntimeOwner } from '@debrute/workbench-runtime';

interface CliOwnerState {
  schemaVersion: 1;
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
  const existing = await readFile(path, 'utf8')
    .then((content): CliOwnerState => JSON.parse(content) as CliOwnerState)
    .catch(() => undefined);
  if (existing?.schemaVersion === 1 && typeof existing.ownerId === 'string' && existing.ownerId.length > 0) {
    return existing.ownerId;
  }
  const next: CliOwnerState = { schemaVersion: 1, ownerId: randomUUID() };
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return next.ownerId;
}
