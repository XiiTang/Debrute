import {
  type FloatingPanelState
} from '../shell/floatingPanels';

interface ProjectViewState {
  floatingPanels: FloatingPanelState;
}

interface ProjectViewStateStorage {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
}

function projectViewStateStorageKey(canonicalRoot: string): string {
  return `debrute:project-view:${encodeURIComponent(canonicalRoot)}`;
}

export function restoreProjectViewState(input: {
  storage: ProjectViewStateStorage;
  canonicalRoot: string;
}): ProjectViewState | undefined {
  const raw = input.storage.getItem(projectViewStateStorageKey(input.canonicalRoot));
  if (raw === null || raw === undefined) {
    return undefined;
  }
  return JSON.parse(raw) as ProjectViewState;
}

export function saveProjectViewState(input: {
  storage: ProjectViewStateStorage;
  canonicalRoot: string;
  state: ProjectViewState;
}): void {
  input.storage.setItem(projectViewStateStorageKey(input.canonicalRoot), JSON.stringify(input.state));
}
