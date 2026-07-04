// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import type { CanvasPreviewResourceScheduler, CanvasPreviewResourceRequest } from './CanvasPreviewResourceScheduler';
import {
  CanvasTextPreviewProvider,
  canvasTextPreviewBodyMeasurement,
  canvasTextPreviewCurrentSourceAvailability,
  isCanvasTextPreviewCaptureLayoutReady,
  canvasTextPreviewImageReducer,
  initialCanvasTextPreviewImageState,
  canvasTextPreviewNextCaptureTargets,
  canvasTextPreviewTargetWidthForNode,
  canvasTextPreviewTargetsForNodes,
  shouldStartCanvasTextPreviewSourceWork,
  prepareCanvasTextPreviewCaptureElement,
  useCanvasTextPreviewRuntime,
  waitForCanvasTextPreviewCaptureLayout
} from './CanvasTextPreviewRuntime';
import type { CanvasTextPreviewImageState, CanvasTextPreviewSource } from './CanvasTextPreviewRuntime';

describe('CanvasTextPreviewRuntime', () => {
  beforeEach(() => {
    installTextPreviewStyleVariables({
      text: '#ffffff',
      muted: 'rgb(255 255 255 / 72%)'
    });
  });

  afterEach(() => {
    clearTextPreviewStyleVariables();
  });

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
      culledNodePaths: new Set(),
      measuredBodies: new Map([
        ['notes/a.md', { width: 560, height: 280 }]
      ]),
      styleKey: 'sha256:style-a'
    });

    expect(targets).toEqual([]);
  });

  it('includes the current text preview style key in generated targets', () => {
    const targets = canvasTextPreviewTargetsForNodes({
      canvasId: 'canvas-1',
      nodes: [textNode('notes/a.md', 600, 320)],
      selectedProjectRelativePaths: [],
      textFileBuffers: {
        'notes/a.md': textBuffer('notes/a.md', 'A')
      },
      culledNodePaths: new Set(),
      measuredBodies: new Map([
        ['notes/a.md', { width: 560, height: 280 }]
      ]),
      styleKey: 'sha256:style-a'
    });

    expect(targets).toMatchObject([{
      projectRelativePath: 'notes/a.md',
      styleKey: 'sha256:style-a'
    }]);
  });

  it('uses the persisted node text viewport when generating inactive preview targets', () => {
    const node = {
      ...textNode('notes/a.md', 600, 320),
      textViewport: { scrollTop: 72, scrollLeft: 9 }
    };
    const targets = canvasTextPreviewTargetsForNodes({
      canvasId: 'canvas-1',
      nodes: [node],
      selectedProjectRelativePaths: [],
      textFileBuffers: {
        'notes/a.md': textBuffer('notes/a.md', 'A')
      },
      culledNodePaths: new Set(),
      measuredBodies: new Map([
        ['notes/a.md', { width: 560, height: 280 }]
      ]),
      styleKey: 'sha256:style-a'
    });

    expect(targets).toMatchObject([{
      projectRelativePath: 'notes/a.md',
      contentCssWidth: 560,
      contentCssHeight: 280,
      scrollTop: 72,
      scrollLeft: 9
    }]);
  });

  it('orders inactive preview targets by their canvas position', () => {
    const targets = canvasTextPreviewTargetsForNodes({
      canvasId: 'canvas-1',
      nodes: [
        { ...textNode('notes/lower.md', 600, 320), x: 20, y: 200 },
        { ...textNode('notes/upper-right.md', 600, 320), x: 120, y: 100 },
        { ...textNode('notes/upper-left.md', 600, 320), x: 40, y: 100 }
      ],
      selectedProjectRelativePaths: [],
      textFileBuffers: {
        'notes/lower.md': textBuffer('notes/lower.md', 'lower'),
        'notes/upper-right.md': textBuffer('notes/upper-right.md', 'right'),
        'notes/upper-left.md': textBuffer('notes/upper-left.md', 'left')
      },
      culledNodePaths: new Set(),
      measuredBodies: new Map([
        ['notes/lower.md', { width: 560, height: 280 }],
        ['notes/upper-right.md', { width: 560, height: 280 }],
        ['notes/upper-left.md', { width: 560, height: 280 }]
      ]),
      styleKey: 'sha256:style-a'
    });

    expect(targets.map((target) => target.projectRelativePath)).toEqual([
      'notes/upper-left.md',
      'notes/upper-right.md',
      'notes/lower.md'
    ]);
  });

  it('computes text preview target width from the source scale', () => {
    const target = {
      ...previewTarget('notes/large.md'),
      contentCssWidth: 413,
      contentCssHeight: 241
    };

    expect(canvasTextPreviewTargetWidthForNode({
      node: textNode('notes/large.md', 4134, 2410),
      target,
      resourceZoom: 0.11,
      devicePixelRatio: 2
    })).toBe(1169);
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
      sourceAvailability: Object.fromEntries(targets.map((target) => [
        target.projectRelativePath,
        { fingerprint: target.fingerprint, available: false }
      ])),
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
    expect(completedCapture).not.toHaveProperty('captureKey');
    pendingCaptureKeys.delete([...pendingCaptureKeys][0]!);
    const secondBatch = canvasTextPreviewNextCaptureTargets({
      targets,
      sourceAvailability: {
        ...Object.fromEntries(targets.map((target) => [
          target.projectRelativePath,
          { fingerprint: target.fingerprint, available: false }
        ])),
        'a.md': {
          fingerprint: completedCapture.fingerprint,
          available: true
        }
      },
      pendingCaptureKeys,
      concurrency: 3
    });

    expect(secondBatch.map((target) => target.projectRelativePath)).toEqual(['d.md']);
    expect(pendingCaptureKeys.size).toBe(3);
  });

  it('measures rendered text body size without storing scroll position', () => {
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
      height: 360
    });
  });

  it('requires the first visible line number to align with the first content line padding before capture', () => {
    const element = document.createElement('div');
    const scroller = layoutElement('cm-scroller', { top: 10, height: 40 });
    setClientSize(scroller, { width: 100, height: 40 });
    const lineNumbers = document.createElement('div');
    lineNumbers.className = 'cm-lineNumbers';
    const spacer = layoutElement('cm-gutterElement', { top: 0, height: 0 });
    const visibleLineNumber = layoutElement('cm-gutterElement', { top: 10, height: 16.8 });
    lineNumbers.append(spacer, visibleLineNumber);
    const content = document.createElement('div');
    content.className = 'cm-content';
    const line = layoutElement('cm-line', { top: 14, height: 16.8 });
    content.append(line);
    scroller.append(lineNumbers, content);
    element.append(scroller);
    document.body.append(element);
    try {
      expect(isCanvasTextPreviewCaptureLayoutReady(element)).toBe(false);

      content.style.paddingTop = '4px';

      expect(isCanvasTextPreviewCaptureLayoutReady(element)).toBe(true);
    } finally {
      element.remove();
    }
  });

  it('accepts scrolled CodeMirror line and gutter layout when content padding is already reflected', () => {
    const element = document.createElement('div');
    const scroller = layoutElement('cm-scroller', { top: 10, height: 40 });
    setClientSize(scroller, { width: 100, height: 40 });
    const lineNumbers = document.createElement('div');
    lineNumbers.className = 'cm-lineNumbers';
    lineNumbers.append(layoutElement('cm-gutterElement', { top: 10, height: 16.8 }));
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.style.paddingTop = '4px';
    content.append(layoutElement('cm-line', { top: 10, height: 16.8 }));
    scroller.append(lineNumbers, content);
    element.append(scroller);
    document.body.append(element);

    try {
      expect(isCanvasTextPreviewCaptureLayoutReady(element)).toBe(true);
    } finally {
      element.remove();
    }
  });

  it('does not treat offscreen aligned CodeMirror lines as capture-ready', () => {
    const element = document.createElement('div');
    const scroller = layoutElement('cm-scroller', { top: 100, height: 40 });
    setClientSize(scroller, { width: 100, height: 40 });
    const lineNumbers = document.createElement('div');
    lineNumbers.className = 'cm-lineNumbers';
    lineNumbers.append(layoutElement('cm-gutterElement', { top: 20, height: 16.8 }));
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.append(layoutElement('cm-line', { top: 20, height: 16.8 }));
    scroller.append(lineNumbers, content);
    element.append(scroller);

    expect(isCanvasTextPreviewCaptureLayoutReady(element)).toBe(false);

    lineNumbers.append(layoutElement('cm-gutterElement', { top: 110, height: 16.8 }));
    content.append(layoutElement('cm-line', { top: 110, height: 16.8 }));

    expect(isCanvasTextPreviewCaptureLayoutReady(element)).toBe(true);
  });

  it('stops waiting for capture layout when the target is cancelled', async () => {
    const element = document.createElement('div');
    const scroller = layoutElement('cm-scroller', { top: 10, height: 40 });
    setClientSize(scroller, { width: 100, height: 40 });
    const lineNumbers = document.createElement('div');
    lineNumbers.className = 'cm-lineNumbers';
    lineNumbers.append(layoutElement('cm-gutterElement', { top: 10, height: 16.8 }));
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.append(layoutElement('cm-line', { top: 14, height: 16.8 }));
    scroller.append(lineNumbers, content);
    element.append(scroller);
    document.body.append(element);

    try {
      await expect(waitForCanvasTextPreviewCaptureLayout(element, {
        isCancelled: () => true
      })).resolves.toBe(false);
    } finally {
      element.remove();
    }
  });

  it('waits past the first capture frames until CodeMirror layout is ready', async () => {
    const previousRequestAnimationFrame = window.requestAnimationFrame;
    const previousCancelAnimationFrame = window.cancelAnimationFrame;
    let frameCount = 0;
    const element = document.createElement('div');
    const scroller = layoutElement('cm-scroller', { top: 10, height: 40 });
    setClientSize(scroller, { width: 100, height: 40 });
    const lineNumbers = document.createElement('div');
    lineNumbers.className = 'cm-lineNumbers';
    lineNumbers.append(layoutElement('cm-gutterElement', { top: 10, height: 16.8 }));
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.append(layoutElement('cm-line', { top: 14, height: 16.8 }));
    scroller.append(lineNumbers, content);
    element.append(scroller);
    document.body.append(element);
    window.requestAnimationFrame = (callback) => window.setTimeout(() => {
      frameCount += 1;
      if (frameCount === 14) {
        content.style.paddingTop = '4px';
      }
      callback(performance.now());
    }, 0);
    window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

    try {
      await expect(waitForCanvasTextPreviewCaptureLayout(element)).resolves.toBe(true);
      expect(frameCount).toBeGreaterThan(12);
    } finally {
      element.remove();
      window.requestAnimationFrame = previousRequestAnimationFrame;
      window.cancelAnimationFrame = previousCancelAnimationFrame;
    }
  });

  it('inlines CodeMirror line metrics onto gutter elements without mutating the hidden gutter container', () => {
    const element = document.createElement('div');
    const scroller = document.createElement('div');
    scroller.className = 'cm-scroller';
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
    lineNumbers.className = 'cm-gutter cm-lineNumbers';
    const gutterElement = document.createElement('div');
    gutterElement.className = 'cm-gutterElement';
    setLayoutRect(gutterElement, { top: 6, height: 16.8 });
    lineNumbers.append(gutterElement);
    scroller.append(lineNumbers, content);
    element.append(scroller);

    prepareCanvasTextPreviewCaptureElement(element);
    prepareCanvasTextPreviewCaptureElement(element);

    expect(gutterElement.style.fontFamily).toBe('monospace');
    expect(gutterElement.style.fontSize).toBe('12px');
    expect(gutterElement.style.lineHeight).toBe('16.8px');
    expect(gutterElement.style.minHeight).toBe('16.8px');
    expect(gutterElement.style.transform).toBe('');
    expect(lineNumbers.style.flexDirection).toBe('');
    expect(lineNumbers.style.boxSizing).toBe('');
  });

  it('materializes the visible CodeMirror viewport into static capture layers', () => {
    const element = document.createElement('div');
    const scroller = layoutElement('cm-scroller', { top: 100, height: 40, width: 500 });
    scroller.className = 'cm-scroller';
    scroller.scrollTop = 72;
    scroller.scrollLeft = 9;
    setClientSize(scroller, { width: 500, height: 40 });
    const gutter = document.createElement('div');
    gutter.className = 'cm-gutter cm-lineNumbers';
    const gutterElement = document.createElement('div');
    gutterElement.className = 'cm-gutterElement';
    setLayoutRect(gutterElement, { top: 110, height: 16.8 });
    const hiddenGutterElement = document.createElement('div');
    hiddenGutterElement.className = 'cm-gutterElement';
    setLayoutRect(hiddenGutterElement, { top: 150, height: 16.8 });
    gutter.append(gutterElement, hiddenGutterElement);
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.style.paddingTop = '6px';
    const line = document.createElement('div');
    line.className = 'cm-line';
    line.style.fontFamily = 'monospace';
    line.style.fontSize = '12px';
    line.style.lineHeight = '16.8px';
    line.textContent = 'visible line';
    setLayoutRect(line, { top: 116, height: 16.8, width: 240 });
    const hiddenLine = document.createElement('div');
    hiddenLine.className = 'cm-line';
    hiddenLine.textContent = 'hidden line';
    setLayoutRect(hiddenLine, { top: 150, height: 16.8, width: 240 });
    content.append(line, hiddenLine);
    scroller.append(gutter, content);
    element.append(scroller);

    prepareCanvasTextPreviewCaptureElement(element);
    prepareCanvasTextPreviewCaptureElement(element);

    expect(scroller.style.overflow).toBe('hidden');
    expect(scroller.scrollTop).toBe(0);
    expect(scroller.scrollLeft).toBe(0);
    expect(content.style.display).toBe('none');
    expect(gutter.style.display).toBe('none');
    expect(content.style.transform).toBe('');
    expect(gutter.style.transform).toBe('');
    const staticViewport = scroller.querySelector<HTMLElement>('.canvas-text-preview-static-viewport');
    expect(staticViewport).not.toBeNull();
    expect(staticViewport?.querySelector<HTMLElement>('.canvas-text-preview-static-content')?.style.display).toBe('');
    expect(staticViewport?.querySelectorAll('.cm-line')).toHaveLength(1);
    expect(staticViewport?.querySelector('.cm-line')?.textContent).toBe('visible line');
    const staticLine = staticViewport?.querySelector<HTMLElement>('.cm-line');
    const staticGutterElement = staticViewport?.querySelector<HTMLElement>('.cm-gutterElement');
    expect(staticLine?.style.display).toBe('block');
    expect(parseFloat(staticLine?.style.top ?? '')).toBeCloseTo(16);
    expect(parseFloat(staticGutterElement?.style.top ?? '')).toBeCloseTo(16);
    expect(gutterElement.style.transform).toBe('');
  });

  it('does not add content padding to static gutter lines that already match scrolled content lines', () => {
    const element = document.createElement('div');
    const scroller = layoutElement('cm-scroller', { top: 100, height: 40, width: 500 });
    scroller.className = 'cm-scroller';
    setClientSize(scroller, { width: 500, height: 40 });
    const gutter = document.createElement('div');
    gutter.className = 'cm-gutter cm-lineNumbers';
    const gutterElement = document.createElement('div');
    gutterElement.className = 'cm-gutterElement';
    setLayoutRect(gutterElement, { top: 108, height: 16.8 });
    gutter.append(gutterElement);
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.style.paddingTop = '6px';
    const line = document.createElement('div');
    line.className = 'cm-line';
    line.textContent = 'already aligned';
    setLayoutRect(line, { top: 108, height: 16.8, width: 240 });
    content.append(line);
    scroller.append(gutter, content);
    element.append(scroller);

    prepareCanvasTextPreviewCaptureElement(element);

    const staticViewport = scroller.querySelector<HTMLElement>('.canvas-text-preview-static-viewport');
    const staticLine = staticViewport?.querySelector<HTMLElement>('.cm-line');
    const staticGutterElement = staticViewport?.querySelector<HTMLElement>('.cm-gutterElement');
    expect(parseFloat(staticLine?.style.top ?? '')).toBeCloseTo(8);
    expect(parseFloat(staticGutterElement?.style.top ?? '')).toBeCloseTo(8);
  });

  it('keeps source availability only when it matches the current text preview target', () => {
    const currentTarget = previewTarget('a.md');
    const sourceAvailability = canvasTextPreviewCurrentSourceAvailability({
      targets: [currentTarget],
      sourceAvailability: {
        'a.md': { fingerprint: 'sha256:old-a', available: true },
        'b.md': { fingerprint: previewTarget('b.md').fingerprint, available: true }
      }
    });

    expect(sourceAvailability).toEqual({});
    expect(canvasTextPreviewCurrentSourceAvailability({
      targets: [currentTarget],
      sourceAvailability: {
        'a.md': {
          fingerprint: currentTarget.fingerprint,
          available: true
        }
      }
    })).toEqual({
      'a.md': {
        fingerprint: currentTarget.fingerprint,
        available: true
      }
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

  it('keeps the loaded text preview visible while a changed fingerprint loads', () => {
    const loaded = textPreviewImageState(textPreviewSource(320, 'sha256:old'));
    const nextSource = textPreviewSource(640, 'sha256:new');
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

  it('keeps loaded text preview state when the current source is temporarily unresolved', () => {
    const loaded = textPreviewImageState(textPreviewSource(320));

    expect(canvasTextPreviewImageReducer(loaded, {
      type: 'source-resolved',
      source: undefined
    })).toEqual(loaded);
  });

  it('clears loaded text preview state when the content identity is invalidated', () => {
    const loaded = textPreviewImageState(textPreviewSource(320, 'sha256:old'));

    expect(canvasTextPreviewImageReducer(loaded, {
      type: 'source-invalidated'
    })).toEqual(initialCanvasTextPreviewImageState());
  });

  it('cancels pending text preview upgrades when interaction starts but keeps first loads', () => {
    const loaded = textPreviewImageState(textPreviewSource(320));
    const loadingUpgrade = canvasTextPreviewImageReducer(loaded, {
      type: 'source-resolved',
      source: textPreviewSource(640)
    });

    const cancelledUpgrade = canvasTextPreviewImageReducer(loadingUpgrade, { type: 'interaction-started' });

    expect(cancelledUpgrade.loaded).toEqual(loaded.loaded);
    expect(cancelledUpgrade.next).toBeUndefined();

    const firstLoad = canvasTextPreviewImageReducer(initialCanvasTextPreviewImageState(), {
      type: 'source-resolved',
      source: textPreviewSource(320)
    });

    expect(canvasTextPreviewImageReducer(firstLoad, { type: 'interaction-started' })).toBe(firstLoad);
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
            resourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={new Set()}
            previewResourceScheduler={createImmediateScheduler()}
            styleDependencyKey="dark"
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

  it('publishes the first current-source text preview immediately and schedules width upgrades', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = textNode('notes/large.md', 4134, 2410);
    const previews: Array<CanvasTextPreviewSource | undefined> = [];
    const queued: CanvasPreviewResourceRequest[] = [];
    const scheduler = createQueuedScheduler(queued);

    const render = async (resourceZoom: number) => {
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
            resourceZoom={resourceZoom}
            devicePixelRatio={2}
            culledNodePaths={new Set()}
            previewResourceScheduler={scheduler}
            styleDependencyKey="dark"
          >
            <TextPreviewSelectionProbe
              node={node}
              onPreview={(preview) => previews.push(preview)}
            />
          </CanvasTextPreviewProvider>
        );
      });
      await flushReactWork();
    };

    try {
      await render(0.11);
      const initialPreview = await waitForTextPreview(previews);
      expect(initialPreview.previewWidth).toBe(1169);
      expect(queued).toEqual([]);

      await render(0.3);
      expect(previews.at(-1)).toEqual(initialPreview);
      expect(queued.map((request) => request.nodeId)).toEqual(['notes/large.md']);

      await act(async () => {
        queued.shift()?.run();
      });
      await flushReactWork();
      const upgradedPreview = previews.find((preview) => preview?.previewWidth === 1652);
      expect(upgradedPreview?.previewWidth).toBe(1652);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });

  it('records text preview source and publication counters', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const counters: string[] = [];
    const perfMonitor = {
      recordCounter: (input: { name: string }) => counters.push(input.name)
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = textNode('notes/perf.md', 4134, 2410);

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
            resourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={new Set()}
            previewResourceScheduler={createQueuedScheduler([])}
            styleDependencyKey="dark"
            perfMonitor={perfMonitor}
          >
            <TextPreviewSelectionProbe node={node} onPreview={() => undefined} />
          </CanvasTextPreviewProvider>
        );
      });

      await waitForRecordedCounters(counters, [
        'text-preview-source-check-requested',
        'text-preview-source-availability-resolved',
        'text-preview-publish-critical'
      ]);
      expect(counters).toContain('text-preview-source-check-requested');
      expect(counters).toContain('text-preview-source-availability-resolved');
      expect(counters).toContain('text-preview-publish-critical');
      expect(counters).not.toContain('text-preview-publish-deferred');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });

  it('does not create hidden off-DOM text preview images after publishing the first preview', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const imageConstructs = installImageConstructorCounter();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = textNode('notes/hidden-load.md', 4134, 2410);
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
            resourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={new Set()}
            previewResourceScheduler={createQueuedScheduler([])}
            styleDependencyKey="dark"
          >
            <TextPreviewSelectionProbe node={node} onPreview={(preview) => previews.push(preview)} />
          </CanvasTextPreviewProvider>
        );
      });
      await flushReactWork();

      const published = await waitForTextPreview(previews);
      expect(published.previewWidth).toBe(1169);
      expect(imageConstructs.count()).toBe(0);
      expect(previews.at(-1)).toEqual(published);
    } finally {
      imageConstructs.restore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });

  it('checks source availability for visible text preview nodes without scheduling first publication', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const records: string[][] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const nodes = [
      { ...textNode('notes/b.md', 4134, 2410), x: 0, y: 100 },
      { ...textNode('notes/a.md', 4134, 2410), x: 0, y: 0 }
    ];
    const enqueued: string[] = [];
    const scheduler = createRecordingImmediateScheduler(enqueued);

    try {
      await act(async () => {
        root.render(
          <CanvasTextPreviewProvider
            canvasId="canvas-1"
            nodes={nodes}
            selectedProjectRelativePaths={[]}
            textFileBuffers={{
              'notes/a.md': textBuffer('notes/a.md', 'A'),
              'notes/b.md': textBuffer('notes/b.md', 'B')
            }}
            actions={recordingTextPreviewActionsFixture(records)}
            cameraState="idle"
            dragState={undefined}
            resourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={new Set(['notes/b.md'])}
            previewResourceScheduler={scheduler}
            styleDependencyKey="dark"
          >
            <TextPreviewSelectionProbe node={nodes[0]!} onPreview={() => undefined} />
            <TextPreviewSelectionProbe node={nodes[1]!} onPreview={() => undefined} />
          </CanvasTextPreviewProvider>
        );
      });

      await waitForRecordedSourceReads(records, [['notes/a.md']]);

      expect(enqueued).toEqual([]);
      expect(records).toEqual([['notes/a.md']]);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });

  it('queues missing source capture through the preview resource scheduler before mounting capture targets', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const records: string[][] = [];
    const queued: CanvasPreviewResourceRequest[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const nodes = [
      textNode('notes/a.md', 4134, 2410),
      textNode('notes/b.md', 4134, 2410)
    ];

    try {
      await act(async () => {
        root.render(
          <CanvasTextPreviewProvider
            canvasId="canvas-1"
            nodes={nodes}
            selectedProjectRelativePaths={[]}
            textFileBuffers={{
              'notes/a.md': textBuffer('notes/a.md', 'A'),
              'notes/b.md': textBuffer('notes/b.md', 'B')
            }}
            actions={missingSourceTextPreviewActionsFixture(records)}
            cameraState="idle"
            dragState={undefined}
            resourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={new Set()}
            previewResourceScheduler={createQueuedScheduler(queued)}
            styleDependencyKey="dark"
          >
            <TextPreviewSelectionProbe node={nodes[0]!} onPreview={() => undefined} />
            <TextPreviewSelectionProbe node={nodes[1]!} onPreview={() => undefined} />
          </CanvasTextPreviewProvider>
        );
      });

      await waitForRecordedSourceReads(records, [['notes/a.md', 'notes/b.md']]);
      await flushReactWork();

      expect(document.body.querySelectorAll('.canvas-text-preview-capture-target')).toHaveLength(0);
      expect(queued.map((request) => [request.kind, request.nodeId])).toEqual([
        ['text-source', 'notes/a.md'],
        ['text-source', 'notes/b.md']
      ]);

      await act(async () => {
        queued.shift()?.run();
      });
      await flushReactWork();

      expect(document.body.querySelectorAll('.canvas-text-preview-capture-target')).toHaveLength(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });

  it('releases queued source capture slots when a target is culled before capture starts', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const records: string[][] = [];
    const queued: CanvasPreviewResourceRequest[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const scheduler = createQueuedScheduler(queued);
    const nodes = [
      textNode('notes/a.md', 4134, 2410),
      textNode('notes/b.md', 4134, 2410),
      textNode('notes/c.md', 4134, 2410),
      textNode('notes/d.md', 4134, 2410)
    ];

    const render = async (culledNodePaths: ReadonlySet<string>) => {
      await act(async () => {
        root.render(
          <CanvasTextPreviewProvider
            canvasId="canvas-1"
            nodes={nodes}
            selectedProjectRelativePaths={[]}
            textFileBuffers={{
              'notes/a.md': textBuffer('notes/a.md', 'A'),
              'notes/b.md': textBuffer('notes/b.md', 'B'),
              'notes/c.md': textBuffer('notes/c.md', 'C'),
              'notes/d.md': textBuffer('notes/d.md', 'D')
            }}
            actions={missingSourceTextPreviewActionsFixture(records)}
            cameraState="idle"
            dragState={undefined}
            resourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={culledNodePaths}
            previewResourceScheduler={scheduler}
            styleDependencyKey="dark"
          >
            {nodes.map((node) => (
              <TextPreviewSelectionProbe key={node.projectRelativePath} node={node} onPreview={() => undefined} />
            ))}
          </CanvasTextPreviewProvider>
        );
      });
      await flushReactWork();
    };

    try {
      await render(new Set());
      await waitForRecordedSourceReads(records, [['notes/a.md', 'notes/b.md', 'notes/c.md', 'notes/d.md']]);
      await flushReactWork();

      expect(queued.map((request) => request.nodeId)).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md']);

      await render(new Set(['notes/a.md']));

      expect(queued.map((request) => request.nodeId)).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md', 'notes/d.md']);

      await act(async () => {
        queued.shift()?.run();
      });
      await flushReactWork();

      expect(document.body.querySelectorAll('.canvas-text-preview-capture-target')).toHaveLength(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
      restoreActEnvironment();
    }
  });

  it('reports source availability failures as text preview errors', async () => {
    await expectScheduledTextPreviewError({
      projectRelativePath: 'notes/read-failure.md',
      expectedError: 'source availability failed',
      actions: {
        ...textPreviewActionsFixture(),
        readCanvasTextPreviewSources: async () => {
          throw new Error('source availability failed');
        }
      }
    });
  });

  it('recomputes text preview target fingerprints when the effective style key changes', async () => {
    const restoreActEnvironment = installReactActEnvironment();
    const restoreAnimationFrame = installAnimationFrame();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = textNode('notes/style.md', 4134, 2410);
    const fingerprints: string[] = [];
    const actions = recordingFingerprintTextPreviewActionsFixture(fingerprints);

    const render = async (input: { text: string; dependency: string }) => {
      installTextPreviewStyleVariables({
        text: input.text,
        muted: 'rgb(255 255 255 / 72%)'
      });
      await act(async () => {
        root.render(
          <CanvasTextPreviewProvider
            canvasId="canvas-1"
            nodes={[node]}
            selectedProjectRelativePaths={[]}
            textFileBuffers={{
              [node.projectRelativePath]: textBuffer(node.projectRelativePath, 'content')
            }}
            actions={actions}
            cameraState="idle"
            dragState={undefined}
            resourceZoom={0.11}
            devicePixelRatio={2}
            culledNodePaths={new Set()}
            previewResourceScheduler={createImmediateScheduler()}
            styleDependencyKey={input.dependency}
          >
            <TextPreviewSelectionProbe node={node} onPreview={() => undefined} />
          </CanvasTextPreviewProvider>
        );
      });
      await flushReactWork();
    };

    try {
      await render({ text: '#ffffff', dependency: 'dark' });
      await waitForRecordedFingerprintCount(fingerprints, 1);
      const first = fingerprints.at(-1);

      await render({ text: '#111827', dependency: 'light' });
      await waitForRecordedFingerprintCount(fingerprints, 2);
      const second = fingerprints.at(-1);

      expect(first).toMatch(/^sha256:/);
      expect(second).toMatch(/^sha256:/);
      expect(second).not.toBe(first);
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

async function expectScheduledTextPreviewError(input: {
  projectRelativePath: string;
  expectedError: string;
  actions: WorkbenchActions;
}): Promise<void> {
  const restoreActEnvironment = installReactActEnvironment();
  const restoreAnimationFrame = installAnimationFrame();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const node = textNode(input.projectRelativePath, 4134, 2410);
  const errors: Array<string | undefined> = [];

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
          actions={input.actions}
          cameraState="idle"
          dragState={undefined}
          resourceZoom={0.11}
          devicePixelRatio={2}
          culledNodePaths={new Set()}
          previewResourceScheduler={createImmediateScheduler()}
          styleDependencyKey="dark"
        >
          <TextPreviewSelectionProbe node={node} onPreview={() => undefined} />
          <TextPreviewErrorProbe node={node} onError={(error) => errors.push(error)} />
        </CanvasTextPreviewProvider>
      );
    });

    await expect(waitForTextPreviewError(errors)).resolves.toBe(input.expectedError);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    restoreAnimationFrame();
    restoreActEnvironment();
  }
}

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
    onPreview(previewForNode({ node }));
  }, [node, onPreview, previewForNode]);

  return <div />;
}

