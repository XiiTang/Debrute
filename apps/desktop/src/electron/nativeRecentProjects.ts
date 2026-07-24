import { basename, win32 } from 'node:path';
import type { JumpListCategory } from 'electron';
import type { DebruteProductPlatform } from '@debrute/app-protocol';

export type DesktopOpenIntent =
  | { kind: 'new-window' }
  | { kind: 'open-project-path'; projectRoot: string }
  | { kind: 'open-project-id'; projectId: string };

export interface NativeRecentProjectHost {
  addRecentDocument(path: string): void;
  clearRecentDocuments(): void;
  setJumpList(categories: JumpListCategory[]): ReturnType<Electron.App['setJumpList']>;
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

export function syncNativeRecentProjects(
  host: NativeRecentProjectHost,
  platform: DebruteProductPlatform,
  execPath: string,
  recentProjectRoots: string[]
): void {
  if (platform === 'darwin') {
    host.clearRecentDocuments();
    for (const projectRoot of [...recentProjectRoots].reverse()) {
      host.addRecentDocument(projectRoot);
    }
    return;
  }
  const result = host.setJumpList(windowsJumpList(execPath, recentProjectRoots));
  if (result !== 'ok') {
    throw new Error(`Windows rejected the Debrute Jump List: ${result}`);
  }
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
