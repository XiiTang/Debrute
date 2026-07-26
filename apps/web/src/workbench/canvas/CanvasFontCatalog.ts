import type { CanvasFontId, CanvasTextAppearance } from '@debrute/app-protocol';
import {
  canvasTextFontUrlSource,
  createCanvasTextFontResource,
  createCanvasTextRenderProfile,
  type CanvasTextFontFaceDefinition,
  type CanvasTextFontResource,
  type CanvasTextRenderProfile,
  type CanvasTextRenderProfileDefinition
} from './CanvasTextRenderProfile.js';

interface CanvasFontCatalogEntry {
  readonly id: CanvasFontId;
  readonly displayName: string;
  readonly resource: CanvasTextFontResource;
}

const NOTO_SANS_MONO_CJK_SC = fontResource([
  managedWoff2Face(
    new URL('../../../../../assets/fonts/NotoSansMonoCJKsc-Regular.woff2', import.meta.url).href,
    'f034cf4574a995165d972e4e7fe56c53c8e1ef7a335e73740ae0c33378671ffb',
    400
  ),
  managedWoff2Face(
    new URL('../../../../../assets/fonts/NotoSansMonoCJKsc-Bold.woff2', import.meta.url).href,
    '79da39879c475a3c7443c07c73400cd21453bf0dd5dba66c75e210f2fca0ecad',
    700
  )
]);

const LILEX = fontResource([
  managedWoff2Face(
    new URL('../../../../../assets/fonts/Lilex-Regular.woff2', import.meta.url).href,
    'f3e8ee046b27e36cd2f1a88c295f042faef9fb546bc41ad3dc13e61aa731ae56',
    400
  ),
  managedWoff2Face(
    new URL('../../../../../assets/fonts/Lilex-Bold.woff2', import.meta.url).href,
    'e706bd34a24678205a9d31297e42b20dd9d26516ccb207baaa54f6aa3a0288cb',
    700
  )
]);

const JETBRAINS_MONO = fontResource([
  managedWoff2Face(
    new URL('../../../../../assets/fonts/JetBrainsMono-Regular.woff2', import.meta.url).href,
    'a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2',
    400
  ),
  managedWoff2Face(
    new URL('../../../../../assets/fonts/JetBrainsMono-Bold.woff2', import.meta.url).href,
    'c503cc5ec5f8b2c7666b7ecda1adf44bd45f2e6579b2eba0fc292150416588a2',
    700
  )
]);

const IBM_PLEX_MONO = fontResource([
  managedWoff2Face(
    new URL('../../../../../assets/fonts/IBMPlexMono-Regular.woff2', import.meta.url).href,
    'ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350',
    400
  ),
  managedWoff2Face(
    new URL('../../../../../assets/fonts/IBMPlexMono-Bold.woff2', import.meta.url).href,
    'ea576f38d05cc44cca48c45314984beb8cc1d2b886f58e1dce99f15dc344eb1d',
    700
  )
]);

const NOTO_SANS_SC = fontResource([
  managedWoff2Face(
    new URL('../../../../../assets/fonts/NotoSansSC-Regular.woff2', import.meta.url).href,
    'a6f257f26f9847472a67a80cec40fe0b4f57cabc8a58631dedaff26ad0d32179',
    400
  ),
  managedWoff2Face(
    new URL('../../../../../assets/fonts/NotoSansSC-Semibold.woff2', import.meta.url).href,
    '1f84f520cb89d0fae2fa77a3b4b43e2ece15fab2af783c95f56d4566b6cf1b53',
    600
  ),
  managedWoff2Face(
    new URL('../../../../../assets/fonts/NotoSansSC-Bold.woff2', import.meta.url).href,
    '39534a4fe074e302982c6e69cfd0039b8148b5c5204a5522d8b0045373b00de9',
    700
  )
]);

export const CANVAS_FONT_CATALOG = [
  {
    id: 'noto-sans-mono-cjk-sc',
    displayName: 'Noto Sans Mono CJK SC',
    resource: NOTO_SANS_MONO_CJK_SC
  },
  {
    id: 'lilex',
    displayName: 'Lilex',
    resource: fontResourceWithFallback(LILEX, NOTO_SANS_MONO_CJK_SC)
  },
  {
    id: 'jetbrains-mono',
    displayName: 'JetBrains Mono',
    resource: fontResourceWithFallback(JETBRAINS_MONO, NOTO_SANS_MONO_CJK_SC)
  },
  {
    id: 'ibm-plex-mono',
    displayName: 'IBM Plex Mono',
    resource: fontResourceWithFallback(IBM_PLEX_MONO, NOTO_SANS_MONO_CJK_SC)
  },
  {
    id: 'noto-sans-sc',
    displayName: 'Noto Sans SC',
    resource: NOTO_SANS_SC
  }
] as const satisfies readonly CanvasFontCatalogEntry[];

const CATALOG_BY_ID = new Map<CanvasFontId, CanvasFontCatalogEntry>(
  CANVAS_FONT_CATALOG.map((entry) => [entry.id, entry])
);

function canvasFontCatalogEntry(fontId: CanvasFontId): CanvasFontCatalogEntry {
  const entry = CATALOG_BY_ID.get(fontId);
  if (!entry) {
    throw new Error(`Unknown managed Canvas Font: ${String(fontId)}`);
  }
  return entry;
}

function canvasTextRenderProfileDefinition(
  appearance: CanvasTextAppearance
): CanvasTextRenderProfileDefinition {
  return {
    font: canvasFontCatalogEntry(appearance.fontId).resource,
    fontSizePx: appearance.fontSizePx,
    lineHeightRatio: appearance.lineHeightRatio,
    fontWeight: appearance.fontWeight,
    letterSpacingPx: appearance.letterSpacingPx,
    ligatures: appearance.ligatures
  };
}

export function canvasTextRenderProfileForAppearance(
  appearance: CanvasTextAppearance
): CanvasTextRenderProfile {
  return createCanvasTextRenderProfile(canvasTextRenderProfileDefinition(appearance));
}

function managedWoff2Face(
  url: string,
  sha256: string,
  weight: number
): CanvasTextFontFaceDefinition {
  return {
    source: canvasTextFontUrlSource(url),
    sha256: `sha256:${sha256}`,
    weight
  };
}

function fontResource(faces: readonly CanvasTextFontFaceDefinition[]): CanvasTextFontResource {
  return createCanvasTextFontResource(faces);
}

function fontResourceWithFallback(
  primary: CanvasTextFontResource,
  fallback: CanvasTextFontResource
): CanvasTextFontResource {
  const identity = JSON.stringify([primary.identity, fallback.identity]);
  return {
    identity,
    fontFamily: `${primary.fontFamily}, ${fallback.fontFamily}`,
    async prepare(document) {
      const [primaryFont, fallbackFont] = await Promise.all([
        primary.prepare(document),
        fallback.prepare(document)
      ]);
      return { identity, faces: [...primaryFont.faces, ...fallbackFont.faces] };
    }
  };
}
