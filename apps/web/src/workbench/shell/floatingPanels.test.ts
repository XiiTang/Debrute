import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOATING_PANEL_STATE,
  closeFloatingPanel,
  dragFloatingPanel,
  toggleFloatingPanel
} from './floatingPanels';

describe('floating panel state', () => {
  it('opens explorer by default without panel z-index state', () => {
    expect(DEFAULT_FLOATING_PANEL_STATE.panels.explorer).toEqual({
      open: true,
      x: 18,
      y: 72
    });
    expect(DEFAULT_FLOATING_PANEL_STATE.panels.inspector.open).toBe(false);
  });

  it('opens a closed panel from the dock without assigning z-index', () => {
    const next = toggleFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'problems');

    expect(next.panels.problems).toEqual({
      open: true,
      x: DEFAULT_FLOATING_PANEL_STATE.panels.problems.x,
      y: DEFAULT_FLOATING_PANEL_STATE.panels.problems.y
    });
  });

  it('closes an open panel from the dock', () => {
    const next = toggleFloatingPanel(DEFAULT_FLOATING_PANEL_STATE, 'explorer');

    expect(next.panels.explorer.open).toBe(false);
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

});