function TextPreviewErrorProbe({
  node,
  onError
}: {
  node: ProjectedCanvasNode;
  onError: (error: string | undefined) => void;
}): React.ReactElement {
  const { previewErrorForNode } = useCanvasTextPreviewRuntime();

  React.useEffect(() => {
    onError(previewErrorForNode({ node }));
  });

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
  return {
    readCanvasTextPreviewSources: async (input: Parameters<WorkbenchActions['readCanvasTextPreviewSources']>[0]) => ({
      sources: Object.fromEntries(input.sources.map((source) => [
        source.projectRelativePath,
        {
          projectRelativePath: source.projectRelativePath,
          fingerprint: source.fingerprint,
          available: true
        }
      ]))
    }),
    saveCanvasTextPreviewSource: async () => {
      throw new Error('Unexpected source capture in variant selection test.');
    }
  } as unknown as WorkbenchActions;
}

function recordingTextPreviewActionsFixture(records: string[][]): WorkbenchActions {
  return {
    readCanvasTextPreviewSources: async (input: Parameters<WorkbenchActions['readCanvasTextPreviewSources']>[0]) => {
      records.push(input.sources.map((source) => source.projectRelativePath));
      return {
        sources: Object.fromEntries(input.sources.map((source) => [
          source.projectRelativePath,
          {
            projectRelativePath: source.projectRelativePath,
            fingerprint: source.fingerprint,
            available: true
          }
        ]))
      };
    },
    saveCanvasTextPreviewSource: async () => {
      throw new Error('Unexpected source capture in scheduled text preview test.');
    }
  } as unknown as WorkbenchActions;
}

