import type {
  CanvasTextPreviewRasterCommand,
  CanvasTextPreviewRasterText,
  CanvasTextPreviewRasterWorkerRequest,
  CanvasTextPreviewRasterWorkerResponse
} from './CanvasTextPreviewRasterWorkerProtocol.js';

const MAX_CANVAS_DIMENSION = 16_384;
const fontResources = new Map<
  string,
  NonNullable<CanvasTextPreviewRasterWorkerRequest['fontFaces']>
>();
const fontProfiles = new Map<string, ReadonlyMap<string, string>>();
let nextFontProfileId = 1;
const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<CanvasTextPreviewRasterWorkerRequest>) => void) | null;
  postMessage(message: CanvasTextPreviewRasterWorkerResponse): void;
  fonts: FontFaceSet;
};

workerScope.onmessage = (event) => {
  void rasterize(event.data).then((sourcePng) => {
    workerScope.postMessage({ id: event.data.id, ok: true, sourcePng });
  }, (error: unknown) => {
    workerScope.postMessage({
      id: event.data.id,
      ok: false,
      message: error instanceof Error && error.message.trim() !== ''
        ? error.message
        : 'Canvas text preview raster Worker failed.'
    });
  });
};

async function rasterize(request: CanvasTextPreviewRasterWorkerRequest): Promise<Blob> {
  assertRasterRequest(request);
  if (request.fontFaces !== undefined) {
    registerFontResource(request.fontResourceKey, request.fontFaces);
  }
  if (!fontResources.has(request.fontResourceKey)) {
    throw new Error('Canvas text preview raster Worker does not have the requested font.');
  }
  const pixelWidth = request.width * request.scale;
  const pixelHeight = request.height * request.scale;
  if (!Number.isInteger(pixelWidth)
    || !Number.isInteger(pixelHeight)
    || pixelWidth > MAX_CANVAS_DIMENSION
    || pixelHeight > MAX_CANVAS_DIMENSION) {
    throw new Error('Canvas text preview raster dimensions exceed the browser limit.');
  }

  const canvas = new OffscreenCanvas(pixelWidth, pixelHeight);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas text preview raster Worker could not create a 2D context.');
  }
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  context.scale(request.scale, request.scale);
  fill(context, request.scene.background, 0, 0, request.width, request.height);
  for (const command of request.scene.commands) {
    const fontFamilies = command.kind === 'text'
      ? await resolveFontProfile(request.fontResourceKey, command)
      : undefined;
    drawCommand(context, command, fontFamilies);
  }
  return canvas.convertToBlob({ type: 'image/png' });
}

function assertRasterRequest(request: CanvasTextPreviewRasterWorkerRequest): void {
  if (!Number.isInteger(request.id)
    || request.id <= 0
    || !request.scene
    || typeof request.scene.background !== 'string'
    || request.scene.background.trim() === ''
    || !Array.isArray(request.scene.commands)
    || request.fontResourceKey.trim() === ''
    || !Number.isFinite(request.width)
    || request.width <= 0
    || !Number.isFinite(request.height)
    || request.height <= 0
    || !Number.isInteger(request.scale)
    || request.scale <= 0) {
    throw new Error('Canvas text preview raster Worker received an invalid request.');
  }
  for (const command of request.scene.commands) {
    assertRasterCommand(command);
  }
}

function assertRasterCommand(command: CanvasTextPreviewRasterCommand): void {
  if (!command
    || (command.kind !== 'rect' && command.kind !== 'text')
    || ![command.x, command.y, command.width, command.height].every(Number.isFinite)
    || command.width < 0
    || command.height < 0) {
    throw new Error('Canvas text preview raster Worker received an invalid scene command.');
  }
  if (command.kind === 'rect') {
    if (typeof command.fill !== 'string'
      || command.fill.trim() === ''
      || typeof command.stroke !== 'string'
      || command.stroke.trim() === ''
      || !Number.isFinite(command.strokeWidth)
      || command.strokeWidth < 0) {
      throw new Error('Canvas text preview raster Worker received an invalid rectangle command.');
    }
    return;
  }
  if (!Number.isFinite(command.textX)
    || !['left', 'center', 'right'].includes(command.textAlign)
    || typeof command.text !== 'string'
    || command.text.length === 0
    || command.text.includes('\t')
    || [
      command.color,
      command.background,
      command.fontFamily,
      command.fontSize,
      command.fontWeight,
      command.fontVariantLigatures,
      command.fontVariantNumeric,
      command.letterSpacing,
      command.wordSpacing,
      command.textDecorationLine,
      command.textDecorationColor,
      command.textDecorationStyle
    ].some((value) => typeof value !== 'string' || value.trim() === '')) {
    throw new Error('Canvas text preview raster Worker received an incomplete text command.');
  }
}

