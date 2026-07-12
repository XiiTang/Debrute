import { describe, expect, it } from 'vitest';
import {
  isKnownProjectTextFilePath,
  projectTextFileTypeForPath,
  projectTextLanguageFromPath,
  projectTextMimeTypeFromPath
} from './projectTextFileTypes';

describe('project text file types', () => {
  it('classifies supported project text file formats through one registry', () => {
    const cases: Array<{ path: string; language: string; mimeType: string; firstLine?: string }> = [
      { path: 'batch/requests.jsonl', language: 'jsonl', mimeType: 'application/jsonl' },
      { path: 'batch/results.ndjson', language: 'jsonl', mimeType: 'application/jsonl' },
      { path: 'config/settings.jsonc', language: 'jsonc', mimeType: 'application/jsonc' },
      { path: 'config/.eslintrc', language: 'jsonc', mimeType: 'application/jsonc' },
      { path: 'docs/notes.mdown', language: 'markdown', mimeType: 'text/markdown' },
      { path: 'skills/SKILL.md', language: 'markdown', mimeType: 'text/markdown' },
      { path: 'compose.dev.yml', language: 'yaml', mimeType: 'application/yaml' },
      { path: 'scripts/run.sh', language: 'shell', mimeType: 'text/x-shellscript' },
      { path: '.zshrc', language: 'shell', mimeType: 'text/x-shellscript' },
      { path: 'bin/run', firstLine: '#!/usr/bin/env bash', language: 'shell', mimeType: 'text/x-shellscript' },
      { path: '.env.local', language: 'dotenv', mimeType: 'text/plain' },
      { path: '.editorconfig', language: 'properties', mimeType: 'text/plain' },
      { path: '.gitignore', language: 'plaintext', mimeType: 'text/plain' },
      { path: '.npmrc', language: 'properties', mimeType: 'text/plain' },
      { path: 'logs/debrute.log', language: 'log', mimeType: 'text/plain' },
      { path: 'logs/debrute.log.1', language: 'log', mimeType: 'text/plain' },
      { path: 'Dockerfile', language: 'dockerfile', mimeType: 'text/plain' },
      { path: 'Containerfile.dev', language: 'dockerfile', mimeType: 'text/plain' },
      { path: 'Makefile', language: 'makefile', mimeType: 'text/plain' },
      { path: 'build/rules.mk', language: 'makefile', mimeType: 'text/plain' },
      { path: 'patches/fix.patch', language: 'diff', mimeType: 'text/plain' },
      { path: 'data/table.tsv', language: 'tsv', mimeType: 'text/tab-separated-values' },
      { path: 'src/module.mts', language: 'typescript', mimeType: 'text/typescript' },
      { path: 'scripts/build.py', language: 'python', mimeType: 'text/x-python' },
      { path: 'LICENSE', language: 'plaintext', mimeType: 'text/plain' }
    ];

    for (const item of cases) {
      expect(projectTextLanguageFromPath(item.path, item.firstLine)).toBe(item.language);
      expect(projectTextMimeTypeFromPath(item.path, item.firstLine)).toBe(item.mimeType);
      expect(isKnownProjectTextFilePath(item.path, item.firstLine)).toBe(true);
      expect(projectTextFileTypeForPath(item.path, item.firstLine)).toMatchObject({
        id: item.language,
        mimeType: item.mimeType
      });
    }

    expect(isKnownProjectTextFilePath('assets/cover.png')).toBe(false);
    expect(isKnownProjectTextFilePath('assets/icon.svg')).toBe(false);
    expect(isKnownProjectTextFilePath('archives/export.debrutebin')).toBe(false);
  });

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
    'subtitles/captions.sub',
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
