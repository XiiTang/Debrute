import { basename, win32 } from 'node:path';
import type { JumpListCategory } from 'electron';
import type { DebruteProductPlatform } from '@debrute/app-protocol';

export type DesktopOpenIntent =
  | { kind: 'new-window' }
  | { kind: 'open-project-path'; projectRoot: string };

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
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const value = argv[index];
    if (value?.startsWith('--debrute-project-root=')) {
      openProjectValue = value.slice('--debrute-project-root='.length);
      break;
    }
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
): ReturnType<Electron.App['setJumpList']> | undefined {
  if (platform === 'darwin') {
    host.clearRecentDocuments();
    for (const projectRoot of [...recentProjectRoots].reverse()) {
      host.addRecentDocument(projectRoot);
    }
    return;
  }
  return host.setJumpList(windowsJumpList(execPath, recentProjectRoots));
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
        args: quoteWindowsCommandLineArgument(`--debrute-project-root=${projectRoot}`),
        iconPath: 'explorer.exe',
        iconIndex: 0
      }))
    });
  }
  return categories;
}

function quoteWindowsCommandLineArgument(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes);
    quoted += character;
    backslashes = 0;
  }
  quoted += '\\'.repeat(backslashes * 2);
  return `${quoted}"`;
}

function projectDisplayName(projectRoot: string): string {
  const normalized = projectRoot.replace(/[\\/]+$/, '');
  return projectRoot.includes('\\') ? win32.basename(normalized) : basename(normalized);
}
