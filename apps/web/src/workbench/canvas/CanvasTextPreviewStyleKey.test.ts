// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { CANVAS_TEXT_SURFACE_METRICS } from './CanvasTextSurface';
import {
  CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES,
  canvasTextPreviewStyleKey,
  canvasTextPreviewStyleSnapshot,
  canvasTextPreviewStyleSnapshotForDocument
} from './CanvasTextPreviewStyleKey';

describe('CanvasTextPreviewStyleKey', () => {
  it('hashes the same effective style snapshot to the same key', async () => {
    const snapshot = canvasTextPreviewStyleSnapshot({
      cssVariables: textPreviewCssVariables({
        '--db-text': '#ffffff',
        '--db-text-muted': 'rgb(255 255 255 / 72%)'
      })
    });

    await expect(canvasTextPreviewStyleKey(snapshot)).resolves.toBe(await canvasTextPreviewStyleKey(snapshot));
  });

  it('changes when an effective text preview style value changes', async () => {
    const first = await canvasTextPreviewStyleKey(canvasTextPreviewStyleSnapshot({
      cssVariables: textPreviewCssVariables({
        '--db-text': '#ffffff',
        '--db-text-muted': 'rgb(255 255 255 / 72%)'
      })
    }));
    const second = await canvasTextPreviewStyleKey(canvasTextPreviewStyleSnapshot({
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
      cssVariables: textPreviewCssVariables({
        '--db-text': '#ffffff',
        '--db-text-muted': 'rgb(255 255 255 / 72%)'
      })
    });

    expect(JSON.stringify(snapshot)).not.toContain('theme');
    expect(JSON.stringify(snapshot)).not.toContain('projectStyle');
    expect(snapshot.textSurfaceMetrics).toEqual(CANVAS_TEXT_SURFACE_METRICS);
  });

  it('reads required CSS variables from the document element', () => {
    const restore = installTextPreviewStyleVariables({
      '--db-text': '#ffffff',
      '--db-text-muted': 'rgb(255 255 255 / 72%)'
    });

    try {
      expect(canvasTextPreviewStyleSnapshotForDocument().cssVariables).toEqual(textPreviewCssVariables({
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
      expect(() => canvasTextPreviewStyleSnapshotForDocument()).toThrow(
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
