import { describe, expect, it } from 'vitest';
import {
  isKnownProjectTextFilePath,
  projectTextFileTypeForPath,
  projectTextLanguageFromPath,
  projectTextMimeTypeFromPath
} from './projectTextFileTypes';

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

  it.each([
    ['subtitles/captions.srt', 'subtitle', 'text/plain'],
    ['subtitles/captions.ass', 'subtitle', 'text/plain'],
    ['subtitles/captions.ssa', 'subtitle', 'text/plain'],
    ['subtitles/captions.sbv', 'subtitle', 'text/plain'],
    ['subtitles/captions.sub', 'subtitle', 'text/plain'],
    ['subtitles/captions.vtt', 'webvtt', 'text/vtt'],
    ['config/app.toml', 'toml', 'application/toml'],
    ['papers/story.tex', 'tex', 'application/x-tex'],
    ['papers/story.latex', 'tex', 'application/x-tex'],
    ['papers/story.ltx', 'tex', 'application/x-tex'],
    ['papers/package.sty', 'tex', 'application/x-tex'],
    ['papers/document.cls', 'tex', 'application/x-tex'],
    ['docs/page.textile', 'textile', 'text/x-textile'],
    ['schema/messages.proto', 'protobuf', 'text/x-protobuf'],
    ['docs/index.rst', 'restructuredtext', 'text/x-rst'],
    ['docs/guide.adoc', 'asciidoc', 'text/x-asciidoc'],
    ['docs/guide.asciidoc', 'asciidoc', 'text/x-asciidoc'],
    ['notes/tasks.org', 'org', 'text/x-org'],
    ['README', 'plaintext', 'text/plain'],
    ['CHANGELOG', 'plaintext', 'text/plain'],
    ['CONTRIBUTING', 'plaintext', 'text/plain'],
    ['NOTICE', 'plaintext', 'text/plain'],
    ['AUTHORS', 'plaintext', 'text/plain'],
    ['COPYING', 'plaintext', 'text/plain']
  ] as const)('detects %s as %s with %s', (path, language, mimeType) => {
    expect(isKnownProjectTextFilePath(path)).toBe(true);
    expect(projectTextLanguageFromPath(path)).toBe(language);
    expect(projectTextMimeTypeFromPath(path)).toBe(mimeType);
    expect(projectTextFileTypeForPath(path)).toMatchObject({
      id: language,
      mimeType
    });
  });

  it.each([
    'brief.pdf',
    'brief.docx',
    'brief.pptx',
    'brief.xlsx',
    'brief.epub'
  ])('does not classify binary document format %s as project text', (path) => {
    expect(isKnownProjectTextFilePath(path)).toBe(false);
    expect(projectTextFileTypeForPath(path)).toBeUndefined();
  });
});
