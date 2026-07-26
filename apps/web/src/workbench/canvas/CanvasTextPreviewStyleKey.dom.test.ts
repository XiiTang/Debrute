import { describe, expect, it } from 'vitest';
import { createCanvasTextRenderProfile } from './CanvasTextRenderProfile.js';
import {
  DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
  DEFAULT_CANVAS_TEXT_RENDER_PROFILE_DEFINITION
} from './DefaultCanvasTextRenderProfile.js';
import {
  CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES,
  canvasTextPreviewStyleKey,
  canvasTextPreviewStyleSnapshot,
  canvasTextPreviewStyleSnapshotForDocument
} from './CanvasTextPreviewStyleKey';

describe('CanvasTextPreviewStyleKey', { tags: ['canvas-text'] }, () => {
  it('hashes the same effective style snapshot to the same key', async () => {
    const snapshot = canvasTextPreviewStyleSnapshot({
      renderProfile: DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
      cssVariables: textPreviewCssVariables({
        '--db-text': '#ffffff',
        '--db-text-muted': 'rgb(255 255 255 / 72%)'
      })
    });

    await expect(canvasTextPreviewStyleKey(snapshot)).resolves.toBe(await canvasTextPreviewStyleKey(snapshot));
  });

  it('changes when an effective text preview style value changes', async () => {
    const first = await canvasTextPreviewStyleKey(canvasTextPreviewStyleSnapshot({
      renderProfile: DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
      cssVariables: textPreviewCssVariables({
        '--db-text': '#ffffff',
        '--db-text-muted': 'rgb(255 255 255 / 72%)'
      })
    }));
    const second = await canvasTextPreviewStyleKey(canvasTextPreviewStyleSnapshot({
      renderProfile: DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
      cssVariables: textPreviewCssVariables({
        '--db-text': '#111827',
        '--db-text-muted': 'rgb(17 24 39 / 70%)'
      })
    }));

    expect(first).not.toBe(second);
    expect(first).toMatch(/^sha256:/);
    expect(second).toMatch(/^sha256:/);
  });

  it('does not include broader theme or project style labels', () => {
    const snapshot = canvasTextPreviewStyleSnapshot({
      renderProfile: DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
      cssVariables: textPreviewCssVariables({
        '--db-text': '#ffffff',
        '--db-text-muted': 'rgb(255 255 255 / 72%)'
      })
    });

    expect(JSON.stringify(snapshot)).not.toContain('theme');
    expect(JSON.stringify(snapshot)).not.toContain('projectStyle');
    expect(snapshot.renderProfileIdentity).toBe(DEFAULT_CANVAS_TEXT_RENDER_PROFILE.identity);
  });

  it('changes when any resolved text render profile setting changes', async () => {
    const alternate = createCanvasTextRenderProfile({
      ...DEFAULT_CANVAS_TEXT_RENDER_PROFILE_DEFINITION,
      typography: {
        ...DEFAULT_CANVAS_TEXT_RENDER_PROFILE_DEFINITION.typography,
        letterSpacingPx: 2
      }
    });
    const cssVariables = textPreviewCssVariables({
      '--db-text': '#ffffff',
      '--db-text-muted': 'rgb(255 255 255 / 72%)'
    });

    const first = await canvasTextPreviewStyleKey(canvasTextPreviewStyleSnapshot({
      renderProfile: DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
      cssVariables
    }));
    const second = await canvasTextPreviewStyleKey(canvasTextPreviewStyleSnapshot({
      renderProfile: alternate,
      cssVariables
    }));

    expect(first).not.toBe(second);
  });

  it('reads required CSS variables from the document element', () => {
    const restore = installTextPreviewStyleVariables({
      '--db-text': '#ffffff',
      '--db-text-muted': 'rgb(255 255 255 / 72%)'
    });

    try {
      expect(canvasTextPreviewStyleSnapshotForDocument(
        DEFAULT_CANVAS_TEXT_RENDER_PROFILE
      ).cssVariables).toEqual(textPreviewCssVariables({
        '--db-text': '#ffffff',
        '--db-text-muted': 'rgb(255 255 255 / 72%)'
      }));
    } finally {
      restore();
    }
  });

  it('rejects missing required CSS variables instead of omitting them', () => {
    const restore = installTextPreviewStyleVariables({
      '--db-text': '#ffffff',
      '--db-text-muted': ''
    });

    try {
      expect(() => canvasTextPreviewStyleSnapshotForDocument(
        DEFAULT_CANVAS_TEXT_RENDER_PROFILE
      )).toThrow(
        'Canvas text preview style variable is required: --db-text-muted'
      );
    } finally {
      restore();
    }
  });
});

function textPreviewCssVariables(
  values: Record<typeof CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES[number], string>
): Record<typeof CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES[number], string> {
  return values;
}

function installTextPreviewStyleVariables(
  values: Record<typeof CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES[number], string>
): () => void {
  const root = document.documentElement;
  const previous = Object.fromEntries(CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES.map((variable) => [
    variable,
    root.style.getPropertyValue(variable)
  ])) as Record<typeof CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES[number], string>;
  for (const variable of CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES) {
    root.style.setProperty(variable, values[variable]);
  }
  return () => {
    for (const variable of CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES) {
      root.style.setProperty(variable, previous[variable]);
    }
  };
}
