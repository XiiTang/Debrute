import { describe, expect, it } from 'vitest';

import {
  CanvasMapError,
  canvasMapPath,
  parseCanvasMap,
  serializeCanvasMapWithRule
} from './index.js';

describe('Canvas Map parsing', () => {
  it('parses top-level object paths and layout rows', () => {
    const map = parseCanvasMap({
      canvasId: 'canvas-1',
      sourcePath: '.debrute/canvas-maps/canvas-1.yaml',
      content: [
        'paths:',
        '  - prompts/cover.md',
        '  - outputs/gpt/',
        '  - glob: outputs/**/*.png',
        'layout:',
        '  rows:',
        '    - outputs/**/high/*.png',
        ''
      ].join('\n')
    });

    expect(map).toEqual({
      canvasId: 'canvas-1',
      sourcePath: '.debrute/canvas-maps/canvas-1.yaml',
      paths: [
        { raw: 'prompts/cover.md', pattern: 'prompts/cover.md', kind: 'exact-file' },
        { raw: 'outputs/gpt/', pattern: 'outputs/gpt', kind: 'recursive-directory' },
        { raw: 'outputs/**/*.png', pattern: 'outputs/**/*.png', kind: 'file-glob' }
      ],
      layoutRows: [
        { raw: 'outputs/**/high/*.png', pattern: 'outputs/**/high/*.png' }
      ]
    });
    expect(canvasMapPath('canvas-1')).toBe('.debrute/canvas-maps/canvas-1.yaml');
  });

  it('rejects non-object YAML, unknown fields, invalid paths, and invalid rows', () => {
    expect(() => parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: '- prompts/cover.md\n'
    })).toThrow('Canvas Map YAML must be a top-level object.');

    expect(() => parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: 'paths:\n  - a.md\nitems: []\n'
    })).toThrow('Unsupported Canvas Map field "items".');

    expect(() => parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: 'paths:\n  - 1\n'
    })).toThrow('Canvas Map path rule must be a non-empty string or a glob object.');

    expect(() => parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: 'paths:\n  - ../outside.md\n'
    })).toThrow('Canvas Map path must be a safe relative project path.');

    expect(() => parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: 'paths:\n  - "!outputs/tmp/"\n'
    })).toThrow('Canvas Map negative rules are not supported.');

    expect(() => parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: 'paths:\n  - outputs/**/*.png\nlayout:\n  rows:\n    - outputs/high/\n'
    })).toThrow('Canvas Map row rules must be file globs.');

    expect(() => parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: 'paths:\n  - outputs/**/*.png\nlayout:\n  rows:\n'
    })).toThrow('Canvas Map layout.rows must be an array.');

    expect(() => parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: 'paths:\n  - outputs/**/*.png\nlayout:\n  columns: []\n'
    })).toThrow('Unsupported Canvas Map layout field "columns".');
  });

  it('serializes drag-added path rules without duplicates while preserving rows', () => {
    const source = [
      'paths:',
      '  - prompts/cover.md',
      'layout:',
      '  rows:',
      '    - outputs/**/high/*.png',
      ''
    ].join('\n');

    expect(serializeCanvasMapWithRule(source, 'outputs/gpt/')).toBe([
      'paths:',
      '  - prompts/cover.md',
      '  - outputs/gpt/',
      'layout:',
      '  rows:',
      '    - outputs/**/high/*.png',
      ''
    ].join('\n'));
    expect(serializeCanvasMapWithRule(source, 'prompts/cover.md')).toBe(source);
  });

  it('surfaces YAML parse positions on CanvasMapError', () => {
    try {
      parseCanvasMap({
        canvasId: 'main',
        sourcePath: '.debrute/canvas-maps/main.yaml',
        content: 'paths:\n  - [broken\n'
      });
      throw new Error('Expected parse to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasMapError);
      expect(error).toMatchObject({ code: 'canvas_map_invalid_yaml' });
    }
  });
});
