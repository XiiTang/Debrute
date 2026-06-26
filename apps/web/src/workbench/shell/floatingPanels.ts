import {
  constrainDragHitAreaVisible,
  sameWindowRect,
  type WorkbenchWindowRect,
  type WorkbenchViewportRect
} from './windowBounds';

export type FloatingPanelId = 'explorer' | 'inspector' | 'problems' | 'settings' | 'terminal';

export interface FloatingPanelDefinition {
  id: FloatingPanelId;
  title: string;
  defaultX: number;
  defaultY: number;
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}

export interface FloatingPanelLayout {
  open: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingPanelState {
  panels: Record<FloatingPanelId, FloatingPanelLayout>;
}

export type FloatingPanelResizeRect = WorkbenchWindowRect;

export const FLOATING_PANEL_DEFINITIONS: Record<FloatingPanelId, FloatingPanelDefinition> = {
  explorer: panelDefinition('explorer', 'Explorer', 58, 45, 320, 620, 280, 320, 720, 900),
  inspector: panelDefinition('inspector', 'Inspector', 1036, 470, 340, 420, 300, 280, 760, 760),
  problems: panelDefinition('problems', 'Problems', 360, 680, 720, 260, 420, 180, 1200, 520),
  settings: panelDefinition('settings', 'Settings', 360, 120, 760, 580, 520, 360, 1100, 860),
  terminal: panelDefinition('terminal', 'Terminal', 96, 420, 920, 320, 520, 220, 1440, 900)
};

export const FLOATING_PANEL_IDS = Object.keys(FLOATING_PANEL_DEFINITIONS) as FloatingPanelId[];

export const DEFAULT_FLOATING_PANEL_STATE: FloatingPanelState = {
  panels: {
    explorer: {
      open: false,
      x: FLOATING_PANEL_DEFINITIONS.explorer.defaultX,
      y: FLOATING_PANEL_DEFINITIONS.explorer.defaultY,
      width: FLOATING_PANEL_DEFINITIONS.explorer.defaultWidth,
      height: FLOATING_PANEL_DEFINITIONS.explorer.defaultHeight
    },
    inspector: {
      open: false,
      x: FLOATING_PANEL_DEFINITIONS.inspector.defaultX,
      y: FLOATING_PANEL_DEFINITIONS.inspector.defaultY,
      width: FLOATING_PANEL_DEFINITIONS.inspector.defaultWidth,
      height: FLOATING_PANEL_DEFINITIONS.inspector.defaultHeight
    },
    problems: {
      open: false,
      x: FLOATING_PANEL_DEFINITIONS.problems.defaultX,
      y: FLOATING_PANEL_DEFINITIONS.problems.defaultY,
      width: FLOATING_PANEL_DEFINITIONS.problems.defaultWidth,
      height: FLOATING_PANEL_DEFINITIONS.problems.defaultHeight
    },
    settings: {
      open: false,
      x: FLOATING_PANEL_DEFINITIONS.settings.defaultX,
      y: FLOATING_PANEL_DEFINITIONS.settings.defaultY,
      width: FLOATING_PANEL_DEFINITIONS.settings.defaultWidth,
      height: FLOATING_PANEL_DEFINITIONS.settings.defaultHeight
    },
    terminal: {
      open: false,
      x: FLOATING_PANEL_DEFINITIONS.terminal.defaultX,
      y: FLOATING_PANEL_DEFINITIONS.terminal.defaultY,
      width: FLOATING_PANEL_DEFINITIONS.terminal.defaultWidth,
      height: FLOATING_PANEL_DEFINITIONS.terminal.defaultHeight
    }
  }
};

export function openFloatingPanel(
  state: FloatingPanelState,
  panelId: FloatingPanelId,
  viewport: WorkbenchViewportRect
): FloatingPanelState {
  const panel = constrainFloatingPanelLayout(state.panels[panelId], viewport);
  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: { ...panel, open: true }
    }
  };
}

export function toggleFloatingPanel(
  state: FloatingPanelState,
  panelId: FloatingPanelId,
  viewport: WorkbenchViewportRect
): FloatingPanelState {
  const panel = state.panels[panelId];
  const nextOpen = !panel.open;
  const nextPanel = nextOpen ? constrainFloatingPanelLayout(panel, viewport) : panel;
  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: { ...nextPanel, open: nextOpen }
    }
  };
}

export function closeFloatingPanel(state: FloatingPanelState, panelId: FloatingPanelId): FloatingPanelState {
  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: { ...state.panels[panelId], open: false }
    }
  };
}

export function dragFloatingPanel(
  state: FloatingPanelState,
  panelId: FloatingPanelId,
  delta: { dx: number; dy: number },
  viewport: WorkbenchViewportRect
): FloatingPanelState {
  const panel = state.panels[panelId];
  const nextPanel = constrainFloatingPanelLayout({
    ...panel,
    x: panel.x + delta.dx,
    y: panel.y + delta.dy
  }, viewport);
  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: nextPanel
    }
  };
}

export function resizeFloatingPanel(
  state: FloatingPanelState,
  panelId: FloatingPanelId,
  rect: FloatingPanelResizeRect,
  viewport: WorkbenchViewportRect
): FloatingPanelState {
  const panel = state.panels[panelId];
  const definition = FLOATING_PANEL_DEFINITIONS[panelId];
  const width = clamp(Math.round(rect.width), definition.minWidth, definition.maxWidth);
  const height = clamp(Math.round(rect.height), definition.minHeight, definition.maxHeight);
  const leftEdgeMoved = Math.round(rect.x) !== panel.x;
  const topEdgeMoved = Math.round(rect.y) !== panel.y;
  const nextPanel = constrainFloatingPanelLayout({
    ...panel,
    x: leftEdgeMoved ? panel.x + panel.width - width : panel.x,
    y: topEdgeMoved ? panel.y + panel.height - height : panel.y,
    width,
    height
  }, viewport);
  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: nextPanel
    }
  };
}

export function constrainOpenFloatingPanelsToViewport(
  state: FloatingPanelState,
  viewport: WorkbenchViewportRect
): FloatingPanelState {
  let changed = false;
  const panels = { ...state.panels };
  for (const panelId of FLOATING_PANEL_IDS) {
    const panel = panels[panelId];
    if (!panel.open) {
      continue;
    }
    const nextPanel = constrainFloatingPanelLayout(panel, viewport);
    if (!sameFloatingPanelLayout(panel, nextPanel)) {
      panels[panelId] = nextPanel;
      changed = true;
    }
  }
  return changed ? { ...state, panels } : state;
}

function constrainFloatingPanelLayout(
  panel: FloatingPanelLayout,
  viewport: WorkbenchViewportRect
): FloatingPanelLayout {
  return {
    ...panel,
    ...constrainDragHitAreaVisible(panel, viewport)
  };
}

function sameFloatingPanelLayout(left: FloatingPanelLayout, right: FloatingPanelLayout): boolean {
  return left.open === right.open && sameWindowRect(left, right);
}

function panelDefinition(
  id: FloatingPanelId,
  title: string,
  defaultX: number,
  defaultY: number,
  defaultWidth: number,
  defaultHeight: number,
  minWidth: number,
  minHeight: number,
  maxWidth: number,
  maxHeight: number
): FloatingPanelDefinition {
  return {
    id,
    title,
    defaultX,
    defaultY,
    defaultWidth,
    defaultHeight,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
