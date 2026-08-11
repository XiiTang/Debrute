import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCanvasTextFontResource,
  createCanvasTextRenderProfile
} from '../CanvasTextRenderProfile';
import { CanvasTextProjectFontEnvironment } from './CanvasTextProjectFontEnvironment';

const ONE_BYTE_SHA256 = 'sha256:4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CanvasTextProjectFontEnvironment', { tags: ['canvas-text'] }, () => {
  it('loads full font bytes lazily once for actual interactive editors', async () => {
    installFontFaceMock();
    const read = vi.fn(async () => new Uint8Array([1]).buffer);
    const fontDocument = fontDocumentMock();
    const profile = profileFixture(read);
    const environment = new CanvasTextProjectFontEnvironment(profile, fontDocument.document);

    expect(read).not.toHaveBeenCalled();
    await environment.prepareInteractive(profile);
    await environment.prepareInteractive(profile);

    expect(read).toHaveBeenCalledTimes(1);
    expect(fontDocument.add).toHaveBeenCalledTimes(1);
  });

  it('keeps the prior full font active when a replacement cannot load', async () => {
    installFontFaceMock();
    const fontDocument = fontDocumentMock();
    const initial = profileFixture(async () => new Uint8Array([1]).buffer);
    const replacement = profileFixture(async () => Promise.reject(new Error('replacement failed')), 700);
    const environment = new CanvasTextProjectFontEnvironment(initial, fontDocument.document);
    await environment.prepareInteractive(initial);

    environment.updateProfile(replacement);
    await expect(environment.prepareInteractive(replacement)).rejects.toThrow('replacement failed');

    expect(fontDocument.add).toHaveBeenCalledTimes(1);
    expect(fontDocument.delete).not.toHaveBeenCalled();
    expect(environment.activeInteractiveProfile).toBe(initial);
  });

  it('removes generation-scoped full faces when disposed', async () => {
    installFontFaceMock();
    const fontDocument = fontDocumentMock();
    const profile = profileFixture(async () => new Uint8Array([1]).buffer);
    const environment = new CanvasTextProjectFontEnvironment(profile, fontDocument.document);
    await environment.prepareInteractive(profile);

    environment.dispose();

    expect(fontDocument.delete).toHaveBeenCalledTimes(1);
  });
});

function profileFixture(read: () => Promise<ArrayBuffer>, weight = 400) {
  return createCanvasTextRenderProfile({
    font: createCanvasTextFontResource([{
      source: { url: `/font-${weight}.woff2`, read },
      sha256: ONE_BYTE_SHA256,
      weight
    }]),
    fontSizePx: 12,
    lineHeightRatio: 1.4,
    fontWeight: weight,
    letterSpacingPx: 0,
    ligatures: true
  });
}

function fontDocumentMock() {
  const add = vi.fn();
  const deleteFace = vi.fn(() => true);
  return {
    document: { fonts: { add, delete: deleteFace } } as unknown as Document,
    add,
    delete: deleteFace
  };
}

function installFontFaceMock(): void {
  vi.stubGlobal('FontFace', class FontFaceMock {
    constructor(
      readonly family: string,
      readonly source: ArrayBuffer,
      readonly descriptors: FontFaceDescriptors
    ) {}

    async load(): Promise<FontFace> {
      return this as unknown as FontFace;
    }
  });
}
