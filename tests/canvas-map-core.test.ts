import { describe, expect, it } from 'vitest';
import {
  CanvasMapError,
  canvasMapPath,
  expandCanvasMap,
  expandCanvasMapPathRules,
  parseCanvasMap,
  serializeCanvasMapWithRule,
  type CanvasMapProjectEntry
} from '@debrute/canvas-map-core';

describe('canvas-map core', () => {
  it('parses top-level object paths and layout rows', () => {
    const map = parseCanvasMap({
      canvasId: 'canvas-1',
      sourcePath: '.debrute/canvas-maps/canvas-1.yaml',
      content: [
        'paths:',
        '  - prompts/cover.md',
        '  - outputs/gpt/',
        '  - outputs/**/*.png',
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
    })).toThrow('Canvas Map path rule must be a non-empty string.');

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

  it('expands exact files, recursive folders, file-only globs, ancestor folders, and rows', () => {
    const map = parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: [
        'paths:',
        '  - prompts/cover.md',
        '  - outputs/gpt/',
        '  - outputs/**/*.png',
        '  - missing/future.md',
        'layout:',
        '  rows:',
        '    - outputs/**/high/*.png',
        ''
      ].join('\n')
    });
    const entries: CanvasMapProjectEntry[] = [
      { projectRelativePath: 'prompts', kind: 'directory' },
      { projectRelativePath: 'prompts/cover.md', kind: 'file' },
      { projectRelativePath: 'outputs', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt/high', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt/high/a.png', kind: 'file' },
      { projectRelativePath: 'outputs/gpt/high/b.png', kind: 'file' },
      { projectRelativePath: 'outputs/gpt/high/readme.md', kind: 'file' },
      { projectRelativePath: 'outputs/gemini', kind: 'directory' },
      { projectRelativePath: 'outputs/gemini/high', kind: 'directory' },
      { projectRelativePath: 'outputs/gemini/high/a.png', kind: 'file' },
      { projectRelativePath: 'outputs/gemini/high/nested', kind: 'directory' },
      { projectRelativePath: 'outputs/gemini/high/nested/deep.png', kind: 'file' },
      { projectRelativePath: 'outputs/manual', kind: 'directory' },
      { projectRelativePath: 'outputs/manual/c.png', kind: 'file' },
      { projectRelativePath: 'outputs/manual/folder.png', kind: 'directory' }
    ];

    expect(expandCanvasMap(map, entries)).toEqual({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      nodes: [
        { projectRelativePath: 'outputs', nodeKind: 'directory' },
        { projectRelativePath: 'outputs/gemini', nodeKind: 'directory' },
        { projectRelativePath: 'outputs/gemini/high', nodeKind: 'directory' },
        { projectRelativePath: 'outputs/gemini/high/nested', nodeKind: 'directory' },
        { projectRelativePath: 'outputs/gemini/high/nested/deep.png', nodeKind: 'file' },
        { projectRelativePath: 'outputs/gemini/high/a.png', nodeKind: 'file' },
        { projectRelativePath: 'outputs/gpt', nodeKind: 'directory' },
        { projectRelativePath: 'outputs/gpt/high', nodeKind: 'directory' },
        { projectRelativePath: 'outputs/gpt/high/a.png', nodeKind: 'file' },
        { projectRelativePath: 'outputs/gpt/high/b.png', nodeKind: 'file' },
        { projectRelativePath: 'outputs/gpt/high/readme.md', nodeKind: 'file' },
        { projectRelativePath: 'outputs/manual', nodeKind: 'directory' },
        { projectRelativePath: 'outputs/manual/c.png', nodeKind: 'file' },
        { projectRelativePath: 'prompts', nodeKind: 'directory' },
        { projectRelativePath: 'prompts/cover.md', nodeKind: 'file' }
      ],
      layoutRows: [
        {
          parentProjectRelativePath: 'outputs/gemini/high',
          memberProjectRelativePaths: ['outputs/gemini/high/a.png']
        },
        {
          parentProjectRelativePath: 'outputs/gpt/high',
          memberProjectRelativePaths: [
            'outputs/gpt/high/a.png',
            'outputs/gpt/high/b.png'
          ]
        },
        {
          parentProjectRelativePath: 'outputs/gemini/high/nested',
          memberProjectRelativePaths: ['outputs/gemini/high/nested/deep.png']
        },
        {
          parentProjectRelativePath: 'outputs/gpt/high',
          memberProjectRelativePaths: ['outputs/gpt/high/readme.md']
        },
        {
          parentProjectRelativePath: 'outputs/manual',
          memberProjectRelativePaths: ['outputs/manual/c.png']
        },
        {
          parentProjectRelativePath: 'prompts',
          memberProjectRelativePaths: ['prompts/cover.md']
        }
      ]
    });
  });

  it('expands YAML row splits before default remainder rows for each parent directory', () => {
    const map = parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: [
        'paths:',
        '  - outputs/gpt/',
        '  - outputs/gemini/',
        'layout:',
        '  rows:',
        '    - outputs/**/[bd].png',
        '    - outputs/**/notes-*.md',
        ''
      ].join('\n')
    });

    const entries: CanvasMapProjectEntry[] = [
      { projectRelativePath: 'outputs', kind: 'directory' },
      { projectRelativePath: 'outputs/gemini', kind: 'directory' },
      { projectRelativePath: 'outputs/gemini/a.png', kind: 'file' },
      { projectRelativePath: 'outputs/gemini/b.png', kind: 'file' },
      { projectRelativePath: 'outputs/gpt', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt/a.png', kind: 'file' },
      { projectRelativePath: 'outputs/gpt/b.png', kind: 'file' },
      { projectRelativePath: 'outputs/gpt/c.png', kind: 'file' },
      { projectRelativePath: 'outputs/gpt/d.png', kind: 'file' },
      { projectRelativePath: 'outputs/gpt/notes-1.md', kind: 'file' },
      { projectRelativePath: 'outputs/gpt/readme.md', kind: 'file' }
    ];

    expect(expandCanvasMap(map, entries).layoutRows).toEqual([
      {
        parentProjectRelativePath: 'outputs/gemini',
        memberProjectRelativePaths: ['outputs/gemini/b.png']
      },
      {
        parentProjectRelativePath: 'outputs/gpt',
        memberProjectRelativePaths: [
          'outputs/gpt/b.png',
          'outputs/gpt/d.png'
        ]
      },
      {
        parentProjectRelativePath: 'outputs/gpt',
        memberProjectRelativePaths: ['outputs/gpt/notes-1.md']
      },
      {
        parentProjectRelativePath: 'outputs/gemini',
        memberProjectRelativePaths: ['outputs/gemini/a.png']
      },
      {
        parentProjectRelativePath: 'outputs/gpt',
        memberProjectRelativePaths: [
          'outputs/gpt/a.png',
          'outputs/gpt/c.png',
          'outputs/gpt/readme.md'
        ]
      }
    ]);
  });

  it('expands reset path rules without adding file ancestors', () => {
    const entries: CanvasMapProjectEntry[] = [
      { projectRelativePath: 'outputs', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt/high', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt/high/a.png', kind: 'file' },
      { projectRelativePath: 'outputs/gpt/high/b.md', kind: 'file' },
      { projectRelativePath: 'prompts', kind: 'directory' },
      { projectRelativePath: 'prompts/cover.md', kind: 'file' }
    ];

    expect(expandCanvasMapPathRules(['prompts/cover.md', 'outputs/**/*.png'], entries)).toEqual([
      { projectRelativePath: 'outputs/gpt/high/a.png', nodeKind: 'file' },
      { projectRelativePath: 'prompts/cover.md', nodeKind: 'file' }
    ]);

    expect(expandCanvasMapPathRules(['outputs/gpt/'], entries)).toEqual([
      { projectRelativePath: 'outputs/gpt', nodeKind: 'directory' },
      { projectRelativePath: 'outputs/gpt/high', nodeKind: 'directory' },
      { projectRelativePath: 'outputs/gpt/high/a.png', nodeKind: 'file' },
      { projectRelativePath: 'outputs/gpt/high/b.md', nodeKind: 'file' }
    ]);
  });

  it('keeps row expansion file-only even when a matching project path is a directory', () => {
    const map = parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: [
        'paths:',
        '  - outputs/gpt/',
        'layout:',
        '  rows:',
        '    - outputs/gpt/*.png',
        ''
      ].join('\n')
    });

    expect(expandCanvasMap(map, [
      { projectRelativePath: 'outputs', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt/a.png', kind: 'file' },
      { projectRelativePath: 'outputs/gpt/folder.png', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt/folder.png/nested.png', kind: 'file' }
    ])).toMatchObject({
      nodes: [
        { projectRelativePath: 'outputs', nodeKind: 'directory' },
        { projectRelativePath: 'outputs/gpt', nodeKind: 'directory' },
        { projectRelativePath: 'outputs/gpt/folder.png', nodeKind: 'directory' },
        { projectRelativePath: 'outputs/gpt/folder.png/nested.png', nodeKind: 'file' },
        { projectRelativePath: 'outputs/gpt/a.png', nodeKind: 'file' }
      ],
      layoutRows: [{
        parentProjectRelativePath: 'outputs/gpt',
        memberProjectRelativePaths: ['outputs/gpt/a.png']
      },
      {
        parentProjectRelativePath: 'outputs/gpt/folder.png',
        memberProjectRelativePaths: ['outputs/gpt/folder.png/nested.png']
      }]
    });
  });

  it('accepts quiet future row rules and rejects duplicate row control', () => {
    expect(expandCanvasMap(parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: 'paths:\n  - future/**/*.png\nlayout:\n  rows:\n    - future/**/high/*.png\n'
    }), [])).toMatchObject({
      nodes: [],
      layoutRows: []
    });

    expect(() => expandCanvasMap(parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: [
        'paths:',
        '  - outputs/**/*.png',
        'layout:',
        '  rows:',
        '    - outputs/**/*.png',
        '    - outputs/gpt/*.png',
        ''
      ].join('\n')
    }), [
      { projectRelativePath: 'outputs', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt', kind: 'directory' },
      { projectRelativePath: 'outputs/gpt/a.png', kind: 'file' }
    ])).toThrow('Canvas Map row rules match the same file more than once: outputs/gpt/a.png');
  });

  it('accepts missing future paths and rejects rules that contradict existing file kinds', () => {
    expect(() => expandCanvasMap(parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: 'paths:\n  - outputs\n'
    }), [
      { projectRelativePath: 'outputs', kind: 'directory' }
    ])).toThrow('Canvas Map file rule currently resolves to a directory. Use a trailing slash for recursive folders: outputs/');

    expect(() => expandCanvasMap(parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: 'paths:\n  - prompts/cover.md/\n'
    }), [
      { projectRelativePath: 'prompts/cover.md', kind: 'file' }
    ])).toThrow('Canvas Map folder rule currently resolves to a file: prompts/cover.md');

    expect(expandCanvasMap(parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: 'paths:\n  - future/path.md\n  - future/folder/\n  - future/**/*.png\n'
    }), [])).toMatchObject({
      nodes: [],
      layoutRows: []
    });
  });

  it('reports invalid glob syntax as a Canvas Map validation error', () => {
    try {
      expandCanvasMap(parseCanvasMap({
        canvasId: 'main',
        sourcePath: '.debrute/canvas-maps/main.yaml',
        content: 'paths:\n  - outputs/[z-a].png\n'
      }), [
        { projectRelativePath: 'outputs/a.png', kind: 'file' }
      ]);
      throw new Error('Expected glob validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasMapError);
      expect(error).toMatchObject({ code: 'canvas_map_invalid_path' });
    }
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
