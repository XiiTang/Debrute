import {
  DEFAULT_CANVAS_TEXT_APPEARANCE,
  canvasFontCatalogEntry,
  canvasTextRenderProfileDefinition,
  canvasTextRenderProfileForAppearance
} from './CanvasFontCatalog.js';

export const DEFAULT_CANVAS_TEXT_FONT_RESOURCE = canvasFontCatalogEntry(
  DEFAULT_CANVAS_TEXT_APPEARANCE.fontId
).resource;

export const DEFAULT_CANVAS_TEXT_RENDER_PROFILE_DEFINITION = canvasTextRenderProfileDefinition(
  DEFAULT_CANVAS_TEXT_APPEARANCE
);

export const DEFAULT_CANVAS_TEXT_RENDER_PROFILE = canvasTextRenderProfileForAppearance(
  DEFAULT_CANVAS_TEXT_APPEARANCE
);