function missingSourceTextPreviewActionsFixture(records: string[][]): WorkbenchActions {
  return {
    readCanvasTextPreviewSources: async (input: Parameters<WorkbenchActions['readCanvasTextPreviewSources']>[0]) => {
      records.push(input.sources.map((source) => source.projectRelativePath));
      return {
        sources: Object.fromEntries(input.sources.map((source) => [
          source.projectRelativePath,
          {
            projectRelativePath: source.projectRelativePath,
            fingerprint: source.fingerprint,
            available: false
          }
        ]))
      };
    },
    saveCanvasTextPreviewSource: async () => {
      throw new Error('Unexpected source save in scheduling test.');
    }
  } as unknown as WorkbenchActions;
}

function recordingFingerprintTextPreviewActionsFixture(fingerprints: string[]): WorkbenchActions {
  return {
    readCanvasTextPreviewSources: async (input: Parameters<WorkbenchActions['readCanvasTextPreviewSources']>[0]) => ({
      sources: Object.fromEntries(input.sources.map((source) => {
        if (fingerprints.at(-1) !== source.fingerprint) {
          fingerprints.push(source.fingerprint);
        }
        return [
          source.projectRelativePath,
          {
            projectRelativePath: source.projectRelativePath,
            fingerprint: source.fingerprint,
            available: true
          }
        ];
      }))
    }),
    saveCanvasTextPreviewSource: async () => {
      throw new Error('Unexpected source capture in style key test.');
    }
  } as unknown as WorkbenchActions;
}

