import { describe, expect, it } from 'vitest';
import { resolveProjectPathCommandTarget } from './projectPathCommandTarget.js';

describe('project path command target', () => {
  it('sorts explicit entries while preserving the independent invocation entry', () => {
    const resolved = resolveProjectPathCommandTarget({
      source: 'canvas',
      invocationEntry: { projectRelativePath: 'folder/b.png', kind: 'file' },
      selectedEntries: [
        { projectRelativePath: 'folder/b.png', kind: 'file' },
        { projectRelativePath: 'folder', kind: 'directory' },
        { projectRelativePath: 'folder/a.png', kind: 'file' }
      ]
    });
    expect(resolved.invocationEntry.projectRelativePath).toBe('folder/b.png');
    expect(resolved.explicitSortedEntries.map((entry) => entry.projectRelativePath)).toEqual([
      'folder',
      'folder/a.png',
      'folder/b.png'
    ]);
    expect(resolved.effectiveFilesystemEntries.map((entry) => entry.projectRelativePath)).toEqual(['folder']);
  });

  it('rejects missing batches, permits unreadable previews, and excludes Project root', () => {
    expect(resolveProjectPathCommandTarget({
      source: 'canvas',
      invocationEntry: { projectRelativePath: 'missing.png', kind: 'file' },
      selectedEntries: [{ projectRelativePath: 'missing.png', kind: 'file', availability: 'missing' }]
    }).filesystemCommandsAvailable).toBe(false);
    expect(resolveProjectPathCommandTarget({
      source: 'canvas',
      invocationEntry: { projectRelativePath: 'unreadable.png', kind: 'file' },
      selectedEntries: [{ projectRelativePath: 'unreadable.png', kind: 'file', availability: 'unreadable' }]
    }).filesystemCommandsAvailable).toBe(true);
    expect(resolveProjectPathCommandTarget({
      source: 'canvas',
      invocationEntry: { projectRelativePath: '', kind: 'directory' },
      selectedEntries: [{ projectRelativePath: '', kind: 'directory' }]
    }).effectiveFilesystemEntries).toEqual([]);
  });
});
