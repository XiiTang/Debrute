import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasPreviewTargetIdentityFromDigest } from '@debrute/canvas-core';
import {
  captureCanvasTextPreviewSource,
  canvasTextPreviewTargetIdentity,
  canvasTextPreviewSourceSize,
  canvasTextRasterEnvironmentIdentity,
  type CanvasTextPreviewCaptureTarget,
  type CanvasTextPreviewTarget
} from './CanvasTextPreviewCapture.js';

const decodedSources: string[] = [];
const svgBlobs: Blob[] = [];
const drawImage = vi.fn();
const canvases: Array<{ width: number; height: number }> = [];

describe('CanvasTextPreviewCapture', { tags: ['canvas-text'] }, () => {
  beforeEach(() => {
    decodedSources.length = 0;
    svgBlobs.length = 0;
    canvases.length = 0;
    drawImage.mockClear();
    installRasterMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    [420, 248, 1680, 992],
    [840, 496, 3360, 1984],
    [1680, 992, 3769, 2225],
    [1680, 248, 4096, 604],
    [420, 992, 1680, 3968],
    [3360, 1984, 3769, 2225]
  ])('bounds a %sx%s CSS viewport to a %sx%s source', (
    contentCssWidth,
    contentCssHeight,
    sourcePixelWidth,
    sourcePixelHeight
  ) => {
    expect(canvasTextPreviewSourceSize({ contentCssWidth, contentCssHeight })).toMatchObject({
      sourcePixelWidth,
      sourcePixelHeight
    });
  });

  it('rasterizes the current CodeMirror DOM into one bounded PNG source', async () => {
    const captureRoot = captureRootFixture();
    const widgetBuffer = document.createElement('img');
    widgetBuffer.className = 'cm-widgetBuffer';
    captureRoot.querySelector('.cm-content')?.append(widgetBuffer);
    const target = targetFixture();

    const result = await captureCanvasTextPreviewSource({
      captureRoot,
      target,
      fields: failureFields(),
      preparedFont: preparedFontFixture(),
      isInteractionActive: () => false
    });

    expect(result).toMatchObject({
      sourcePng: expect.objectContaining({ type: 'image/png' }),
      cssWidth: 320,
      cssHeight: 160,
      sourcePixelWidth: 1280,
      sourcePixelHeight: 640,
      snapshotElementCount: 9
    });
    expect(canvases).toEqual([{ width: 1280, height: 640 }]);
    expect(decodedSources).toHaveLength(1);
    const decodedSource = await svgBlobs[0]!.text();
    expect(decodedSource).toContain('@font-face{font-family:"test"');
    expect(decodedSource).not.toContain('unused-bold-face');
    expect(decodedSource).toContain('translate(-18px, -44px)');
    expect(decodedSource).not.toContain('evil.invalid');
    expect(decodedSource).not.toContain('onclick=');
    expect(decodedSource).not.toContain('cm-widgetBuffer');
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it('waits for an interaction-free frame before cloning the capture DOM', async () => {
    const captureRoot = captureRootFixture();
    const clone = vi.spyOn(captureRoot, 'cloneNode');
    let interactionChecks = 0;
    const capture = captureCanvasTextPreviewSource({
      captureRoot,
      target: targetFixture(),
      fields: failureFields(),
      preparedFont: preparedFontFixture(),
      isInteractionActive: () => {
        interactionChecks += 1;
        return interactionChecks === 1;
      }
    });

    expect(clone).not.toHaveBeenCalled();
    await capture;
    expect(interactionChecks).toBeGreaterThanOrEqual(2);
    expect(clone).toHaveBeenCalledWith(false);
  });

  it('preserves browser font matching when a requested weight has no exact managed face', async () => {
    const captureRoot = captureRootFixture();
    captureRoot.style.fontWeight = '500';

    await captureCanvasTextPreviewSource({
      captureRoot,
      target: targetFixture(),
      fields: failureFields(),
      preparedFont: preparedFontFixture(),
      isInteractionActive: () => false
    });

    const svg = await svgBlobs[0]!.text();
    expect(svg).toContain('@font-face{font-family:"test"');
    expect(svg).toContain('unused-bold-face');
  });

  it('rejects a capture root without the required CodeMirror viewport', async () => {
    const captureRoot = document.createElement('div');
    setClientSize(captureRoot, 320, 160);

    await expect(captureCanvasTextPreviewSource({
      captureRoot,
      target: targetFixture(),
      fields: failureFields(),
      preparedFont: preparedFontFixture(),
      isInteractionActive: () => false
    })).rejects.toMatchObject({
      stage: 'capture_not_ready'
    });
  });

  it('reports image decode events as raster failures', async () => {
    vi.stubGlobal('Image', class ImageFailureMock {
      decoding = 'async';
      src = '';

      async decode(): Promise<void> {
        throw new Event('error');
      }
    });

    await expect(captureCanvasTextPreviewSource({
      captureRoot: captureRootFixture(),
      target: targetFixture(),
      fields: failureFields(),
      preparedFont: preparedFontFixture(),
      isInteractionActive: () => false
    })).rejects.toMatchObject({
      stage: 'raster_failed',
      message: 'Canvas text preview raster failed (browser event: error).'
    });
  });

  it('aborts stale capture without publishing a failure result', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(captureCanvasTextPreviewSource({
      captureRoot: captureRootFixture(),
      target: targetFixture(),
      fields: failureFields(),
      preparedFont: preparedFontFixture(),
      signal: controller.signal,
      isInteractionActive: () => false
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('hashes adaptive source dimensions and every pixel-affecting target input', async () => {
    const first = await canvasTextPreviewTargetIdentity(candidateFixture());
    const second = await canvasTextPreviewTargetIdentity({
      ...candidateFixture(),
      wordWrap: false
    });
    const resized = await canvasTextPreviewTargetIdentity({
      ...candidateFixture(),
      sourcePixelWidth: 1279
    });

    expect(first).toMatch(/^sha256:/);
    expect(first).not.toBe(second);
    expect(first).not.toBe(resized);
  });

  it('uses a fixed raster contract and hashes the system fallback policy', async () => {
    expect(canvasTextRasterEnvironmentIdentity()).toEqual({
      platform: 'darwin',
      frontend: 'browser',
      engine: 'chromium',
      engineContractVersion: 'chromium-raster-v1',
      systemFallbackPolicyVersion: 'canvas-text-system-fallback-v1'
    });
    const first = await canvasTextPreviewTargetIdentity({
      ...candidateFixture(),
      rasterEnvironmentIdentity: {
        ...canvasTextRasterEnvironmentIdentity(),
        systemFallbackPolicyVersion: 'fallback-v1'
      }
    });
    const second = await canvasTextPreviewTargetIdentity({
      ...candidateFixture(),
      rasterEnvironmentIdentity: {
        ...canvasTextRasterEnvironmentIdentity(),
        systemFallbackPolicyVersion: 'fallback-v2'
      }
    });

    expect(first).not.toBe(second);
  });
});

function installRasterMocks(): void {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(performance.now()));
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('FileReader', class FileReaderMock extends EventTarget {
    result: string | ArrayBuffer | null = null;
    error: DOMException | null = null;

    readAsDataURL(blob: Blob): void {
      svgBlobs.push(blob);
      this.result = `data:image/svg+xml;base64,fixture-${svgBlobs.length}`;
      queueMicrotask(() => this.dispatchEvent(new Event('load')));
    }
  });
  vi.stubGlobal('Image', class ImageMock {
    decoding = 'async';
    src = '';

    async decode(): Promise<void> {
      decodedSources.push(this.src);
    }
  });
  vi.stubGlobal('OffscreenCanvas', class OffscreenCanvasMock {
    constructor(readonly width: number, readonly height: number) {
      canvases.push({ width, height });
    }

    getContext(): OffscreenCanvasRenderingContext2D {
      return { drawImage } as unknown as OffscreenCanvasRenderingContext2D;
    }

    async convertToBlob(): Promise<Blob> {
      return new Blob(['png'], { type: 'image/png' });
    }
  });
}

function captureRootFixture(): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'canvas-text-preview-capture-target canvas-text-body';
  root.style.fontFamily = '"test"';
  root.innerHTML = [
    '<div class="canvas-text-editor" data-editor-mode="handoff">',
    '<div class="cm-editor">',
    '<div class="cm-scroller">',
    '<div class="cm-gutters"><div class="cm-gutter cm-lineNumbers">',
    '<div class="cm-gutterElement">1</div>',
    '</div></div>',
    '<div class="cm-content"><div class="cm-line"><span onclick="evil()" style="color: rgb(255, 0, 0); background-image: url(https://evil.invalid/pixel.png)">content</span></div></div>',
    '</div>',
    '</div>',
    '</div>'
  ].join('');
  setClientSize(root, 320, 160);
  const scroller = root.querySelector<HTMLElement>('.cm-scroller')!;
  const content = root.querySelector<HTMLElement>('.cm-content')!;
  const gutters = root.querySelector<HTMLElement>('.cm-gutters')!;
  setClientSize(scroller, 320, 160);
  setScrollSize(content, 640, 480);
  setScrollSize(gutters, 40, 480);
  scroller.scrollTop = 44;
  scroller.scrollLeft = 18;
  return root;
}

function targetFixture(): CanvasTextPreviewCaptureTarget {
  return {
    ...candidateFixture(),
    content: 'content',
    targetIdentity: canvasPreviewTargetIdentityFromDigest('sha256:target')
  };
}

function candidateFixture(): Omit<CanvasTextPreviewTarget, 'targetIdentity'> {
  return {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    projectRelativePath: 'notes/a.md',
    contentDigest: 'sha256:content',
    estimatedBytes: 7,
    language: 'markdown',
    wordWrap: true,
    contentCssWidth: 320,
    contentCssHeight: 160,
    scrollTop: 44,
    scrollLeft: 18,
    styleKey: 'sha256:style',
    sourcePixelWidth: 1280,
    sourcePixelHeight: 640,
    sourceScale: 4
  };
}

function failureFields() {
  return {
    canvasId: 'canvas-1',
    projectRelativePath: 'notes/a.md',
    targetIdentity: canvasPreviewTargetIdentityFromDigest('sha256:target')
  };
}

function preparedFontFixture() {
  return {
    resourceIdentity: 'test-font',
    embeddedFaces: [
      {
        family: 'test',
        weight: '400',
        css: '@font-face{font-family:"test";src:url("data:font/woff2;base64,AQ==");font-weight:400}'
      },
      { family: 'test', weight: '700', css: 'unused-bold-face' }
    ]
  };
}

function setClientSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height }
  });
}

function setScrollSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, value: width },
    scrollHeight: { configurable: true, value: height }
  });
}
