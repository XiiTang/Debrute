import type { ProjectTextLanguageId } from '@debrute/app-protocol';
import {
  canvasPreviewTargetKey,
  canvasPreviewTargetIdentityFromDigest,
  type CanvasPreviewTargetIdentity,
  type CanvasPreviewTargetKey
} from '@debrute/canvas-core';
import type { CanvasTextPreparedFont } from './CanvasTextRenderProfile.js';
import {
  canvasTextPreviewFailureFromUnknown,
  type CanvasTextPreviewFailureFields
} from './CanvasTextPreviewFailure.js';

const CANVAS_TEXT_PREVIEW_RENDER_POLICY_VERSION = 'canvas-text-preview-dom-v5';
const CANVAS_TEXT_SYSTEM_FALLBACK_POLICY_VERSION = 'canvas-text-system-fallback-v1';
const CANVAS_TEXT_CHROMIUM_RASTER_CONTRACT_VERSION = 'chromium-raster-v1';
const CANVAS_TEXT_PREVIEW_MAX_SOURCE_SCALE = 4;
const CANVAS_TEXT_PREVIEW_MAX_SOURCE_DIMENSION = 4096;
const CANVAS_TEXT_PREVIEW_MAX_SOURCE_PIXELS = 8 * 1024 * 1024;
const CANVAS_TEXT_PREVIEW_SNAPSHOT_SLICE_MS = 8;
const CANVAS_TEXT_PREVIEW_TEXT_CHUNK_CODE_UNITS = 16 * 1024;
const CANVAS_TEXT_PREVIEW_ALLOWED_TAGS = new Set(['BR', 'DIV', 'SPAN']);
const CANVAS_TEXT_PREVIEW_COMPUTED_STYLE_PROPERTIES = [
  '-webkit-font-smoothing',
  '-webkit-text-fill-color',
  '-webkit-text-size-adjust',
  'align-content',
  'align-items',
  'align-self',
  'backdrop-filter',
  'background-attachment',
  'background-blend-mode',
  'background-clip',
  'background-color',
  'background-image',
  'background-origin',
  'background-position',
  'background-repeat',
  'background-size',
  'border-bottom-color',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'border-bottom-style',
  'border-bottom-width',
  'border-left-color',
  'border-left-style',
  'border-left-width',
  'border-right-color',
  'border-right-style',
  'border-right-width',
  'border-top-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-top-style',
  'border-top-width',
  'bottom',
  'box-shadow',
  'box-sizing',
  'clip-path',
  'color',
  'contain',
  'content-visibility',
  'direction',
  'display',
  'filter',
  'flex-basis',
  'flex-direction',
  'flex-grow',
  'flex-shrink',
  'flex-wrap',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-optical-sizing',
  'font-size',
  'font-stretch',
  'font-style',
  'font-synthesis',
  'font-variant-ligatures',
  'font-variation-settings',
  'font-weight',
  'forced-color-adjust',
  'grid-auto-columns',
  'grid-auto-flow',
  'grid-auto-rows',
  'grid-column-end',
  'grid-column-start',
  'grid-row-end',
  'grid-row-start',
  'grid-template-columns',
  'grid-template-rows',
  'height',
  'isolation',
  'justify-content',
  'justify-items',
  'justify-self',
  'left',
  'letter-spacing',
  'line-height',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'mix-blend-mode',
  'opacity',
  'order',
  'outline-color',
  'outline-offset',
  'outline-style',
  'outline-width',
  'overflow-wrap',
  'overflow-x',
  'overflow-y',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'position',
  'right',
  'tab-size',
  'text-align',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-thickness',
  'text-indent',
  'text-rendering',
  'text-shadow',
  'text-transform',
  'top',
  'transform',
  'transform-origin',
  'unicode-bidi',
  'vertical-align',
  'visibility',
  'white-space',
  'width',
  'word-break',
  'word-spacing',
  'writing-mode',
  'z-index'
] as const;
const CANVAS_TEXT_PREVIEW_REMOVED_SELECTORS = [
  '.cm-cursorLayer',
  '.cm-selectionLayer',
  '.cm-widgetBuffer',
  '.cm-tooltip',
  '.cm-panels',
  '.cm-announced'
] as const;

