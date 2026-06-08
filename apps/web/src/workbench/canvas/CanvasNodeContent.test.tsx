import { describe, expect, it } from 'vitest';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer } from '../../types';
import { canvasTextBufferEnsureKey } from './CanvasNodeContent';

describe('CanvasNodeContent text buffer ensure keys', () => {
  it('returns one stable key for an available text node revision', () => {
    expect(canvasTextBufferEnsureKey(textNode('flow/readme.md', 'rev-a'), undefined)).toBe('flow/readme.md\u001frev-a');
  });

  it('skips ensure when the current buffer already matches the node revision', () => {
    expect(canvasTextBufferEnsureKey(textNode('flow/readme.md', 'rev-a'), textBuffer('flow/readme.md', 'rev-a'))).toBeUndefined();
  });

  it('requests ensure again when the node revision changes', () => {
    expect(canvasTextBufferEnsureKey(textNode('flow/readme.md', 'rev-b'), textBuffer('flow/readme.md', 'rev-a'))).toBe('flow/readme.md\u001frev-b');
  });
});

function textNode(path: string, revision: string): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    nodeKind: 'file',
    mediaKind: 'text',
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    z: 0,
    visible: true,
    locked: false,
    availability: {
      state: 'available',
      size: 64,
      mimeType: 'text/markdown',
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/${path}?v=${revision}`,
      revision
    }
  };
}

function textBuffer(path: string, revision: string): TextFileBuffer {
  return {
    projectRelativePath: path,
    content: '# Notes',
    language: 'markdown',
    wordWrap: false,
    dirty: false,
    saving: false,
    diskRevision: revision,
    lastSavedRevision: revision,
    externalChange: false
  };
}
