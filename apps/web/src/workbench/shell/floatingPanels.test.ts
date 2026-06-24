import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOATING_PANEL_STATE,
  closeFloatingPanel,
  dragFloatingPanel,
  openFloatingPanel,
  resizeFloatingPanel,
  toggleFloatingPanel
} from './floatingPanels';

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
    const next = toggleFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'problems');

    expect(next.panels.problems).toEqual({
      open: true,
      x: DEFAULT_FLOATING_PANEL_STATE.panels.problems.x,
      y: DEFAULT_FLOATING_PANEL_STATE.panels.problems.y,
      width: DEFAULT_FLOATING_PANEL_STATE.panels.problems.width,
      height: DEFAULT_FLOATING_PANEL_STATE.panels.problems.height
    });
  });

  it('opens a panel directly for commands', () => {
    const next = openFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'terminal');

    expect(next.panels.terminal.open).toBe(true);
    expect(next.panels.terminal.width).toBe(920);
    expect(next.panels.terminal.height).toBe(320);
  });

  it('opens explorer from the dock', () => {
    const next = toggleFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'explorer');

    expect(next.panels.explorer.open).toBe(true);
  });

  it('closes a panel without changing its position', () => {
    const next = closeFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'explorer');

    expect(next.panels.explorer.open).toBe(false);
    expect(next.panels.explorer.x).toBe(DEFAULT_FLOATING_PANEL_STATE.panels.explorer.x);
    expect(next.panels.explorer.y).toBe(DEFAULT_FLOATING_PANEL_STATE.panels.explorer.y);
  });

  it('updates panel position after drag', () => {
    const next = dragFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'settings', { dx: -24, dy: 18 });

    expect(next.panels.settings.x).toBe(DEFAULT_FLOATING_PANEL_STATE.panels.settings.x - 24);
    expect(next.panels.settings.y).toBe(DEFAULT_FLOATING_PANEL_STATE.panels.settings.y + 18);
  });

  it('updates panel size after resize and clamps to definition limits', () => {
    const small = resizeFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'terminal', { width: 10, height: 10 });
    expect(small.panels.terminal.width).toBe(520);
    expect(small.panels.terminal.height).toBe(220);

    const large = resizeFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'terminal', { width: 2000, height: 1200 });
    expect(large.panels.terminal.width).toBe(1440);
    expect(large.panels.terminal.height).toBe(900);
  });
});
