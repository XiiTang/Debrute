import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOATING_PANEL_STATE,
  type FloatingPanelResizeDirection,
  type FloatingPanelState,
  closeFloatingPanel,
  constrainOpenFloatingPanelsToViewport,
  dragFloatingPanel,
  openFloatingPanel,
  resizeFloatingPanel,
  toggleFloatingPanel
} from './floatingPanels';

const viewport = { x: 0, y: 0, width: 1000, height: 700 };

describe('floating panel state', () => {
  it('keeps panels closed by default while preserving the Explorer spawn position', () => {
    expect(DEFAULT_FLOATING_PANEL_STATE.panels.explorer).toEqual({
      open: false,
      x: 58,
      y: 45,
      width: 320,
      height: 620
    });
    expect(DEFAULT_FLOATING_PANEL_STATE.panels.inspector.open).toBe(false);
    expect(DEFAULT_FLOATING_PANEL_STATE.panels.terminal).toEqual({
      open: false,
      x: 96,
      y: 420,
      width: 920,
      height: 320
    });
  });

  it('opens a closed panel from the dock without assigning z-index', () => {
    const roomyViewport = { ...viewport, height: 900 };
    const next = toggleFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'problems', roomyViewport);

    expect(next.panels.problems).toEqual({
      open: true,
      x: DEFAULT_FLOATING_PANEL_STATE.panels.problems.x,
      y: DEFAULT_FLOATING_PANEL_STATE.panels.problems.y,
      width: DEFAULT_FLOATING_PANEL_STATE.panels.problems.width,
      height: DEFAULT_FLOATING_PANEL_STATE.panels.problems.height
    });
  });

  it('opens a panel directly for commands', () => {
    const next = openFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'terminal', viewport);

    expect(next.panels.terminal.open).toBe(true);
    expect(next.panels.terminal.width).toBe(920);
    expect(next.panels.terminal.height).toBe(320);
    expect(next.panels.terminal.x).toBe(96);
    expect(next.panels.terminal.y).toBe(420);
  });

  it('opens explorer from the dock', () => {
    const next = toggleFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'explorer', viewport);

    expect(next.panels.explorer.open).toBe(true);
  });

  it('constrains a fully offscreen panel when it opens', () => {
    const state = {
      panels: {
        ...DEFAULT_FLOATING_PANEL_STATE.panels,
        terminal: {
          ...DEFAULT_FLOATING_PANEL_STATE.panels.terminal,
          open: false,
          x: 1600,
          y: 900
        }
      }
    };

    const next = openFloatingPanel(state, 'terminal', viewport);

    expect(next.panels.terminal).toMatchObject({
      open: true,
      x: 981,
      y: 681
    });
  });

  it('closes a panel without changing its position', () => {
    const next = closeFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'explorer');

    expect(next.panels.explorer.open).toBe(false);
    expect(next.panels.explorer.x).toBe(DEFAULT_FLOATING_PANEL_STATE.panels.explorer.x);
    expect(next.panels.explorer.y).toBe(DEFAULT_FLOATING_PANEL_STATE.panels.explorer.y);
  });

  it('allows panel drag past all viewport edges while keeping the drag hit area reachable', () => {
    const leftTop = dragFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'settings', { dx: -1200, dy: -600 }, viewport);
    expect(leftTop.panels.settings).toMatchObject({
      x: -741,
      y: -1
    });

    const farEdges = dragFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'settings', { dx: 2000, dy: 2000 }, viewport);
    expect(farEdges.panels.settings).toMatchObject({
      x: 981,
      y: 681
    });
  });

  it('updates panel size after resize and clamps to definition limits', () => {
    const small = resizeTerminal('se', { width: 10, height: 10 });
    expect(small.width).toBe(520);
    expect(small.height).toBe(220);
    expect(small.x).toBe(96);
    expect(small.y).toBe(420);

    const large = resizeTerminal('se', { width: 2000, height: 1200 });
    expect(large.width).toBe(1440);
    expect(large.height).toBe(900);
    expect(large.x).toBe(96);
    expect(large.y).toBe(420);
  });

  it('resizes from left and top edges while preserving the opposite edges', () => {
    const left = resizeTerminal('w', { x: 196, width: 820 });

    expect(left).toMatchObject({
      x: 196,
      y: 420,
      width: 820,
      height: 320
    });

    const top = resizeTerminal('n', { y: 360, height: 380 });

    expect(top).toMatchObject({
      x: 96,
      y: 360,
      width: 920,
      height: 380
    });
  });

  it('clamps left and top resize at minimum size without moving the opposite edges', () => {
    const left = resizeTerminal('w', { x: 900, width: 116 });

    expect(left).toMatchObject({
      x: 496,
      width: 520
    });

    const top = resizeTerminal('n', { y: 700, height: 40 });

    expect(top).toMatchObject({
      y: 520,
      height: 220
    });
  });

  it('uses the active resize direction instead of inferring moved edges from the current panel rect', () => {
    const partiallyResizedFromLeft = {
      panels: {
        ...DEFAULT_FLOATING_PANEL_STATE.panels,
        terminal: {
          ...DEFAULT_FLOATING_PANEL_STATE.panels.terminal,
          x: 196,
          width: 820
        }
      }
    };

    const next = resizeTerminal('se', { width: 960, height: 380 }, partiallyResizedFromLeft);

    expect(next).toMatchObject({
      x: 96,
      y: 420,
      width: 960,
      height: 380
    });
  });

  it('constrains only open panels during viewport resize', () => {
    const state = {
      panels: {
        ...DEFAULT_FLOATING_PANEL_STATE.panels,
        explorer: {
          ...DEFAULT_FLOATING_PANEL_STATE.panels.explorer,
          open: true,
          x: -500,
          y: -100
        },
        settings: {
          ...DEFAULT_FLOATING_PANEL_STATE.panels.settings,
          open: false,
          x: 2000,
          y: 2000
        }
      }
    };

    const next = constrainOpenFloatingPanelsToViewport(state, viewport);

    expect(next.panels.explorer).toMatchObject({
      open: true,
      x: -301,
      y: -1
    });
    expect(next.panels.settings).toMatchObject({
      open: false,
      x: 2000,
      y: 2000
    });
  });
});

function resizeTerminal(
  direction: FloatingPanelResizeDirection,
  rect: Partial<typeof DEFAULT_FLOATING_PANEL_STATE.panels.terminal>,
  state: FloatingPanelState = DEFAULT_FLOATING_PANEL_STATE
): FloatingPanelState['panels']['terminal'] {
  return resizeFloatingPanel(state, 'terminal', {
    ...DEFAULT_FLOATING_PANEL_STATE.panels.terminal,
    ...rect,
    direction
  }, viewport).panels.terminal;
}
