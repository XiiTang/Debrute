import { describe, expect, it } from 'vitest';
import { projectTextFileTypeForPath, projectTextLanguageFromPath } from './projectTextFileTypes';

describe('project text file types', () => {
  it('detects Debrute text language ids without editor-specific metadata', () => {
    expect(projectTextLanguageFromPath('src/app.ts')).toBe('typescript');

    const fileType = projectTextFileTypeForPath('src/app.ts');
    expect(fileType).toMatchObject({
      id: 'typescript',
      mimeType: 'text/typescript'
    });
    expect(Object.keys(fileType ?? {}).sort()).toEqual(['extensions', 'firstLine', 'id', 'mimeType']);
  });

  it('keeps text MIME type detection independent from editor engines', () => {
    expect(projectTextFileTypeForPath('notes/readme.md')).toMatchObject({
      id: 'markdown',
      mimeType: 'text/markdown'
    });
    expect(projectTextFileTypeForPath('data/events.jsonl')).toMatchObject({
      id: 'jsonl',
      mimeType: 'application/jsonl'
    });
  });
});
