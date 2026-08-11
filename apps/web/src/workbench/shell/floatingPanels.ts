import {
  constrainDragHitAreaVisible,
  sameWindowRect,
  type WorkbenchWindowRect
} from './windowBounds';
import {
  anchorResizedFloatingWindowRect,
  type FloatingWindowGesture
} from './floatingWindowGesture';

export type FloatingPanelId = 'explorer' | 'inspector' | 'feedback' | 'settings' | 'terminal';
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
  feedback: panelDefinition('feedback', 'Feedback', 840, 86, 380, 560, 320, 320, 820, 900),
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
    feedback: {
      open: false,
      x: FLOATING_PANEL_DEFINITIONS.feedback.defaultX,
      y: FLOATING_PANEL_DEFINITIONS.feedback.defaultY,
      width: FLOATING_PANEL_DEFINITIONS.feedback.defaultWidth,
      height: FLOATING_PANEL_DEFINITIONS.feedback.defaultHeight
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
  viewport: WorkbenchWindowRect
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
  viewport: WorkbenchWindowRect
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
  if (!state.panels[panelId].open) {
    return state;
  }
  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: { ...state.panels[panelId], open: false }
    }
  };
}

export function resolveFloatingPanelGestureRect(
  panelId: FloatingPanelId,
  candidate: WorkbenchWindowRect,
  gesture: FloatingWindowGesture,
  viewport: WorkbenchWindowRect
): WorkbenchWindowRect {
  if (gesture.kind === 'move') {
    return constrainDragHitAreaVisible(candidate, viewport);
  }
  const definition = FLOATING_PANEL_DEFINITIONS[panelId];
  const width = clamp(Math.round(candidate.width), definition.minWidth, definition.maxWidth);
  const height = clamp(Math.round(candidate.height), definition.minHeight, definition.maxHeight);
  return constrainDragHitAreaVisible(
    anchorResizedFloatingWindowRect(candidate, gesture.direction, { width, height }),
    viewport
  );
}

export function commitFloatingPanelRect(
  state: FloatingPanelState,
  panelId: FloatingPanelId,
  rect: WorkbenchWindowRect
): FloatingPanelState {
  const current = state.panels[panelId];
  if (sameWindowRect(current, rect)) {
    return state;
  }
  return {
    ...state,
    panels: {
      ...state.panels,
      [panelId]: { ...current, ...rect }
    }
  };
}

export function constrainOpenFloatingPanelsToViewport(
  state: FloatingPanelState,
  viewport: WorkbenchWindowRect
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
  viewport: WorkbenchWindowRect
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
