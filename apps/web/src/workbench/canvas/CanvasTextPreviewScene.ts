import {
  canvasTextPreviewFailureFromUnknown,
  type CanvasTextPreviewFailureFields
} from './CanvasTextPreviewFailure';
import type {
  CanvasTextPreviewRasterRect,
  CanvasTextPreviewRasterScene,
  CanvasTextPreviewRasterText
} from './CanvasTextPreviewRasterWorkerProtocol.js';

const ROW_TOLERANCE_PX = 0.5;

export interface CanvasTextPreviewBuiltScene {
  scene: CanvasTextPreviewRasterScene;
  width: number;
  height: number;
}

export type CanvasTextPreviewSceneSliceResult =
  | { done: false }
  | { done: true; builtScene: CanvasTextPreviewBuiltScene };

export interface CanvasTextPreviewSceneBuild {
  runSlice(deadline: number): CanvasTextPreviewSceneSliceResult;
  dispose(): void;
}

type SceneWorkItem =
  | { kind: 'line-number'; element: HTMLElement }
  | { kind: 'line-walker'; walker: TreeWalker }
  | { kind: 'text-node'; node: Text }
  | {
      kind: 'text-row';
      node: Text;
      row: DOMRect;
      startOffset: number;
      endOffset: number;
    };

interface SceneGeometry {
  viewport: DOMRect;
  rootRect: DOMRect;
  rootWidth: number;
  rootHeight: number;
}

export function createCanvasTextPreviewSceneBuild(input: {
  captureRoot: HTMLElement;
  fields: CanvasTextPreviewFailureFields;
  now?: (() => number) | undefined;
}): CanvasTextPreviewSceneBuild {
  const now = input.now ?? performance.now.bind(performance);
  const scroller = input.captureRoot.querySelector<HTMLElement>('.cm-scroller');
  const content = input.captureRoot.querySelector<HTMLElement>('.cm-content');
  const rootWidth = input.captureRoot.clientWidth;
  const rootHeight = input.captureRoot.clientHeight;
  if (!scroller
    || !content
    || rootWidth <= 0
    || rootHeight <= 0
    || scroller.clientWidth <= 0
    || scroller.clientHeight <= 0) {
    throw canvasTextPreviewFailureFromUnknown(
      'scene_not_ready',
      input.fields,
      'Canvas text preview capture target does not have a ready CodeMirror viewport.'
    );
  }

  const viewport = scroller.getBoundingClientRect();
  const rootRect = input.captureRoot.getBoundingClientRect();
  if (!isFinitePositiveRect(viewport) || !isFinitePositiveRect(rootRect)) {
    throw canvasTextPreviewFailureFromUnknown(
      'scene_not_ready',
      input.fields,
      'Canvas text preview capture geometry is not ready.'
    );
  }

  const geometry = { viewport, rootRect, rootWidth, rootHeight };
  const work = collectVisibleSceneWork(scroller, content, viewport);
  const scrollerStyle = getComputedStyle(scroller);
  const commands: Array<CanvasTextPreviewRasterRect | CanvasTextPreviewRasterText> = [];
  appendBackgroundPlanes(commands, scroller, content, geometry);

  let cursor = 0;
  let disposed = false;
  let completed: CanvasTextPreviewBuiltScene | undefined;

  return {
    runSlice(deadline) {
      if (disposed) {
        throw canvasTextPreviewFailureFromUnknown(
          'scene_invariant_violation',
          input.fields,
          'Canvas text preview scene build was disposed.'
        );
      }
      if (completed) {
        return { done: true, builtScene: completed };
      }
      while (cursor < work.length && now() < deadline) {
        const item = work[cursor++];
        if (!item) {
          break;
        }
        if (item.kind === 'line-number') {
          appendLineNumber(commands, item.element, geometry);
        } else if (item.kind === 'line-walker') {
          const node = item.walker.nextNode();
          if (node) {
            if (node instanceof Text && node.data.length > 0) {
              work.push({ kind: 'text-node', node });
            }
            work.push(item);
          }
        } else if (item.kind === 'text-node') {
          work.push(...visibleTextRowWork(item.node, geometry));
        } else {
          appendVisibleTextRow(commands, item, geometry);
        }
      }
      if (cursor < work.length) {
        return { done: false };
      }
      const scene = {
        background: scrollerStyle.backgroundColor || 'transparent',
        commands
      } satisfies CanvasTextPreviewRasterScene;
      completed = {
        scene,
        width: rootWidth,
        height: rootHeight
      };
      assertCanvasTextPreviewScene(completed, input.fields);
      work.length = 0;
      return { done: true, builtScene: completed };
    },
    dispose() {
      disposed = true;
      work.length = 0;
    }
  };
}

