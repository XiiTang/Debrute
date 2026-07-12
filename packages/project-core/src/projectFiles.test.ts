import { describe, expect, it } from 'vitest';

import {
  assertProjectTreeVisibleMutationPath,
  nextCopyProjectPathName,
  normalizeFileWatchEvent,
  normalizeProjectRelativePath
} from './index.js';

const IMAGE_PREVIEW_CACHE_PATH = '.debrute/cache/canvas-image-previews/images%2Fsource.png--1234567890abcdef/1000%3A6/preview-w300.jpg';
const TEXT_PREVIEW_CACHE_PATH = '.debrute/cache/canvas-text-previews/canvas-1/notes%2Fa.md--1234567890abcdef/preview-w700.png';

describe('project file classification', () => {
  it('classifies project file watch events by current Debrute boundaries', () => {
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/canvases/main.json', 'changed').affects).toEqual(['canvas']);
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/project.json', 'changed').affects).toEqual(['project-metadata']);
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/assets/generated-assets-index.json', 'changed').affects).toEqual(['generated-asset-metadata']);
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/assets/generated/record-1.json', 'changed').affects).toEqual(['generated-asset-metadata']);
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/cache/file-fingerprints.json', 'changed').affects).toEqual([]);
    expect(normalizeFileWatchEvent('/project', `/project/${IMAGE_PREVIEW_CACHE_PATH}`, 'changed').affects).toEqual([]);
    expect(normalizeFileWatchEvent('/project', `/project/${TEXT_PREVIEW_CACHE_PATH}`, 'changed').affects).toEqual([]);
    expect(normalizeFileWatchEvent('/project', '/project/.debrute/canvases/main.json.lock', 'changed').affects).toEqual([]);
    expect(normalizeFileWatchEvent('/project', '/project/notes/draft.tmp', 'changed').affects).toEqual(['content']);
    expect(normalizeFileWatchEvent('/project', '/project/work/items.json', 'changed').affects).toEqual(['content']);
  });

  it('rejects backslash project paths instead of normalizing them into project separators', () => {
    expect(() => normalizeProjectRelativePath('images\\cover.png'))
      .toThrow('Project path must not contain backslashes');
    expect(() => normalizeProjectRelativePath('..\\outside.txt'))
      .toThrow('Project path must not contain backslashes');
  });

  it('exposes the Project Tree mutation visibility boundary for desktop actions', () => {
    expect(() => assertProjectTreeVisibleMutationPath('assets/cover.png')).not.toThrow();
    expect(() => assertProjectTreeVisibleMutationPath(IMAGE_PREVIEW_CACHE_PATH))
      .toThrow('Project path is not visible in the Project Tree');
    expect(() => assertProjectTreeVisibleMutationPath(TEXT_PREVIEW_CACHE_PATH))
      .toThrow('Project path is not visible in the Project Tree');
    expect(() => assertProjectTreeVisibleMutationPath('.debrute/canvases/canvas-1.json'))
      .toThrow('Project path is protected by the Project Document System');
    expect(() => assertProjectTreeVisibleMutationPath('.git/config'))
      .toThrow('Project path is not visible in the Project Tree');
    expect(() => assertProjectTreeVisibleMutationPath('.DeBrute/canvases/canvas-1.json'))
      .toThrow('Project path is protected by the Project Document System');
    expect(() => assertProjectTreeVisibleMutationPath('.GIT/config'))
      .toThrow('Project path is not visible in the Project Tree');
  });

  it('generates repeated copy names for files and extensionless paths', () => {
    expect(nextCopyProjectPathName(new Set(['cover.png']), 'cover.png')).toBe('cover copy.png');
    expect(nextCopyProjectPathName(new Set(['cover.png', 'cover copy.png']), 'cover.png')).toBe('cover copy 2.png');
    expect(nextCopyProjectPathName(new Set(['brief', 'brief copy']), 'brief')).toBe('brief copy 2');
  });
});