function createImmediateScheduler(): CanvasPreviewResourceScheduler {
  return {
    enqueue: (request: CanvasPreviewResourceRequest) => {
      if (request.isCurrent() && !request.isCulled()) {
        request.run();
      }
    },
    cancel: () => undefined,
    setInteractionState: () => undefined,
    dispose: () => undefined
  };
}

function createRecordingImmediateScheduler(enqueued: string[]): CanvasPreviewResourceScheduler {
  return {
    enqueue: (request: CanvasPreviewResourceRequest) => {
      enqueued.push(request.nodeId);
      if (request.isCurrent() && !request.isCulled()) {
        request.run();
      }
    },
    cancel: () => undefined,
    setInteractionState: () => undefined,
    dispose: () => undefined
  };
}

function createQueuedScheduler(queued: CanvasPreviewResourceRequest[]): CanvasPreviewResourceScheduler {
  return {
    enqueue: (request: CanvasPreviewResourceRequest) => {
      const existingIndex = queued.findIndex((item) => item.kind === request.kind && item.nodeId === request.nodeId);
      if (existingIndex >= 0) {
        queued.splice(existingIndex, 1, request);
        return;
      }
      queued.push(request);
    },
    cancel: (kind, nodeId) => {
      const existingIndex = queued.findIndex((item) => item.kind === kind && item.nodeId === nodeId);
      if (existingIndex >= 0) {
        queued.splice(existingIndex, 1);
      }
    },
    setInteractionState: () => undefined,
    dispose: () => {
      queued.splice(0, queued.length);
    }
  };
}

