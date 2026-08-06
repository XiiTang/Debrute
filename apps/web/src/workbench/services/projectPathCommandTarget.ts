import type { ProjectPathEntry } from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from '../canvas/CanvasScene.js';

export interface WorkbenchProjectPathCommandCandidate {
  pathEntry: ProjectPathEntry;
  availability?: 'available' | 'missing' | 'unreadable';
}

interface WorkbenchProjectPathCommandTargetFields {
  invocationEntry: WorkbenchProjectPathCommandCandidate;
  selectedEntries: readonly WorkbenchProjectPathCommandCandidate[];
}

export type WorkbenchProjectPathCommandTarget = WorkbenchProjectPathCommandTargetFields & (
  | { source: 'canvas' }
  | { source: 'explorer' }
);

export interface ResolvedProjectPathCommandTarget {
  invocationEntry: ProjectPathEntry;
  selectionEntries: readonly ProjectPathEntry[];
  effectiveFilesystemEntries: readonly ProjectPathEntry[];
  filesystemCommandsAvailable: boolean;
}

interface ResolvedProjectPathCommandEntries {
  selectionEntries: readonly ProjectPathEntry[];
  effectiveFilesystemEntries: readonly ProjectPathEntry[];
  filesystemCommandsAvailable: boolean;
}

export function resolveProjectPathCommandTarget(
  target: WorkbenchProjectPathCommandTarget
): ResolvedProjectPathCommandTarget {
  const resolvedEntries = resolveProjectPathCommandEntries(target.selectedEntries);
  return {
    invocationEntry: exactProjectPathEntry(target.invocationEntry.pathEntry),
    ...resolvedEntries
  };
}

function resolveProjectPathCommandEntries(
  entries: readonly WorkbenchProjectPathCommandCandidate[]
): ResolvedProjectPathCommandEntries {
  const explicitSortedCandidates = canonicalCandidates(entries);
  const nonRootCandidates = explicitSortedCandidates.filter((candidate) => (
    candidate.pathEntry.projectRelativePath !== ''
  ));
  const missing = nonRootCandidates.some((candidate) => candidate.availability === 'missing');
  const selectedDirectories = nonRootCandidates
    .filter((candidate) => candidate.pathEntry.kind === 'directory')
    .map((candidate) => candidate.pathEntry.projectRelativePath);
  const effectiveFilesystemCandidates = nonRootCandidates.filter((candidate) => !selectedDirectories.some((directory) => (
    directory !== candidate.pathEntry.projectRelativePath
    && candidate.pathEntry.projectRelativePath.startsWith(`${directory}/`)
  )));
  const selectionEntries = explicitSortedCandidates.map((candidate) => (
    exactProjectPathEntry(candidate.pathEntry)
  ));
  const effectiveFilesystemEntries = effectiveFilesystemCandidates.map((candidate) => (
    exactProjectPathEntry(candidate.pathEntry)
  ));
  return {
    selectionEntries,
    effectiveFilesystemEntries,
    filesystemCommandsAvailable: !missing && effectiveFilesystemEntries.length > 0
  };
}

export function projectPathCommandEntryForCanvasNode(
  node: ProjectedCanvasNode
): WorkbenchProjectPathCommandCandidate {
  return {
    pathEntry: {
      projectRelativePath: node.projectRelativePath,
      kind: node.nodeKind,
      ...(node.nodeKind === 'file' && node.availability.state === 'available'
        ? { sizeBytes: node.availability.size }
        : {})
    },
    ...(node.availability.state === 'directory' ? {} : { availability: node.availability.state })
  };
}

function canonicalCandidates(
  candidates: readonly WorkbenchProjectPathCommandCandidate[]
): WorkbenchProjectPathCommandCandidate[] {
  const byPath = new Map<string, WorkbenchProjectPathCommandCandidate>();
  for (const candidate of candidates) {
    byPath.set(candidate.pathEntry.projectRelativePath, candidate);
  }
  return [...byPath.values()].sort((left, right) => (
    left.pathEntry.projectRelativePath < right.pathEntry.projectRelativePath
      ? -1
      : left.pathEntry.projectRelativePath > right.pathEntry.projectRelativePath ? 1 : 0
  ));
}

function exactProjectPathEntry(entry: ProjectPathEntry): ProjectPathEntry {
  return {
    projectRelativePath: entry.projectRelativePath,
    kind: entry.kind,
    ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes })
  };
}
