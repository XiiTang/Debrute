import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertCanvasTextPreviewSnapshot,
  createCanvasTextPreviewSnapshotBuild,
  type CanvasTextPreviewSnapshot
} from './CanvasTextPreviewSnapshot';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe('CanvasTextPreviewSnapshot', { tags: ['canvas-text'] }, () => {
  it.each([6_472, 600_000])(
    'copies bounded visible text from an unwrapped %i-byte JSON line',
    (payloadLength) => {
      const content = JSON.stringify({
        id: '12_cma_1993.143',
        payload: 'x'.repeat(payloadLength),
        tags: ['art', 'api', 'preview']
      });
      const fixture = snapshotFixture({ content, scrollLeft: 14_600 });

      const snapshot = finishSnapshot(fixture.captureRoot);

      expect(snapshot.width).toBe(420);
      expect(snapshot.height).toBe(280);
      expect(snapshot.root.textContent).toContain('xxxxxxxx');
      expect(snapshot.root.textContent?.length).toBeLessThan(512);
      expect(snapshot.root.textContent).not.toBe(content);
      expect(snapshot.serializedBytes).toBeLessThan(32_000);
      expect(snapshot.root.querySelector('.cm-scroller, .cm-editor, .cm-line, .cm-gap')).toBeNull();
      expect(snapshot.root.querySelector('button, input, textarea, [contenteditable="true"]')).toBeNull();
      expect(fixture.rangeMetrics.maxRequestedSpan).toBeLessThan(1_024);
    }
  );

  it('creates a valid blank preview for an empty text file', () => {
    const fixture = snapshotFixture({ content: '', scrollLeft: 0 });

    const snapshot = finishSnapshot(fixture.captureRoot);

    expect(snapshot.root.querySelector('[data-canvas-text-preview-fragment="text"]')).toBeNull();
    expect(snapshot.root.dataset.canvasTextPreviewSnapshot).toBe('true');
  });

  it('preserves visible syntax colors and aligned line numbers without source subtrees', () => {
    const fixture = snapshotFixture({
      content: 'const answer = 42;',
      scrollLeft: 0,
      syntaxColor: 'rgb(255, 0, 0)'
    });

    const snapshot = finishSnapshot(fixture.captureRoot);
    const lineNumber = snapshot.root.querySelector<HTMLElement>('[data-canvas-text-preview-fragment="line-number"]');
    const text = snapshot.root.querySelector<HTMLElement>('[data-canvas-text-preview-fragment="text"]');

    expect(lineNumber?.textContent).toBe('1');
    expect(text?.style.color).toBe('rgb(255, 0, 0)');
    expect(lineNumber?.style.top).toBe(text?.style.top);
    expect(lineNumber?.style.textAlign).toBe('right');
    expect(lineNumber?.style.paddingLeft).toBe('5px');
    expect(lineNumber?.style.paddingRight).toBe('3px');
    expect(snapshot.root.querySelector('.cm-gutters, .cm-content')).toBeNull();
  });

  it('copies only vertically visible wrapped rows from one CodeMirror text node', () => {
    const fixture = wrappedSnapshotFixture('abcdefghijKLMNOPQRSTuvwxyzABCD1234567890');

    const snapshot = finishSnapshot(fixture.captureRoot);
    const fragments = [...snapshot.root.querySelectorAll<HTMLElement>(
      '[data-canvas-text-preview-fragment="text"]'
    )];

    expect(fragments.length).toBeGreaterThanOrEqual(2);
    expect(fragments.map((fragment) => fragment.textContent).join('')).not.toContain('abcdefghij');
    expect(fragments.map((fragment) => fragment.textContent).join('')).toContain('KLMNOPQRST');
    expect(fragments.every((fragment) => Number.parseFloat(fragment.style.top) >= 0)).toBe(true);
  });

  it('never requests the complete offset range of a 600 KB wrapped text node', () => {
    const fixture = wrappedSnapshotFixture('x'.repeat(600_000));

    const snapshot = finishSnapshot(fixture.captureRoot);

    expect(snapshot.root.textContent?.length).toBeLessThan(512);
    expect(fixture.rangeMetrics.maxRequestedSpan).toBeLessThan(1_024);
  });

  it('yields an incremental build when the frame deadline is consumed', () => {
    const fixture = snapshotFixture({ content: 'first second third', scrollLeft: 0 });
    let now = 0;
    const build = createCanvasTextPreviewSnapshotBuild({
      captureRoot: fixture.captureRoot,
      fields: failureFields(),
      now: () => now++
    });

    expect(build.runSlice(1)).toEqual({ done: false });
    const completed = build.runSlice(Number.POSITIVE_INFINITY);
    expect(completed.done).toBe(true);
  });

  it('defers CodeMirror text tree traversal until an incremental slice runs', () => {
    const fixture = snapshotFixture({ content: 'incremental traversal', scrollLeft: 0 });
    const createTreeWalker = document.createTreeWalker.bind(document);
    let nextNodeCalls = 0;
    const spy = vi.spyOn(document, 'createTreeWalker').mockImplementation((...args) => {
      const walker = createTreeWalker(...args);
      const nextNode = walker.nextNode.bind(walker);
      const countsTextTraversal = args[0] instanceof HTMLElement
        && args[0].classList.contains('cm-line')
        && args[1] === NodeFilter.SHOW_TEXT;
      walker.nextNode = () => {
        if (countsTextTraversal) {
          nextNodeCalls += 1;
        }
        return nextNode();
      };
      return walker;
    });

    const build = createCanvasTextPreviewSnapshotBuild({
      captureRoot: fixture.captureRoot,
      fields: failureFields(),
      now: () => 0
    });

    expect(nextNodeCalls).toBe(0);
    build.dispose();
    spy.mockRestore();
  });

  it('rejects a snapshot child whose declared box escapes the root', () => {
    const fixture = snapshotFixture({ content: 'bounded', scrollLeft: 0 });
    const snapshot = finishSnapshot(fixture.captureRoot);
    const child = snapshot.root.querySelector<HTMLElement>('[data-canvas-text-preview-fragment]');
    expect(child).toBeDefined();
    if (!child) {
      throw new Error('Expected a snapshot fragment.');
    }
    child.style.width = '421px';

    expect(() => assertCanvasTextPreviewSnapshot(snapshot, failureFields())).toThrowError(
      expect.objectContaining({ stage: 'snapshot_invariant_violation' })
    );
  });

  it('rejects an unmarked descendant that bypasses fragment invariants', () => {
    const fixture = snapshotFixture({ content: 'bounded', scrollLeft: 0 });
    const snapshot = finishSnapshot(fixture.captureRoot);
    const child = document.createElement('div');
    Object.assign(child.style, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: '421px',
      height: '20px'
    });
    snapshot.root.append(child);

    expect(() => assertCanvasTextPreviewSnapshot(snapshot, failureFields())).toThrowError(
      expect.objectContaining({ stage: 'snapshot_invariant_violation' })
    );
  });

  it('reports snapshot_not_ready when CodeMirror has no visible scroller', () => {
    const captureRoot = document.createElement('div');
    document.body.append(captureRoot);
    cleanups.push(() => captureRoot.remove());

    expect(() => createCanvasTextPreviewSnapshotBuild({
      captureRoot,
      fields: failureFields()
    })).toThrowError(expect.objectContaining({ stage: 'snapshot_not_ready' }));
  });
});