export interface CanvasTextPreviewSourceSize {
  sourcePixelWidth: number;
  sourcePixelHeight: number;
  sourceScale: number;
}

export interface CanvasTextPreviewCandidate extends CanvasTextPreviewSourceSize {
  projectId: string;
  canvasId: string;
  projectRelativePath: string;
  contentDigest: string;
  estimatedBytes: number;
  language: ProjectTextLanguageId;
  wordWrap: boolean;
  contentCssWidth: number;
  contentCssHeight: number;
  scrollTop: number;
  scrollLeft: number;
  styleKey: string;
}

export interface CanvasTextPreviewTarget extends CanvasTextPreviewCandidate {
  targetIdentity: CanvasPreviewTargetIdentity;
}

export interface CanvasTextPreviewCaptureTarget extends CanvasTextPreviewTarget {
  content: string;
}

export function canvasTextPreviewTargetKey(target: CanvasTextPreviewTarget): CanvasPreviewTargetKey {
  return canvasPreviewTargetKey({
    mediaKind: 'text',
    projectId: target.projectId,
    canvasId: target.canvasId,
    projectRelativePath: target.projectRelativePath,
    targetIdentity: target.targetIdentity
  });
}

export interface CanvasTextPreviewCaptureResult {
  sourcePng: Blob;
  cssWidth: number;
  cssHeight: number;
  sourcePixelWidth: number;
  sourcePixelHeight: number;
  snapshotDurationMs: number;
  rasterDurationMs: number;
  captureDurationMs: number;
  snapshotBytes: number;
  snapshotElementCount: number;
  maxSynchronousSliceMs: number;
}

interface CanvasTextPreviewDomSnapshot {
  xhtmlParts: readonly string[];
  byteLength: number;
  elementCount: number;
  durationMs: number;
  maxSynchronousSliceMs: number;
  fontWeights: readonly string[];
  fontFamilies: readonly string[];
}

export interface CanvasTextRasterEnvironmentIdentity {
  readonly platform: string;
  readonly frontend: 'desktop' | 'browser';
  readonly engine: 'chromium';
  readonly engineContractVersion: string;
  readonly systemFallbackPolicyVersion: string;
}

export function canvasTextPreviewSourceSize(input: {
  contentCssWidth: number;
  contentCssHeight: number;
}): CanvasTextPreviewSourceSize {
  const { contentCssWidth, contentCssHeight } = input;
  if (!Number.isInteger(contentCssWidth)
    || contentCssWidth <= 0
    || !Number.isInteger(contentCssHeight)
    || contentCssHeight <= 0) {
    throw new Error('Canvas text preview CSS dimensions must be positive integers.');
  }
  const sourceScale = Math.min(
    CANVAS_TEXT_PREVIEW_MAX_SOURCE_SCALE,
    CANVAS_TEXT_PREVIEW_MAX_SOURCE_DIMENSION / contentCssWidth,
    CANVAS_TEXT_PREVIEW_MAX_SOURCE_DIMENSION / contentCssHeight,
    Math.sqrt(CANVAS_TEXT_PREVIEW_MAX_SOURCE_PIXELS / (contentCssWidth * contentCssHeight))
  );
  return {
    sourcePixelWidth: Math.max(1, Math.floor(contentCssWidth * sourceScale)),
    sourcePixelHeight: Math.max(1, Math.floor(contentCssHeight * sourceScale)),
    sourceScale
  };
}

