import { basename, win32 } from 'node:path';
import type { JumpListCategory } from 'electron';

export type DesktopOpenIntent =
  | { kind: 'new-window' }
  | { kind: 'open-project-path'; projectRoot: string }
  | { kind: 'open-project-id'; projectId: string };

export interface NativeRecentProjectHost {
  addRecentDocument?(path: string): void;
  clearRecentDocuments?(): void;
  setJumpList?(categories: JumpListCategory[]): string | void;
}

export interface NativeRecentProjectSyncInput {
  platform: NodeJS.Platform;
  execPath: string;
  recentProjectRoots: string[];
}

export function parseDesktopOpenIntent(argv: string[]): DesktopOpenIntent | undefined {
  if (argv.includes('--new-window')) {
    return { kind: 'new-window' };
  }
  let openProjectValue: string | undefined;
  let projectIdValue: string | undefined;
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const value = argv[index];
    if (value?.startsWith('--open-project=')) {
      openProjectValue = value.slice('--open-project='.length);
      break;
    }
    if (value?.startsWith('--debrute-project-id=')) {
      projectIdValue = value.slice('--debrute-project-id='.length);
      break;
    }
  }
  if (projectIdValue) {
    return { kind: 'open-project-id', projectId: projectIdValue };
  }
  if (openProjectValue) {
    return { kind: 'open-project-path', projectRoot: openProjectValue };
  }
  return undefined;
}

export function buildNativeRecentProjectSync(input: NativeRecentProjectSyncInput): { apply(host: NativeRecentProjectHost): void } {
  return {
    apply(host) {
      if (input.platform === 'darwin') {
        host.clearRecentDocuments?.();
        for (const projectRoot of [...input.recentProjectRoots].reverse()) {
          host.addRecentDocument?.(projectRoot);
        }
        return;
      }

      if (input.platform === 'win32') {
        host.setJumpList?.(windowsJumpList(input.execPath, input.recentProjectRoots));
      }
    }
  };
}

export function syncNativeRecentProjects(
  host: NativeRecentProjectHost,
  platform: NodeJS.Platform,
  execPath: string,
  recentProjectRoots: string[]
): void {
  buildNativeRecentProjectSync({ platform, execPath, recentProjectRoots }).apply(host);
}

function windowsJumpList(execPath: string, recentProjectRoots: string[]): JumpListCategory[] {
  const categories: JumpListCategory[] = [
    {
      type: 'tasks',
      items: [
        {
          type: 'task',
          title: 'New Window',
          program: execPath,
          args: '--new-window',
          iconPath: execPath,
          iconIndex: 0,
          description: 'Open a new Debrute window'
        }
      ]
    }
  ];
  if (recentProjectRoots.length > 0) {
    categories.push({
      type: 'custom',
      name: 'Recent Projects',
      items: recentProjectRoots.slice(0, 7).map((projectRoot) => ({
        type: 'task',
        title: projectDisplayName(projectRoot),
        description: projectRoot,
        program: execPath,
        args: `--open-project="${projectRoot.replace(/"/g, '\\"')}"`,
        iconPath: 'explorer.exe',
        iconIndex: 0
      }))
    });
  }
  return categories;
}

function projectDisplayName(projectRoot: string): string {
  const normalized = projectRoot.replace(/[\\/]+$/, '');
  return projectRoot.includes('\\') ? win32.basename(normalized) : basename(normalized);
}
