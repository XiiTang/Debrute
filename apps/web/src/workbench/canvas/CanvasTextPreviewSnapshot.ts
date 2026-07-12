import {
  canvasTextPreviewFailureFromUnknown,
  type CanvasTextPreviewFailureFields
} from './CanvasTextPreviewFailure';

const FORBIDDEN_SNAPSHOT_SELECTOR = [
  '.cm-editor',
  '.cm-scroller',
  '.cm-content',
  '.cm-line',
  '.cm-gutters',
  '.cm-gutter',
  '.cm-selectionLayer',
  '.cm-cursorLayer',
  '.cm-gap',
  'button',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]'
].join(', ');

const ROW_TOLERANCE_PX = 0.5;
const SNAPSHOT_FRAGMENT_KINDS = new Set(['background', 'line-number', 'text']);

export interface CanvasTextPreviewSnapshot {
  root: HTMLDivElement;
  width: number;
  height: number;
  serializedBytes: number;
}

export type CanvasTextPreviewSnapshotSliceResult =
  | { done: false }
  | { done: true; snapshot: CanvasTextPreviewSnapshot };

export interface CanvasTextPreviewSnapshotBuild {
  runSlice(deadline: number): CanvasTextPreviewSnapshotSliceResult;
  dispose(): void;
}

type SnapshotWorkItem =
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

interface SnapshotGeometry {
  viewport: DOMRect;
  rootRect: DOMRect;
  rootWidth: number;
  rootHeight: number;
}

export function createCanvasTextPreviewSnapshotBuild(input: {
  captureRoot: HTMLElement;
  fields: CanvasTextPreviewFailureFields;
  now?: (() => number) | undefined;
}): CanvasTextPreviewSnapshotBuild {
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
      'snapshot_not_ready',
      input.fields,
      'Canvas text preview capture target does not have a ready CodeMirror viewport.'
    );
  }

  const viewport = scroller.getBoundingClientRect();
  const rootRect = input.captureRoot.getBoundingClientRect();
  if (!isFinitePositiveRect(viewport) || !isFinitePositiveRect(rootRect)) {
    throw canvasTextPreviewFailureFromUnknown(
      'snapshot_not_ready',
      input.fields,
      'Canvas text preview capture geometry is not ready.'
    );
  }

  const geometry = { viewport, rootRect, rootWidth, rootHeight };
  const work = collectVisibleSnapshotWork(scroller, content, viewport);
  const root = document.createElement('div');
  root.dataset.canvasTextPreviewSnapshot = 'true';
  const scrollerStyle = getComputedStyle(scroller);
  Object.assign(root.style, {
    position: 'absolute',
    left: '0px',
    top: '0px',
    width: `${rootWidth}px`,
    height: `${rootHeight}px`,
    overflow: 'hidden',
    pointerEvents: 'none',
    contain: 'strict',
    background: scrollerStyle.background
  });
  input.captureRoot.append(root);
  appendBackgroundPlanes(root, scroller, content, geometry);

  let cursor = 0;
  let disposed = false;
  let completed: CanvasTextPreviewSnapshot | undefined;

  return {
    runSlice(deadline) {
      if (disposed) {
        throw canvasTextPreviewFailureFromUnknown(
          'snapshot_invariant_violation',
          input.fields,
          'Canvas text preview snapshot build was disposed.'
        );
      }
      if (completed) {
        return { done: true, snapshot: completed };
      }
      while (cursor < work.length && now() < deadline) {
        const item = work[cursor++];
        if (!item) {
          break;
        }
        if (item.kind === 'line-number') {
          appendLineNumber(root, item.element, geometry);
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
          appendVisibleTextRow(root, item, geometry);
        }
      }
      if (cursor < work.length) {
        return { done: false };
      }
      completed = {
        root,
        width: rootWidth,
        height: rootHeight,
        serializedBytes: new TextEncoder().encode(root.outerHTML).byteLength
      };
      assertCanvasTextPreviewSnapshot(completed, input.fields);
      return { done: true, snapshot: completed };
    },
    dispose() {
      disposed = true;
      root.remove();
    }
  };
}

export function assertCanvasTextPreviewSnapshot(
  snapshot: CanvasTextPreviewSnapshot,
  fields: CanvasTextPreviewFailureFields
): void {
  const fail = (message: string): never => {
    throw canvasTextPreviewFailureFromUnknown('snapshot_invariant_violation', {
      ...fields,
      snapshotWidth: snapshot.width,
      snapshotHeight: snapshot.height,
      snapshotBytes: snapshot.serializedBytes
    }, message);
  };

  if (snapshot.root.dataset.canvasTextPreviewSnapshot !== 'true') {
    fail('Canvas text preview raster input is not a snapshot root.');
  }
  if (!Number.isFinite(snapshot.width)
    || snapshot.width <= 0
    || !Number.isFinite(snapshot.height)
    || snapshot.height <= 0
    || Number.parseFloat(snapshot.root.style.width) !== snapshot.width
    || Number.parseFloat(snapshot.root.style.height) !== snapshot.height
    || snapshot.root.style.overflow !== 'hidden') {
    fail('Canvas text preview snapshot root dimensions are invalid.');
  }
  if (!Number.isFinite(snapshot.serializedBytes) || snapshot.serializedBytes <= 0) {
    fail('Canvas text preview snapshot serialization is empty.');
  }
  if (snapshot.root.querySelector(FORBIDDEN_SNAPSHOT_SELECTOR)) {
    fail('Canvas text preview snapshot contains a forbidden editor or interactive subtree.');
  }
  for (const child of snapshot.root.querySelectorAll<HTMLElement>('*')) {
    if (!SNAPSHOT_FRAGMENT_KINDS.has(child.dataset.canvasTextPreviewFragment ?? '')) {
      fail('Canvas text preview snapshot contains an unmarked descendant.');
    }
    const left = Number.parseFloat(child.style.left);
    const top = Number.parseFloat(child.style.top);
    const width = Number.parseFloat(child.style.width);
    const height = Number.parseFloat(child.style.height);
    if (![left, top, width, height].every(Number.isFinite)
      || left < 0
      || top < 0
      || width < 0
      || height < 0
      || left + width > snapshot.width + ROW_TOLERANCE_PX
      || top + height > snapshot.height + ROW_TOLERANCE_PX) {
      fail('Canvas text preview snapshot contains a fragment outside the root bounds.');
    }
  }
}

