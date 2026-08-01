import { describe, expect, it } from 'vitest';
import type { ProjectPathEntry } from '@debrute/app-protocol';
import {
  projectPathCommandEntryForCanvasNode,
  resolveProjectPathCommandTarget
} from './projectPathCommandTarget.js';

describe('project path command target', () => {
  it('sorts explicit entries while preserving the independent invocation entry', () => {
    const resolved = resolveProjectPathCommandTarget({
      source: 'canvas',
      invocationEntry: candidate({ projectRelativePath: 'folder/b.png', kind: 'file' }),
      selectedEntries: [
        candidate({ projectRelativePath: 'folder/b.png', kind: 'file' }),
        candidate({ projectRelativePath: 'Folder/Z.png', kind: 'file' }),
        candidate({ projectRelativePath: 'folder', kind: 'directory' }),
        candidate({ projectRelativePath: 'folder/a.png', kind: 'file' })
      ]
    });
    expect(resolved.invocationEntry.projectRelativePath).toBe('folder/b.png');
    expect(resolved.selectionEntries.map((entry) => entry.projectRelativePath)).toEqual([
      'Folder/Z.png',
      'folder',
      'folder/a.png',
      'folder/b.png'
    ]);
    expect(resolved.effectiveFilesystemEntries.map((entry) => entry.projectRelativePath)).toEqual([
      'Folder/Z.png',
      'folder'
    ]);
  });

  it('keeps Canvas availability out of Project Path command entries', () => {
    const canvasEntry = projectPathCommandEntryForCanvasNode({
      projectRelativePath: 'available.png',
      nodeKind: 'file',
      mediaKind: 'image',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      z: 0,
      availability: {
        state: 'available',
        size: 42,
        mimeType: 'image/png',
        fileUrl: '/files/available.png',
        revision: 'rev'
      }
    });
    const resolved = resolveProjectPathCommandTarget({
      source: 'canvas',
      invocationEntry: canvasEntry,
      selectedEntries: [canvasEntry]
    });

    expect(resolved.invocationEntry).toEqual({
      projectRelativePath: 'available.png',
      kind: 'file',
      sizeBytes: 42
    });
    expect(resolved.selectionEntries).toEqual([{
      projectRelativePath: 'available.png',
      kind: 'file',
      sizeBytes: 42
    }]);
    expect(resolved.effectiveFilesystemEntries).toEqual([{
      projectRelativePath: 'available.png',
      kind: 'file',
      sizeBytes: 42
    }]);
  });

  it('rejects missing batches, permits unreadable previews, and excludes Project root', () => {
    expect(resolveProjectPathCommandTarget({
      source: 'canvas',
      invocationEntry: candidate({ projectRelativePath: 'missing.png', kind: 'file' }),
      selectedEntries: [candidate({ projectRelativePath: 'missing.png', kind: 'file' }, 'missing')]
    }).filesystemCommandsAvailable).toBe(false);
    expect(resolveProjectPathCommandTarget({
      source: 'canvas',
      invocationEntry: candidate({ projectRelativePath: 'unreadable.png', kind: 'file' }),
      selectedEntries: [candidate({ projectRelativePath: 'unreadable.png', kind: 'file' }, 'unreadable')]
    }).filesystemCommandsAvailable).toBe(true);
    expect(resolveProjectPathCommandTarget({
      source: 'canvas',
      invocationEntry: candidate({ projectRelativePath: '', kind: 'directory' }),
      selectedEntries: [candidate({ projectRelativePath: '', kind: 'directory' })]
    }).effectiveFilesystemEntries).toEqual([]);
  });
});

function candidate(
  pathEntry: ProjectPathEntry,
  availability?: 'available' | 'missing' | 'unreadable'
) {
  return {
    pathEntry,
    ...(availability === undefined ? {} : { availability })
  };
}
