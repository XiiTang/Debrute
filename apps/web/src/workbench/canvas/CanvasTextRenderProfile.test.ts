import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCanvasTextFontResource,
  createCanvasTextRenderProfile,
  type CanvasTextFontDigest,
  type CanvasTextFontSource,
  type CanvasTextRenderProfileDefinition
} from './CanvasTextRenderProfile.js';

const ONE_BYTE_SHA256 = (
  'sha256:4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a'
) as CanvasTextFontDigest;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CanvasTextRenderProfile', { tags: ['canvas-text'] }, () => {
  it('resolves every supported typography and editor-geometry value into one binding', () => {
    const profile = createCanvasTextRenderProfile(profileDefinition());

    expect(profile.resolvedTypography).toEqual({
      fontSize: '12px',
      lineHeight: '16.8px',
      fontWeight: '400',
      fontStyle: 'normal',
      fontStretch: '100%',
      letterSpacing: '0px',
      wordSpacing: '0px',
      tabSize: '4',
      fontKerning: 'normal',
      fontVariantLigatures: 'common-ligatures no-discretionary-ligatures no-historical-ligatures contextual',
      fontFeatureSettings: 'normal',
      fontVariationSettings: 'normal',
      fontOpticalSizing: 'auto',
      fontSynthesis: 'weight style'
    });
    expect(profile.editorGeometry).toEqual({
      linePaddingInlinePx: 8,
      gutterPaddingLeftPx: 5,
      gutterPaddingRightPx: 3
    });
    expect(profile.editorStyle).toMatchObject({
      '--canvas-text-editor-font-size': '12px',
      '--canvas-text-editor-line-height': '16.8px',
      '--canvas-text-editor-font-weight': '400',
      '--canvas-text-editor-font-style': 'normal',
      '--canvas-text-editor-letter-spacing': '0px',
      '--canvas-text-editor-word-spacing': '0px',
      '--canvas-text-editor-line-padding-inline': '8px',
      '--canvas-text-editor-gutter-padding-left': '5px',
      '--canvas-text-editor-gutter-padding-right': '3px'
    });
  });

  it('uses exact font bytes and resolved typography as visual identity', () => {
    const first = createCanvasTextRenderProfile(profileDefinition());
    const changedFont = createCanvasTextRenderProfile(profileDefinition({
      digest: `sha256:${'c'.repeat(64)}`
    }));
    const changedTypographyDefinition = profileDefinition();
    const changedTypography = createCanvasTextRenderProfile({
      ...changedTypographyDefinition,
      typography: {
        ...changedTypographyDefinition.typography,
        letterSpacingPx: 2
      }
    });

    expect(first.identity).not.toBe(changedFont.identity);
    expect(first.identity).not.toBe(changedTypography.identity);
    expect(first.editorStyle['--canvas-text-editor-font-family'])
      .not.toBe(changedFont.editorStyle['--canvas-text-editor-font-family']);
  });

  it('prepares exact font bytes once per document for live and Worker rendering', async () => {
    const read = vi.fn(async () => new Uint8Array([1]).buffer);
    const documentToken = fontDocument();
    const installedFaces = installFontFaceMock();
    const profile = createCanvasTextRenderProfile(profileDefinition({ read }));

    await profile.prepare(documentToken);
    const preparedFont = await profile.prepare(documentToken);
    const family = profile.editorStyle['--canvas-text-editor-font-family'].replaceAll('"', '');

    expect(read).toHaveBeenCalledTimes(1);
    expect(installedFaces).toHaveLength(1);
    expect(installedFaces[0]).toMatchObject({
      family,
      descriptors: { weight: '300 500', style: 'normal', stretch: '75% 125%' }
    });
    expect(documentToken.fonts.add).toHaveBeenCalledTimes(1);
    expect(preparedFont.identity).toBe(profileDefinition({ read }).font.identity);
    expect(preparedFont.faces).toHaveLength(1);
    expect(preparedFont.faces[0]).toMatchObject({
      family,
      descriptors: { weight: '300 500', style: 'normal', stretch: '75% 125%' }
    });
    expect(new Uint8Array(preparedFont.faces[0]!.bytes)).toEqual(new Uint8Array([1]));
  });

  it('retains a failed preparation result without an implicit retry', async () => {
    const failure = new Error('font source unavailable');
    const read = vi.fn(async () => Promise.reject(failure));
    const profile = createCanvasTextRenderProfile(profileDefinition({ read }));
    const documentToken = fontDocument();

    await expect(profile.prepare(documentToken)).rejects.toBe(failure);
    await expect(profile.prepare(documentToken)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects font bytes whose digest does not match the managed asset identity', async () => {
    const profile = createCanvasTextRenderProfile(profileDefinition({
      digest: `sha256:${'f'.repeat(64)}`
    }));

    await expect(profile.prepare(fontDocument())).rejects.toThrow('font digest mismatch');
  });
});

function profileDefinition(input: {
  digest?: CanvasTextFontDigest;
  read?: CanvasTextFontSource['read'];
} = {}): CanvasTextRenderProfileDefinition {
  const font = createCanvasTextFontResource({
    families: [{
      faces: [{
        asset: {
          source: { read: input.read ?? (async () => new Uint8Array([1]).buffer) },
          sha256: input.digest ?? ONE_BYTE_SHA256,
          format: 'woff2'
        },
        weight: [300, 500],
        style: 'normal',
        stretchPercent: [75, 125]
      }]
    }]
  });
  return {
    font,
    typography: {
      fontSizePx: 12,
      lineHeight: { kind: 'ratio', value: 1.4 },
      fontWeight: 400,
      fontStyle: 'normal',
      fontStretchPercent: 100,
      letterSpacingPx: 0,
      wordSpacingPx: 0,
      tabSize: 4,
      kerning: 'normal',
      ligatures: {
        common: true,
        discretionary: false,
        historical: false,
        contextual: true
      },
      features: {},
      variations: {},
      opticalSizing: 'auto',
      synthesis: {
        weight: true,
        style: true,
        smallCaps: false
      }
    },
    editorGeometry: {
      linePaddingInlinePx: 8,
      gutterPaddingLeftPx: 5,
      gutterPaddingRightPx: 3
    }
  };
}

function fontDocument(): Document & { fonts: { add: ReturnType<typeof vi.fn> } } {
  return {
    fonts: { add: vi.fn() }
  } as unknown as Document & { fonts: { add: ReturnType<typeof vi.fn> } };
}

function installFontFaceMock(): Array<{
  family: string;
  descriptors: FontFaceDescriptors;
}> {
  const installed: Array<{ family: string; descriptors: FontFaceDescriptors }> = [];
  class FontFaceMock {
    constructor(
      readonly family: string,
      _source: ArrayBuffer,
      readonly descriptors: FontFaceDescriptors
    ) {
      installed.push({ family, descriptors });
    }

    async load(): Promise<FontFace> {
      return this as unknown as FontFace;
    }
  }
  vi.stubGlobal('FontFace', FontFaceMock);
  return installed;
}
