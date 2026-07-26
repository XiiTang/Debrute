import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
  captureCanvasTextPreviewSource,
  canvasTextPreviewFingerprint
} from './CanvasTextPreviewCapture';
import { rasterizeCanvasTextPreviewInWorker } from './CanvasTextPreviewRasterWorkerClient.js';
import type { CanvasTextPreviewBuiltScene } from './CanvasTextPreviewScene.js';
import { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } from './CanvasTextRenderProfile.test-support.js';

vi.mock('./CanvasTextPreviewRasterWorkerClient.js', () => ({
  rasterizeCanvasTextPreviewInWorker: vi.fn(async () => new Blob(['png'], { type: 'image/png' }))
}));

const TEST_DOCUMENT = {} as Document;

describe('CanvasTextPreviewCapture', { tags: ['canvas-text'] }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends only a bounded drawing scene to the raster worker at the fixed source scale', async () => {
    const builtScene = builtSceneFixture(320, 160);
    const renderProfile = renderProfileFixture();

    const result = await captureCanvasTextPreviewSource({
      builtScene,
      document: TEST_DOCUMENT,
      renderProfile,
      fields: failureFields()
    });

    expect(result.sourcePng.type).toBe('image/png');
    expect(result).toMatchObject({
      sceneWidth: 320,
      sceneHeight: 160
    });
    expect(rasterizeCanvasTextPreviewInWorker).toHaveBeenCalledWith({
      scene: expect.objectContaining({
        background: expect.any(String),
        commands: expect.any(Array)
      }),
      fontFaces: expect.arrayContaining([
        expect.objectContaining({ family: 'canvas-text-test' })
      ]),
      fontResourceKey: 'canvas-text-test-font',
      width: 320,
      height: 160,
      scale: 4
    });
  });

  it('reports raster_failed instead of exposing a raw Event', async () => {
    vi.mocked(rasterizeCanvasTextPreviewInWorker).mockRejectedValueOnce(new Event('error'));

    await expect(captureCanvasTextPreviewSource({
      builtScene: builtSceneFixture(320, 160),
      document: TEST_DOCUMENT,
      renderProfile: renderProfileFixture(),
      fields: failureFields()
    })).rejects.toMatchObject({
      stage: 'raster_failed',
      message: 'Canvas text preview raster failed (browser event: error).'
    });
  });

  it('measures raster wall duration through PNG blob completion', async () => {
    const raster = deferred<Blob>();
    let now = 10;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.mocked(rasterizeCanvasTextPreviewInWorker).mockReturnValueOnce(raster.promise);

    const capture = captureCanvasTextPreviewSource({
      builtScene: builtSceneFixture(320, 160),
      document: TEST_DOCUMENT,
      renderProfile: renderProfileFixture(),
      fields: failureFields()
    });
    now = 37;
    raster.resolve(new Blob(['png'], { type: 'image/png' }));

    await expect(capture).resolves.toMatchObject({ rasterDurationMs: 27 });
  });

  it('hashes all pixel-affecting text preview inputs', async () => {
    const first = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      styleKey: 'sha256:style-a'
    });
    const second = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: false,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      styleKey: 'sha256:style-a'
    });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^sha256:/);
  });

  it('hashes the text preview style key', async () => {
    const first = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      styleKey: 'sha256:style-a'
    });
    const second = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      styleKey: 'sha256:style-b'
    });

    expect(first).not.toBe(second);
  });

  it('hashes the fixed text preview source scale', async () => {
    const fingerprint = await canvasTextPreviewFingerprint({
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      styleKey: 'sha256:style-a'
    });

    await expect(sha256({
      visualVersion: 'canvas-text-preview-v15',
      content: 'hello',
      language: 'markdown',
      wordWrap: true,
      contentCssWidth: 320,
      contentCssHeight: 160,
      scrollTop: 0,
      scrollLeft: 0,
      sourceScale: CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
      styleKey: 'sha256:style-a'
    })).resolves.toBe(fingerprint);
  });
});

function builtSceneFixture(width: number, height: number): CanvasTextPreviewBuiltScene {
  const scene = { background: 'transparent', commands: [] };
  return {
    scene,
    width,
    height
  };
}

function renderProfileFixture() {
  return {
    ...DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
    prepare: async () => ({
      identity: 'canvas-text-test-font',
      faces: [{
        family: 'canvas-text-test',
        bytes: new Uint8Array([1]).buffer,
        descriptors: { weight: '400', style: 'normal', stretch: '100%' }
      }]
    })
  };
}

function failureFields() {
  return {
    canvasId: 'canvas-1',
    projectRelativePath: 'notes/readme.md',
    fingerprint: 'sha256:current'
  };
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
