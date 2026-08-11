import { describe, expect, it, vi } from 'vitest';
import { measureCanvasGenericIdentityRows } from './CanvasGenericNodeGeometry';

describe('Canvas generic node production measurement', () => {
  it('measures one rendered identity-row batch after fonts load and caches only complete widths', () => {
    const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { status: 'loaded' }
    });
    const append = vi.spyOn(document.body, 'append');
    const getRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measureRow(
      this: HTMLElement
    ) {
      expect(this.classList.contains('db-canvas-node-generic')).toBe(true);
      expect(this.classList.contains('canvas-generic-node-measurement-row')).toBe(true);
      expect(this.querySelector('svg')).not.toBeNull();
      expect(this.querySelector('strong.db-canvas-node-generic__label')).not.toBeNull();
      const width = this.textContent?.includes('__geometry-dom-long__') ? 412.25 : 142.5;
      return domRect(width, 48);
    });

    try {
      const labels = ['__geometry-dom-short__', '__geometry-dom-long__', '__geometry-dom-short__'];
      expect(measureCanvasGenericIdentityRows(labels)).toEqual(new Map([
        ['__geometry-dom-short__', 142.5],
        ['__geometry-dom-long__', 412.25]
      ]));
      expect(append).toHaveBeenCalledOnce();
      expect(document.querySelector('[data-canvas-generic-measurement-batch="true"]')).toBeNull();

      expect(measureCanvasGenericIdentityRows(labels)).toEqual(new Map([
        ['__geometry-dom-short__', 142.5],
        ['__geometry-dom-long__', 412.25]
      ]));
      expect(append).toHaveBeenCalledOnce();
    } finally {
      append.mockRestore();
      getRect.mockRestore();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      restoreProperty(document, 'fonts', fontsDescriptor);
    }
  });

  it('fails loudly when Workbench fonts are not ready', () => {
    const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { status: 'loading' }
    });
    try {
      expect(() => measureCanvasGenericIdentityRows(['__geometry-font-pending__'])).toThrow(
        'require ready Workbench shell fonts'
      );
    } finally {
      restoreProperty(document, 'fonts', fontsDescriptor);
    }
  });
});

function domRect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => undefined
  };
}

function restoreProperty(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
  } else {
    Reflect.deleteProperty(target, property);
  }
}
