import { stat } from 'node:fs/promises';
import type {
  ProjectFileBatchOperationResult,
  ProjectSessionSnapshot,
  WorkbenchProjectPathEntry
} from '@debrute/app-protocol';
import { assertProjectTreeVisibleMutationPath, resolveExistingProjectPath } from '@debrute/project-core';
import type { DebruteNativeShell } from './nativeShell.js';

export type ProjectNativePathKind = 'file' | 'directory';

export interface ProjectNativePathInput {
  projectRoot: string;
  projectRelativePath: string;
  kind: ProjectNativePathKind;
}

interface ResolvedNativeTrashEntry {
  entry: WorkbenchProjectPathEntry;
  absolutePath: string;
}

export async function copyProjectAbsolutePaths(input: {
  projectRoot: string;
  entries: WorkbenchProjectPathEntry[];
}): Promise<{ paths: string[] }> {
  const paths: string[] = [];
  for (const entry of input.entries) {
    paths.push(await resolveProjectNativePath({
      projectRoot: input.projectRoot,
      projectRelativePath: entry.projectRelativePath,
      kind: entry.kind
    }));
  }
  return { paths };
}

export async function revealProjectPathInSystemFileManager(
  input: ProjectNativePathInput & { nativeShell: DebruteNativeShell }
): Promise<{ ok: true }> {
  const absolutePath = await resolveProjectNativePath(input);
  if (input.kind === 'directory') {
    await input.nativeShell.openPath(absolutePath);
  } else {
    await input.nativeShell.showItemInFolder(absolutePath);
  }
  return { ok: true };
}

export async function trashProjectPathsWithNativeShell(input: {
  projectRoot: string;
  entries: WorkbenchProjectPathEntry[];
  nativeShell: DebruteNativeShell;
  refreshProject(): Promise<ProjectSessionSnapshot>;
}): Promise<ProjectFileBatchOperationResult> {
  const entries = topLevelProjectPathEntries(input.entries);
  const resolvedEntries: ResolvedNativeTrashEntry[] = [];
  for (const entry of entries) {
    assertProjectTreeVisibleMutationPath(entry.projectRelativePath);
    resolvedEntries.push({
      entry,
      absolutePath: await resolveProjectNativePath({
        projectRoot: input.projectRoot,
        projectRelativePath: entry.projectRelativePath,
        kind: entry.kind
      })
    });
  }

  const results: ProjectFileBatchOperationResult['results'] = [];
  let attemptedNativeTrash = false;
  try {
    for (const { entry, absolutePath } of resolvedEntries) {
      attemptedNativeTrash = true;
      await input.nativeShell.trashItem(absolutePath);
      results.push({
        sourceProjectRelativePath: entry.projectRelativePath,
        projectRelativePath: entry.projectRelativePath,
        kind: entry.kind,
        status: 'ok'
      });
    }
  } catch (error) {
    if (attemptedNativeTrash) {
      await input.refreshProject();
    }
    throw error;
  }
  return {
    results,
    snapshot: await input.refreshProject()
  };
}

export async function resolveProjectNativePath(input: ProjectNativePathInput): Promise<string> {
  const absolutePath = await resolveExistingProjectPath(input.projectRoot, input.projectRelativePath);
  const resolvedStats = await stat(absolutePath);
  if (input.kind === 'file' && !resolvedStats.isFile()) {
    throw new Error('Resolved project path is not a file.');
  }
  if (input.kind === 'directory' && !resolvedStats.isDirectory()) {
    throw new Error('Resolved project path is not a directory.');
  }
  return absolutePath;
}

function topLevelProjectPathEntries(entries: WorkbenchProjectPathEntry[]): WorkbenchProjectPathEntry[] {
  const result: WorkbenchProjectPathEntry[] = [];
  for (const entry of entries) {
    if (result.some((candidate) => isSameOrChildProjectPath(entry.projectRelativePath, candidate.projectRelativePath))) {
      continue;
    }
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (isSameOrChildProjectPath(result[index]!.projectRelativePath, entry.projectRelativePath)) {
        result.splice(index, 1);
      }
    }
    result.push(entry);
  }
  return result;
}

function isSameOrChildProjectPath(projectRelativePath: string, parentPath: string): boolean {
  return projectRelativePath === parentPath || projectRelativePath.startsWith(`${parentPath}/`);
}
