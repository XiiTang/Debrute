import { describe, expect, it } from 'vitest';
import {
  CanvasMapError,
  expandCanvasMap,
  expandCanvasMapPathRules,
  parseCanvasMap,
  type CanvasMapProjectEntry
} from './index.js';

describe('Canvas Map projection', () => {
  it('expands visible Debrute files, including the Canvas Map itself, without absent cache entries', () => {
    const map = parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: [
        'paths:',
        '  - .debrute/',
        '  - .debrute/canvas-maps/main.yaml',
        '  - .debrute/cache/canvas-text-previews/source.png',
        ''
      ].join('\n')
    });
    const entries: CanvasMapProjectEntry[] = [
      { projectRelativePath: '.debrute', kind: 'directory' },
      { projectRelativePath: '.debrute/canvas-maps', kind: 'directory' },
      { projectRelativePath: '.debrute/canvas-maps/main.yaml', kind: 'file' },
      { projectRelativePath: '.debrute/project.json', kind: 'file' }
    ];

    expect(expandCanvasMap(map, entries).nodes.map((node) => node.projectRelativePath)).toEqual([
      '',
      '.debrute',
      '.debrute/canvas-maps',
      '.debrute/canvas-maps/main.yaml',
      '.debrute/project.json'
    ]);
  });

  it('expands exact files, recursive folders, file-only globs, ancestor folders, and rows', () => {
    const map = parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: [
        'paths:',
        '  - prompts/cover.md',
        '  - outputs/gpt/',
        '  - glob: outputs/**/*.png',
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
        { projectRelativePath: '', nodeKind: 'directory' },
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

  it('expands the project root node and default rows for root-level files', () => {
    const map = parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: [
        'paths:',
        '  - glob: "*.md"',
        ''
      ].join('\n')
    });

    const entries: CanvasMapProjectEntry[] = [
      { projectRelativePath: 'brief.md', kind: 'file' },
      { projectRelativePath: 'readme.md', kind: 'file' },
      { projectRelativePath: 'outputs', kind: 'directory' },
      { projectRelativePath: 'outputs/a.png', kind: 'file' }
    ];

    expect(expandCanvasMap(map, entries)).toEqual({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      nodes: [
        { projectRelativePath: '', nodeKind: 'directory' },
        { projectRelativePath: 'brief.md', nodeKind: 'file' },
        { projectRelativePath: 'readme.md', nodeKind: 'file' }
      ],
      layoutRows: [{
        parentProjectRelativePath: '',
        memberProjectRelativePaths: ['brief.md', 'readme.md']
      }]
    });
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

    expect(expandCanvasMapPathRules({ paths: ['prompts/cover.md'], globs: ['outputs/**/*.png'] }, entries)).toEqual([
      { projectRelativePath: 'outputs/gpt/high/a.png', nodeKind: 'file' },
      { projectRelativePath: 'prompts/cover.md', nodeKind: 'file' }
    ]);

    expect(expandCanvasMapPathRules({ paths: ['outputs/gpt/'] }, entries)).toEqual([
      { projectRelativePath: 'outputs/gpt', nodeKind: 'directory' },
      { projectRelativePath: 'outputs/gpt/high', nodeKind: 'directory' },
      { projectRelativePath: 'outputs/gpt/high/a.png', nodeKind: 'file' },
      { projectRelativePath: 'outputs/gpt/high/b.md', nodeKind: 'file' }
    ]);
  });

  it('treats Canvas Map string paths literally and requires explicit glob rules', () => {
    const entries: CanvasMapProjectEntry[] = [
      { projectRelativePath: 'videos', kind: 'directory' },
      { projectRelativePath: 'videos/谷歌：正在评估中国内存 [BV1LKjS6gEaN].mp4', kind: 'file' },
      { projectRelativePath: 'videos/clip-a.mp4', kind: 'file' },
      { projectRelativePath: 'videos/clip-b.mp4', kind: 'file' }
    ];

    expect(expandCanvasMap(parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: [
        'paths:',
        '  - videos/谷歌：正在评估中国内存 [BV1LKjS6gEaN].mp4',
        '  - videos/clip-*.mp4',
        '  - glob: videos/clip-*.mp4',
        ''
      ].join('\n')
    }), entries).nodes).toEqual([
      { projectRelativePath: '', nodeKind: 'directory' },
      { projectRelativePath: 'videos', nodeKind: 'directory' },
      { projectRelativePath: 'videos/clip-a.mp4', nodeKind: 'file' },
      { projectRelativePath: 'videos/clip-b.mp4', nodeKind: 'file' },
      { projectRelativePath: 'videos/谷歌：正在评估中国内存 [BV1LKjS6gEaN].mp4', nodeKind: 'file' }
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
        { projectRelativePath: '', nodeKind: 'directory' },
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
      content: 'paths:\n  - glob: future/**/*.png\nlayout:\n  rows:\n    - future/**/high/*.png\n'
    }), [])).toMatchObject({
      nodes: [],
      layoutRows: []
    });

    expect(() => expandCanvasMap(parseCanvasMap({
      canvasId: 'main',
      sourcePath: '.debrute/canvas-maps/main.yaml',
      content: [
        'paths:',
        '  - glob: outputs/**/*.png',
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
      content: 'paths:\n  - future/path.md\n  - future/folder/\n  - glob: future/**/*.png\n'
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
        content: 'paths:\n  - glob: outputs/[z-a].png\n'
      }), [
        { projectRelativePath: 'outputs/a.png', kind: 'file' }
      ]);
      throw new Error('Expected glob validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasMapError);
      expect(error).toMatchObject({ code: 'canvas_map_invalid_path' });
    }
  });

});
