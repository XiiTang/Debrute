// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanvasTextPreviewDescriptor, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import {
  CanvasTextPreviewProvider,
  canvasTextPreviewBodyMeasurement,
  canvasTextPreviewCurrentDescriptors,
  isCanvasTextPreviewCaptureLayoutReady,
  canvasTextPreviewImageReducer,
  canvasTextPreviewNextCaptureTargets,
  canvasTextPreviewTargetsForNodes,
  selectCanvasTextPreviewVariant,
  shouldStartCanvasTextPreviewSourceWork,
  prepareCanvasTextPreviewCaptureElement,
  useCanvasTextPreviewRuntime,
  waitForCanvasTextPreviewCaptureLayout
} from './CanvasTextPreviewRuntime';
import type { CanvasTextPreviewImageState, CanvasTextPreviewSource } from './CanvasTextPreviewRuntime';

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

  it('requires the first visible line number to align with the first content line before capture', () => {
    const element = document.createElement('div');
    const lineNumbers = document.createElement('div');
    lineNumbers.className = 'cm-lineNumbers';
    const spacer = layoutElement('cm-gutterElement', { top: 0, height: 0 });
    const visibleLineNumber = layoutElement('cm-gutterElement', { top: 10, height: 16.8 });
    lineNumbers.append(spacer, visibleLineNumber);
    const content = document.createElement('div');
    content.className = 'cm-content';
    const line = layoutElement('cm-line', { top: 14, height: 16.8 });
    content.append(line);
    element.append(lineNumbers, content);

    expect(isCanvasTextPreviewCaptureLayoutReady(element)).toBe(false);

    setLayoutRect(visibleLineNumber, { top: 14, height: 16.8 });

    expect(isCanvasTextPreviewCaptureLayoutReady(element)).toBe(true);
  });

  it('reports capture layout readiness instead of continuing when readiness cannot be proven', async () => {
    const element = document.createElement('div');
    const lineNumbers = document.createElement('div');
    lineNumbers.className = 'cm-lineNumbers';
    lineNumbers.append(layoutElement('cm-gutterElement', { top: 10, height: 16.8 }));
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.append(layoutElement('cm-line', { top: 14, height: 16.8 }));
    element.append(lineNumbers, content);

    await expect(waitForCanvasTextPreviewCaptureLayout(element, { maxFrames: 0 })).resolves.toBe(false);

    setLayoutRect(lineNumbers.querySelector('.cm-gutterElement') as HTMLElement, { top: 14, height: 16.8 });

    await expect(waitForCanvasTextPreviewCaptureLayout(element, { maxFrames: 0 })).resolves.toBe(true);
  });

  it('inlines CodeMirror line metrics onto gutter elements before image capture', () => {
    const element = document.createElement('div');
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.style.paddingTop = '6px';
    const line = document.createElement('div');
    line.className = 'cm-line';
    line.style.fontFamily = 'monospace';
    line.style.fontSize = '12px';
    line.style.lineHeight = '16.8px';
    setLayoutRect(line, { top: 6, height: 16.8 });
    content.append(line);
    const lineNumbers = document.createElement('div');
    lineNumbers.className = 'cm-lineNumbers';
    const gutterElement = document.createElement('div');
    gutterElement.className = 'cm-gutterElement';
    setLayoutRect(gutterElement, { top: 6, height: 16.8 });
    lineNumbers.append(gutterElement);
    element.append(lineNumbers, content);

    prepareCanvasTextPreviewCaptureElement(element);
    prepareCanvasTextPreviewCaptureElement(element);

    expect(gutterElement.style.fontFamily).toBe('monospace');
    expect(gutterElement.style.fontSize).toBe('12px');
    expect(gutterElement.style.lineHeight).toBe('16.8px');
    expect(gutterElement.style.minHeight).toBe('16.8px');
    expect(gutterElement.style.transform).toBe('translateY(6px)');
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

  it('selects text preview variants above the previous DPR-only source width', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = textNode('notes/large.md', 4134, 2410);
    const previews: Array<CanvasTextPreviewSource | undefined> = [];

    try {
      await act(async () => {
        root.render(
          <CanvasTextPreviewProvider
            canvasId="canvas-1"
            nodes={[node]}
            selectedProjectRelativePaths={[]}
            textFileBuffers={{
              [node.projectRelativePath]: textBuffer(node.projectRelativePath, 'content')
            }}
            actions={textPreviewActionsFixture()}
            cameraState="idle"
            dragState={undefined}
            devicePixelRatio={2}
          >
            <TextPreviewSelectionProbe
              node={node}
              onPreview={(preview) => previews.push(preview)}
            />
          </CanvasTextPreviewProvider>
        );
      });

      const preview = await waitForTextPreview(previews);

      expect(preview.previewWidth).toBe(1169);
      expect(new URL(preview.src, 'http://127.0.0.1').searchParams.get('w')).toBe('1169');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });
});

