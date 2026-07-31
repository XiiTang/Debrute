import { describe, expect, it } from 'vitest';
import {
  createInlineEditState,
  projectTreePasteTargetDirectory,
  validateInlineProjectName
} from './projectTreeEditing';

describe('project tree editing helpers', () => {
  it('creates inline edit states for new files, folders, and rename', () => {
    expect(createInlineEditState('creating-file', 'assets')).toMatchObject({
      kind: 'creating-file',
      parentProjectRelativePath: 'assets',
      value: ''
    });
    expect(createInlineEditState('creating-directory', 'assets')).toMatchObject({
      kind: 'creating-directory',
      parentProjectRelativePath: 'assets',
      value: ''
    });
    expect(createInlineEditState('renaming', 'assets/cover.png')).toMatchObject({
      kind: 'renaming',
      projectRelativePath: 'assets/cover.png',
      value: 'cover.png'
    });
  });

  it('validates inline project basenames', () => {
    expect(validateInlineProjectName(' cover.png ')).toEqual({ ok: true, name: 'cover.png' });
    expect(validateInlineProjectName('')).toEqual({ ok: false, message: 'required' });
    expect(validateInlineProjectName('nested/name.md')).toEqual({ ok: false, message: 'path-separators' });
    expect(validateInlineProjectName('nested\\name.md')).toEqual({ ok: false, message: 'path-separators' });
  });

  it('resolves paste target directories from file and directory targets', () => {
    expect(projectTreePasteTargetDirectory({
      source: 'explorer',
      invocationEntry: { projectRelativePath: 'assets', kind: 'directory' },
      selectedEntries: [{ projectRelativePath: 'assets', kind: 'directory' }]
    })).toBe('assets');
    expect(projectTreePasteTargetDirectory({
      source: 'explorer',
      invocationEntry: { projectRelativePath: 'assets/cover.png', kind: 'file' },
      selectedEntries: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }]
    })).toBe('assets');
    expect(projectTreePasteTargetDirectory({
      source: 'explorer',
      invocationEntry: { projectRelativePath: '', kind: 'directory' },
      selectedEntries: []
    })).toBe('');
  });
});