function assertCanvasTextPreviewScene(
  builtScene: CanvasTextPreviewBuiltScene,
  fields: CanvasTextPreviewFailureFields
): void {
  const fail = (message: string): never => {
    throw canvasTextPreviewFailureFromUnknown('scene_invariant_violation', {
      ...fields,
      sceneWidth: builtScene.width,
      sceneHeight: builtScene.height
    }, message);
  };

  if (!Number.isFinite(builtScene.width)
    || builtScene.width <= 0
    || !Number.isFinite(builtScene.height)
    || builtScene.height <= 0) {
    fail('Canvas text preview scene dimensions are invalid.');
  }
  for (const command of builtScene.scene.commands) {
    if (![command.x, command.y, command.width, command.height].every(Number.isFinite)
      || command.x < 0
      || command.y < 0
      || command.width <= 0
      || command.height <= 0
      || command.x + command.width > builtScene.width + ROW_TOLERANCE_PX
      || command.y + command.height > builtScene.height + ROW_TOLERANCE_PX) {
      fail('Canvas text preview scene contains a command outside its bounds.');
    }
    if (command.kind === 'text' && command.text.includes('\t')) {
      fail('Canvas text preview scene contains an unresolved tab.');
    }
  }
}

function collectVisibleSceneWork(
  scroller: HTMLElement,
  content: HTMLElement,
  viewport: DOMRect
): SceneWorkItem[] {
  const work: SceneWorkItem[] = [];
  for (const element of scroller.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')) {
    if (rectsIntersect(element.getBoundingClientRect(), viewport)) {
      work.push({ kind: 'line-number', element });
    }
  }
  for (const line of content.querySelectorAll<HTMLElement>('.cm-line')) {
    if (!rectsIntersect(line.getBoundingClientRect(), viewport)) {
      continue;
    }
    work.push({
      kind: 'line-walker',
      walker: document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    });
  }
  return work;
}

function appendBackgroundPlanes(
  commands: CanvasTextPreviewRasterScene['commands'],
  scroller: HTMLElement,
  content: HTMLElement,
  geometry: SceneGeometry
): void {
  const gutters = scroller.querySelector<HTMLElement>('.cm-gutters');
  for (const element of [gutters, content]) {
    if (!element) {
      continue;
    }
    const clipped = clipToScene(element.getBoundingClientRect(), geometry);
    if (!clipped) {
      continue;
    }
    const style = getComputedStyle(element);
    const borderWidth = Number.parseFloat(style.borderWidth) || 0;
    commands.push({
      kind: 'rect',
      x: clipped.left,
      y: clipped.top,
      width: clipped.width,
      height: clipped.height,
      fill: style.backgroundColor || 'transparent',
      stroke: borderWidth > 0 && style.borderStyle !== '' && style.borderStyle !== 'none'
        ? style.borderColor || 'transparent'
        : 'none',
      strokeWidth: borderWidth
    });
  }
}

function appendLineNumber(
  commands: CanvasTextPreviewRasterScene['commands'],
  source: HTMLElement,
  geometry: SceneGeometry
): void {
  const sourceRect = source.getBoundingClientRect();
  const clipped = clipToScene(sourceRect, geometry);
  if (!clipped) {
    return;
  }
  commands.push(textCommand({
    source,
    kind: 'line-number',
    text: source.textContent ?? '',
    sourceRect,
    clipped,
    geometry
  }));
}

