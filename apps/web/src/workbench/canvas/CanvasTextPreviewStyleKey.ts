import { CANVAS_TEXT_EDITOR_SYNTAX_HIGHLIGHT_STYLE_ID } from './CanvasTextEditorContract';
import type { CanvasTextRenderProfile } from './CanvasTextRenderProfile';

export const CANVAS_TEXT_PREVIEW_STYLE_SNAPSHOT_VERSION = 'canvas-text-preview-style-v3';

export const CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES = [
  '--db-text',
  '--db-text-muted'
] as const;

export type CanvasTextPreviewStyleCssVariable = typeof CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES[number];

export interface CanvasTextPreviewStyleSnapshot {
  styleSnapshotVersion: typeof CANVAS_TEXT_PREVIEW_STYLE_SNAPSHOT_VERSION;
  renderProfileIdentity: string;
  cssVariables: Record<CanvasTextPreviewStyleCssVariable, string>;
  syntaxHighlightStyleId: typeof CANVAS_TEXT_EDITOR_SYNTAX_HIGHLIGHT_STYLE_ID;
}

export function canvasTextPreviewStyleSnapshot(input: {
  renderProfile: CanvasTextRenderProfile;
  cssVariables: Record<CanvasTextPreviewStyleCssVariable, string>;
}): CanvasTextPreviewStyleSnapshot {
  return {
    styleSnapshotVersion: CANVAS_TEXT_PREVIEW_STYLE_SNAPSHOT_VERSION,
    renderProfileIdentity: input.renderProfile.identity,
    cssVariables: Object.fromEntries(CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES.map((variable) => {
      const value = input.cssVariables[variable].trim();
      if (!value) {
        throw new Error(`Canvas text preview style variable is required: ${variable}`);
      }
      return [variable, value];
    })) as Record<CanvasTextPreviewStyleCssVariable, string>,
    syntaxHighlightStyleId: CANVAS_TEXT_EDITOR_SYNTAX_HIGHLIGHT_STYLE_ID
  };
}

export function canvasTextPreviewStyleSnapshotForDocument(
  renderProfile: CanvasTextRenderProfile,
  doc: Document = document
): CanvasTextPreviewStyleSnapshot {
  const style = doc.defaultView?.getComputedStyle(doc.documentElement);
  if (!style) {
    throw new Error('Canvas text preview style requires a document with computed styles.');
  }
  return canvasTextPreviewStyleSnapshot({
    renderProfile,
    cssVariables: Object.fromEntries(CANVAS_TEXT_PREVIEW_STYLE_CSS_VARIABLES.map((variable) => [
      variable,
      style.getPropertyValue(variable)
    ])) as Record<CanvasTextPreviewStyleCssVariable, string>
  });
}

export async function canvasTextPreviewStyleKey(
  snapshot: CanvasTextPreviewStyleSnapshot
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot)));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