export async function captureCanvasTextPreviewSource(input: {
  captureRoot: HTMLElement;
  target: CanvasTextPreviewCaptureTarget;
  fields: CanvasTextPreviewFailureFields;
  preparedFont: CanvasTextPreparedFont;
  signal?: AbortSignal | undefined;
  isInteractionActive: () => boolean;
}): Promise<CanvasTextPreviewCaptureResult> {
  await nextEligibleCaptureFrame(input.signal, input.isInteractionActive);
  const captureStartedAt = performance.now();
  throwIfCaptureAborted(input.signal);
  assertCaptureRootReady(input.captureRoot, input.target, input.fields);

  let snapshot: CanvasTextPreviewDomSnapshot;
  try {
    snapshot = await snapshotCanvasTextPreviewDom({
      captureRoot: input.captureRoot,
      target: input.target,
      signal: input.signal,
      isInteractionActive: input.isInteractionActive
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw canvasTextPreviewFailureFromUnknown('dom_snapshot_failed', {
      ...input.fields,
      cssWidth: input.target.contentCssWidth,
      cssHeight: input.target.contentCssHeight,
      durationMs: performance.now() - captureStartedAt
    }, error);
  }

  const rasterStartedAt = performance.now();
  try {
    const canvas = new OffscreenCanvas(input.target.sourcePixelWidth, input.target.sourcePixelHeight);
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) {
      throw new Error('Canvas text preview DOM raster could not create a 2D context.');
    }
    await nextEligibleCaptureFrame(input.signal, input.isInteractionActive);
    const image = new Image();
    image.decoding = 'async';
    const imageUrl = await canvasTextPreviewSvgDataUrl(
      snapshot.xhtmlParts,
      embeddedFontCssForSnapshot(input.preparedFont, snapshot),
      input.target
    );
    image.src = imageUrl;
    try {
      await image.decode();
      throwIfCaptureAborted(input.signal);
      context.drawImage(
        image,
        0,
        0,
        input.target.sourcePixelWidth,
        input.target.sourcePixelHeight
      );
    } finally {
      image.src = '';
    }
    throwIfCaptureAborted(input.signal);
    const sourcePng = await canvas.convertToBlob({ type: 'image/png' });
    throwIfCaptureAborted(input.signal);
    if (sourcePng.type !== 'image/png') {
      throw new Error('Canvas text preview DOM raster did not produce a PNG blob.');
    }
    const completedAt = performance.now();
    return {
      sourcePng,
      cssWidth: input.target.contentCssWidth,
      cssHeight: input.target.contentCssHeight,
      sourcePixelWidth: input.target.sourcePixelWidth,
      sourcePixelHeight: input.target.sourcePixelHeight,
      snapshotDurationMs: snapshot.durationMs,
      rasterDurationMs: completedAt - rasterStartedAt,
      captureDurationMs: completedAt - captureStartedAt,
      snapshotBytes: snapshot.byteLength,
      snapshotElementCount: snapshot.elementCount,
      maxSynchronousSliceMs: snapshot.maxSynchronousSliceMs
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw canvasTextPreviewFailureFromUnknown('raster_failed', {
      ...input.fields,
      sourcePixelWidth: input.target.sourcePixelWidth,
      sourcePixelHeight: input.target.sourcePixelHeight,
      durationMs: performance.now() - rasterStartedAt
    }, error);
  }
}

export async function canvasTextPreviewTargetIdentity(input: {
  contentDigest: string;
  language: ProjectTextLanguageId;
  wordWrap: boolean;
  contentCssWidth: number;
  contentCssHeight: number;
  scrollTop: number;
  scrollLeft: number;
  styleKey: string;
  sourcePixelWidth: number;
  sourcePixelHeight: number;
  sourceScale: number;
  rasterEnvironmentIdentity?: CanvasTextRasterEnvironmentIdentity | undefined;
}): Promise<CanvasPreviewTargetIdentity> {
  const payload = JSON.stringify({
    renderPolicyVersion: CANVAS_TEXT_PREVIEW_RENDER_POLICY_VERSION,
    rasterEnvironmentIdentity: input.rasterEnvironmentIdentity
      ?? canvasTextRasterEnvironmentIdentity(),
    contentDigest: input.contentDigest,
    language: input.language,
    wordWrap: input.wordWrap,
    contentCssWidth: input.contentCssWidth,
    contentCssHeight: input.contentCssHeight,
    scrollTop: input.scrollTop,
    scrollLeft: input.scrollLeft,
    styleKey: input.styleKey,
    sourcePixelWidth: input.sourcePixelWidth,
    sourcePixelHeight: input.sourcePixelHeight,
    sourceScale: input.sourceScale
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return canvasPreviewTargetIdentityFromDigest(
    `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  );
}

export function canvasTextRasterEnvironmentIdentity(): CanvasTextRasterEnvironmentIdentity {
  return {
    platform: __DEBRUTE_PLATFORM__,
    frontend: window.debruteShell ? 'desktop' : 'browser',
    engine: 'chromium',
    engineContractVersion: CANVAS_TEXT_CHROMIUM_RASTER_CONTRACT_VERSION,
    systemFallbackPolicyVersion: CANVAS_TEXT_SYSTEM_FALLBACK_POLICY_VERSION
  };
}

function assertCaptureRootReady(
  captureRoot: HTMLElement,
  target: CanvasTextPreviewTarget,
  fields: CanvasTextPreviewFailureFields
): void {
  const scroller = captureRoot.querySelector<HTMLElement>('.cm-scroller');
  const content = captureRoot.querySelector<HTMLElement>('.cm-content');
  if (!scroller
    || !content
    || captureRoot.clientWidth !== target.contentCssWidth
    || captureRoot.clientHeight !== target.contentCssHeight
    || scroller.clientWidth <= 0
    || scroller.clientHeight <= 0) {
    throw canvasTextPreviewFailureFromUnknown(
      'capture_not_ready',
      fields,
      'Canvas text preview capture target does not have a ready CodeMirror viewport.'
    );
  }
}

async function snapshotCanvasTextPreviewDom(input: {
  captureRoot: HTMLElement;
  target: CanvasTextPreviewTarget;
  signal?: AbortSignal | undefined;
  isInteractionActive: () => boolean;
}): Promise<CanvasTextPreviewDomSnapshot> {
  const startedAt = performance.now();
  const clone = input.captureRoot.cloneNode(false) as HTMLElement;
  const clones = new Map<HTMLElement, HTMLElement>([[input.captureRoot, clone]]);
  let maxSynchronousSliceMs = 0;
  let elementCount = 0;
  const fontWeights = new Set<string>();
  const fontFamilies = new Set<string>();
  assertCanvasTextPreviewElementAllowed(input.captureRoot);
  const rootFont = inlineComputedStyle(input.captureRoot, clone);
  fontWeights.add(rootFont.weight);
  fontFamilies.add(rootFont.family);
  sanitizeClonedElement(clone);
  const walker = input.captureRoot.ownerDocument.createTreeWalker(
    input.captureRoot,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node instanceof HTMLElement
          && CANVAS_TEXT_PREVIEW_REMOVED_SELECTORS.some((selector) => node.matches(selector))
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  let completed = false;
  let pendingText: { value: string; offset: number; parent: HTMLElement } | undefined;
  while (!completed) {
    const frameTime = await nextEligibleCaptureFrame(input.signal, input.isInteractionActive);
    const sliceStartedAt = performance.now();
    const deadline = Math.max(frameTime, sliceStartedAt) + CANVAS_TEXT_PREVIEW_SNAPSHOT_SLICE_MS;
    do {
      if (pendingText) {
        const end = canvasTextPreviewTextChunkEnd(pendingText.value, pendingText.offset);
        pendingText.parent.append(
          input.captureRoot.ownerDocument.createTextNode(
            pendingText.value.slice(pendingText.offset, end)
          )
        );
        pendingText.offset = end;
        if (end >= pendingText.value.length) {
          pendingText = undefined;
        }
        continue;
      }
      const source = walker.nextNode();
      if (!source) {
        completed = true;
        break;
      }
      const sourceParent = source.parentElement;
      const targetParent = sourceParent ? clones.get(sourceParent) : undefined;
      if (!targetParent) {
        throw new Error('Canvas text preview DOM clone changed element structure.');
      }
      if (source instanceof HTMLElement) {
        assertCanvasTextPreviewElementAllowed(source);
        const target = source.cloneNode(false) as HTMLElement;
        const font = inlineComputedStyle(source, target);
        fontWeights.add(font.weight);
        fontFamilies.add(font.family);
        sanitizeClonedElement(target);
        targetParent.append(target);
        clones.set(source, target);
        elementCount += 1;
      } else if (source.nodeType === Node.TEXT_NODE) {
        const value = source.nodeValue ?? '';
        if (value) {
          pendingText = { value, offset: 0, parent: targetParent };
        }
      }
    } while (!completed && performance.now() < deadline);
    maxSynchronousSliceMs = Math.max(maxSynchronousSliceMs, performance.now() - sliceStartedAt);
  }
  materializeCanvasTextPreviewViewport(input.captureRoot, clone, input.target);
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  const serialized = await serializeCanvasTextPreviewDom({
    root: clone,
    signal: input.signal,
    isInteractionActive: input.isInteractionActive
  });
  return {
    xhtmlParts: serialized.parts,
    byteLength: serialized.byteLength,
    elementCount,
    durationMs: performance.now() - startedAt,
    maxSynchronousSliceMs: Math.max(maxSynchronousSliceMs, serialized.maxSynchronousSliceMs),
    fontWeights: [...fontWeights],
    fontFamilies: [...fontFamilies]
  };
}

function assertCanvasTextPreviewElementAllowed(element: HTMLElement): void {
  if (!CANVAS_TEXT_PREVIEW_ALLOWED_TAGS.has(element.tagName)) {
    throw new Error(`Canvas text preview DOM contains an unsupported element: ${element.tagName}.`);
  }
}

function inlineComputedStyle(
  source: HTMLElement,
  target: HTMLElement
): { weight: string; family: string } {
  const computed = source.ownerDocument.defaultView?.getComputedStyle(source);
  if (!computed) {
    throw new Error('Canvas text preview DOM does not have computed styles.');
  }
  target.removeAttribute('style');
  for (const property of CANVAS_TEXT_PREVIEW_COMPUTED_STYLE_PROPERTIES) {
    const value = computed.getPropertyValue(property);
    if (!value || value.includes('url(')) {
      continue;
    }
    target.style.setProperty(property, value, computed.getPropertyPriority(property));
  }
  target.style.setProperty('animation', 'none', 'important');
  target.style.setProperty('caret-color', 'transparent', 'important');
  target.style.setProperty('transition', 'none', 'important');
  return {
    weight: normalizedFontWeight(computed.fontWeight),
    family: computed.fontFamily
  };
}

function normalizedFontWeight(value: string): string {
  if (value === 'normal') {
    return '400';
  }
  if (value === 'bold') {
    return '700';
  }
  return value;
}

function sanitizeClonedElement(element: HTMLElement): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith('on') || name === 'href' || name === 'src' || name === 'srcset' || name === 'xlink:href') {
      element.removeAttribute(attribute.name);
    }
  }
}

function canvasTextPreviewTextChunkEnd(value: string, offset: number): number {
  let end = Math.min(value.length, offset + CANVAS_TEXT_PREVIEW_TEXT_CHUNK_CODE_UNITS);
  if (end < value.length
    && end > offset
    && isHighSurrogate(value.charCodeAt(end - 1))
    && isLowSurrogate(value.charCodeAt(end))) {
    end -= 1;
  }
  return end;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

async function serializeCanvasTextPreviewDom(input: {
  root: HTMLElement;
  signal?: AbortSignal | undefined;
  isInteractionActive: () => boolean;
}): Promise<{
  parts: readonly string[];
  byteLength: number;
  maxSynchronousSliceMs: number;
}> {
  interface ElementFrame {
    readonly element: HTMLElement;
    opened: boolean;
    nextChildIndex: number;
  }
  const encoder = new TextEncoder();
  const parts: string[] = [];
  const frames: ElementFrame[] = [{ element: input.root, opened: false, nextChildIndex: 0 }];
  let pendingText: { value: string; offset: number } | undefined;
  let byteLength = 0;
  let maxSynchronousSliceMs = 0;
  const append = (part: string): void => {
    parts.push(part);
    byteLength += encoder.encode(part).byteLength;
  };
  while (frames.length > 0 || pendingText) {
    const frameTime = await nextEligibleCaptureFrame(input.signal, input.isInteractionActive);
    const sliceStartedAt = performance.now();
    const deadline = Math.max(frameTime, sliceStartedAt) + CANVAS_TEXT_PREVIEW_SNAPSHOT_SLICE_MS;
    do {
      if (pendingText) {
        const end = canvasTextPreviewTextChunkEnd(pendingText.value, pendingText.offset);
        append(escapeCanvasTextPreviewXmlText(pendingText.value.slice(pendingText.offset, end)));
        pendingText.offset = end;
        if (end >= pendingText.value.length) {
          pendingText = undefined;
        }
        continue;
      }
      const frame = frames.at(-1);
      if (!frame) {
        break;
      }
      if (!frame.opened) {
        append(canvasTextPreviewOpeningTag(frame.element));
        frame.opened = true;
        continue;
      }
      const child = frame.element.childNodes.item(frame.nextChildIndex);
      if (child) {
        frame.nextChildIndex += 1;
        if (child instanceof HTMLElement) {
          frames.push({ element: child, opened: false, nextChildIndex: 0 });
        } else if (child.nodeType === Node.TEXT_NODE && child.nodeValue) {
          pendingText = { value: child.nodeValue, offset: 0 };
        }
        continue;
      }
      append(`</${frame.element.tagName.toLowerCase()}>`);
      frames.pop();
    } while ((frames.length > 0 || pendingText) && performance.now() < deadline);
    maxSynchronousSliceMs = Math.max(maxSynchronousSliceMs, performance.now() - sliceStartedAt);
  }
  return { parts, byteLength, maxSynchronousSliceMs };
}

function canvasTextPreviewOpeningTag(element: HTMLElement): string {
  let tag = `<${element.tagName.toLowerCase()}`;
  for (const attribute of element.attributes) {
    tag += ` ${attribute.name}="${escapeCanvasTextPreviewXmlAttribute(attribute.value)}"`;
  }
  return `${tag}>`;
}

function escapeCanvasTextPreviewXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeCanvasTextPreviewXmlAttribute(value: string): string {
  return escapeCanvasTextPreviewXmlText(value).replaceAll('"', '&quot;');
}

function materializeCanvasTextPreviewViewport(
  sourceRoot: HTMLElement,
  cloneRoot: HTMLElement,
  target: CanvasTextPreviewTarget
): void {
  const sourceScroller = sourceRoot.querySelector<HTMLElement>('.cm-scroller');
  const sourceContent = sourceRoot.querySelector<HTMLElement>('.cm-content');
  const sourceGutters = sourceRoot.querySelector<HTMLElement>('.cm-gutters');
  const cloneScroller = cloneRoot.querySelector<HTMLElement>('.cm-scroller');
  const cloneContent = cloneRoot.querySelector<HTMLElement>('.cm-content');
  const cloneGutters = cloneRoot.querySelector<HTMLElement>('.cm-gutters');
  if (!sourceScroller || !sourceContent || !cloneScroller || !cloneContent) {
    throw new Error('Canvas text preview DOM clone is missing its CodeMirror viewport.');
  }

  Object.assign(cloneRoot.style, {
    position: 'relative',
    left: '0px',
    top: '0px',
    width: `${target.contentCssWidth}px`,
    height: `${target.contentCssHeight}px`,
    margin: '0px',
    overflow: 'hidden'
  });
  Object.assign(cloneScroller.style, {
    overflow: 'hidden',
    overflowX: 'hidden',
    overflowY: 'hidden'
  });
  Object.assign(cloneContent.style, {
    width: `${Math.max(sourceContent.clientWidth, sourceContent.scrollWidth)}px`,
    height: `${Math.max(sourceContent.clientHeight, sourceContent.scrollHeight)}px`,
    flex: 'none',
    transform: `translate(${-sourceScroller.scrollLeft}px, ${-sourceScroller.scrollTop}px)`,
    transformOrigin: '0 0'
  });
  if (sourceGutters && cloneGutters) {
    Object.assign(cloneGutters.style, {
      width: `${Math.max(sourceGutters.clientWidth, sourceGutters.scrollWidth)}px`,
      height: `${Math.max(sourceGutters.clientHeight, sourceGutters.scrollHeight)}px`,
      flex: 'none',
      transform: `translateY(${-sourceScroller.scrollTop}px)`,
      transformOrigin: '0 0'
    });
  }
}

async function canvasTextPreviewSvgDataUrl(
  xhtmlParts: readonly string[],
  embeddedFontCss: string,
  target: CanvasTextPreviewTarget
): Promise<string> {
  if (!embeddedFontCss) {
    throw new Error('Canvas text preview DOM raster requires embedded managed-font CSS.');
  }
  const svgParts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${target.sourcePixelWidth}" height="${target.sourcePixelHeight}"`,
    ` viewBox="0 0 ${target.contentCssWidth} ${target.contentCssHeight}"`,
    ' preserveAspectRatio="none">',
    `<style type="text/css">${embeddedFontCss}</style>`,
    `<foreignObject x="0" y="0" width="${target.contentCssWidth}" height="${target.contentCssHeight}">`,
    ...xhtmlParts,
    '</foreignObject></svg>'
  ];
  const blob = new Blob(svgParts, { type: 'image/svg+xml;charset=utf-8' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Canvas text preview SVG data URL encoding returned a non-string result.'));
      }
    }, { once: true });
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error('Canvas text preview SVG data URL encoding failed.'));
    }, { once: true });
    reader.readAsDataURL(blob);
  });
}

