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

export function openFloatingPanel(state: FloatingPanelState, panelId: FloatingPanelId): FloatingPanelState {
  const panel = state.panels[panelId];
  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: { ...panel, open: true }
    }
  };
}

export function toggleFloatingPanel(state: FloatingPanelState, panelId: FloatingPanelId): FloatingPanelState {
  const panel = state.panels[panelId];
  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: { ...panel, open: !panel.open }
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
  delta: { dx: number; dy: number }
): FloatingPanelState {
  const panel = state.panels[panelId];
  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: {
        ...panel,
        x: Math.max(8, panel.x + delta.dx),
        y: Math.max(8, panel.y + delta.dy)
      }
    }
  };
}

export function resizeFloatingPanel(
  state: FloatingPanelState,
  panelId: FloatingPanelId,
  size: { width: number; height: number }
): FloatingPanelState {
  const panel = state.panels[panelId];
  const definition = FLOATING_PANEL_DEFINITIONS[panelId];
  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: {
        ...panel,
        width: clamp(Math.round(size.width), definition.minWidth, definition.maxWidth),
        height: clamp(Math.round(size.height), definition.minHeight, definition.maxHeight)
      }
    }
  };
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
