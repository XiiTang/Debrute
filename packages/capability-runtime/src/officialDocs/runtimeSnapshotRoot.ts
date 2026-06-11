import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type OfficialDocSnapshotModelKind = 'imageModels' | 'videoModels';

interface RuntimeOfficialDocSnapshotRootInput {
  modelKind: OfficialDocSnapshotModelKind;
  importMetaUrl?: string;
  moduleDir?: string;
  execPath?: string;
  pkgRuntime?: boolean;
}

export function runtimeOfficialDocSnapshotRoot(input: RuntimeOfficialDocSnapshotRootInput): string {
  if (input.pkgRuntime ?? isPkgRuntime()) {
    return resolve(dirname(input.execPath ?? process.execPath), 'official-docs', input.modelKind, 'snapshots');
  }

  const moduleDir = input.moduleDir ?? moduleDirFromImportMetaUrl(input.importMetaUrl);
  if (!moduleDir) {
    throw new Error('Official documentation snapshot module path is unavailable.');
  }
  if (moduleDir.endsWith(`${sep}dist-electron`)) {
    return resolve(moduleDir, 'official-docs', input.modelKind, 'snapshots');
  }
  return resolve(moduleDir, 'snapshots');
}

function moduleDirFromImportMetaUrl(importMetaUrl: string | undefined): string | undefined {
  return typeof importMetaUrl === 'string' ? dirname(fileURLToPath(importMetaUrl)) : undefined;
}

function isPkgRuntime(): boolean {
  return typeof (process as { pkg?: unknown }).pkg === 'object';
}
