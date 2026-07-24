import {
  FLOATING_PANEL_IDS,
  type FloatingPanelLayout,
  type FloatingPanelState
} from '../shell/floatingPanels';

export interface ProjectViewState {
  activeCanvasId?: string;
  floatingPanels: FloatingPanelState;
}

export type ProjectViewStateRestoreResult =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'ready'; state: ProjectViewState };

export interface ProjectViewStateStorage {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function projectViewStateStorageKey(projectId: string): string {
  return `debrute:project-view:${encodeURIComponent(projectId)}`;
}

export function restoreProjectViewState(input: {
  storage: ProjectViewStateStorage;
  projectId: string;
}): ProjectViewStateRestoreResult {
  const key = projectViewStateStorageKey(input.projectId);
  const raw = input.storage.getItem(key);
  if (raw === null || raw === undefined) {
    return { status: 'absent' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    input.storage.removeItem(key);
    return { status: 'invalid' };
  }

  if (!isProjectViewState(parsed)) {
    input.storage.removeItem(key);
    return { status: 'invalid' };
  }
  return { status: 'ready', state: parsed };
}

export function saveProjectViewState(input: {
  storage: ProjectViewStateStorage;
  projectId: string;
  state: ProjectViewState;
}): void {
  input.storage.setItem(projectViewStateStorageKey(input.projectId), JSON.stringify(input.state));
}

function isProjectViewState(value: unknown): value is ProjectViewState {
  if (!isExactRecord(value, ['activeCanvasId', 'floatingPanels'], ['floatingPanels'])) {
    return false;
  }
  if (
    Object.hasOwn(value, 'activeCanvasId')
    && (typeof value.activeCanvasId !== 'string' || value.activeCanvasId.length === 0)
  ) {
    return false;
  }
  return isFloatingPanelState(value.floatingPanels);
}

function isFloatingPanelState(value: unknown): value is FloatingPanelState {
  if (!isExactRecord(value, ['panels'], ['panels'])) {
    return false;
  }
  const panels = value.panels;
  if (!isExactRecord(panels, FLOATING_PANEL_IDS, FLOATING_PANEL_IDS)) {
    return false;
  }
  return FLOATING_PANEL_IDS.every((panelId) => isFloatingPanelLayout(panels[panelId]));
}

function isFloatingPanelLayout(value: unknown): value is FloatingPanelLayout {
  if (!isExactRecord(value, ['open', 'x', 'y', 'width', 'height'], ['open', 'x', 'y', 'width', 'height'])) {
    return false;
  }
  return typeof value.open === 'boolean'
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width)
    && isFiniteNumber(value.height);
}

function isExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[]
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.every((key) => allowedKeys.includes(key))
    && requiredKeys.every((key) => Object.hasOwn(value, key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
