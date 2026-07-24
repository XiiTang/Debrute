import type { FloatingPanelState } from '../shell/floatingPanels';

export interface ProjectViewState {
  activeCanvasId?: string;
  floatingPanels?: FloatingPanelState;
}

export interface ProjectViewStateStorage {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
}

export function projectViewStateStorageKey(projectId: string): string {
  return `debrute:project-view:${encodeURIComponent(projectId)}`;
}

export function loadProjectViewState(input: {
  storage: ProjectViewStateStorage | undefined;
  projectId: string;
}): ProjectViewState {
  const raw = input.storage?.getItem(projectViewStateStorageKey(input.projectId));
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as ProjectViewState;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export function saveProjectViewState(input: {
  storage: ProjectViewStateStorage | undefined;
  projectId: string;
  state: ProjectViewState;
}): void {
  input.storage?.setItem(projectViewStateStorageKey(input.projectId), JSON.stringify(input.state));
}