function visibleTextRowWork(
  node: Text,
  geometry: SceneGeometry
): SceneWorkItem[] {
  if (!node.parentElement || node.data.length === 0) {
    return [];
  }
  const range = document.createRange();
  if (!textNodeWraps(node)) {
    const startOffset = lowerBoundCharacterOffset(node, range, 0, node.data.length, (rect) => (
      rect.right > geometry.viewport.left
    ));
    const endOffset = lowerBoundCharacterOffset(node, range, startOffset, node.data.length, (rect) => (
      rect.left >= geometry.viewport.right
    ));
    if (endOffset <= startOffset) {
      range.detach();
      return [];
    }
    range.setStart(node, startOffset);
    range.setEnd(node, endOffset);
    const row = range.getBoundingClientRect();
    range.detach();
    return rectsIntersect(row, geometry.viewport)
      ? [{ kind: 'text-row', node, row, startOffset, endOffset }]
      : [];
  }
  const startOffset = lowerBoundCharacterOffset(node, range, 0, node.data.length, (rect) => (
    rect.bottom > geometry.viewport.top
  ));
  const endOffset = lowerBoundCharacterOffset(node, range, startOffset, node.data.length, (rect) => (
    rect.top >= geometry.viewport.bottom
  ));
  if (endOffset <= startOffset) {
    range.detach();
    return [];
  }
  range.setStart(node, startOffset);
  range.setEnd(node, endOffset);
  const rows = Array.from(range.getClientRects()).filter((rect) => rectsIntersect(rect, geometry.viewport));
  range.detach();
  return rows.map((row) => ({ kind: 'text-row', node, row, startOffset, endOffset }));
}

function textNodeWraps(node: Text): boolean {
  const line = node.parentElement?.closest<HTMLElement>('.cm-line');
  return line ? getComputedStyle(line).whiteSpace === 'pre-wrap' : false;
}

function appendVisibleTextRow(
  commands: CanvasTextPreviewRasterScene['commands'],
  item: Extract<SceneWorkItem, { kind: 'text-row' }>,
  geometry: SceneGeometry
): void {
  const { node, row, startOffset, endOffset } = item;
  const source = node.parentElement;
  if (!source || node.data.length === 0) {
    return;
  }
  const range = document.createRange();
  const start = lowerBoundCharacterOffset(node, range, startOffset, endOffset, (rect) => (
    rect.top > row.top + ROW_TOLERANCE_PX
    || (sameRow(rect, row) && rect.right > geometry.viewport.left)
  ));
  const end = lowerBoundCharacterOffset(node, range, start, endOffset, (rect) => (
    rect.top > row.top + ROW_TOLERANCE_PX
    || (sameRow(rect, row) && rect.left >= geometry.viewport.right)
  ));
  if (end <= start) {
    range.detach();
    return;
  }
  let segmentStart = start;
  for (let offset = start; offset < end; offset += 1) {
    if (node.data[offset] !== '\t') {
      continue;
    }
    appendVisibleTextSegment(commands, range, node, source, segmentStart, offset, geometry);
    segmentStart = offset + 1;
  }
  appendVisibleTextSegment(commands, range, node, source, segmentStart, end, geometry);
  range.detach();
}

function appendVisibleTextSegment(
  commands: CanvasTextPreviewRasterScene['commands'],
  range: Range,
  node: Text,
  source: HTMLElement,
  start: number,
  end: number,
  geometry: SceneGeometry
): void {
  if (end <= start) {
    return;
  }
  range.setStart(node, start);
  range.setEnd(node, end);
  const sourceRect = range.getBoundingClientRect();
  const clipped = clipToScene(sourceRect, geometry);
  if (!clipped) {
    return;
  }
  commands.push(textCommand({
    source,
    kind: 'text',
    text: node.data.slice(start, end),
    sourceRect,
    clipped,
    geometry
  }));
}

