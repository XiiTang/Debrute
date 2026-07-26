const CANVAS_TEXT_FONT_ALIAS_PREFIX = '__debrute_canvas_text_';

export type CanvasTextFontFormat = 'woff2' | 'woff' | 'truetype' | 'opentype';
export type CanvasTextFontDigest = `sha256:${string}`;
export type CanvasTextFontStyle = 'normal' | 'italic' | 'oblique' | `oblique ${number}deg`;

export interface CanvasTextFontSource {
  read(): Promise<ArrayBuffer>;
}

export interface CanvasTextFontAssetDefinition {
  readonly source: CanvasTextFontSource;
  readonly sha256: CanvasTextFontDigest;
  readonly format: CanvasTextFontFormat;
}

export interface CanvasTextFontFaceDefinition {
  readonly asset: CanvasTextFontAssetDefinition;
  readonly weight: number | readonly [number, number];
  readonly style: CanvasTextFontStyle;
  readonly stretchPercent: number | readonly [number, number];
  readonly unicodeRange?: string | undefined;
}

export interface CanvasTextFontFamilyDefinition {
  readonly faces: readonly CanvasTextFontFaceDefinition[];
}

export interface CanvasTextFontResourceDefinition {
  readonly families: readonly CanvasTextFontFamilyDefinition[];
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

export interface CanvasTextPreparedFont {
  readonly identity: string;
  readonly faces: readonly CanvasTextPreparedFontFace[];
}

export interface CanvasTextLigaturePreferences {
  readonly common: boolean;
  readonly discretionary: boolean;
  readonly historical: boolean;
  readonly contextual: boolean;
}

export interface CanvasTextFontSynthesisPreferences {
  readonly weight: boolean;
  readonly style: boolean;
  readonly smallCaps: boolean;
}

export type CanvasTextLineHeight =
  | { readonly kind: 'pixels'; readonly value: number }
  | { readonly kind: 'ratio'; readonly value: number };

export interface CanvasTextTypographyPreferences {
  readonly fontSizePx: number;
  readonly lineHeight: CanvasTextLineHeight;
  readonly fontWeight: number;
  readonly fontStyle: CanvasTextFontStyle;
  readonly fontStretchPercent: number;
  readonly letterSpacingPx: number;
  readonly wordSpacingPx: number;
  readonly tabSize: number;
  readonly kerning: 'auto' | 'normal' | 'none';
  readonly ligatures: CanvasTextLigaturePreferences;
  readonly features: Readonly<Record<string, number>>;
  readonly variations: Readonly<Record<string, number>>;
  readonly opticalSizing: 'auto' | 'none';
  readonly synthesis: CanvasTextFontSynthesisPreferences;
}

export interface CanvasTextEditorGeometry {
  readonly linePaddingInlinePx: number;
  readonly gutterPaddingLeftPx: number;
  readonly gutterPaddingRightPx: number;
}

export interface CanvasTextRenderProfileDefinition {
  readonly font: CanvasTextFontResource;
  readonly typography: CanvasTextTypographyPreferences;
  readonly editorGeometry: CanvasTextEditorGeometry;
}

type CanvasTextTypographyBinding = readonly [
  key: string,
  cssProperty: string,
  resolve: (preferences: CanvasTextTypographyPreferences) => string
];

const CANVAS_TEXT_TYPOGRAPHY_BINDINGS = [
  ['fontSize', 'font-size', (preferences) => `${cssNumber(preferences.fontSizePx)}px`],
  ['lineHeight', 'line-height', (preferences) => `${cssNumber(preferences.lineHeight.kind === 'ratio'
      ? preferences.fontSizePx * preferences.lineHeight.value
      : preferences.lineHeight.value)}px`],
  ['fontWeight', 'font-weight', (preferences) => String(preferences.fontWeight)],
  ['fontStyle', 'font-style', (preferences) => preferences.fontStyle],
  ['fontStretch', 'font-stretch', (preferences) => `${cssNumber(preferences.fontStretchPercent)}%`],
  ['letterSpacing', 'letter-spacing', (preferences) => `${cssNumber(preferences.letterSpacingPx)}px`],
  ['wordSpacing', 'word-spacing', (preferences) => `${cssNumber(preferences.wordSpacingPx)}px`],
  ['tabSize', 'tab-size', (preferences) => String(preferences.tabSize)],
  ['fontKerning', 'font-kerning', (preferences) => preferences.kerning],
  ['fontVariantLigatures', 'font-variant-ligatures', (preferences) => (
    fontVariantLigatures(preferences.ligatures)
  )],
  ['fontFeatureSettings', 'font-feature-settings', (preferences) => fontSettings(preferences.features)],
  ['fontVariationSettings', 'font-variation-settings', (preferences) => fontSettings(preferences.variations)],
  ['fontOpticalSizing', 'font-optical-sizing', (preferences) => preferences.opticalSizing],
  ['fontSynthesis', 'font-synthesis', (preferences) => fontSynthesis(preferences.synthesis)]
] as const satisfies readonly CanvasTextTypographyBinding[];

type CanvasTextResolvedTypographyKey = typeof CANVAS_TEXT_TYPOGRAPHY_BINDINGS[number][0];

export type CanvasTextResolvedTypography = Readonly<Record<CanvasTextResolvedTypographyKey, string>>;

const CANVAS_TEXT_GEOMETRY_BINDINGS = [
  ['linePaddingInlinePx', 'line-padding-inline'],
  ['gutterPaddingLeftPx', 'gutter-padding-left'],
  ['gutterPaddingRightPx', 'gutter-padding-right']
] as const satisfies ReadonlyArray<readonly [keyof CanvasTextEditorGeometry, string]>;

export type CanvasTextRenderProfileCssVariable =
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

interface ResolvedCanvasTextFontFaceIdentity {
  readonly digest: CanvasTextFontDigest;
  readonly format: CanvasTextFontFormat;
  readonly weight: string;
  readonly style: CanvasTextFontStyle;
  readonly stretch: string;
  readonly unicodeRange: string | null;
}

interface ResolvedCanvasTextFontFace {
  readonly source: CanvasTextFontSource;
  readonly identity: ResolvedCanvasTextFontFaceIdentity;
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
  definition: CanvasTextFontResourceDefinition
): CanvasTextFontResource {
  const families = definition.families.map((family, familyIndex): ResolvedCanvasTextFontFamily => {
    const faces = family.faces.map((face): ResolvedCanvasTextFontFace => ({
      source: face.asset.source,
      identity: {
        digest: face.asset.sha256,
        format: face.asset.format,
        weight: fontFaceNumberOrRange(face.weight),
        style: face.style,
        stretch: fontFacePercentageOrRange(face.stretchPercent),
        unicodeRange: face.unicodeRange ?? null
      }
    }));
    const familyIdentity = JSON.stringify(faces.map((face) => face.identity));
    return {
      alias: `${CANVAS_TEXT_FONT_ALIAS_PREFIX}${familyIndex}_${encodeURIComponent(familyIdentity)}`,
      faces
    };
  });
  const identity = JSON.stringify(families.map((family) => family.faces.map((face) => face.identity)));
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
  const resolvedTypography = Object.fromEntries(CANVAS_TEXT_TYPOGRAPHY_BINDINGS.map(([key, , resolve]) => [
    key,
    resolve(definition.typography)
  ])) as Record<CanvasTextResolvedTypographyKey, string>;
  const editorGeometry = {
    linePaddingInlinePx: cssNumber(definition.editorGeometry.linePaddingInlinePx),
    gutterPaddingLeftPx: cssNumber(definition.editorGeometry.gutterPaddingLeftPx),
    gutterPaddingRightPx: cssNumber(definition.editorGeometry.gutterPaddingRightPx)
  };
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
    const current = bytesByDigest.get(face.identity.digest);
    if (current) {
      return current;
    }
    const pending = face.source.read().then(async (bytes) => {
      const digest = await sha256(bytes);
      if (digest !== face.identity.digest) {
        throw new Error(
          `Canvas text font digest mismatch: expected ${face.identity.digest}, received ${digest}.`
        );
      }
      return bytes;
    });
    bytesByDigest.set(face.identity.digest, pending);
    return pending;
  };
  const preparedFaces: CanvasTextPreparedFontFace[] = [];
  for (const family of families) {
    for (const face of family.faces) {
      const bytes = await load(face);
      const descriptors = fontFaceDescriptors(face.identity);
      const loaded = await new FontFace(family.alias, bytes, descriptors).load();
      document.fonts.add(loaded);
      preparedFaces.push({ family: family.alias, bytes, descriptors });
    }
  }
  return { identity, faces: preparedFaces };
}