function embeddedFontCssForSnapshot(
  preparedFont: CanvasTextPreparedFont,
  snapshot: CanvasTextPreviewDomSnapshot
): string {
  const weights = new Set(snapshot.fontWeights);
  const usedFamilies = new Set(preparedFont.embeddedFaces
    .map((face) => face.family)
    .filter((family) => snapshot.fontFamilies.some((value) => (
      canvasTextFontFamilyListContains(value, family)
    ))));
  const selectedFaces = preparedFont.embeddedFaces.filter((face) => {
    if (!usedFamilies.has(face.family)) {
      return false;
    }
    const familyFaces = preparedFont.embeddedFaces.filter((candidate) => (
      candidate.family === face.family
    ));
    const hasExactFaceForEveryWeight = snapshot.fontWeights.every((weight) => (
      familyFaces.some((candidate) => candidate.weight === weight)
    ));
    return !hasExactFaceForEveryWeight || weights.has(face.weight);
  });
  const css = selectedFaces
    .map((face) => face.css)
    .join('');
  if (!css) {
    throw new Error(
      `Canvas text preview DOM raster has no managed font face for families ${snapshot.fontFamilies.join(', ')} and weights ${snapshot.fontWeights.join(', ')}.`
    );
  }
  return css;
}

function canvasTextFontFamilyListContains(value: string, family: string): boolean {
  return value.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    const unquoted = trimmed.length >= 2
      && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed;
    return unquoted === family;
  });
}

function nextEligibleCaptureFrame(
  signal: AbortSignal | undefined,
  isInteractionActive: () => boolean
): Promise<number> {
  return new Promise((resolve, reject) => {
    const schedule = (): void => {
      if (signal?.aborted) {
        reject(captureAbortError());
        return;
      }
      requestAnimationFrame((timestamp) => {
        try {
          throwIfCaptureAborted(signal);
          if (isInteractionActive()) {
            schedule();
          } else {
            resolve(timestamp);
          }
        } catch (error) {
          reject(error);
        }
      });
    };
    schedule();
  });
}

function throwIfCaptureAborted(
  signal: AbortSignal | undefined
): void {
  if (!signal?.aborted) {
    return;
  }
  throw captureAbortError();
}

function captureAbortError(): DOMException {
  return new DOMException('Canvas text preview capture was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