function lowerBoundCharacterOffset(
  node: Text,
  range: Range,
  startOffset: number,
  endOffset: number,
  predicate: (rect: DOMRect) => boolean
): number {
  let low = startOffset;
  let high = endOffset;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    range.setStart(node, middle);
    range.setEnd(node, Math.min(node.data.length, middle + 1));
    const rect = range.getClientRects()[0];
    if (!rect || predicate(rect)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

function textCommand(input: {
  source: HTMLElement;
  kind: 'line-number' | 'text';
  text: string;
  sourceRect: DOMRect;
  clipped: { left: number; top: number; width: number; height: number };
  geometry: SceneGeometry;
}): CanvasTextPreviewRasterText {
  const style = getComputedStyle(input.source);
  const indent = input.sourceRect.left
    - input.geometry.rootRect.left
    - input.clipped.left;
  const textAlign = input.kind === 'line-number'
    && (style.textAlign === 'right' || style.textAlign === 'center')
    ? style.textAlign
    : 'left';
  const paddingLeft = input.kind === 'line-number'
    ? Number.parseFloat(style.paddingLeft) || 0
    : 0;
  const paddingRight = input.kind === 'line-number'
    ? Number.parseFloat(style.paddingRight) || 0
    : 0;
  const textX = textAlign === 'right'
    ? input.clipped.width - paddingRight + indent
    : textAlign === 'center'
      ? input.clipped.width / 2 + indent
      : paddingLeft + indent;
  return {
    kind: 'text',
    x: input.clipped.left,
    y: input.clipped.top,
    width: input.clipped.width,
    height: input.clipped.height,
    text: input.text,
    textX,
    textAlign,
    color: style.color || 'transparent',
    background: style.backgroundColor || 'transparent',
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    fontStretch: style.fontStretch,
    fontKerning: style.fontKerning,
    fontVariantCaps: style.fontVariantCaps || 'normal',
    fontVariantLigatures: style.fontVariantLigatures,
    fontVariantNumeric: input.kind === 'line-number' ? style.fontVariantNumeric : '',
    fontFeatureSettings: style.fontFeatureSettings,
    fontVariationSettings: style.fontVariationSettings,
    fontOpticalSizing: style.fontOpticalSizing,
    fontSynthesis: style.fontSynthesis,
    letterSpacing: style.letterSpacing,
    wordSpacing: style.wordSpacing,
    textDecorationLine: style.textDecorationLine,
    textDecorationColor: style.textDecorationColor,
    textDecorationStyle: style.textDecorationStyle
  };
}

function clipToScene(rect: DOMRect, geometry: SceneGeometry): {
  left: number;
  top: number;
  width: number;
  height: number;
} | undefined {
  const left = Math.max(rect.left, geometry.viewport.left, geometry.rootRect.left);
  const top = Math.max(rect.top, geometry.viewport.top, geometry.rootRect.top);
  const right = Math.min(rect.right, geometry.viewport.right, geometry.rootRect.left + geometry.rootWidth);
  const bottom = Math.min(rect.bottom, geometry.viewport.bottom, geometry.rootRect.top + geometry.rootHeight);
  if (right <= left || bottom <= top) {
    return undefined;
  }
  return {
    left: left - geometry.rootRect.left,
    top: top - geometry.rootRect.top,
    width: right - left,
    height: bottom - top
  };
}

function sameRow(first: DOMRect, second: DOMRect): boolean {
  return Math.abs(first.top - second.top) <= ROW_TOLERANCE_PX;
}

function rectsIntersect(first: DOMRect, second: DOMRect): boolean {
  return first.width > 0
    && first.height > 0
    && second.width > 0
    && second.height > 0
    && first.right > second.left
    && first.left < second.right
    && first.bottom > second.top
    && first.top < second.bottom;
}

function isFinitePositiveRect(rect: DOMRect): boolean {
  return [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0
    && rect.height > 0;
}
