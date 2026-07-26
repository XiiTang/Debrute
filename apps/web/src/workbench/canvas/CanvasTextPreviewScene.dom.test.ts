import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCanvasTextPreviewSceneBuild,
  type CanvasTextPreviewBuiltScene
} from './CanvasTextPreviewScene';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe('CanvasTextPreviewSceneBuilder', { tags: ['canvas-text'] }, () => {
  it('returns the worker drawing scene without a temporary DOM representation', () => {
    const fixture = captureFixture({ content: 'const direct = true;', scrollLeft: 0 });
    const build = createCanvasTextPreviewSceneBuild({
      captureRoot: fixture.captureRoot,
      fields: failureFields(),
      now: () => 0
    });

    const result = build.runSlice(Number.POSITIVE_INFINITY);

    expect(result.done).toBe(true);
    if (!result.done) {
      throw new Error('Scene fixture did not complete.');
    }
    expect(result.builtScene).not.toHaveProperty('root');
    expect(result.builtScene.scene.commands).toContainEqual(expect.objectContaining({
      kind: 'text',
      text: 'const direct = true;'
    }));
  });

  it.each([6_472, 600_000])(
    'copies bounded visible text from an unwrapped %i-byte JSON line',
    (payloadLength) => {
      const content = JSON.stringify({
        id: '12_cma_1993.143',
        payload: 'x'.repeat(payloadLength),
        tags: ['art', 'api', 'preview']
      });
      const fixture = captureFixture({ content, scrollLeft: 14_600 });

      const builtScene = finishScene(fixture.captureRoot);
      const text = sceneText(builtScene);

      expect(builtScene.width).toBe(420);
      expect(builtScene.height).toBe(280);
      expect(text).toContain('xxxxxxxx');
      expect(text.length).toBeLessThan(512);
      expect(text).not.toBe(content);
      expect(JSON.stringify(builtScene.scene).length).toBeLessThan(32_000);
      expect(builtScene).not.toHaveProperty('root');
      expect(fixture.rangeMetrics.maxRequestedSpan).toBeLessThan(1_024);
    }
  );

  it('creates a valid blank preview for an empty text file', () => {
    const fixture = captureFixture({ content: '', scrollLeft: 0 });

    const builtScene = finishScene(fixture.captureRoot);

    expect(builtScene.scene.commands
      .filter((command) => command.kind === 'text')
      .map((command) => command.text)).toEqual(['1']);
    expect(builtScene.scene.commands.some((command) => command.kind === 'rect')).toBe(true);
  });

  it('preserves visible syntax colors and aligned line numbers without source subtrees', () => {
    const fixture = captureFixture({
      content: 'const answer = 42;',
      scrollLeft: 0,
      syntaxColor: 'rgb(255, 0, 0)'
    });

    const builtScene = finishScene(fixture.captureRoot);
    const lineNumber = builtScene.scene.commands.find((command) => (
      command.kind === 'text' && command.text === '1'
    ));
    const text = builtScene.scene.commands.find((command) => (
      command.kind === 'text' && command.text === 'const answer = 42;'
    ));

    expect(lineNumber).toMatchObject({
      kind: 'text',
      text: '1',
      textAlign: 'right',
      textX: 37,
      fontVariantNumeric: 'tabular-nums'
    });
    expect(text).toMatchObject({
      kind: 'text',
      color: 'rgb(255, 0, 0)',
      fontSize: '17px',
      fontWeight: '700',
      fontStyle: 'italic',
      fontStretch: '120%',
      letterSpacing: '2px',
      wordSpacing: '4px',
      fontKerning: 'none',
      fontVariantLigatures: 'no-common-ligatures no-contextual',
      fontFeatureSettings: '"ss01" 1',
      fontVariationSettings: '"MONO" 0.75',
      fontOpticalSizing: 'none',
      fontSynthesis: 'none'
    });
    expect(lineNumber?.y).toBe(text?.y);
  });

  it('builds a bounded worker-safe drawing scene', () => {
    const fixture = captureFixture({
      content: 'const answer = 42;',
      scrollLeft: 0,
      syntaxColor: 'rgb(255, 0, 0)'
    });
    const builtScene = finishScene(fixture.captureRoot);

    const scene = builtScene.scene;

    expect(scene.commands).toContainEqual(expect.objectContaining({ kind: 'rect' }));
    expect(scene.commands).toContainEqual(expect.objectContaining({
      kind: 'text',
      text: 'const answer = 42;',
      color: 'rgb(255, 0, 0)',
      fontVariantLigatures: 'no-common-ligatures no-contextual',
      fontFeatureSettings: '"ss01" 1',
      fontVariationSettings: '"MONO" 0.75',
      fontOpticalSizing: 'none',
      fontSynthesis: 'none'
    }));
    expect(JSON.stringify(scene)).not.toContain('foreignObject');
    expect(JSON.stringify(scene)).not.toContain('cm-editor');
  });

  it('uses DOM geometry to split tabs before Worker drawing', () => {
    const fixture = captureFixture({ content: '\tconst\tanswer', scrollLeft: 0 });
    const builtScene = finishScene(fixture.captureRoot);

    const scene = builtScene.scene;
    const textCommands = scene.commands.filter((command) => command.kind === 'text');

    expect(textCommands.every((command) => !command.text.includes('\t'))).toBe(true);
    expect(textCommands.map((command) => command.text).join('')).toContain('constanswer');
  });

  it('copies only vertically visible wrapped rows from one CodeMirror text node', () => {
    const fixture = wrappedCaptureFixture('abcdefghijKLMNOPQRSTuvwxyzABCD1234567890');

    const builtScene = finishScene(fixture.captureRoot);
    const fragments = builtScene.scene.commands.filter((command) => command.kind === 'text');

    expect(fragments.length).toBeGreaterThanOrEqual(2);
    expect(fragments.map((fragment) => fragment.text).join('')).not.toContain('abcdefghij');
    expect(fragments.map((fragment) => fragment.text).join('')).toContain('KLMNOPQRST');
    expect(fragments.every((fragment) => fragment.y >= 0)).toBe(true);
  });

  it('never requests the complete offset range of a 600 KB wrapped text node', () => {
    const fixture = wrappedCaptureFixture('x'.repeat(600_000));

    const builtScene = finishScene(fixture.captureRoot);

    expect(sceneText(builtScene).length).toBeLessThan(512);
    expect(fixture.rangeMetrics.maxRequestedSpan).toBeLessThan(1_024);
  });

  it('yields an incremental build when the frame deadline is consumed', () => {
    const fixture = captureFixture({ content: 'first second third', scrollLeft: 0 });
    let now = 0;
    const build = createCanvasTextPreviewSceneBuild({
      captureRoot: fixture.captureRoot,
      fields: failureFields(),
      now: () => now++
    });

    expect(build.runSlice(1)).toEqual({ done: false });
    const completed = build.runSlice(Number.POSITIVE_INFINITY);
    expect(completed.done).toBe(true);
  });

  it('defers CodeMirror text tree traversal until an incremental slice runs', () => {
    const fixture = captureFixture({ content: 'incremental traversal', scrollLeft: 0 });
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

    const build = createCanvasTextPreviewSceneBuild({
      captureRoot: fixture.captureRoot,
      fields: failureFields(),
      now: () => 0
    });

    expect(nextNodeCalls).toBe(0);
    build.dispose();
    spy.mockRestore();
  });

  it('returns only commands bounded by the builtScene dimensions', () => {
    const fixture = captureFixture({ content: 'bounded', scrollLeft: 0 });
    const builtScene = finishScene(fixture.captureRoot);

    expect(builtScene.scene.commands.every((command) => (
      command.x >= 0
      && command.y >= 0
      && command.x + command.width <= builtScene.width + 0.5
      && command.y + command.height <= builtScene.height + 0.5
    ))).toBe(true);
  });

  it('reports scene_not_ready when CodeMirror has no visible scroller', () => {
    const captureRoot = document.createElement('div');
    document.body.append(captureRoot);
    cleanups.push(() => captureRoot.remove());

    expect(() => createCanvasTextPreviewSceneBuild({
      captureRoot,
      fields: failureFields()
    })).toThrowError(expect.objectContaining({ stage: 'scene_not_ready' }));
  });
});

