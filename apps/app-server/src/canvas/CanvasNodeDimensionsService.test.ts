import { describe, expect, it } from 'vitest';
import { readCanvasNodeLayoutSize } from './CanvasNodeDimensionsService';

const PROJECT_ROOT = '/project';

describe('CanvasNodeDimensionsService', () => {
  it('returns compact minimum automatic dimensions for short generic names', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: PROJECT_ROOT,
      projectRelativePath: 'assets',
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 1800, height: 640 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: PROJECT_ROOT,
      projectRelativePath: 'archive.bin',
      nodeKind: 'file',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 1800, height: 640 });
  });

  it('expands generic automatic width from display-name text plus chrome', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: PROJECT_ROOT,
      projectRelativePath: 'assets/abcdefghijklmnopqrstuv',
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 2320, height: 640 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: PROJECT_ROOT,
      projectRelativePath: 'exports/abcdefghijklmnopqrstuv.dat',
      nodeKind: 'file',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 2640, height: 640 });
  });

  it('clamps very long generic automatic widths to the final maximum', async () => {
    const longName = 'a'.repeat(120);

    await expect(readCanvasNodeLayoutSize({
      projectRoot: PROJECT_ROOT,
      projectRelativePath: `assets/${longName}`,
      nodeKind: 'directory',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 7200, height: 640 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: PROJECT_ROOT,
      projectRelativePath: `exports/${longName}.bin`,
      nodeKind: 'file',
      mediaKind: 'unknown'
    })).resolves.toEqual({ width: 7200, height: 640 });
  });

  it('keeps existing fixed dimensions for text and audio nodes', async () => {
    await expect(readCanvasNodeLayoutSize({
      projectRoot: PROJECT_ROOT,
      projectRelativePath: 'notes/readme.md',
      nodeKind: 'file',
      mediaKind: 'text'
    })).resolves.toEqual({ width: 4200, height: 2800 });

    await expect(readCanvasNodeLayoutSize({
      projectRoot: PROJECT_ROOT,
      projectRelativePath: 'audio/theme.wav',
      nodeKind: 'file',
      mediaKind: 'audio'
    })).resolves.toEqual({ width: 3200, height: 960 });
  });
});