function finishSnapshot(captureRoot: HTMLElement): CanvasTextPreviewSnapshot {
  const build = createCanvasTextPreviewSnapshotBuild({
    captureRoot,
    fields: failureFields(),
    now: () => 0
  });
  const result = build.runSlice(Number.POSITIVE_INFINITY);
  expect(result.done).toBe(true);
  if (!result.done) {
    throw new Error('Snapshot fixture did not complete.');
  }
  return result.snapshot;
}

function failureFields() {
  return {
    canvasId: 'canvas-1',
    projectRelativePath: 'generated.json',
    fingerprint: 'sha256:fixture'
  };
}

function snapshotFixture(input: {
  content: string;
  scrollLeft: number;
  syntaxColor?: string | undefined;
}): {
  captureRoot: HTMLDivElement;
  rangeMetrics: { maxRequestedSpan: number };
} {
  const captureRoot = document.createElement('div');
  captureRoot.style.position = 'relative';
  captureRoot.style.width = '420px';
  captureRoot.style.height = '280px';
  const scroller = document.createElement('div');
  scroller.className = 'cm-scroller';
  const gutters = document.createElement('div');
  gutters.className = 'cm-gutters';
  const lineNumbers = document.createElement('div');
  lineNumbers.className = 'cm-gutter cm-lineNumbers';
  const lineNumber = document.createElement('div');
  lineNumber.className = 'cm-gutterElement';
  lineNumber.textContent = '1';
  lineNumber.style.textAlign = 'right';
  lineNumber.style.paddingLeft = '5px';
  lineNumber.style.paddingRight = '3px';
  const content = document.createElement('div');
  content.className = 'cm-content';
  content.style.whiteSpace = 'pre';
  const line = document.createElement('div');
  line.className = 'cm-line';
  line.style.whiteSpace = 'pre';
  const syntax = document.createElement('span');
  syntax.style.color = input.syntaxColor ?? 'rgb(220, 220, 220)';
  const text = document.createTextNode(input.content);
  syntax.append(text);
  line.append(syntax);
  content.append(line);
  lineNumbers.append(lineNumber);
  gutters.append(lineNumbers);
  scroller.append(gutters, content);
  captureRoot.append(scroller);
  document.body.append(captureRoot);

  const viewport = rect(0, 0, 420, 280);
  const lineLeft = 40 - input.scrollLeft;
  setClientSize(captureRoot, 420, 280);
  setClientSize(scroller, 420, 280);
  setRect(captureRoot, viewport);
  setRect(scroller, viewport);
  setRect(gutters, rect(0, 0, 40, 280));
  setRect(lineNumbers, rect(0, 0, 40, 280));
  setRect(lineNumber, rect(0, 10, 40, 20));
  setRect(content, rect(40, 0, 380, 280));
  setRect(line, rect(lineLeft, 10, input.content.length * 8, 20));
  setRect(syntax, rect(lineLeft, 10, input.content.length * 8, 20));
  const rangeControl = installRangeGeometry(text, lineLeft, 10, 8, 20);
  cleanups.push(() => {
    rangeControl.restore();
    captureRoot.remove();
  });
  return { captureRoot, rangeMetrics: rangeControl.metrics };
}