async function flushReactWork(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function installTextPreviewStyleVariables(input: {
  text: string;
  muted: string;
}): void {
  document.documentElement.style.setProperty('--db-text', input.text);
  document.documentElement.style.setProperty('--db-text-muted', input.muted);
}

function clearTextPreviewStyleVariables(): void {
  document.documentElement.style.removeProperty('--db-text');
  document.documentElement.style.removeProperty('--db-text-muted');
}

async function waitForRecordedFingerprintCount(fingerprints: string[], count: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (fingerprints.length >= count) {
      return;
    }
    await flushReactWork();
  }
  throw new Error(`Expected ${count} recorded text preview fingerprints.`);
}

async function waitForRecordedSourceReads(records: string[][], expected: string[][]): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (JSON.stringify(records) === JSON.stringify(expected)) {
      return;
    }
    await flushReactWork();
  }
  throw new Error(`Expected text preview source reads ${JSON.stringify(expected)}, got ${JSON.stringify(records)}.`);
}

async function waitForRecordedCounters(counters: string[], expected: string[]): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (expected.every((counter) => counters.includes(counter))) {
      return;
    }
    await flushReactWork();
  }
  throw new Error(`Expected text preview counters ${JSON.stringify(expected)}, got ${JSON.stringify(counters)}.`);
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
    styleKey: 'sha256:style-a',
    fingerprint: `sha256:${projectRelativePath}`
  };
}