function fontFaceDescriptors(
  face: ResolvedCanvasTextFontFaceIdentity
): FontFaceDescriptors {
  return {
    weight: face.weight,
    style: face.style,
    stretch: face.stretch,
    ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {})
  };
}

function fontFaceNumberOrRange(value: number | readonly [number, number]): string {
  return typeof value === 'number' ? String(value) : `${value[0]} ${value[1]}`;
}

function fontFacePercentageOrRange(value: number | readonly [number, number]): string {
  return typeof value === 'number' ? `${value}%` : `${value[0]}% ${value[1]}%`;
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

function fontSettings(settings: Readonly<Record<string, number>>): string {
  const entries = Object.entries(settings).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0
    ? 'normal'
    : entries.map(([tag, value]) => `"${tag}" ${value}`).join(', ');
}

function fontVariantLigatures(preferences: CanvasTextLigaturePreferences): string {
  return [
    preferences.common ? 'common-ligatures' : 'no-common-ligatures',
    preferences.discretionary ? 'discretionary-ligatures' : 'no-discretionary-ligatures',
    preferences.historical ? 'historical-ligatures' : 'no-historical-ligatures',
    preferences.contextual ? 'contextual' : 'no-contextual'
  ].join(' ');
}

function fontSynthesis(preferences: CanvasTextFontSynthesisPreferences): string {
  const values = [
    preferences.weight ? 'weight' : undefined,
    preferences.style ? 'style' : undefined,
    preferences.smallCaps ? 'small-caps' : undefined
  ].filter((value): value is string => value !== undefined);
  return values.length === 0 ? 'none' : values.join(' ');
}