function wrappedSnapshotFixture(textContent: string): {
  captureRoot: HTMLDivElement;
  rangeMetrics: { maxRequestedSpan: number };
} {
  const captureRoot = document.createElement('div');
  captureRoot.style.position = 'relative';
  captureRoot.style.width = '120px';
  captureRoot.style.height = '40px';
  const scroller = document.createElement('div');
  scroller.className = 'cm-scroller';
  const content = document.createElement('div');
  content.className = 'cm-content';
  content.style.whiteSpace = 'pre-wrap';
  const line = document.createElement('div');
  line.className = 'cm-line';
  line.style.whiteSpace = 'pre-wrap';
  const syntax = document.createElement('span');
  syntax.style.color = 'rgb(0, 128, 255)';
  const text = document.createTextNode(textContent);
  syntax.append(text);
  line.append(syntax);
  content.append(line);
  scroller.append(content);
  captureRoot.append(scroller);
  document.body.append(captureRoot);

  setClientSize(captureRoot, 120, 40);
  setClientSize(scroller, 120, 40);
  setRect(captureRoot, rect(0, 0, 120, 40));
  setRect(scroller, rect(0, 0, 120, 40));
  setRect(content, rect(0, -20, 120, 80));
  setRect(line, rect(0, -20, 80, 80));
  setRect(syntax, rect(0, -20, 80, 80));
  const rangeControl = installWrappedRangeGeometry(text, 0, -20, 10, 8, 20);
  cleanups.push(() => {
    rangeControl.restore();
    captureRoot.remove();
  });
  return { captureRoot, rangeMetrics: rangeControl.metrics };
}