function registerFontResource(
  fontResourceKey: string,
  faces: NonNullable<CanvasTextPreviewRasterWorkerRequest['fontFaces']>
): void {
  if (fontResources.has(fontResourceKey)) {
    return;
  }
  if (faces.length === 0) {
    throw new Error('Canvas text preview raster Worker received no font faces.');
  }
  if (faces.some((face) => face.family.trim() === '' || face.bytes.byteLength === 0)) {
    throw new Error('Canvas text preview raster Worker received an invalid font face.');
  }
  fontResources.set(fontResourceKey, faces);
}

async function resolveFontProfile(
  fontResourceKey: string,
  command: CanvasTextPreviewRasterText
): Promise<ReadonlyMap<string, string>> {
  const featureSettings = canvasTextFeatureSettings(command);
  const profileKey = JSON.stringify([
    fontResourceKey,
    featureSettings
  ]);
  const current = fontProfiles.get(profileKey);
  if (current) {
    return current;
  }
  const faces = fontResources.get(fontResourceKey);
  if (!faces) {
    throw new Error('Canvas text preview raster Worker does not have the requested font resource.');
  }
  const profileId = nextFontProfileId++;
  const familyMap = new Map<string, string>();
  for (const face of faces) {
    if (!familyMap.has(face.family)) {
      familyMap.set(face.family, `${face.family}__worker_${profileId}`);
    }
  }
  const loadedFaces = await Promise.all(faces.map((face) => new FontFace(
    familyMap.get(face.family)!,
    face.bytes,
    {
      ...face.descriptors,
      ...(featureSettings === 'normal' ? {} : { featureSettings })
    }
  ).load()));
  for (const face of loadedFaces) {
    workerScope.fonts.add(face);
  }
  fontProfiles.set(profileKey, familyMap);
  return familyMap;
}

function drawCommand(
  context: OffscreenCanvasRenderingContext2D,
  command: CanvasTextPreviewRasterCommand,
  fontFamilies: ReadonlyMap<string, string> | undefined
): void {
  if (command.kind === 'rect') {
    fill(context, command.fill, command.x, command.y, command.width, command.height);
    if (command.stroke !== 'none' && command.strokeWidth > 0) {
      context.strokeStyle = command.stroke;
      context.lineWidth = command.strokeWidth;
      const inset = command.strokeWidth / 2;
      context.strokeRect(
        command.x + inset,
        command.y + inset,
        Math.max(0, command.width - command.strokeWidth),
        Math.max(0, command.height - command.strokeWidth)
      );
    }
    return;
  }
  if (!fontFamilies) {
    throw new Error('Canvas text preview raster Worker did not resolve the text font profile.');
  }
  drawText(context, command, fontFamilies);
}

function drawText(
  context: OffscreenCanvasRenderingContext2D,
  command: CanvasTextPreviewRasterText,
  fontFamilies: ReadonlyMap<string, string>
): void {
  context.save();
  context.beginPath();
  context.rect(command.x, command.y, command.width, command.height);
  context.clip();
  fill(context, command.background, command.x, command.y, command.width, command.height);
  context.fillStyle = command.color;
  context.font = [
    'normal',
    command.fontWeight,
    command.fontSize,
    workerFontFamily(command.fontFamily, fontFamilies)
  ].join(' ');
  context.textAlign = command.textAlign === 'left' ? 'start' : command.textAlign;
  context.textBaseline = 'alphabetic';
  setRequiredTextContextProperty(context, 'fontKerning', 'normal');
  setRequiredTextContextProperty(context, 'letterSpacing', command.letterSpacing);
  setRequiredTextContextProperty(context, 'wordSpacing', command.wordSpacing);
  if (command.text.includes('\t')) {
    throw new Error('Canvas text preview raster scene contains an unresolved tab.');
  }
  const text = command.text;
  const metrics = context.measureText(text);
  const ascent = metrics.actualBoundingBoxAscent;
  const descent = metrics.actualBoundingBoxDescent;
  const baseline = command.y + Math.max(0, (command.height - ascent - descent) / 2) + ascent;
  const x = command.x + command.textX;
  context.fillText(text, x, baseline);
  drawTextDecoration(context, command, metrics.width, x, baseline, ascent, descent);
  context.restore();
}

