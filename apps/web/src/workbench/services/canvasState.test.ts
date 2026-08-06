import { describe, expect, it } from 'vitest';
import type { ProjectDiagnostic } from '@debrute/app-protocol';
import type { WorkbenchState } from '../../types.js';
import type { ProjectedCanvasNode } from '../canvas/CanvasScene.js';
import { getSelectionContext } from './canvasState.js';

describe('Canvas selection context', () => {
  const diagnostic = {
    id: 'diagnostic-1',
    severity: 'warning',
    code: 'missing_asset',
    message: 'Missing asset'
  } satisfies ProjectDiagnostic;
  const first = node('flow/a.png');
  const second = node('flow/b.png');
  const state = {
    canvasProjection: {
      nodes: [first, second],
      edges: []
    },
    snapshot: {
      diagnostics: [diagnostic]
    }
  } as unknown as WorkbenchState;

  it('distinguishes empty, one-node, many-node, and diagnostic selection', () => {
    expect(getSelectionContext(state, undefined)).toEqual({
      kind: 'empty',
      diagnostics: []
    });
    expect(getSelectionContext(state, {
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png']
    })).toEqual({
      kind: 'node',
      node: first,
      diagnostics: []
    });
    expect(getSelectionContext(state, {
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/b.png']
    })).toEqual({
      kind: 'nodes',
      nodes: [first, second],
      diagnostics: []
    });
    expect(getSelectionContext(state, {
      kind: 'diagnostic',
      id: diagnostic.id
    })).toEqual({
      kind: 'diagnostic',
      diagnostic,
      diagnostics: [diagnostic]
    });
  });

  it('does not expose stale node selections', () => {
    expect(getSelectionContext(state, {
      kind: 'nodes',
      projectRelativePaths: ['flow/missing.png']
    }).kind).toBe('empty');
  });
});

function node(projectRelativePath: string): ProjectedCanvasNode {
  return {
    projectRelativePath,
    displayName: projectRelativePath,
    nodeKind: 'file',
    mediaKind: 'image',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    z: 0,
    availability: {
      state: 'available',
      size: 10,
      mimeType: 'image/png',
      fileUrl: `/files/${projectRelativePath}`,
      revision: 'rev'
    }
  };
}