function TextPreviewSelectionProbe({
  node,
  onPreview
}: {
  node: ProjectedCanvasNode;
  onPreview: (preview: CanvasTextPreviewSource | undefined) => void;
}): React.ReactElement {
  const { registerTextBody, previewForNode } = useCanvasTextPreviewRuntime();

  React.useEffect(() => {
    const element = textPreviewBodyElement(413, 241);
    registerTextBody(node.projectRelativePath, element);
    return () => registerTextBody(node.projectRelativePath, null);
  }, [node.projectRelativePath, registerTextBody]);

  React.useEffect(() => {
    onPreview(previewForNode({
      node,
      imageResourceZoom: 0.11,
      devicePixelRatio: 2
    }));
  }, [node, onPreview, previewForNode]);

  return <div />;
}

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

function textPreviewActionsFixture(): WorkbenchActions {
  const descriptorResponse = (input: { nodes: Array<{
    projectRelativePath: string;
    fingerprint: string;
    contentCssWidth: number;
    contentCssHeight: number;
    scrollTop: number;
    scrollLeft: number;
  }> }) => ({
    descriptors: Object.fromEntries(input.nodes.map((node) => [
      node.projectRelativePath,
      {
        fingerprint: node.fingerprint,
        sourceWidth: 1652,
        sourceHeight: 964,
        contentCssWidth: node.contentCssWidth,
        contentCssHeight: node.contentCssHeight,
        scrollTop: node.scrollTop,
        scrollLeft: node.scrollLeft,
        variants: [104, 147, 207, 293, 413, 585, 826, 1169, 1652]
      } satisfies CanvasTextPreviewDescriptor
    ]))
  });
  return {
    readCanvasTextPreviewDescriptors: async (
      input: Parameters<WorkbenchActions['readCanvasTextPreviewDescriptors']>[0]
    ) => descriptorResponse(input),
    reconcileCanvasTextPreviews: async (
      input: Parameters<WorkbenchActions['reconcileCanvasTextPreviews']>[0]
    ) => descriptorResponse(input),
    saveCanvasTextPreviewSource: async () => {
      throw new Error('Unexpected source capture in variant selection test.');
    }
  } as unknown as WorkbenchActions;
}

function textPreviewBodyElement(width: number, height: number): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientWidth', { value: width });
  Object.defineProperty(element, 'clientHeight', { value: height });
  return element;
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

async function waitForTextPreview(previews: Array<CanvasTextPreviewSource | undefined>): Promise<CanvasTextPreviewSource> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const preview = [...previews].reverse().find((item): item is CanvasTextPreviewSource => item !== undefined);
    if (preview) {
      return preview;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error('Expected text preview source to resolve.');
}

function installReactActEnvironment(): () => void {
  const globalWithActFlag = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
  globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = true;
  return () => {
    if (previous === undefined) {
      delete globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
    } else {
      globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  };
}

function installAnimationFrame(): () => void {
  const previousRequestAnimationFrame = window.requestAnimationFrame;
  const previousCancelAnimationFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame ??= (handle) => window.clearTimeout(handle);
  return () => {
    window.requestAnimationFrame = previousRequestAnimationFrame;
    window.cancelAnimationFrame = previousCancelAnimationFrame;
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

function layoutElement(className: string, rect: { top: number; height: number }): HTMLElement {
  const element = document.createElement('div');
  element.className = className;
  setLayoutRect(element, rect);
  return element;
}

function setLayoutRect(element: HTMLElement, rect: { top: number; height: number }): void {
  element.getBoundingClientRect = () => ({
    x: 0,
    y: rect.top,
    top: rect.top,
    bottom: rect.top + rect.height,
    left: 0,
    right: 10,
    width: 10,
    height: rect.height,
    toJSON: () => undefined
  });
}
