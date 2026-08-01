import type { ProjectPathEntry } from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';

export interface WorkbenchProjectPathCommandEntry extends ProjectPathEntry {
  availability?: 'available' | 'missing' | 'unreadable';
}

interface WorkbenchProjectPathCommandTargetFields {
  invocationEntry: WorkbenchProjectPathCommandEntry;
  selectedEntries: readonly WorkbenchProjectPathCommandEntry[];
}

export type WorkbenchProjectPathCommandTarget = WorkbenchProjectPathCommandTargetFields & (
  | { source: 'canvas' }
  | { source: 'explorer' }
);

export interface ResolvedProjectPathCommandTarget {
  invocationEntry: WorkbenchProjectPathCommandEntry;
  selectionEntries: readonly WorkbenchProjectPathCommandEntry[];
  explicitSortedEntries: readonly WorkbenchProjectPathCommandEntry[];
  effectiveFilesystemEntries: readonly WorkbenchProjectPathCommandEntry[];
  filesystemCommandsAvailable: boolean;
}

interface ResolvedProjectPathCommandEntries {
  explicitSortedEntries: readonly WorkbenchProjectPathCommandEntry[];
  effectiveFilesystemEntries: readonly WorkbenchProjectPathCommandEntry[];
  filesystemCommandsAvailable: boolean;
}

export function resolveProjectPathCommandTarget(
  target: WorkbenchProjectPathCommandTarget
): ResolvedProjectPathCommandTarget {
  const resolvedEntries = resolveProjectPathCommandEntries(target.selectedEntries);
  return {
    invocationEntry: target.invocationEntry,
    selectionEntries: resolvedEntries.explicitSortedEntries,
    ...resolvedEntries
  };
}

function resolveProjectPathCommandEntries(
  entries: readonly WorkbenchProjectPathCommandEntry[]
): ResolvedProjectPathCommandEntries {
  const explicitSortedEntries = canonicalEntries(entries);
  const nonRootEntries = explicitSortedEntries.filter((entry) => entry.projectRelativePath !== '');
  const missing = nonRootEntries.some((entry) => entry.availability === 'missing');
  const selectedDirectories = nonRootEntries
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => entry.projectRelativePath);
  const effectiveFilesystemEntries = nonRootEntries.filter((entry) => !selectedDirectories.some((directory) => (
    directory !== entry.projectRelativePath
    && entry.projectRelativePath.startsWith(`${directory}/`)
  )));
  return {
    explicitSortedEntries,
    effectiveFilesystemEntries,
    filesystemCommandsAvailable: !missing && effectiveFilesystemEntries.length > 0
  };
}

export function effectiveProjectPathEntries(
  entries: readonly WorkbenchProjectPathCommandEntry[]
): readonly WorkbenchProjectPathCommandEntry[] {
  return resolveProjectPathCommandEntries(entries).effectiveFilesystemEntries;
}

export function projectPathCommandEntryForCanvasNode(
  node: ProjectedCanvasNode
): WorkbenchProjectPathCommandEntry {
  return {
    projectRelativePath: node.projectRelativePath,
    kind: node.nodeKind,
    availability: node.availability.state,
    ...(node.nodeKind === 'file' && node.availability.state === 'available'
      ? { sizeBytes: node.availability.size }
      : {})
  };
}

function canonicalEntries(
  entries: readonly WorkbenchProjectPathCommandEntry[]
): WorkbenchProjectPathCommandEntry[] {
  const byPath = new Map<string, WorkbenchProjectPathCommandEntry>();
  for (const entry of entries) {
    byPath.set(entry.projectRelativePath, entry);
  }
  return [...byPath.values()].sort((left, right) => (
    left.projectRelativePath.localeCompare(right.projectRelativePath)
  ));
}
