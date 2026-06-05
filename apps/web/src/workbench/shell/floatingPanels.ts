export type FloatingPanelId = 'explorer' | 'inspector' | 'problems' | 'settings';

export interface FloatingPanelDefinition {
  id: FloatingPanelId;
  title: string;
  width: number;
  height: number;
  defaultX: number;
  defaultY: number;
}

export interface FloatingPanelLayout {
  open: boolean;
  x: number;
  y: number;
}

export interface FloatingPanelState {
  panels: Record<FloatingPanelId, FloatingPanelLayout>;
}

export const FLOATING_PANEL_STORAGE_KEY = 'debrute.workbench.floatingPanels';

export const FLOATING_PANEL_DEFINITIONS: Record<FloatingPanelId, FloatingPanelDefinition> = {
  explorer: { id: 'explorer', title: 'Explorer', width: 320, height: 620, defaultX: 18, defaultY: 72 },
  inspector: { id: 'inspector', title: 'Inspector', width: 340, height: 420, defaultX: 1036, defaultY: 470 },
  problems: { id: 'problems', title: 'Problems', width: 720, height: 260, defaultX: 360, defaultY: 680 },
  settings: { id: 'settings', title: 'Settings', width: 760, height: 580, defaultX: 360, defaultY: 120 }
};

export const FLOATING_PANEL_IDS = Object.keys(FLOATING_PANEL_DEFINITIONS) as FloatingPanelId[];

export const DEFAULT_FLOATING_PANEL_STATE: FloatingPanelState = {
  panels: {
    explorer: {
      open: true,
      x: FLOATING_PANEL_DEFINITIONS.explorer.defaultX,
      y: FLOATING_PANEL_DEFINITIONS.explorer.defaultY
    },
    inspector: {
      open: false,
      x: FLOATING_PANEL_DEFINITIONS.inspector.defaultX,
      y: FLOATING_PANEL_DEFINITIONS.inspector.defaultY
    },
    problems: {
      open: false,
      x: FLOATING_PANEL_DEFINITIONS.problems.defaultX,
      y: FLOATING_PANEL_DEFINITIONS.problems.defaultY
    },
    settings: {
      open: false,
      x: FLOATING_PANEL_DEFINITIONS.settings.defaultX,
      y: FLOATING_PANEL_DEFINITIONS.settings.defaultY
    }
  }
};

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

export function loadFloatingPanelState(raw: string | null | undefined): FloatingPanelState {
  return raw ? JSON.parse(raw) as FloatingPanelState : DEFAULT_FLOATING_PANEL_STATE;
}

export function serializeFloatingPanelState(state: FloatingPanelState): string {
  return JSON.stringify(state);
}
