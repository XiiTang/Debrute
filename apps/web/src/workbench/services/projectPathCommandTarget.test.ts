import { describe, expect, it } from 'vitest';
import {
  projectPathCommandEntryForCanvasNode,
  projectPathCommandsAvailable,
  resolveProjectPathCommandTarget,
  type ProjectPathCommandEntry
} from './projectPathCommandTarget';

describe('project path command target', () => {
  it('preserves first-seen selection order while deduplicating and removing Project root', () => {
    const resolved = resolveProjectPathCommandTarget({
      source: 'canvas',
      invocation: entry('folder/b.png', 'file'),
      selection: [
        entry('folder/b.png', 'file'),
        entry('', 'directory'),
        entry('Folder/Z.png', 'file'),
        entry('folder/b.png', 'file'),
        entry('folder/a.png', 'file')
      ]
    });

    expect(resolved.map((item) => item.projectRelativePath)).toEqual([
      'folder/b.png',
      'Folder/Z.png',
      'folder/a.png'
    ]);
  });

  it('lets a selected directory cover descendants without reordering survivors', () => {
    const resolved = resolveProjectPathCommandTarget({
      source: 'explorer',
      invocation: entry('folder/b.png', 'file'),
      selection: [
        entry('before.png', 'file'),
        entry('folder/b.png', 'file'),
        entry('folder', 'directory'),
        entry('after.png', 'file'),
        entry('folder/deep/c.png', 'file')
      ]
    });

    expect(resolved).toEqual([
      entry('before.png', 'file'),
      entry('folder', 'directory'),
      entry('after.png', 'file')
    ]);
  });

  it('uses only missing to decide filesystem command availability', () => {
    expect(projectPathCommandsAvailable([entry('available.png', 'file')])).toBe(true);
    expect(projectPathCommandsAvailable([entry('missing.png', 'file', true)])).toBe(false);
    expect(projectPathCommandsAvailable([])).toBe(false);
  });

  it('maps Canvas preview state to a path reference with missing as the only qualifier', () => {
    expect(projectPathCommandEntryForCanvasNode({
      projectRelativePath: 'missing.png',
      displayName: 'missing.png',
      nodeKind: 'file',
      mediaKind: 'image',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      z: 0,
      availability: { state: 'missing', message: 'missing' }
    })).toEqual(entry('missing.png', 'file', true));

    expect(projectPathCommandEntryForCanvasNode({
      projectRelativePath: 'unreadable.png',
      displayName: 'unreadable.png',
      nodeKind: 'file',
      mediaKind: 'image',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      z: 0,
      availability: { state: 'unreadable', message: 'unreadable' }
    })).toEqual(entry('unreadable.png', 'file'));
  });
});

function entry(
  projectRelativePath: string,
  kind: 'file' | 'directory',
  missing = false
): ProjectPathCommandEntry {
  return {
    projectRelativePath,
    kind,
    ...(missing ? { missing: true } : {})
  };
}
