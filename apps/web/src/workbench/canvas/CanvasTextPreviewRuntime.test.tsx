import { describe, expect, it } from 'vitest';
import type { CanvasTextPreviewDescriptor, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer } from '../../types';
import {
  canvasTextPreviewBodyMeasurement,
  canvasTextPreviewCurrentDescriptors,
  canvasTextPreviewImageReducer,
  canvasTextPreviewNextCaptureTargets,
  canvasTextPreviewTargetsForNodes,
  selectCanvasTextPreviewVariant,
  shouldStartCanvasTextPreviewSourceWork
} from './CanvasTextPreviewRuntime';
import type { CanvasTextPreviewImageState } from './CanvasTextPreviewRuntime';

describe('CanvasTextPreviewRuntime', () => {
  it('targets inactive available text nodes and excludes the selected text node', () => {
    const targets = canvasTextPreviewTargetsForNodes({
      canvasId: 'canvas-1',
      nodes: [
        textNode('notes/a.md', 600, 320),
        { ...textNode('notes/b.md', 600, 320), availability: { state: 'missing', message: 'missing' } }
      ],
      selectedProjectRelativePaths: ['notes/a.md'],
      textFileBuffers: {
        'notes/a.md': textBuffer('notes/a.md', 'A'),
        'notes/b.md': textBuffer('notes/b.md', 'B')
      },
      measuredBodies: new Map([
        ['notes/a.md', { width: 560, height: 280, scrollTop: 0, scrollLeft: 0 }]
      ])
    });

    expect(targets).toEqual([]);
  });

  it('selects the closest existing variant at or above target width', () => {
    expect(selectCanvasTextPreviewVariant({
      variants: [100, 200, 400],
      targetWidth: 180
    })).toBe(200);
    expect(selectCanvasTextPreviewVariant({
      variants: [100, 200, 400],
      targetWidth: 800
    })).toBe(400);
  });

  it('does not start source capture while the camera is moving', () => {
    expect(shouldStartCanvasTextPreviewSourceWork({
      cameraState: 'moving',
      dragState: undefined,
      pendingSourceCount: 4
    })).toBe(false);
  });

  it('does not start source capture during node resize', () => {
    expect(shouldStartCanvasTextPreviewSourceWork({
      cameraState: 'idle',
      dragState: { kind: 'resize-node' },
      pendingSourceCount: 4
    })).toBe(false);
  });

  it('reserves only capture targets that actually start', () => {
    const targets = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map(previewTarget);
    const pendingCaptureKeys = new Set<string>();

    const firstBatch = canvasTextPreviewNextCaptureTargets({
      targets,
      descriptors: {},
      pendingCaptureKeys,
      concurrency: 3
    });

    expect(firstBatch.map((target) => target.projectRelativePath)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(pendingCaptureKeys.size).toBe(3);

    const completedCapture = firstBatch[0];
    expect(completedCapture).toBeDefined();
    if (!completedCapture) {
      throw new Error('Expected a scheduled text preview capture.');
    }
    pendingCaptureKeys.delete(completedCapture.captureKey);
    const secondBatch = canvasTextPreviewNextCaptureTargets({
      targets,
      descriptors: {
        'a.md': descriptorFor(completedCapture)
      },
      pendingCaptureKeys,
      concurrency: 3
    });

    expect(secondBatch.map((target) => target.projectRelativePath)).toEqual(['d.md']);
    expect(pendingCaptureKeys.size).toBe(3);
  });

  it('measures CodeMirror scroller scroll and preserves it after the editor unmounts', () => {
    const scroller = { scrollTop: 72, scrollLeft: 9 };
    const element = {
      clientWidth: 640,
      clientHeight: 360,
      scrollTop: 0,
      scrollLeft: 0,
      querySelector: (selector: string) => selector === '.cm-scroller' ? scroller : null
    } as unknown as HTMLElement;

    const measured = canvasTextPreviewBodyMeasurement(element);

    expect(measured).toEqual({
      width: 640,
      height: 360,
      scrollTop: 72,
      scrollLeft: 9
    });

    const inactiveElement = {
      clientWidth: 680,
      clientHeight: 390,
      scrollTop: 0,
      scrollLeft: 0,
      querySelector: () => null
    } as unknown as HTMLElement;

    expect(canvasTextPreviewBodyMeasurement(inactiveElement, measured)).toEqual({
      width: 680,
      height: 390,
      scrollTop: 72,
      scrollLeft: 9
    });
  });

  it('keeps descriptors only when they match the current text preview target', () => {
    const currentTarget = previewTarget('a.md');
    const staleTarget = { ...currentTarget, fingerprint: 'sha256:old-a' };
    const descriptors = canvasTextPreviewCurrentDescriptors({
      targets: [currentTarget],
      descriptors: {
        'a.md': descriptorFor(staleTarget),
        'b.md': descriptorFor(previewTarget('b.md'))
      }
    });

    expect(descriptors).toEqual({});
    expect(canvasTextPreviewCurrentDescriptors({
      targets: [currentTarget],
      descriptors: {
        'a.md': descriptorFor(currentTarget)
      }
    })).toEqual({
      'a.md': descriptorFor(currentTarget)
    });
  });

  it('keeps the loaded text preview visible while a zoomed variant loads', () => {
    const loaded = textPreviewImageState(textPreviewSource(320));
    const nextSource = textPreviewSource(640);
    const loading = canvasTextPreviewImageReducer(loaded, {
      type: 'source-resolved',
      source: nextSource
    });

    expect(loading.loaded).toEqual(loaded.loaded);
    expect(loading.next).toEqual({
      ...nextSource,
      loadKey: nextSource.src
    });

    const promoted = canvasTextPreviewImageReducer(loading, {
      type: 'next-loaded',
      loadKey: nextSource.src
    });

    expect(promoted.loaded).toEqual({
      ...nextSource,
      loadKey: nextSource.src
    });
    expect(promoted.next).toBeUndefined();
  });
});

function textNode(path: string, width: number, height: number): ProjectedCanvasNode {
  return {
    projectRelativePath: path,
    nodeKind: 'file',
    mediaKind: 'text',
    x: 0,
    y: 0,
    width,
    height,
    z: 0,
    availability: {
      state: 'available',
      size: 32,
      mimeType: 'text/markdown',
      fileUrl: `http://127.0.0.1:17321/api/projects/p/files/raw/${path}`,
      revision: 'rev-a'
    }
  };
}

function textBuffer(projectRelativePath: string, content: string): TextFileBuffer {
  return {
    projectRelativePath,
    content,
    language: 'markdown',
    wordWrap: true,
    dirty: false,
    saving: false,
    diskRevision: 'rev-a',
    externalChange: false
  };
}

function previewTarget(projectRelativePath: string) {
  return {
    canvasId: 'canvas-1',
    projectRelativePath,
    content: projectRelativePath,
    language: 'markdown' as const,
    wordWrap: true,
    contentCssWidth: 320,
    contentCssHeight: 160,
    scrollTop: 0,
    scrollLeft: 0,
    fingerprint: `sha256:${projectRelativePath}`
  };
}

function descriptorFor(target: {
  fingerprint: string;
  contentCssWidth: number;
  contentCssHeight: number;
  scrollTop: number;
  scrollLeft: number;
}): CanvasTextPreviewDescriptor {
  return {
    fingerprint: target.fingerprint,
    sourceWidth: 640,
    sourceHeight: 320,
    contentCssWidth: target.contentCssWidth,
    contentCssHeight: target.contentCssHeight,
    scrollTop: target.scrollTop,
    scrollLeft: target.scrollLeft,
    variants: [320]
  };
}

function textPreviewSource(previewWidth: number) {
  return {
    src: `/api/projects/p/canvas-text-preview?canvasId=canvas-1&path=flow%2Freadme.md&fingerprint=fp&w=${previewWidth}`,
    previewWidth
  };
}

function textPreviewImageState(source: ReturnType<typeof textPreviewSource>): CanvasTextPreviewImageState {
  return {
    loaded: {
      ...source,
      loadKey: source.src
    },
    next: undefined
  };
}