function finishScene(captureRoot: HTMLElement): CanvasTextPreviewBuiltScene {
  const build = createCanvasTextPreviewSceneBuild({
    captureRoot,
    fields: failureFields(),
    now: () => 0
  });
  const result = build.runSlice(Number.POSITIVE_INFINITY);
  expect(result.done).toBe(true);
  if (!result.done) {
    throw new Error('Scene fixture did not complete.');
  }
  return result.builtScene;
}

function sceneText(builtScene: CanvasTextPreviewBuiltScene): string {
  return builtScene.scene.commands
    .filter((command) => command.kind === 'text')
    .map((command) => command.text)
    .join('');
}

function failureFields() {
  return {
    canvasId: 'canvas-1',
    projectRelativePath: 'generated.json',
    fingerprint: 'sha256:fixture'
  };
}

function captureFixture(input: {
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
  lineNumber.style.fontVariantNumeric = 'tabular-nums';
  const content = document.createElement('div');
  content.className = 'cm-content';
  content.style.whiteSpace = 'pre';
  const line = document.createElement('div');
  line.className = 'cm-line';
  line.style.whiteSpace = 'pre';
  const syntax = document.createElement('span');
  syntax.style.color = input.syntaxColor ?? 'rgb(220, 220, 220)';
  syntax.style.fontSize = '17px';
  syntax.style.fontWeight = '700';
  syntax.style.fontStyle = 'italic';
  syntax.style.fontStretch = '120%';
  syntax.style.letterSpacing = '2px';
  syntax.style.wordSpacing = '4px';
  syntax.style.fontKerning = 'none';
  syntax.style.fontVariantLigatures = 'no-common-ligatures no-contextual';
  syntax.style.fontFeatureSettings = '"ss01" 1';
  syntax.style.fontVariationSettings = '"MONO" 0.75';
  syntax.style.fontOpticalSizing = 'none';
  syntax.style.fontSynthesis = 'none';
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

function wrappedCaptureFixture(textContent: string): {
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
