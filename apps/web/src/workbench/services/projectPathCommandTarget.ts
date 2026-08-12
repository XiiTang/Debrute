import type { ProjectPathRef } from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from '../canvas/CanvasScene';

export type ProjectPathCommandEntry = ProjectPathRef & { missing?: true };

export interface ProjectPathCommandTarget {
  source: 'canvas' | 'explorer';
  invocation: ProjectPathCommandEntry;
  selection: readonly ProjectPathCommandEntry[];
}

export function projectPathBasename(projectRelativePath: string): string {
  return projectRelativePath.slice(projectRelativePath.lastIndexOf('/') + 1);
}

export function projectPathParent(projectRelativePath: string): string {
  const slash = projectRelativePath.lastIndexOf('/');
  return slash < 0 ? '' : projectRelativePath.slice(0, slash);
}

export function resolveProjectPathCommandTarget(
  target: ProjectPathCommandTarget
): readonly ProjectPathCommandEntry[] {
  const uniqueEntries: ProjectPathCommandEntry[] = [];
  const seenPaths = new Set<string>();
  for (const entry of target.selection) {
    if (entry.projectRelativePath === '' || seenPaths.has(entry.projectRelativePath)) {
      continue;
    }
    seenPaths.add(entry.projectRelativePath);
    uniqueEntries.push(entry);
  }

  const selectedDirectories = uniqueEntries.filter((entry) => entry.kind === 'directory');
  return uniqueEntries.filter((entry) => !selectedDirectories.some((directory) => (
    directory !== entry
    && entry.projectRelativePath.startsWith(`${directory.projectRelativePath}/`)
  )));
}

export function projectPathCommandsAvailable(
  entries: readonly ProjectPathCommandEntry[]
): boolean {
  return entries.length > 0 && entries.every((entry) => entry.missing !== true);
}

export function projectPathCommandEntryForCanvasNode(
  node: ProjectedCanvasNode
): ProjectPathCommandEntry {
  return {
    projectRelativePath: node.projectRelativePath,
    kind: node.nodeKind,
    ...(node.availability.state === 'missing' ? { missing: true } : {})
  };
}