function textPreviewSource(previewWidth: number, fingerprint = 'sha256:preview'): CanvasTextPreviewSource & { fingerprint: string } {
  return {
    src: `/api/projects/p/canvas-text-preview?canvasId=canvas-1&path=flow%2Freadme.md&fingerprint=${fingerprint}&w=${previewWidth}`,
    previewWidth,
    fingerprint
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

async function waitForTextPreviewError(errors: Array<string | undefined>): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const error = [...errors].reverse().find((item): item is string => typeof item === 'string');
    if (error) {
      return error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error('Expected text preview error.');
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

function installImageConstructorCounter(): { count(): number; restore(): void } {
  const previousImage = window.Image;
  let count = 0;
  window.Image = ((width?: number, height?: number) => {
    count += 1;
    const image = document.createElement('img');
    if (typeof width === 'number') {
      image.width = width;
    }
    if (typeof height === 'number') {
      image.height = height;
    }
    return image;
  }) as unknown as typeof window.Image;
  return {
    count: () => count,
    restore: () => {
      window.Image = previousImage;
    }
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

function layoutElement(
  className: string,
  rect: { top: number; height: number; width?: number | undefined }
): HTMLElement {
  const element = document.createElement('div');
  element.className = className;
  setLayoutRect(element, rect);
  return element;
}

function setLayoutRect(element: HTMLElement, rect: { top: number; height: number; width?: number | undefined }): void {
  const width = rect.width ?? 10;
  element.getBoundingClientRect = () => ({
    x: 0,
    y: rect.top,
    top: rect.top,
    bottom: rect.top + rect.height,
    left: 0,
    right: width,
    width,
    height: rect.height,
    toJSON: () => undefined
  });
}

function setClientSize(element: HTMLElement, size: { width: number; height: number }): void {
  Object.defineProperty(element, 'clientWidth', {
    configurable: true,
    value: size.width
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: size.height
  });
}