function workerFontFamily(
  fontFamily: string,
  familyMap: ReadonlyMap<string, string>
): string {
  const sourceFamilies = fontFamily.split(',').map((value) => {
    const trimmed = value.trim();
    const quoted = trimmed.match(/^(["'])(.*)\1$/u);
    return quoted?.[2] ?? trimmed;
  });
  if (sourceFamilies.length === 0 || sourceFamilies.some((family) => family === '')) {
    throw new Error('Canvas text preview raster scene is missing its managed font family.');
  }
  return sourceFamilies.map((source) => {
    const target = familyMap.get(source);
    if (!target) {
      throw new Error(`Canvas text preview raster scene contains an unmanaged font: ${source}.`);
    }
    return `"${target}"`;
  }).join(', ');
}

function canvasTextFeatureSettings(command: CanvasTextPreviewRasterText): string {
  const settings = new Map<string, string>();
  const ligatures = new Set(command.fontVariantLigatures.split(/\s+/u));
  setVariantFeature(settings, 'liga', ligatures, 'common-ligatures', 'no-common-ligatures');
  setVariantFeature(settings, 'clig', ligatures, 'common-ligatures', 'no-common-ligatures');
  setVariantFeature(
    settings,
    'dlig',
    ligatures,
    'discretionary-ligatures',
    'no-discretionary-ligatures'
  );
  setVariantFeature(
    settings,
    'hlig',
    ligatures,
    'historical-ligatures',
    'no-historical-ligatures'
  );
  setVariantFeature(settings, 'calt', ligatures, 'contextual', 'no-contextual');

  const numeric = new Set(command.fontVariantNumeric.split(/\s+/u));
  setVariantFeature(settings, 'tnum', numeric, 'tabular-nums', 'proportional-nums');
  setVariantFeature(settings, 'pnum', numeric, 'proportional-nums', 'tabular-nums');
  setVariantFeature(settings, 'lnum', numeric, 'lining-nums', 'oldstyle-nums');
  setVariantFeature(settings, 'onum', numeric, 'oldstyle-nums', 'lining-nums');
  setVariantFeature(settings, 'zero', numeric, 'slashed-zero', 'normal');

  return settings.size === 0
    ? 'normal'
    : [...settings].map(([tag, value]) => `"${tag}" ${value}`).join(', ');
}

function setVariantFeature(
  settings: Map<string, string>,
  tag: string,
  values: ReadonlySet<string>,
  enabledValue: string,
  disabledValue: string
): void {
  if (values.has(enabledValue)) {
    settings.set(tag, '1');
  } else if (values.has(disabledValue)) {
    settings.set(tag, '0');
  }
}

function drawTextDecoration(
  context: OffscreenCanvasRenderingContext2D,
  command: CanvasTextPreviewRasterText,
  textWidth: number,
  anchorX: number,
  baseline: number,
  ascent: number,
  descent: number
): void {
  const lines = new Set(command.textDecorationLine.split(/\s+/u));
  if (!lines.has('underline') && !lines.has('line-through')) {
    return;
  }
  const startX = command.textAlign === 'right'
    ? anchorX - textWidth
    : command.textAlign === 'center'
      ? anchorX - textWidth / 2
      : anchorX;
  context.strokeStyle = command.textDecorationColor;
  context.lineWidth = Math.max(1, Number.parseFloat(command.fontSize) / 16);
  context.setLineDash(command.textDecorationStyle === 'dashed'
    ? [3, 2]
    : command.textDecorationStyle === 'dotted'
      ? [1, 2]
      : []);
  for (const y of [
    ...(lines.has('underline') ? [baseline + Math.max(1, descent / 2)] : []),
    ...(lines.has('line-through') ? [baseline - ascent * 0.35] : [])
  ]) {
    context.beginPath();
    context.moveTo(startX, y);
    context.lineTo(startX + textWidth, y);
    context.stroke();
  }
}

function setRequiredTextContextProperty(
  context: OffscreenCanvasRenderingContext2D,
  property: string,
  value: string
): void {
  if (!(property in context)) {
    throw new Error(`Canvas text preview raster Worker requires 2D context.${property}.`);
  }
  (context as unknown as Record<string, string>)[property] = value;
}

function fill(
  context: OffscreenCanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  if (color === 'transparent' || color === 'rgba(0, 0, 0, 0)') {
    return;
  }
  context.fillStyle = color;
  context.fillRect(x, y, width, height);
}
