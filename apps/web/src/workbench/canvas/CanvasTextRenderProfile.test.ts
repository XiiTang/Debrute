import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCanvasTextFontResource,
  createCanvasTextRenderProfile,
  readVerifiedCanvasTextFontFace,
  type CanvasTextFontFaceDefinition,
  type CanvasTextRenderProfileDefinition
} from './CanvasTextRenderProfile';

type CanvasTextFontDigest = CanvasTextFontFaceDefinition['sha256'];

const ONE_BYTE_SHA256 = (
  'sha256:4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a'
) as CanvasTextFontDigest;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CanvasTextRenderProfile', { tags: ['canvas-text'] }, () => {
  it('resolves the supported appearance and fixed editor contract into one binding', () => {
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
      fontSynthesis: 'none'
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
      letterSpacingPx: 2
    });

    expect(first.identity).not.toBe(changedFont.identity);
    expect(first.identity).not.toBe(changedTypography.identity);
    expect(first.editorStyle['--canvas-text-editor-font-family'])
      .not.toBe(changedFont.editorStyle['--canvas-text-editor-font-family']);
  });

  it('assigns distinct aliases to interactive and preview rendering', () => {
    const profile = createCanvasTextRenderProfile(profileDefinition());
    expect(profile.editorStyle['--canvas-text-editor-font-family'])
      .not.toBe(profile.previewEditorStyle['--canvas-text-editor-font-family']);
    expect(profile.font.families[0]?.interactiveAlias).toContain('__debrute_canvas_text_full_');
    expect(profile.font.families[0]?.previewAlias).toContain('__debrute_canvas_text_preview_');
  });

  it('rejects font bytes whose digest does not match the managed asset identity', async () => {
    const profile = createCanvasTextRenderProfile(profileDefinition({
      digest: `sha256:${'f'.repeat(64)}`
    }));

    await expect(readVerifiedCanvasTextFontFace(profile.font.families[0]!.faces[0]!))
      .rejects.toThrow('font digest mismatch');
  });
});

function profileDefinition(input: {
  digest?: CanvasTextFontDigest;
  read?: CanvasTextFontFaceDefinition['source']['read'];
} = {}): CanvasTextRenderProfileDefinition {
  const font = createCanvasTextFontResource([{
    source: { read: input.read ?? (async () => new Uint8Array([1]).buffer) },
    sha256: input.digest ?? ONE_BYTE_SHA256,
    weight: 400
  }]);
  return {
    font,
    fontSizePx: 12,
    lineHeightRatio: 1.4,
    fontWeight: 400,
    letterSpacingPx: 0,
    ligatures: true
  };
}