function collectVisibleSnapshotWork(
  scroller: HTMLElement,
  content: HTMLElement,
  viewport: DOMRect
): SnapshotWorkItem[] {
  const work: SnapshotWorkItem[] = [];
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
  root: HTMLElement,
  scroller: HTMLElement,
  content: HTMLElement,
  geometry: SnapshotGeometry
): void {
  const gutters = scroller.querySelector<HTMLElement>('.cm-gutters');
  for (const element of [gutters, content]) {
    if (!element) {
      continue;
    }
    const clipped = clipToSnapshot(element.getBoundingClientRect(), geometry);
    if (!clipped) {
      continue;
    }
    const style = getComputedStyle(element);
    const plane = document.createElement('div');
    plane.dataset.canvasTextPreviewFragment = 'background';
    setFragmentBox(plane, clipped);
    plane.style.backgroundColor = style.backgroundColor;
    plane.style.borderColor = style.borderColor;
    plane.style.borderStyle = style.borderStyle;
    plane.style.borderWidth = style.borderWidth;
    root.append(plane);
  }
}

function appendLineNumber(
  root: HTMLElement,
  source: HTMLElement,
  geometry: SnapshotGeometry
): void {
  const sourceRect = source.getBoundingClientRect();
  const clipped = clipToSnapshot(sourceRect, geometry);
  if (!clipped) {
    return;
  }
  const fragment = document.createElement('span');
  fragment.dataset.canvasTextPreviewFragment = 'line-number';
  fragment.textContent = source.textContent;
  setFragmentBox(fragment, clipped);
  copyPixelTextStyle(source, fragment);
  const sourceStyle = getComputedStyle(source);
  fragment.style.display = 'block';
  fragment.style.overflow = 'hidden';
  fragment.style.textAlign = sourceStyle.textAlign;
  fragment.style.paddingLeft = sourceStyle.paddingLeft;
  fragment.style.paddingRight = sourceStyle.paddingRight;
  fragment.style.fontVariantNumeric = sourceStyle.fontVariantNumeric;
  fragment.style.textIndent = `${sourceRect.left - geometry.rootRect.left - clipped.left}px`;
  root.append(fragment);
}

function visibleTextRowWork(
  node: Text,
  geometry: SnapshotGeometry
): SnapshotWorkItem[] {
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
  root: HTMLElement,
  item: Extract<SnapshotWorkItem, { kind: 'text-row' }>,
  geometry: SnapshotGeometry
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
  range.setStart(node, start);
  range.setEnd(node, end);
  const sourceRect = range.getBoundingClientRect();
  const clipped = clipToSnapshot(sourceRect, geometry);
  if (!clipped) {
    range.detach();
    return;
  }
  const fragment = document.createElement('span');
  fragment.dataset.canvasTextPreviewFragment = 'text';
  fragment.textContent = node.data.slice(start, end);
  setFragmentBox(fragment, clipped);
  copyPixelTextStyle(source, fragment);
  fragment.style.display = 'block';
  fragment.style.overflow = 'hidden';
  fragment.style.textIndent = `${sourceRect.left - geometry.rootRect.left - clipped.left}px`;
  root.append(fragment);
  range.detach();
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

function copyPixelTextStyle(source: Element, target: HTMLElement): void {
  const style = getComputedStyle(source);
  target.style.fontFamily = style.fontFamily;
  target.style.fontSize = style.fontSize;
  target.style.fontWeight = style.fontWeight;
  target.style.fontStyle = style.fontStyle;
  target.style.fontVariant = style.fontVariant;
  target.style.lineHeight = style.lineHeight;
  target.style.color = style.color;
  target.style.backgroundColor = style.backgroundColor;
  target.style.textDecorationLine = style.textDecorationLine;
  target.style.textDecorationColor = style.textDecorationColor;
  target.style.textDecorationStyle = style.textDecorationStyle;
  target.style.letterSpacing = style.letterSpacing;
  target.style.whiteSpace = 'pre';
  target.style.tabSize = style.tabSize;
}

function clipToSnapshot(rect: DOMRect, geometry: SnapshotGeometry): {
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

function setFragmentBox(
  element: HTMLElement,
  box: { left: number; top: number; width: number; height: number }
): void {
  Object.assign(element.style, {
    position: 'absolute',
    boxSizing: 'border-box',
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`
  });
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