function installRangeGeometry(
  target: Text,
  left: number,
  top: number,
  characterWidth: number,
  height: number
): { restore(): void; metrics: { maxRequestedSpan: number } } {
  const original = document.createRange.bind(document);
  const metrics = { maxRequestedSpan: 0 };
  document.createRange = () => {
    let start = 0;
    let end = target.data.length;
    return {
      setStart(node: Node, offset: number) {
        if (node === target) {
          start = offset;
        }
      },
      setEnd(node: Node, offset: number) {
        if (node === target) {
          end = offset;
        }
      },
      selectNodeContents(node: Node) {
        if (node === target) {
          start = 0;
          end = target.data.length;
        }
      },
      getClientRects() {
        metrics.maxRequestedSpan = Math.max(metrics.maxRequestedSpan, end - start);
        return [rect(left + start * characterWidth, top, Math.max(0, end - start) * characterWidth, height)] as unknown as DOMRectList;
      },
      getBoundingClientRect() {
        metrics.maxRequestedSpan = Math.max(metrics.maxRequestedSpan, end - start);
        return rect(left + start * characterWidth, top, Math.max(0, end - start) * characterWidth, height);
      },
      detach() {}
    } as unknown as Range;
  };
  return {
    metrics,
    restore() {
      document.createRange = original;
    }
  };
}

function installWrappedRangeGeometry(
  target: Text,
  left: number,
  top: number,
  charactersPerRow: number,
  characterWidth: number,
  rowHeight: number
): { restore(): void; metrics: { maxRequestedSpan: number } } {
  const original = document.createRange.bind(document);
  const metrics = { maxRequestedSpan: 0 };
  document.createRange = () => {
    let start = 0;
    let end = target.data.length;
    const rangeRects = (): DOMRect[] => {
      metrics.maxRequestedSpan = Math.max(metrics.maxRequestedSpan, end - start);
      if (end <= start) {
        return [];
      }
      const firstRow = Math.floor(start / charactersPerRow);
      const lastRow = Math.floor((end - 1) / charactersPerRow);
      const rects: DOMRect[] = [];
      for (let row = firstRow; row <= Math.min(lastRow, firstRow + 100); row += 1) {
        const rowStart = row * charactersPerRow;
        const visibleStart = Math.max(start, rowStart);
        const visibleEnd = Math.min(end, rowStart + charactersPerRow);
        rects.push(rect(
          left + (visibleStart - rowStart) * characterWidth,
          top + row * rowHeight,
          (visibleEnd - visibleStart) * characterWidth,
          rowHeight
        ));
      }
      return rects;
    };
    return {
      setStart(node: Node, offset: number) {
        if (node === target) {
          start = offset;
        }
      },
      setEnd(node: Node, offset: number) {
        if (node === target) {
          end = offset;
        }
      },
      selectNodeContents(node: Node) {
        if (node === target) {
          start = 0;
          end = target.data.length;
        }
      },
      getClientRects() {
        return rangeRects() as unknown as DOMRectList;
      },
      getBoundingClientRect() {
        const rects = rangeRects();
        return rects[0] ?? rect(0, 0, 0, 0);
      },
      detach() {}
    } as unknown as Range;
  };
  return {
    metrics,
    restore() {
      document.createRange = original;
    }
  };
}

function setClientSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height }
  });
}

function setRect(element: Element, value: DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => value
  });
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({})
  } as DOMRect;
}
