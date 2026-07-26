const CANVAS_TEXT_FONT_ALIAS_PREFIX = '__debrute_canvas_text_';

const CANVAS_TEXT_EDITOR_GEOMETRY = {
  linePaddingInlinePx: 8,
  gutterPaddingLeftPx: 5,
  gutterPaddingRightPx: 3
} as const;

type CanvasTextFontDigest = `sha256:${string}`;

interface CanvasTextFontSource {
  read(): Promise<ArrayBuffer>;
}

export interface CanvasTextFontFaceDefinition {
  readonly source: CanvasTextFontSource;
  readonly sha256: CanvasTextFontDigest;
  readonly weight: number;
}

export interface CanvasTextFontResource {
  readonly identity: string;
  readonly fontFamily: string;
  prepare(document: Document): Promise<CanvasTextPreparedFont>;
}

export interface CanvasTextPreparedFontFace {
  readonly family: string;
  readonly bytes: ArrayBuffer;
  readonly descriptors: FontFaceDescriptors;
}

interface CanvasTextPreparedFont {
  readonly identity: string;
  readonly faces: readonly CanvasTextPreparedFontFace[];
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

export interface CanvasTextRenderProfile {
  readonly identity: string;
  readonly resolvedTypography: CanvasTextResolvedTypography;
  readonly editorGeometry: CanvasTextEditorGeometry;
  readonly editorStyle: Readonly<Record<CanvasTextRenderProfileCssVariable, string>>;
  prepare(document: Document): Promise<CanvasTextPreparedFont>;
}

interface ResolvedCanvasTextFontFace {
  readonly source: CanvasTextFontSource;
  readonly digest: CanvasTextFontDigest;
  readonly weight: string;
}

interface ResolvedCanvasTextFontFamily {
  readonly alias: string;
  readonly faces: readonly ResolvedCanvasTextFontFace[];
}

export function canvasTextFontUrlSource(url: string): CanvasTextFontSource {
  return {
    async read() {
      const response = await fetch(url);
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
  const resolvedFaces = faces.map((face): ResolvedCanvasTextFontFace => ({
    source: face.source,
    digest: face.sha256,
    weight: String(face.weight)
  }));
  const faceIdentity = resolvedFaces.map(({ digest, weight }) => ({ digest, weight }));
  const identity = JSON.stringify(faceIdentity);
  const families: readonly ResolvedCanvasTextFontFamily[] = [{
    alias: `${CANVAS_TEXT_FONT_ALIAS_PREFIX}0_${encodeURIComponent(identity)}`,
    faces: resolvedFaces
  }];
  const preparedDocuments = new WeakMap<Document, Promise<CanvasTextPreparedFont>>();
  return {
    identity,
    fontFamily: families.map((family) => `"${family.alias}"`).join(', '),
    prepare(document) {
      const current = preparedDocuments.get(document);
      if (current) {
        return current;
      }
      const pending = prepareCanvasTextFont(document, identity, families);
      preparedDocuments.set(document, pending);
      return pending;
    }
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
  const editorStyle = Object.fromEntries([
    ['--canvas-text-editor-font-family', definition.font.fontFamily],
    ...CANVAS_TEXT_TYPOGRAPHY_BINDINGS.map(([key, cssProperty]) => [
      `--canvas-text-editor-${cssProperty}`,
      resolvedTypography[key]
    ]),
    ...CANVAS_TEXT_GEOMETRY_BINDINGS.map(([key, cssProperty]) => [
      `--canvas-text-editor-${cssProperty}`,
      `${editorGeometry[key]}px`
    ])
  ]) as Record<CanvasTextRenderProfileCssVariable, string>;
  return {
    identity: JSON.stringify({
      font: definition.font.identity,
      typography: resolvedTypography,
      editorGeometry
    }),
    resolvedTypography,
    editorGeometry,
    editorStyle,
    prepare: (document: Document) => definition.font.prepare(document)
  };
}

async function prepareCanvasTextFont(
  document: Document,
  identity: string,
  families: readonly ResolvedCanvasTextFontFamily[]
): Promise<CanvasTextPreparedFont> {
  const bytesByDigest = new Map<CanvasTextFontDigest, Promise<ArrayBuffer>>();
  const load = (face: ResolvedCanvasTextFontFace): Promise<ArrayBuffer> => {
    const current = bytesByDigest.get(face.digest);
    if (current) {
      return current;
    }
    const pending = face.source.read().then(async (bytes) => {
      const digest = await sha256(bytes);
      if (digest !== face.digest) {
        throw new Error(
          `Canvas text font digest mismatch: expected ${face.digest}, received ${digest}.`
        );
      }
      return bytes;
    });
    bytesByDigest.set(face.digest, pending);
    return pending;
  };
  const preparedFaces: CanvasTextPreparedFontFace[] = [];
  for (const family of families) {
    for (const face of family.faces) {
      const bytes = await load(face);
      const descriptors = fontFaceDescriptors(face);
      const loaded = await new FontFace(family.alias, bytes, descriptors).load();
      document.fonts.add(loaded);
      preparedFaces.push({ family: family.alias, bytes, descriptors });
    }
  }
  return { identity, faces: preparedFaces };
}

function fontFaceDescriptors(face: ResolvedCanvasTextFontFace): FontFaceDescriptors {
  return {
    weight: face.weight,
    style: 'normal',
    stretch: '100%'
  };
}

async function sha256(bytes: ArrayBuffer): Promise<CanvasTextFontDigest> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function cssNumber(value: number): number {
  return Number(value.toFixed(4));
}
