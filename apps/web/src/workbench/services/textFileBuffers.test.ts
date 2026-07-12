import { describe, expect, it } from 'vitest';
import type { TextFileBuffer } from '../../types';
import { textBufferFromFile } from './textFileBuffers';

describe('text file buffer merge behavior', () => {
  it('reloads clean buffers from externally changed files', () => {
    const current: TextFileBuffer = {
      projectRelativePath: 'briefs/concept.md',
      content: 'old',
      language: 'markdown',
      wordWrap: true,
      dirty: false,
      saving: false,
      baseRevision: 'rev-1',
      externalChange: false
    };

	    expect(textBufferFromFile({
	      projectRelativePath: 'briefs/concept.md',
	      content: 'new',
      size: 3,
      mtimeMs: 20,
      revision: 'rev-2',
      language: 'markdown',
      mimeType: 'text/markdown'
    }, current)).toMatchObject({
      content: 'new',
      dirty: false,
      baseRevision: 'rev-2',
      externalChange: false,
      wordWrap: true
    });
  });

  it('preserves dirty local edits and marks external changes', () => {
    const current: TextFileBuffer = {
      projectRelativePath: 'briefs/concept.md',
      content: 'local edit',
      language: 'markdown',
      wordWrap: false,
      dirty: true,
      saving: false,
      baseRevision: 'rev-1',
      externalChange: false
    };

	    expect(textBufferFromFile({
	      projectRelativePath: 'briefs/concept.md',
	      content: 'external edit',
      size: 13,
      mtimeMs: 30,
      revision: 'rev-2',
      language: 'markdown',
      mimeType: 'text/markdown'
    }, current)).toMatchObject({
      content: 'local edit',
      dirty: true,
      baseRevision: 'rev-1',
      externalChange: true
    });
  });

  it('keeps an active save marked as saving while a file event is reconciled', () => {
    const current: TextFileBuffer = {
      projectRelativePath: 'briefs/concept.md',
      content: 'local edit',
      language: 'markdown',
      wordWrap: false,
      dirty: true,
      saving: true,
      baseRevision: 'rev-1',
      externalChange: false
    };

	    expect(textBufferFromFile({
	      projectRelativePath: 'briefs/concept.md',
	      content: 'disk content',
      size: 12,
      mtimeMs: 20,
	      revision: 'rev-2',
      language: 'markdown',
      mimeType: 'text/markdown'
    }, current)).toMatchObject({
      content: 'local edit',
      dirty: true,
      saving: true,
      baseRevision: 'rev-1',
      externalChange: true
    });
  });
});
