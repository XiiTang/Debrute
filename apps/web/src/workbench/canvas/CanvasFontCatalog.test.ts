import { describe, expect, it } from 'vitest';
import {
  CANVAS_FONT_CATALOG,
  DEFAULT_CANVAS_TEXT_APPEARANCE,
  canvasTextRenderProfileForAppearance
} from './CanvasFontCatalog.js';

describe('CanvasFontCatalog', { tags: ['canvas-text'] }, () => {
  it('exposes the five managed Canvas Font selections in stable order', () => {
    expect(CANVAS_FONT_CATALOG.map(({ id, displayName }) => ({ id, displayName }))).toEqual([
      { id: 'noto-sans-mono-cjk-sc', displayName: 'Noto Sans Mono CJK SC' },
      { id: 'lilex', displayName: 'Lilex' },
      { id: 'jetbrains-mono', displayName: 'JetBrains Mono' },
      { id: 'ibm-plex-mono', displayName: 'IBM Plex Mono' },
      { id: 'noto-sans-sc', displayName: 'Noto Sans SC' }
    ]);
  });

  it('keeps requested appearance values while disabling synthetic faces', () => {
    const profile = canvasTextRenderProfileForAppearance({
      ...DEFAULT_CANVAS_TEXT_APPEARANCE,
      fontId: 'lilex',
      fontSizePx: 15.5,
      lineHeightRatio: 1.35,
      fontWeight: 600,
      letterSpacingPx: -0.2,
      ligatures: false
    });

    expect(profile.resolvedTypography).toMatchObject({
      fontSize: '15.5px',
      lineHeight: '20.925px',
      fontWeight: '600',
      letterSpacing: '-0.2px',
      fontVariantLigatures: 'no-common-ligatures no-discretionary-ligatures no-historical-ligatures no-contextual',
      fontSynthesis: 'none'
    });
    expect(profile.editorStyle['--canvas-text-editor-font-family'].split(', ')).toHaveLength(2);
  });

  it('changes render identity for the selected managed bytes or any appearance value', () => {
    const initial = canvasTextRenderProfileForAppearance(DEFAULT_CANVAS_TEXT_APPEARANCE);
    const changedFont = canvasTextRenderProfileForAppearance({
      ...DEFAULT_CANVAS_TEXT_APPEARANCE,
      fontId: 'jetbrains-mono'
    });
    const changedWeight = canvasTextRenderProfileForAppearance({
      ...DEFAULT_CANVAS_TEXT_APPEARANCE,
      fontWeight: 500
    });

    expect(initial.identity).not.toBe(changedFont.identity);
    expect(initial.identity).not.toBe(changedWeight.identity);
  });
});
