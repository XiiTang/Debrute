import { describe, expect, it } from 'vitest';
import {
  assertPublishedFlowmap,
  expandFlowmap,
  inferFlowmapIdFromDraftPath,
  parseFlowmapDraft,
  publishFlowmap
} from '@axis/flowmap-core';

describe('flowmap core', () => {
  it('infers flowmap ids from canonical draft paths', () => {
    expect(inferFlowmapIdFromDraftPath('.axis/flowmaps/image-production.draft.yaml')).toBe('image-production');
    expect(() => inferFlowmapIdFromDraftPath('.axis/canvases/image-production.draft.yaml'))
      .toThrow('Flowmap draft path must be ".axis/flowmaps/<flowmap-id>.draft.yaml".');
    expect(() => inferFlowmapIdFromDraftPath('.axis/flowmaps/../bad.draft.yaml')).toThrow('Flowmap path must be a safe relative project path.');
  });

  it('publishes canonical include-only Flowmap YAML with managed metadata', () => {
    const published = publishFlowmap({
      sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml',
      now: () => '2026-05-25T10:30:00.000Z',
      content: [
        'schemaVersion: 1',
        'canvases:',
        '  - main',
        'include:',
        '  - "**/*.md"',
        '  - "**/*.png"',
        ''
      ].join('\n')
    });

    expect(published.flowmapId).toBe('image-production');
    expect(published.activePath).toBe('.axis/flowmaps/image-production.yaml');
    expect(published.sourceDraftPath).toBe('.axis/flowmaps/image-production.draft.yaml');
    expect(published.rootProjectRelativePath).toBe('image-production');
    expect(published.canvasIds).toEqual(['main']);
    expect(published.yaml).toContain('managed: true');
    expect(published.yaml).toContain('sourceDraft: .axis/flowmaps/image-production.draft.yaml');
    expect(published.yaml).toContain('contentHash: sha256:');
    expect(published.yaml).toContain('include:');
    expect(published.yaml).not.toContain('flowmapId:');
    expect(assertPublishedFlowmap(published.yaml, '.axis/flowmaps/image-production.yaml').ok).toBe(true);
  });

  it('publishes canonical Flowmap YAML with horizontal layout groups', () => {
    const published = publishFlowmap({
      sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml',
      now: () => '2026-05-26T10:30:00.000Z',
      content: [
        'schemaVersion: 1',
        'canvases:',
        '  - main',
        'include:',
        '  - "outputs/**/*"',
        'layout:',
        '  groups:',
        '    - directory: outputs/gpt-image-2/2000x2000/high',
        '      include:',
        '        - "*.png"',
        ''
      ].join('\n')
    });

    expect(published.map.layout).toEqual({
      groups: [{
        directory: 'outputs/gpt-image-2/2000x2000/high',
        include: ['*.png']
      }]
    });
    expect(published.yaml).toContain('layout:');
    expect(published.yaml).toContain('groups:');
    expect(published.yaml).toContain('directory: outputs/gpt-image-2/2000x2000/high');
    expect(assertPublishedFlowmap(published.yaml, '.axis/flowmaps/image-production.yaml').ok).toBe(true);
  });

  it('rejects published Flowmap YAML when the active filename no longer matches the source draft', () => {
    const published = publishFlowmap({
      sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml',
      now: () => '2026-05-25T10:30:00.000Z',
      content: [
        'schemaVersion: 1',
        'canvases: []',
        'include: []',
        ''
      ].join('\n')
    });

    expect(assertPublishedFlowmap(published.yaml, '.axis/flowmaps/image-production.yaml').ok).toBe(true);
    expect(assertPublishedFlowmap(published.yaml, '.axis/flowmaps/renamed.yaml')).toMatchObject({
      ok: false,
      error: {
        code: 'flowmap_source_mismatch'
      }
    });
  });

  it('requires include but accepts empty canvases and empty include', () => {
    const draft = parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/empty.draft.yaml',
      content: [
        'schemaVersion: 1',
        'canvases: []',
        'include: []',
        ''
      ].join('\n')
    });

    expect(draft.canvases).toEqual([]);
    expect(draft.include).toEqual([]);
  });

  it('rejects unsupported fields and invalid canvas ids', () => {
    expect(() => parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/broken.draft.yaml',
      content: [
        'schemaVersion: 1',
        'canvases:',
        '  - ../bad',
        'include: []',
        ''
      ].join('\n')
    })).toThrow('Flowmap canvas id must be a valid id.');

    expect(() => parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/broken.draft.yaml',
      content: [
        'schemaVersion: 1',
        'canvases: []',
        'include: []',
        'exclude: []',
        ''
      ].join('\n')
    })).toThrow('Unsupported Flowmap field "exclude".');
  });

  it('rejects invalid Flowmap layout group YAML', () => {
    expect(() => parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/broken.draft.yaml',
      content: [
        'schemaVersion: 1',
        'include: []',
        'layout:',
        '  direction: horizontal',
        ''
      ].join('\n')
    })).toThrow('Unsupported Flowmap layout field "direction".');

    expect(() => parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/broken.draft.yaml',
      content: [
        'schemaVersion: 1',
        'include: []',
        'layout:',
        '  groups:',
        '    - directory: ../outside',
        '      include:',
        '        - "*.png"',
        ''
      ].join('\n')
    })).toThrow('Flowmap layout group directory must be a safe relative path.');

    expect(() => parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/broken.draft.yaml',
      content: [
        'schemaVersion: 1',
        'include: []',
        'layout:',
        '  groups:',
        '    - directory: outputs/high',
        '      include:',
        '        - "**/*.png"',
        ''
      ].join('\n')
    })).toThrow('Flowmap layout group include patterns must match direct child filenames.');
  });

  it('expands include-only file matches into ancestor directory nodes and undirected structure edges', () => {
    const map = parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml',
      content: [
        'schemaVersion: 1',
        'canvases:',
        '  - main',
        'include:',
        '  - "**/*.md"',
        '  - "**/*.png"',
        ''
      ].join('\n')
    });

    const expanded = expandFlowmap(map, [
      { projectRelativePath: 'image-production', kind: 'directory' },
      { projectRelativePath: 'image-production/01-prompts', kind: 'directory' },
      { projectRelativePath: 'image-production/01-prompts/cover.md', kind: 'file' },
      { projectRelativePath: 'image-production/02-output', kind: 'directory' },
      { projectRelativePath: 'image-production/02-output/final.png', kind: 'file' },
      { projectRelativePath: 'image-production/notes.tmp', kind: 'file' },
      { projectRelativePath: 'other/ignore.md', kind: 'file' }
    ]);

    expect(expanded.nodes.map((node) => [node.projectRelativePath, node.nodeKind])).toEqual([
      ['image-production', 'directory'],
      ['image-production/01-prompts', 'directory'],
      ['image-production/01-prompts/cover.md', 'file'],
      ['image-production/02-output', 'directory'],
      ['image-production/02-output/final.png', 'file']
    ]);
    expect(expanded.edges.map((edge) => [edge.sourceProjectRelativePath, edge.targetProjectRelativePath])).toEqual([
      ['image-production', 'image-production/01-prompts'],
      ['image-production/01-prompts', 'image-production/01-prompts/cover.md'],
      ['image-production', 'image-production/02-output'],
      ['image-production/02-output', 'image-production/02-output/final.png']
    ]);
  });

  it('sorts file-tree siblings with directories before files', () => {
    const map = parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/tree.draft.yaml',
      content: [
        'schemaVersion: 1',
        'include:',
        '  - "**/*"',
        ''
      ].join('\n')
    });

    const expanded = expandFlowmap(map, [
      { projectRelativePath: 'tree/a-readme.md', kind: 'file' },
      { projectRelativePath: 'tree/z-assets/cover.png', kind: 'file' }
    ]);

    expect(expanded.nodes.map((node) => [node.projectRelativePath, node.nodeKind])).toEqual([
      ['tree', 'directory'],
      ['tree/z-assets', 'directory'],
      ['tree/z-assets/cover.png', 'file'],
      ['tree/a-readme.md', 'file']
    ]);
    expect(expanded.edges.map((edge) => [edge.sourceProjectRelativePath, edge.targetProjectRelativePath])).toEqual([
      ['tree', 'tree/z-assets'],
      ['tree/z-assets', 'tree/z-assets/cover.png'],
      ['tree', 'tree/a-readme.md']
    ]);
  });

  it('treats exact include entries as literal file paths before glob matching', () => {
    const map = parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/literal.draft.yaml',
      content: [
        'schemaVersion: 1',
        'include:',
        '  - "notes/[draft].md"',
        ''
      ].join('\n')
    });

    const expanded = expandFlowmap(map, [
      { projectRelativePath: 'literal/notes/[draft].md', kind: 'file' },
      { projectRelativePath: 'literal/notes/d.md', kind: 'file' }
    ]);

    expect(expanded.nodes.map((node) => node.projectRelativePath)).toEqual([
      'literal',
      'literal/notes',
      'literal/notes/[draft].md'
    ]);
  });

  it('treats brackets in include paths as literal while still allowing glob matching', () => {
    const map = parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/literal-glob.draft.yaml',
      content: [
        'schemaVersion: 1',
        'include:',
        '  - "folder[1]/*.md"',
        ''
      ].join('\n')
    });

    const expanded = expandFlowmap(map, [
      { projectRelativePath: 'literal-glob/folder[1]/a.md', kind: 'file' },
      { projectRelativePath: 'literal-glob/folder[1]/b.txt', kind: 'file' },
      { projectRelativePath: 'literal-glob/folder1/a.md', kind: 'file' }
    ]);

    expect(expanded.nodes.map((node) => node.projectRelativePath)).toEqual([
      'literal-glob',
      'literal-glob/folder[1]',
      'literal-glob/folder[1]/a.md'
    ]);
  });

  it('expands horizontal layout groups for materialized direct child files only', () => {
    const map = parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml',
      content: [
        'schemaVersion: 1',
        'include:',
        '  - "outputs/**/*.png"',
        'layout:',
        '  groups:',
        '    - directory: outputs/gemini/4k',
        '      include:',
        '        - "*.png"',
        ''
      ].join('\n')
    });

    const expanded = expandFlowmap(map, [
      { projectRelativePath: 'image-production/outputs/gemini/4k/a.png', kind: 'file' },
      { projectRelativePath: 'image-production/outputs/gemini/4k/b.png', kind: 'file' },
      { projectRelativePath: 'image-production/outputs/gemini/4k/deep/c.png', kind: 'file' },
      { projectRelativePath: 'image-production/outputs/gemini/4k/readme.md', kind: 'file' },
      { projectRelativePath: 'image-production/outputs/gemini/other/d.png', kind: 'file' }
    ]);

    expect(expanded.layoutGroups).toEqual([{
      parentProjectRelativePath: 'image-production/outputs/gemini/4k',
      memberProjectRelativePaths: [
        'image-production/outputs/gemini/4k/a.png',
        'image-production/outputs/gemini/4k/b.png'
      ]
    }]);
    expect(expanded.nodes.map((node) => node.projectRelativePath)).toContain('image-production/outputs/gemini/4k/deep/c.png');
    expect(expanded.nodes.map((node) => node.projectRelativePath)).not.toContain('image-production/outputs/gemini/4k/readme.md');
  });

  it('allows missing or empty horizontal layout groups without changing membership', () => {
    const map = parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml',
      content: [
        'schemaVersion: 1',
        'include:',
        '  - "outputs/**/*.png"',
        'layout:',
        '  groups:',
        '    - directory: outputs/future',
        '      include:',
        '        - "*.png"',
        ''
      ].join('\n')
    });

    const expanded = expandFlowmap(map, [
      { projectRelativePath: 'image-production/outputs/existing/a.png', kind: 'file' }
    ]);

    expect(expanded.layoutGroups).toEqual([]);
    expect(expanded.layoutGroupErrors).toEqual([]);
    expect(expanded.nodes.map((node) => node.projectRelativePath)).toEqual([
      'image-production',
      'image-production/outputs',
      'image-production/outputs/existing',
      'image-production/outputs/existing/a.png'
    ]);
  });

  it('reports duplicate materialized horizontal layout group matches', () => {
    const map = parseFlowmapDraft({
      sourceDraftPath: '.axis/flowmaps/image-production.draft.yaml',
      content: [
        'schemaVersion: 1',
        'include:',
        '  - "outputs/*.png"',
        'layout:',
        '  groups:',
        '    - directory: outputs',
        '      include:',
        '        - "*.png"',
        '    - directory: outputs',
        '      include:',
        '        - "a.*"',
        ''
      ].join('\n')
    });

    const expanded = expandFlowmap(map, [
      { projectRelativePath: 'image-production/outputs/a.png', kind: 'file' }
    ]);

    expect(expanded.layoutGroups).toEqual([]);
    expect(expanded.layoutGroupErrors).toEqual([{
      code: 'flowmap_layout_group_duplicate_match',
      message: 'Flowmap layout groups match the same file more than once: image-production/outputs/a.png',
      projectRelativePath: 'image-production/outputs/a.png'
    }]);
  });
});
