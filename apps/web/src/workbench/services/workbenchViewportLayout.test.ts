import { describe, expect, it } from 'vitest';
import type { FloatingTextEditorWindowState } from '../../types';
import {
  DEFAULT_FLOATING_PANEL_STATE,
  type FloatingPanelState
} from '../shell/floatingPanels';
import {
  reconcileWorkbenchViewportLayout,
  type WorkbenchViewportLayoutController
} from './workbenchViewportLayout';

describe('workbench viewport layout', () => {
  it('constrains open floating layouts whenever the viewport is reconciled', () => {
    let viewportState = { x: 0, y: 0, width: 1440, height: 900 };
    let floatingPanels: FloatingPanelState = {
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
    let textEditorWindows: Record<string, FloatingTextEditorWindowState> = {
      'notes/open.md': {
        projectRelativePath: 'notes/open.md',
        open: true,
        x: 1200,
        y: 900,
        width: 500,
        height: 300
      },
      'notes/closed.md': {
        projectRelativePath: 'notes/closed.md',
        open: false,
        x: 1200,
        y: 900,
        width: 500,
        height: 300
      }
    };
    const viewportRef = { current: viewportState };
    const controller: WorkbenchViewportLayoutController = {
      viewportRef,
      setViewportRect: (value) => {
        viewportState = typeof value === 'function' ? value(viewportState) : value;
      },
      setFloatingPanels: (value) => {
        floatingPanels = typeof value === 'function' ? value(floatingPanels) : value;
      },
      setTextEditorWindows: (value) => {
        textEditorWindows = typeof value === 'function' ? value(textEditorWindows) : value;
      }
    };

    reconcileWorkbenchViewportLayout(controller, { x: 0, y: 0, width: 1000, height: 700 });

    expect(viewportRef.current).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    expect(viewportState).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    expect(floatingPanels.panels.explorer).toMatchObject({
      open: true,
      x: -281,
      y: -1
    });
    expect(floatingPanels.panels.settings).toMatchObject({
      open: false,
      x: 2000,
      y: 2000
    });
    expect(textEditorWindows['notes/open.md']).toMatchObject({
      open: true,
      x: 500,
      y: 400,
      width: 500,
      height: 300
    });
    expect(textEditorWindows['notes/closed.md']).toMatchObject({
      open: false,
      x: 1200,
      y: 900
    });
  });
});
