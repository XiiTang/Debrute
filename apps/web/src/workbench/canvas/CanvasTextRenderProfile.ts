const CANVAS_TEXT_FULL_FONT_ALIAS_PREFIX = '__debrute_canvas_text_full_';
const CANVAS_TEXT_PREVIEW_FONT_ALIAS_PREFIX = '__debrute_canvas_text_preview_';

const CANVAS_TEXT_EDITOR_GEOMETRY = {
  linePaddingInlinePx: 8,
  gutterPaddingLeftPx: 5,
  gutterPaddingRightPx: 3
} as const;

export type CanvasTextFontDigest = `sha256:${string}`;

export interface CanvasTextFontSource {
  readonly url?: string | undefined;
  read(signal?: AbortSignal): Promise<ArrayBuffer>;
}

export interface CanvasTextFontFaceDefinition {
  readonly source: CanvasTextFontSource;
  readonly sha256: CanvasTextFontDigest;
  readonly weight: number;
}

export interface CanvasTextFontFace {
  readonly source: CanvasTextFontSource;
  readonly digest: CanvasTextFontDigest;
  readonly weight: string;
}

export interface CanvasTextFontFamily {
  readonly identity: string;
  readonly interactiveAlias: string;
  readonly previewAlias: string;
  readonly faces: readonly CanvasTextFontFace[];
}

export interface CanvasTextFontResource {
  readonly identity: string;
  readonly interactiveFontFamily: string;
  readonly previewFontFamily: string;
  readonly families: readonly CanvasTextFontFamily[];
}

export interface CanvasTextPreparedFont {
  readonly resourceIdentity: string;
  readonly embeddedFaces: readonly CanvasTextEmbeddedFontFace[];
}

export interface CanvasTextEmbeddedFontFace {
  readonly family: string;
  readonly weight: string;
  readonly css: string;
}

export interface CanvasTextRenderProfileDefinition {
  readonly font: CanvasTextFontResource;
  readonly fontSizePx: number;
  readonly lineHeightRatio: number;
  readonly fontWeight: number;
  readonly letterSpacingPx: number;
  readonly ligatures: boolean;
}

interface CanvasTextEditorGeometry {
  readonly linePaddingInlinePx: number;
  readonly gutterPaddingLeftPx: number;
  readonly gutterPaddingRightPx: number;
}

const CANVAS_TEXT_TYPOGRAPHY_BINDINGS = [
  ['fontSize', 'font-size'],
  ['lineHeight', 'line-height'],
  ['fontWeight', 'font-weight'],
  ['fontStyle', 'font-style'],
  ['fontStretch', 'font-stretch'],
  ['letterSpacing', 'letter-spacing'],
  ['wordSpacing', 'word-spacing'],
  ['tabSize', 'tab-size'],
  ['fontKerning', 'font-kerning'],
  ['fontVariantLigatures', 'font-variant-ligatures'],
  ['fontFeatureSettings', 'font-feature-settings'],
  ['fontVariationSettings', 'font-variation-settings'],
  ['fontOpticalSizing', 'font-optical-sizing'],
  ['fontSynthesis', 'font-synthesis']
] as const;

type CanvasTextResolvedTypographyKey = typeof CANVAS_TEXT_TYPOGRAPHY_BINDINGS[number][0];
type CanvasTextResolvedTypography = Readonly<Record<CanvasTextResolvedTypographyKey, string>>;

const CANVAS_TEXT_GEOMETRY_BINDINGS = [
  ['linePaddingInlinePx', 'line-padding-inline'],
  ['gutterPaddingLeftPx', 'gutter-padding-left'],
  ['gutterPaddingRightPx', 'gutter-padding-right']
] as const satisfies ReadonlyArray<readonly [keyof CanvasTextEditorGeometry, string]>;

type CanvasTextRenderProfileCssVariable =
  | '--canvas-text-editor-font-family'
  | `--canvas-text-editor-${typeof CANVAS_TEXT_TYPOGRAPHY_BINDINGS[number][1]}`
  | `--canvas-text-editor-${typeof CANVAS_TEXT_GEOMETRY_BINDINGS[number][1]}`;

export type CanvasTextEditorStyle = Readonly<Record<CanvasTextRenderProfileCssVariable, string>>;

export interface CanvasTextRenderProfile {
  readonly identity: string;
  readonly font: CanvasTextFontResource;
  readonly resolvedTypography: CanvasTextResolvedTypography;
  readonly editorGeometry: CanvasTextEditorGeometry;
  readonly editorStyle: CanvasTextEditorStyle;
  readonly previewEditorStyle: CanvasTextEditorStyle;
}

export function canvasTextFontUrlSource(url: string): CanvasTextFontSource {
  return {
    url,
    async read(signal) {
      const response = await fetch(url, signal ? { signal } : undefined);
      if (!response.ok) {
        throw new Error(`Canvas text font asset request failed (${response.status}): ${url}.`);
      }
      return response.arrayBuffer();
    }
  };
}

