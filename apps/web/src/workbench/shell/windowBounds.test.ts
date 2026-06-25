import { afterEach, describe, expect, it } from 'vitest';
import {
  FLOATING_PANEL_TITLEBAR_HEIGHT,
  constrainContainedRect,
  constrainTitlebarVisible,
  readWorkbenchViewportRect,
  type WorkbenchViewportRect
} from './windowBounds';

const viewport: WorkbenchViewportRect = { x: 0, y: 0, width: 1000, height: 700 };

describe('window bounds', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('allows product panels past every viewport edge while keeping a titlebar-height strip visible', () => {
    expect(constrainTitlebarVisible({
      x: -500,
      y: -80,
      width: 320,
      height: 620
    }, viewport)).toMatchObject({
      x: -281,
      y: -1
    });

    expect(constrainTitlebarVisible({
      x: 1200,
      y: 900,
      width: 320,
      height: 620
    }, viewport)).toMatchObject({
      x: 961,
      y: 661
    });
  });

  it('accounts for the Workbench panel frame when keeping the actual header visible', () => {
    expect(constrainTitlebarVisible({
      x: 999,
      y: 699,
      width: 320,
      height: 620
    }, viewport)).toMatchObject({
      x: 961,
      y: 661
    });
  });

  it('preserves already visible product panel titlebars', () => {
    expect(constrainTitlebarVisible({
      x: -240,
      y: -1,
      width: 320,
      height: 620
    }, viewport)).toEqual({
      x: -240,
      y: -1,
      width: 320,
      height: 620
    });
  });

  it('uses the titlebar height for horizontal and vertical reserved visibility', () => {
    expect(constrainTitlebarVisible({
      x: 1200,
      y: 900,
      width: 320,
      height: 620
    }, viewport, 52)).toMatchObject({
      x: 947,
      y: 647
    });
  });

  it('uses the Workbench floating panel header height for titlebar visibility', () => {
    expect(FLOATING_PANEL_TITLEBAR_HEIGHT).toBe(38);
  });

  it('keeps floating bar windows fully contained in the viewport', () => {
    expect(constrainContainedRect({
      x: 900,
      y: 650,
      width: 300,
      height: 100
    }, viewport)).toEqual({
      x: 700,
      y: 600,
      width: 300,
      height: 100
    });
  });

  it('caps floating bar windows to the viewport before containing their position', () => {
    expect(constrainContainedRect({
      x: 15,
      y: 25,
      width: 1400,
      height: 900
    }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 700
    });
  });

  it('reads the current Workbench viewport from the browser window', () => {
    (globalThis as { window?: unknown }).window = {
      innerWidth: 1440,
      innerHeight: 900
    };

    expect(readWorkbenchViewportRect()).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 900
    });
  });

  it('requires a browser window when reading the Workbench viewport', () => {
    delete (globalThis as { window?: unknown }).window;

    expect(() => readWorkbenchViewportRect()).toThrow('Workbench viewport requires a browser window');
  });
});
