import type {
  AdobeBridgeStateView,
  ProjectBridgeDirectory
} from '@debrute/app-protocol';

export interface LinkedProjectTree {
  projectId: string;
  projectName: string;
  directories: ProjectBridgeDirectory[];
}

export interface AvailableProjectLink {
  projectId: string;
  projectName: string;
}

export function linkedProjectTrees(
  bridge: AdobeBridgeStateView | undefined,
  adobeClientId: string
): LinkedProjectTree[] {
  if (!bridge?.settings.enabled) {
    return [];
  }
  const linkedProjectIds = new Set(bridge.links
    .filter((link) => link.adobeClientId === adobeClientId && link.status === 'active')
    .map((link) => link.projectId));
  return bridge.projects
    .filter((project) => linkedProjectIds.has(project.projectId))
    .map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      directories: project.directories
    }));
}

export function availableProjectLinks(
  bridge: AdobeBridgeStateView | undefined,
  adobeClientId: string
): AvailableProjectLink[] {
  if (!bridge?.settings.enabled) {
    return [];
  }
  const linkedProjectIds = new Set(bridge.links
    .filter((link) => link.adobeClientId === adobeClientId && link.status === 'active')
    .map((link) => link.projectId));
  return bridge.projects
    .filter((project) => !linkedProjectIds.has(project.projectId))
    .map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName
    }));
}