export function createCanvasTextFontResource(
  faces: readonly CanvasTextFontFaceDefinition[]
): CanvasTextFontResource {
  if (faces.length === 0) {
    throw new Error('Canvas text font resource requires at least one face.');
  }
  const resolvedFaces = faces.map((face): CanvasTextFontFace => ({
    source: face.source,
    digest: face.sha256,
    weight: String(face.weight)
  }));
  const identity = JSON.stringify(resolvedFaces.map(({ digest, weight }) => ({ digest, weight })));
  const encodedIdentity = encodeURIComponent(identity);
  return canvasTextFontResourceFromFamilies([{
    identity,
    interactiveAlias: `${CANVAS_TEXT_FULL_FONT_ALIAS_PREFIX}${encodedIdentity}`,
    previewAlias: `${CANVAS_TEXT_PREVIEW_FONT_ALIAS_PREFIX}${encodedIdentity}`,
    faces: resolvedFaces
  }]);
}

export function combineCanvasTextFontResources(
  resources: readonly CanvasTextFontResource[]
): CanvasTextFontResource {
  const families = resources.flatMap((resource) => resource.families);
  if (families.length === 0) {
    throw new Error('Canvas text font resource combination requires at least one family.');
  }
  return canvasTextFontResourceFromFamilies(families);
}

function canvasTextFontResourceFromFamilies(
  families: readonly CanvasTextFontFamily[]
): CanvasTextFontResource {
  return {
    identity: JSON.stringify(families.map((family) => family.identity)),
    interactiveFontFamily: families.map((family) => `"${family.interactiveAlias}"`).join(', '),
    previewFontFamily: families.map((family) => `"${family.previewAlias}"`).join(', '),
    families
  };
}

export function createCanvasTextRenderProfile(
  definition: CanvasTextRenderProfileDefinition
): CanvasTextRenderProfile {
  const resolvedTypography: CanvasTextResolvedTypography = {
    fontSize: `${cssNumber(definition.fontSizePx)}px`,
    lineHeight: `${cssNumber(definition.fontSizePx * definition.lineHeightRatio)}px`,
    fontWeight: String(definition.fontWeight),
    fontStyle: 'normal',
    fontStretch: '100%',
    letterSpacing: `${cssNumber(definition.letterSpacingPx)}px`,
    wordSpacing: '0px',
    tabSize: '4',
    fontKerning: 'normal',
    fontVariantLigatures: definition.ligatures
      ? 'common-ligatures no-discretionary-ligatures no-historical-ligatures contextual'
      : 'no-common-ligatures no-discretionary-ligatures no-historical-ligatures no-contextual',
    fontFeatureSettings: 'normal',
    fontVariationSettings: 'normal',
    fontOpticalSizing: 'auto',
    fontSynthesis: 'none'
  };
  const editorGeometry = CANVAS_TEXT_EDITOR_GEOMETRY;
  const sharedStyle = Object.fromEntries([
    ...CANVAS_TEXT_TYPOGRAPHY_BINDINGS.map(([key, cssProperty]) => [
      `--canvas-text-editor-${cssProperty}`,
      resolvedTypography[key]
    ]),
    ...CANVAS_TEXT_GEOMETRY_BINDINGS.map(([key, cssProperty]) => [
      `--canvas-text-editor-${cssProperty}`,
      `${editorGeometry[key]}px`
    ])
  ]);
  const editorStyle = {
    '--canvas-text-editor-font-family': definition.font.interactiveFontFamily,
    ...sharedStyle
  } as CanvasTextEditorStyle;
  const previewEditorStyle = {
    '--canvas-text-editor-font-family': definition.font.previewFontFamily,
    ...sharedStyle
  } as CanvasTextEditorStyle;
  return {
    identity: JSON.stringify({
      font: definition.font.identity,
      typography: resolvedTypography,
      editorGeometry
    }),
    font: definition.font,
    resolvedTypography,
    editorGeometry,
    editorStyle,
    previewEditorStyle
  };
}

export async function readVerifiedCanvasTextFontFace(
  face: CanvasTextFontFace,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const bytes = await face.source.read(signal);
  const digest = await canvasTextFontSha256(bytes);
  if (digest !== face.digest) {
    throw new Error(
      `Canvas text font digest mismatch: expected ${face.digest}, received ${digest}.`
    );
  }
  return bytes;
}

export function canvasTextFontFaceDescriptors(
  face: Pick<CanvasTextFontFace, 'weight'>
): FontFaceDescriptors {
  return {
    weight: face.weight,
    style: 'normal',
    stretch: '100%'
  };
}

export async function canvasTextFontDataUrl(bytes: ArrayBuffer): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('Canvas text font data URL encoding returned a non-string result.'));
        }
      }, { once: true });
      reader.addEventListener('error', () => {
        reject(reader.error ?? new Error('Canvas text font data URL encoding failed.'));
      }, { once: true });
      reader.readAsDataURL(new Blob([bytes], { type: 'font/woff2' }));
    });
  }
  const source = new Uint8Array(bytes);
  let binary = '';
  for (let offset = 0; offset < source.length; offset += 32_768) {
    binary += String.fromCharCode(...source.subarray(offset, offset + 32_768));
  }
  return `data:font/woff2;base64,${btoa(binary)}`;
}

async function canvasTextFontSha256(bytes: ArrayBuffer): Promise<CanvasTextFontDigest> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function cssNumber(value: number): number {
  return Number(value.toFixed(4));
}
